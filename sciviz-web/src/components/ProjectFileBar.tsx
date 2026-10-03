import { useEffect, useRef, useState } from 'react'
import {
  applyProjectText,
  activeProjectId,
  buildProjectFromStores,
  isDiskNewer,
  projectFilePortContext,
  projectNameFromFileKey,
  projectTextFromStores,
  undoLastPatch,
  type FileStamp,
} from '../store/projectFile'
import { useWorkflowStore } from '../store/useWorkflowStore'
import { useAnnotationStore } from '../store/useAnnotationStore'
import { useNotebookStore } from '../store/useNotebookStore'
import {
  clearPendingProjectReports,
  registerReportProjectWriter,
  reportWriteFailureText,
  restorePendingProjectReports,
  useReportStore,
  type ProjectWriteOutcome,
} from '../store/useReportStore'
import { useNodeOutputStore } from '../store/nodeOutputStore'
import { useDataStore } from '../store/useDataStore'
import { projectToText, textToProject } from '../workflow/project'
import type { Workflow } from '../workflow/types'
import { projectPersistenceFingerprint } from '../kernel/editFingerprint'
import { confirmDiscardReportDraft, hasDirtyReportDraft } from '../store/reportDraftGuard'

/** 浏览器/文件系统拒绝时，`name` 才是有判据的那一半（`NotAllowedError` / `NotFoundError`…）。 */
function describeWriteError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name
  const message = (error as { message?: string } | null)?.message ?? String(error)
  return name ? `${name}: ${message}` : message
}

/**
 * 打开 / 保存 `.sciviz` 工程文件 —— **一份工程、两个操作者**。
 *
 * 三条状态要分清，别混在一起：
 * 1. **画布上的**（store）：人正在改的东西；
 * 2. **下载出来的**（一份文本）：交给 agent 的；
 * 3. **磁盘上的**（文件句柄）：如果浏览器支持 File System Access API，
 *    我们能记住"这个标签页开着哪个文件"，并且**写回它**，而不是每次都让用户
 *    重新选一遍、重新下载覆盖。
 *
 * 第三件带来的关键能力是**发现"文件被 agent 改过了"**：API 不给变更通知，
 * 只能在窗口重新获得焦点时主动看一眼时间戳与大小（见 `isDiskNewer`）。
 * 没有它，人会在一个已经过期的画布上继续干活，然后把 agent 的改动覆盖掉。
 *
 * **2026-09-22 起默认自动跟进，不再让人点一下。** 原先的做法是发现磁盘更新就在
 * 工具条上挂一个「文件被改过了 · 重新载入」的角标等人点 —— 那在"人在编辑器里顺手改一句"
 * 的场景下是对的，在"agent 就在这个工作台里改图"的场景下是纯摩擦：每一次 AI 改动都要
 * 人多点一次，点上十几次之后用户会以为"这个软件每一步都要我确认"。
 * 自动跟进的前提只有一条：**画布上没有未落盘的改动**。判据不是比文本
 * （工程文本会被规范化，逐字比必然不等），而是比完整的持久化指纹 —— 图、批注、笔记和数据视图
 * 是否还是同一份工作区状态，这件事由 `projectPersistenceFingerprint` 统一回答。
 * 画布上有活的时候仍然留那个角标：那时候"以磁盘为准"会吃掉人手上的东西。
 *
 * 浏览器不支持这套 API 时（Firefox / Safari）退回 `<input type=file>` + 下载：
 * 功能都在，只是每次要重新选文件、覆盖要手动。
 */

interface Props {
  /** 测试与故事书里可以注入一个"假窗口"；生产永远走真的 */
  windowRef?: Window & typeof globalThis
}

function workflowDatasetIds(workflow: Workflow, ids = new Set<string>()): Set<string> {
  for (const node of workflow.nodes) {
    if (node.type === 'data.source') {
      const id = String(node.params.datasetId ?? '')
      if (id) ids.add(id)
    }
    if (node.group) workflowDatasetIds(node.group.workflow, ids)
  }
  return ids
}

export function ProjectFileBar({ windowRef }: Props = {}) {
  const win = windowRef ?? window
  const workflow = useWorkflowStore((s) => s.workflow)
  const annotations = useAnnotationStore((s) => s.annotations)
  const notebook = useNotebookStore((s) => s.markdown)
  const reports = useReportStore((s) => s.reports)
  const projectDatasetRefs = useDataStore((s) => s.projectDatasetRefs)
  const importedDatasets = useDataStore((s) => s.imported)
  const modelArtifacts = useNodeOutputStore((s) => s.modelArtifacts)
  const nodes = workflow.nodes.length
  const workName = workflow.name
  const inputRef = useRef<HTMLInputElement>(null)
  const handleRef = useRef<FileSystemFileHandle | null>(null)
  const stampRef = useRef<FileStamp | null>(null)
  const basePersistenceFingerprintRef = useRef<string | null>(null)
  const changeVersionRef = useRef(0)
  const hasUnsavedChangesRef = useRef(false)
  const loadInFlightRef = useRef(false)
  const saveInFlightRef = useRef(false)
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const saveTimerRef = useRef<number | null>(null)
  const dirtyCheckTimerRef = useRef<number | null>(null)
  const [report, setReport] = useState<{
    title: string
    lines: string[]
    canUndo?: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)
  /**
   * 句柄在手上、但浏览器还没给写权限。这一格存在就意味着：自动保存与 Agent 的报告
   * 一个字都写不回去，而**只有一次真实点击**能把授权框叫出来。
   */
  const [needsWritePermission, setNeedsWritePermission] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [openedName, setOpenedName] = useState<string | null>(null)
  /** 自动跟进之后的一句交代。它替代弹窗：做了什么都写在工具条上，不打断人 */
  const [autoNote, setAutoNote] = useState<string | null>(null)

  const supportsHandles = typeof win.showOpenFilePicker === 'function'

  const updateUnsavedState = (unsaved: boolean) => {
    hasUnsavedChangesRef.current = unsaved
    setHasUnsavedChanges(unsaved)
  }

  /** 与最近一次成功打开/保存的工程比对；异步结果过期时不覆盖更新状态。 */
  const reconcileUnsavedState = () => {
    const baseline = basePersistenceFingerprintRef.current
    if (!baseline) return
    const version = changeVersionRef.current
    void buildProjectFromStores()
      .then(projectPersistenceFingerprint)
      .then((fingerprint) => {
        if (version !== changeVersionRef.current || baseline !== basePersistenceFingerprintRef.current) return
        updateUnsavedState(fingerprint !== baseline)
      })
      .catch(() => {
        if (version === changeVersionRef.current && baseline === basePersistenceFingerprintRef.current) {
          updateUnsavedState(true)
        }
      })
  }

  const scheduleUnsavedCheck = () => {
    if (dirtyCheckTimerRef.current !== null) win.clearTimeout(dirtyCheckTimerRef.current)
    dirtyCheckTimerRef.current = win.setTimeout(() => {
      dirtyCheckTimerRef.current = null
      reconcileUnsavedState()
    }, 120)
  }

  /** 持久化相关 store 一变化就先同步标脏，避免关闭页与异步指纹计算竞态。 */
  const noteProjectChange = () => {
    if (loadInFlightRef.current) return
    changeVersionRef.current += 1
    updateUnsavedState(true)
    scheduleUnsavedCheck()
  }

  const setSavedBaseline = (fingerprint: string) => {
    basePersistenceFingerprintRef.current = fingerprint
    if (dirtyCheckTimerRef.current !== null) {
      win.clearTimeout(dirtyCheckTimerRef.current)
      dirtyCheckTimerRef.current = null
    }
    reconcileUnsavedState()
  }

  useEffect(() => {
    const onNewLiveDraft = () => {
      if (saveTimerRef.current !== null) {
        win.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (dirtyCheckTimerRef.current !== null) {
        win.clearTimeout(dirtyCheckTimerRef.current)
        dirtyCheckTimerRef.current = null
      }
      handleRef.current = null
      stampRef.current = null
      basePersistenceFingerprintRef.current = null
      setOpenedName(null)
      setDiskChanged(false)
      setNeedsWritePermission(false)
      setAutoNote('已创建未保存的新画布；保存时会下载为新的工程文件')
    }
    win.addEventListener('sciviz-live-new-draft', onNewLiveDraft)
    const onWorkflow = (state: ReturnType<typeof useWorkflowStore.getState>, previous: ReturnType<typeof useWorkflowStore.getState>) => {
      if (state.workflow !== previous.workflow) noteProjectChange()
    }
    const onAnnotations = (state: ReturnType<typeof useAnnotationStore.getState>, previous: ReturnType<typeof useAnnotationStore.getState>) => {
      if (state.annotations !== previous.annotations) noteProjectChange()
    }
    const onNotebook = (state: ReturnType<typeof useNotebookStore.getState>, previous: ReturnType<typeof useNotebookStore.getState>) => {
      if (state.markdown !== previous.markdown) noteProjectChange()
    }
    const onReports = (state: ReturnType<typeof useReportStore.getState>, previous: ReturnType<typeof useReportStore.getState>) => {
      if (state.reports !== previous.reports) noteProjectChange()
    }
    const onData = (state: ReturnType<typeof useDataStore.getState>, previous: ReturnType<typeof useDataStore.getState>) => {
      if (state.projectDatasetRefs !== previous.projectDatasetRefs) {
        noteProjectChange()
        return
      }
      const referenced = workflowDatasetIds(useWorkflowStore.getState().workflow)
      const relevantIds = new Set<string>()
      for (const id of referenced) {
        relevantIds.add(id)
        if (state.datasetBindings[id]) relevantIds.add(state.datasetBindings[id])
        if (previous.datasetBindings[id]) relevantIds.add(previous.datasetBindings[id])
        if (state.datasetBindings[id] !== previous.datasetBindings[id]) {
          noteProjectChange()
          return
        }
      }
      const before = new Map(previous.imported.map((dataset) => [dataset.id, dataset]))
      const after = new Map(state.imported.map((dataset) => [dataset.id, dataset]))
      const changedIds = new Set([...before.keys(), ...after.keys()])
      if ([...changedIds].some((id) => before.get(id) !== after.get(id) && relevantIds.has(id))) {
        noteProjectChange()
      }
    }
    const onArtifacts = (state: ReturnType<typeof useNodeOutputStore.getState>, previous: ReturnType<typeof useNodeOutputStore.getState>) => {
      if (state.modelArtifacts !== previous.modelArtifacts) noteProjectChange()
    }
    const unsubs = [
      useWorkflowStore.subscribe(onWorkflow),
      useAnnotationStore.subscribe(onAnnotations),
      useNotebookStore.subscribe(onNotebook),
      useReportStore.subscribe(onReports),
      useDataStore.subscribe(onData),
      useNodeOutputStore.subscribe(onArtifacts),
    ]
    return () => {
      win.removeEventListener('sciviz-live-new-draft', onNewLiveDraft)
      unsubs.forEach((unsubscribe) => unsubscribe())
      if (dirtyCheckTimerRef.current !== null) win.clearTimeout(dirtyCheckTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Browsers show their own generic “leave / stay” dialog here. Custom buttons and
      // asynchronous saves are not supported during page teardown.
      if (!hasUnsavedChangesRef.current && saveTimerRef.current === null && !saveInFlightRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    win.addEventListener('beforeunload', onBeforeUnload)
    return () => win.removeEventListener('beforeunload', onBeforeUnload)
  }, [win])

  useEffect(() => {
    const projectId = activeProjectId()
    if (useReportStore.getState().projectId !== projectId) {
      useReportStore.getState().setAll(projectId, [])
    }
    void restorePendingProjectReports(projectId)
      .then((state) => {
        if (state === 'restored') noteProjectChange()
        if (state === 'conflict') setAutoNote('本地有尚未写入工程的报告草稿，且工程报告已变化；已保留磁盘版本，请先检查再保存')
      })
      .catch((error: unknown) => setAutoNote(`报告草稿恢复失败：${String(error)}`))
  }, [])

  // 新建的空白工程以首次渲染状态为基线；若计算期间已有真实编辑，则不把编辑吞进基线。
  useEffect(() => {
    if (basePersistenceFingerprintRef.current) return
    const version = changeVersionRef.current
    void buildProjectFromStores()
      .then(projectPersistenceFingerprint)
      .then((fingerprint) => {
        if (basePersistenceFingerprintRef.current || version !== changeVersionRef.current) return
        basePersistenceFingerprintRef.current = fingerprint
        updateUnsavedState(false)
      })
      .catch(() => {
        // 没有可用基线时，后续任何持久化修改都保守地提示用户保存。
      })
  }, [])

  const download = (name: string, text: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const remember = async (handle: FileSystemFileHandle) => {
    handleRef.current = handle
    try {
      const f = await handle.getFile()
      stampRef.current = { lastModified: f.lastModified, size: f.size }
    } catch {
      stampRef.current = null
    }
  }

  /**
   * 在**这一次点击**里申请该文件的写权限。
   *
   * 浏览器的规矩是：授权框只在用户手势里弹得出来。所以这件事必须在人点东西的那一刻做，
   * 不能等到自动保存或 Agent 写报告的时候再申请 —— 那时候没有点击，申请一定拿不到 granted，
   * 症状就是"工程打开了、报告却写不回去"，而报错还得靠猜（见 docs/开发日志.md 2026-09-27）。
   */
  const grantWritePermission = async (): Promise<boolean> => {
    const handle = handleRef.current
    if (!handle?.requestPermission) return false
    try {
      if (await handle.queryPermission?.({ mode: 'readwrite' }) === 'granted') {
        setNeedsWritePermission(false)
        return true
      }
      const asked = await handle.requestPermission({ mode: 'readwrite' })
      if (asked !== 'granted') return false
      setNeedsWritePermission(false)
      return true
    } catch (error) {
      setAutoNote(`写权限申请失败：${describeWriteError(error)}`)
      return false
    }
  }

  /**
   * 把手里的文本写回句柄指向的那个文件。写不动时把**原因**带回去，交回退路径。
   *
   * 四种失败各有各的修法（没打开文件 / 没授权 / 磁盘更新了 / 写入被拒），
   * 所以这里不再合并成一个 `false`。
   */
  const writeBack = async (text: string): Promise<ProjectWriteOutcome> => {
    const prior = writeQueueRef.current
    let release!: () => void
    writeQueueRef.current = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
    const handle = handleRef.current
    if (!handle || !supportsHandles) return { ok: false, reason: 'no-handle' }
    try {
      const permission = await handle.queryPermission?.({ mode: 'readwrite' })
      if (permission !== 'granted') {
        const asked = await handle.requestPermission?.({ mode: 'readwrite' })
        // 走到这里说明"这一次调用"没能把授权拿到手（多半是没有用户手势）。
        // 工具条上那个「允许写回」按钮就是给人补这一次点击用的。
        if (asked !== 'granted') {
          setNeedsWritePermission(true)
          return { ok: false, reason: 'permission' }
        }
      }
      // 写之前再读一次：自动保存绝不能把外部编辑器或 agent 的新文件静默覆盖。
      const before = await handle.getFile()
      const beforeStamp = { lastModified: before.lastModified, size: before.size }
      if (isDiskNewer(stampRef.current, beforeStamp)) {
        setDiskChanged(true)
        return { ok: false, reason: 'disk-changed' }
      }
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      // 自己写过之后要把时间戳更新掉，否则下次聚焦会把自己写的当成"别人改的"
      const f = await handle.getFile()
      stampRef.current = { lastModified: f.lastModified, size: f.size }
      setDiskChanged(false)
      setNeedsWritePermission(false)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'write-error', detail: describeWriteError(error) }
    }
    } finally {
      release()
    }
  }

  /**
   * 供"没有点击的调用方"（报告写回、自动保存）使用的同一个函数。
   * 注册进 store 的闭包会跨渲染活着，所以走 ref 拿最新那一版。
   */
  const writeBackRef = useRef<(text: string) => Promise<ProjectWriteOutcome>>(writeBack)
  writeBackRef.current = writeBack
  const diskChangedRef = useRef(diskChanged)
  diskChangedRef.current = diskChanged

  // task_checkpoint.finish needs a durable answer before it can mark a task complete.
  // Use the same conflict-checked handle as the toolbar, and serialize with autosave.
  useEffect(() => {
    registerReportProjectWriter(async (projectId) => {
      if (projectId !== activeProjectId()) throw new Error('报告所属工程已切换，无法写入原工程文件')
      if (!supportsHandles || !handleRef.current) return { ok: false, reason: 'no-handle' }
      // 读 ref 而不是闭包里的 state：这个闭包注册一次会用很久，跨了几次渲染之后
      // 它手里的 diskChanged 可能已经过期（真机上的失败就是这么解释错的）。
      if (diskChangedRef.current) return { ok: false, reason: 'disk-changed' }
      while (saveInFlightRef.current) await new Promise((resolve) => win.setTimeout(resolve, 30))
      saveInFlightRef.current = true
      try {
        const project = await buildProjectFromStores()
        const fingerprint = await projectPersistenceFingerprint(project)
        const outcome = await writeBackRef.current(projectToText(project))
        if (!outcome.ok) return outcome
        setSavedBaseline(fingerprint)
        setAutoNote(`报告已写入「${openedName ?? '工程文件'}」`)
        return outcome
      } finally {
        saveInFlightRef.current = false
      }
    })
    return () => registerReportProjectWriter(null)
  }, [supportsHandles, diskChanged, openedName, win])

  /**
   * `quiet` 是给"自动跟进磁盘"用的：那条路上不该再弹一个"已打开 xxx"的模态 ——
   * 用户等的是画布自己变新，不是等他点一下「知道了」。
   */
  const loadText = async (text: string, name: string, quiet = false) => {
    loadInFlightRef.current = true
    setOpenedName(name)
    /*
     * 文件名一起交给身份判定：文件里没有 `projectId` 的旧工程（用户那份 `最终.sciviz` 就是）
     * 由文件名派生出**稳定**身份。不给它，每次打开都是一个新的工程身份，
     * 症状是"重开工程，对话记录又是空白"。
     */
    const result = applyProjectText(text, `wf-${Date.now().toString(36)}`, { fileKey: name })
    if (result.ok && result.report?.project) {
      // 文件名是用户打开的工程名。把它写回根图后，顶栏、保存文本与 Agent 上下文
      // 都继续读同一处，不再让旧文件里的「未命名工作流」冒充当前工程。
      const openedProjectName = projectNameFromFileKey(name)
      if (openedProjectName) useWorkflowStore.getState().renameWorkflow(openedProjectName)
      // 以应用到本机 store 后的工程取基线：数据集可能按身份重绑定，直接对比文件里的旧 id
      // 会把一次正常打开误判成“画布有未保存改动”。
      const current = await buildProjectFromStores()
      changeVersionRef.current += 1
      if (dirtyCheckTimerRef.current !== null) {
        win.clearTimeout(dirtyCheckTimerRef.current)
        dirtyCheckTimerRef.current = null
      }
      basePersistenceFingerprintRef.current = await projectPersistenceFingerprint(current)
      updateUnsavedState(false)
      setDiskChanged(false)
      try {
        const pending = await restorePendingProjectReports(activeProjectId())
        if (pending === 'restored') {
          changeVersionRef.current += 1
          updateUnsavedState(true)
          result.report.lines.push('本机有尚未写入文件的报告草稿，已恢复；请保存工程')
        } else if (pending === 'conflict') {
          result.report.lines.push('本机报告草稿与这份文件的报告内容不同，已保留文件版本且未覆盖；请先核对')
        }
      } catch (error) {
        result.report.lines.push(`报告草稿检查失败：${String(error)}`)
      }
    }
    if (quiet) {
      setAutoNote(result.ok
        ? `磁盘上的「${name}」比你手上这份新，已自动跟进（${result.report?.lines[0] ?? '工程已载入'}）`
        : `自动跟进失败：${result.error ?? '解析失败'} —— 请用「打开工程」手动载入`)
      setReport(null)
      loadInFlightRef.current = false
      return
    }
    setReport(
      result.ok && result.report
        ? {
            title: `已打开 ${name}`,
            lines: result.report.lines,
            canUndo: result.report.patchCount > 0,
          }
        : { title: `打不开 ${name}`, lines: [result.error ?? '解析失败'] },
    )
    loadInFlightRef.current = false
  }

  const handleOpen = async () => {
    if (!confirmDiscardReportDraft()) return
    setAutoNote(null)
    setBusy(true)
    try {
      // 取成局部变量再判：TS 不会顺着 supportsHandles 这个布尔量去窄化 win 上的可选成员
      const picker = win.showOpenFilePicker
      if (!picker) {
        inputRef.current?.click()
        return
      }
      const [handle] = await picker.call(win, {
        types: [
          {
            description: 'SciViz 工程',
            accept: { 'application/x-sciviz': ['.sciviz', '.yaml', '.yml', '.txt'] },
          },
        ],
      })
      await remember(handle)
      /*
       * 打开时就顺手把写权限要下来 —— 授权框只在"人点东西"的那一刻能弹出来，
       * 而自动保存与 Agent 写报告那条路上没有点击。等到那时候再申请已经晚了：
       * 报告会以"写回失败"收场，界面上还看不出是权限问题（见 docs/开发日志.md 2026-09-27）。
       */
      if (!await grantWritePermission()) {
        setNeedsWritePermission(true)
        setAutoNote('这份工程文件现在只有读权限：Agent 的报告与自动保存都写不回去。点工具条上的「允许写回」授权一次即可')
      }
      const file = await handle.getFile()
      await loadText(await file.text(), file.name)
    } catch (err) {
      // 用户按取消不是错误
      if ((err as Error)?.name === 'AbortError') return
      setReport({ title: '打开失败', lines: [String((err as Error)?.message ?? err)] })
    } finally {
      setBusy(false)
    }
  }

  /** 文件被别处改过之后，重新读一遍。会覆盖画布 —— 这是"以磁盘为准" */
  const handleReload = async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (quiet && hasDirtyReportDraft()) { setDiskChanged(true); return }
    if (!quiet && !confirmDiscardReportDraft()) return
    const handle = handleRef.current
    if (!handle) return
    if (!quiet) setBusy(true)
    try {
      const file = await handle.getFile()
      await remember(handle)
      setDiskChanged(false)
      await loadText(await file.text(), file.name, quiet)
    } catch (err) {
      if (quiet) setAutoNote(`自动跟进失败：${String((err as Error)?.message ?? err)}`)
      else setReport({ title: '重新载入失败', lines: [String((err as Error)?.message ?? err)] })
    } finally {
      if (!quiet) setBusy(false)
    }
  }

  const handleSave = async () => {
    setAutoNote(null)
    setBusy(true)
    try {
      const text = await projectTextFromStores()
      const project = await buildProjectFromStores()
      const persistenceFingerprint = await projectPersistenceFingerprint(project)
      const safe = workName.replace(/[\\/:*?"<>|]/g, '_') || 'project'

      // 首选写回原文件：人不必每次重新选、也不必手动覆盖
      const outcome = await writeBack(text)
      if (outcome.ok) {
        setSavedBaseline(persistenceFingerprint)
        await clearPendingProjectReports(activeProjectId(), project.reports)
        setReport({
          title: `已写回 ${openedName ?? '工程文件'}`,
          lines: [`${nodes} 个节点`, '磁盘上这份就是当前画布，agent 可以直接接着改。'],
        })
        return
      }
      // 没写成的都要说清是哪一种：从前这里只会往下掉进"另存为/下载"，人看不出为什么。
      if (outcome.reason !== 'no-handle') setAutoNote(`写回原文件未完成：${reportWriteFailureText(outcome, 'brief')}`)

      // 还没有句柄、但浏览器支持：这一次让你选一个文件，之后就记住了
      const saver = win.showSaveFilePicker
      if (saver) {
        const handle = await saver.call(win, {
          suggestedName: `${safe}.sciviz`,
          types: [{ description: 'SciViz 工程', accept: { 'application/x-sciviz': ['.sciviz'] } }],
        })
        await remember(handle)
        const savedProjectName = projectNameFromFileKey(handle.name)
        if (savedProjectName) useWorkflowStore.getState().renameWorkflow(savedProjectName)
        const namedText = savedProjectName ? await projectTextFromStores() : text
        const namedProject = savedProjectName ? await buildProjectFromStores() : project
        const namedFingerprint = savedProjectName
          ? await projectPersistenceFingerprint(namedProject)
          : persistenceFingerprint
        const namedOutcome = await writeBack(namedText)
        if (namedOutcome.ok) {
          setSavedBaseline(namedFingerprint)
          await clearPendingProjectReports(activeProjectId(), namedProject.reports)
          setReport({
            title: `已保存 ${handle.name}`,
            lines: [`${nodes} 个节点`, '下次点「保存工程」会直接写回这个文件。'],
          })
          return
        }
        if (namedOutcome.reason !== 'no-handle') {
          setAutoNote(`写回未完成：${reportWriteFailureText(namedOutcome, 'brief')}`)
        }
      }

      // 回退：下载一份
      download(`${safe}.sciviz`, text)
      setSavedBaseline(persistenceFingerprint)
      setReport({
        title: '已导出工程文件',
        lines: [
          `${nodes} 个节点`,
          '数据本身不在这个文件里 —— 它记的是身份（内容哈希）与列视图。',
          '把这个文件交给 agent，它就能接着改；改完你再用「打开工程」读回来。',
        ],
      })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setReport({ title: '保存失败', lines: [String((err as Error)?.message ?? err)] })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 工具条上的「允许写回」：一次点击补上浏览器要的那次手势，然后把
   * 手里这份（画布 + 报告草稿）写回文件。
   *
   * 没有它，症状就只能是"报告写回失败"，而唯一的补救是让人碰巧去点一次「保存工程」。
   */
  const allowWriteBack = async () => {
    setAutoNote(null)
    setBusy(true)
    try {
      if (!handleRef.current) {
        setAutoNote('还没有打开工程文件：点「保存工程」选一个文件，报告与画布就会一起写出去')
        return
      }
      if (!await grantWritePermission()) {
        setAutoNote('浏览器没有授予写权限：授权框里点「允许」；没有弹框时，先关掉可能占用这个文件的程序再点一次')
        return
      }
      await handleSave()
    } finally {
      setBusy(false)
    }
  }

  const handleUndo = async () => {
    if (!confirmDiscardReportDraft()) return
    setAutoNote(null)
    setBusy(true)
    try {
      const undone = await undoLastPatch()
      if (!undone.ok || !undone.text) {
        setReport({ title: '撤销失败', lines: [undone.error ?? '未知原因'] })
        return
      }
      const outcome = await writeBack(undone.text)
      const wrote = outcome.ok
      if (!wrote) {
        const safe = workName.replace(/[\\/:*?"<>|]/g, '_') || 'project'
        download(`${safe}.sciviz`, undone.text)
      }
      if (!outcome.ok && outcome.reason !== 'no-handle') {
        setAutoNote(`撤销没能写回原文件：${reportWriteFailureText(outcome, 'brief')}；已导出一份`)
      }
      const project = await buildProjectFromStores()
      setSavedBaseline(await projectPersistenceFingerprint(project))
      setReport({
        title: '已撤销最近一次改动',
        lines: [
          ...(undone.changes ?? []).map((c) => `撤销：${c}`),
          wrote
            ? '已写回文件，画布与磁盘一致。'
            : '浏览器不让就地写，已经下载了一份 —— 用它覆盖原来的文件，免得画布与文件不一致。',
        ],
      })
    } finally {
      setBusy(false)
    }
  }

  /*
   * 窗口重新聚焦时看一眼磁盘：文件可能被 agent 改过了。
   *
   * 两条路，判据是"画布上有没有还没落盘的活"：
   * - 没有 → **自动跟进**，人不必点任何东西（2026-09-22 起）；
   * - 有 → 只挂角标等人决定。「以磁盘为准」在自己也改过的时候就是丢数据的同义词，
   *   所以这一条不许自动。
   *
   * 判"有没有活"比的是完整持久化指纹，而不是逐字比工程文本：文本出栈时会规范化（字段顺序、默认值、
   * 缩进），逐字比必然判成"有活"。数据集重绑定由 `applyProjectText` 统一处理，指纹仍以当前工程 IR 为准。
   */
  useEffect(() => {
    if (!supportsHandles) return
    const onFocus = async () => {
      const handle = handleRef.current
      if (!handle) return
      try {
        const f = await handle.getFile()
        if (!isDiskNewer(stampRef.current, { lastModified: f.lastModified, size: f.size })) return
        const text = await f.text()
        const parsed = textToProject(text, projectFilePortContext, 'disk')
        if (!parsed.project) {
          setDiskChanged(true)
          return
        }
        const canvas = await buildProjectFromStores()
        const diskFingerprint = await projectPersistenceFingerprint(parsed.project)
        const canvasFingerprint = await projectPersistenceFingerprint(canvas)
        if (!hasDirtyReportDraft() && (basePersistenceFingerprintRef.current === canvasFingerprint || diskFingerprint === canvasFingerprint)) {
          await handleReload({ quiet: true })
        } else setDiskChanged(true)
      } catch {
        /* 读不到就算了：提示重载比误报更烦人 */
      }
    }
    win.addEventListener('focus', onFocus)
    return () => win.removeEventListener('focus', onFocus)
  }, [supportsHandles, win])

  /** 画布、批注、笔记或数据视图变化后，静默写回已打开的工程文件。 */
  useEffect(() => {
    if (!supportsHandles || !handleRef.current || loadInFlightRef.current || diskChanged) return
    if (saveTimerRef.current !== null) win.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = win.setTimeout(() => {
      saveTimerRef.current = null
      if (saveInFlightRef.current || loadInFlightRef.current || diskChanged || !handleRef.current) return
      saveInFlightRef.current = true
      void (async () => {
        try {
          const project = await buildProjectFromStores()
          const fingerprint = await projectPersistenceFingerprint(project)
          if (fingerprint === basePersistenceFingerprintRef.current) return
          const text = projectToText(project)
          const outcome = await writeBack(text)
          if (outcome.ok) {
            setSavedBaseline(fingerprint)
            await clearPendingProjectReports(activeProjectId(), project.reports)
            setAutoNote(`已自动保存「${openedName ?? '工程文件'}」`)
          } else if (outcome.reason !== 'no-handle') {
            // 从前这里把四种原因写成一句"权限或磁盘"，于是真正的原因（多半是没授权）没人看得出来。
            setAutoNote(`自动保存未完成：${reportWriteFailureText(outcome, 'brief')}`)
          }
        } catch (error) {
          setAutoNote(`自动保存未完成：${String(error)}`)
        } finally {
          saveInFlightRef.current = false
        }
      })()
    }, 450)
    return () => {
      if (saveTimerRef.current !== null) {
        win.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [annotations, notebook, reports, projectDatasetRefs, importedDatasets, modelArtifacts, workflow, diskChanged, supportsHandles, win, openedName])

  return (
    <>
      <button disabled={busy} onClick={() => void handleOpen()} title="打开一份 .sciviz 工程文件（agent 改过的那份也是它）">
        打开工程
      </button>
      <button
        disabled={busy}
        onClick={() => void handleSave()}
        title={supportsHandles ? '写回这个标签页打开的文件' : '导出 .sciviz，交给 agent 接着做'}
      >
        保存工程
      </button>
      {hasUnsavedChanges && (
        <button
          type="button"
          className="file-change-badge err"
          disabled={busy}
          onClick={() => void handleSave()}
          title="当前工程有尚未写入文件的修改；离开页面前可先保存"
        >
          有未保存的修改 · 保存
        </button>
      )}

      {/*
       * 写权限只能在点击里申请，所以"打不开写回"这件事必须有一个明确的人工入口。
       * 自动保存与 Agent 的报告写回都在这条路之外，它们只会静静地失败。
       */}
      {needsWritePermission && (
        <button
          type="button"
          className="file-change-badge err"
          disabled={busy}
          onClick={() => void allowWriteBack()}
          title="浏览器还没给这个工程文件的写权限：Agent 的报告与自动保存都写不回去。点一下授权，随后把画布与报告一起写回"
        >
          允许写回
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".sciviz,.yaml,.yml,.txt"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void f.text().then((t) => loadText(t, f.name))
        }}
      />

      {diskChanged && (
        <button
          className="file-change-badge err"
          disabled={busy}
          onClick={() => { setAutoNote(null); void handleReload() }}
          title="磁盘上的这份文件在别处被改过（可能是 agent 刚改的），而画布上也有你还没落盘的改动 —— 所以这次不自动跟进，由你决定"
        >
          文件被改过了 · 重新载入
        </button>
      )}

      {/* 自动跟进过之后的一句交代：换了什么，一句话说清，不弹窗 */}
      {autoNote && (
        <button
          className="file-change-badge"
          onClick={() => setAutoNote(null)}
          title="点一下收起这条说明"
        >
          {autoNote}
        </button>
      )}

      {report && (
        <div className="modal-mask" onClick={() => setReport(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">{report.title}</div>
            <div className="modal-body">
              <ul>
                {report.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
            <div className="modal-foot">
              {report.canUndo && (
                <button disabled={busy} onClick={() => void handleUndo()}>
                  撤销这次改动
                </button>
              )}
              <button className="primary" onClick={() => setReport(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
