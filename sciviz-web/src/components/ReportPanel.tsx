import { useEffect, useMemo, useState } from 'react'
import {
  createProjectReport,
  deleteProjectReport,
  downloadProjectReport,
  updateProjectReport,
  useReportStore,
} from '../store/useReportStore'
import { useCanvasFocusStore } from '../store/useCanvasFocusStore'
import { useEditingWorkflow } from '../store/useWorkflowStore'
import { notebookOutline, renderNotebook } from '../workflow/notebook'
import { registerReportDraftGuard } from '../store/reportDraftGuard'

/** Project reports are named, local Markdown documents in the same .sciviz file as the graph. */
export function ReportPanel() {
  const projectId = useReportStore((state) => state.projectId)
  const reports = useReportStore((state) => state.reports)
  const selectedReportId = useReportStore((state) => state.selectedReportId)
  const selectReport = useReportStore((state) => state.selectReport)
  const workflow = useEditingWorkflow()
  const setFocusedNodeId = useCanvasFocusStore((state) => state.setFocusedNodeId)
  const selected = reports.find((report) => report.id === selectedReportId) ?? null
  const [draft, setDraft] = useState({ id: '', title: '', markdown: '', baseUpdatedAt: '' })
  const [editorDirty, setEditorDirty] = useState(false)
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const dirty = selected !== null && draft.id === selected.id && editorDirty
  const stale = dirty && draft.baseUpdatedAt !== selected?.updatedAt

  useEffect(() => {
    registerReportDraftGuard(() => dirty)
    return () => registerReportDraftGuard(null)
  }, [dirty])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!selected) {
      setDraft({ id: '', title: '', markdown: '', baseUpdatedAt: '' })
      setEditorDirty(false)
      return
    }
    if (editorDirty && draft.id === selected.id) {
      if (draft.baseUpdatedAt !== selected.updatedAt) {
        setNotice('Agent 或其他窗口更新了这份报告；你的编辑仍在，先核对最新版本再继续')
      }
      return
    }
    setDraft({ id: selected.id, title: selected.title, markdown: selected.markdown, baseUpdatedAt: selected.updatedAt })
    setEditorDirty(false)
    /*
     * 依赖的是**报告对象本身**，不是 `id + updatedAt`：重开工程、重新载入磁盘上的文件、
     * 或别的窗口改写同一份报告时，正文可能变了而时间戳没变（时间戳是上一次保存那一刻写的）。
     * 只认时间戳的话，界面会一直显示旧正文 —— 而文件里已经是新的了，"第二处真相"就是这么来的。
     * 有未保存编辑时上面那段会把人的改动留住并给出提示，不会拿新版本把编辑冲掉。
     */
  }, [projectId, selected])

  const labelOf = useMemo(() => {
    const byId = new Map(workflow.nodes.map((node) => [node.id, node.label]))
    return (id: string) => byId.get(id) ?? null
  }, [workflow.nodes])
  const preview = useMemo(() => renderNotebook(draft.markdown, labelOf), [draft.markdown, labelOf])
  const outline = useMemo(() => notebookOutline(draft.markdown), [draft.markdown])

  const save = async (): Promise<boolean> => {
    if (!projectId || !selected || draft.id !== selected.id || !dirty) return true
    if (stale) {
      setNotice('这份报告已被更新；请先查看最新版本，当前编辑不会自动覆盖它')
      return false
    }
    setBusy(true)
    setNotice(null)
    try {
      const result = await updateProjectReport(projectId, selected.id, {
        title: draft.title.trim(),
        markdown: draft.markdown,
      }, draft.baseUpdatedAt)
      setEditorDirty(false)
      setNotice(result.projectFileSaved ? '已写入工程文件' : '已保存在本机草稿；请点顶栏「保存工程」导出 .sciviz')
      return true
    } catch (error) {
      setNotice(`报告未保存：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  const open = async (id: string) => {
    if (dirty && !await save()) return
    selectReport(id)
    setMode('preview')
    setNotice(null)
  }

  const create = async () => {
    if (!projectId || (dirty && !await save())) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await createProjectReport(projectId)
      selectReport(result.reportId)
      setMode('edit')
      setNotice(result.projectFileSaved ? '新报告已写入工程文件' : '新报告已保存在本机草稿')
    } catch (error) {
      setNotice(`新建失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!projectId || !selected) return
    if (dirty && !await save()) return
    if (!window.confirm(`删除报告「${selected.title}」？此操作会从工程中移除这份报告。`)) return
    setBusy(true)
    setNotice(null)
    try {
      const result = await deleteProjectReport(projectId, selected.id)
      setNotice(result.projectFileSaved ? '报告已从工程文件移除' : '删除已存入本机草稿；请保存工程')
    } catch (error) {
      setNotice(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const onPreviewClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const id = (target.closest('button.nb-node') as HTMLElement | null)?.dataset.node
    if (id) setFocusedNodeId(id)
  }

  return (
    <section className="nb-panel report-panel" aria-label="项目报告">
      <div className="report-panel-head">
        <strong>项目报告</strong>
        <span>{reports.length} 份 · 随工程保存</span>
        <button type="button" className="nb-btn" onClick={() => void create()} disabled={busy || !projectId}>新建</button>
      </div>
      <div className="report-list" aria-label="报告列表">
        {reports.length === 0 && <span className="report-empty">当前项目还没有报告。Agent 完成任务后会把报告放在这里。</span>}
        {reports.map((report) => (
          <button
            type="button"
            key={report.id}
            className={report.id === selectedReportId ? 'active' : ''}
            onClick={() => void open(report.id)}
            title={report.title}
          >
            <strong>{report.title}</strong>
            <small>{report.source ? 'Agent 实验' : '手写报告'} · {report.updatedAt ? new Date(report.updatedAt).toLocaleString('zh-CN') : '旧报告'}</small>
          </button>
        ))}
      </div>
      {selected && draft.id === selected.id && (
        <>
          <div className="report-actions">
            <div className="nb-seg">
              <button type="button" className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>预览</button>
              <button type="button" className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>编辑</button>
            </div>
            <button type="button" className="nb-btn" onClick={() => void save()} disabled={busy || !dirty}>保存修改</button>
            <button type="button" className="nb-btn" onClick={() => downloadProjectReport(selected.id)} disabled={dirty}>下载 MD</button>
            <button type="button" className="nb-btn danger" onClick={() => void remove()} disabled={busy}>删除</button>
            {stale && <button type="button" className="nb-btn" onClick={() => {
              setDraft({ id: selected.id, title: selected.title, markdown: selected.markdown, baseUpdatedAt: selected.updatedAt })
              setEditorDirty(false)
              setNotice('已载入最新报告版本')
            }}>放弃编辑并载入新版</button>}
          </div>
          {mode === 'edit' && (
            <input
              className="report-title-input"
              aria-label="报告标题"
              value={draft.title}
              onChange={(event) => { setDraft((old) => ({ ...old, title: event.target.value })); setEditorDirty(true) }}
            />
          )}
          {outline.length > 0 && mode === 'preview' && (
            <div className="report-outline">
              {outline.map((item) => <span key={`${item.offset}-${item.title}`}>{item.title}</span>)}
            </div>
          )}
          {mode === 'edit' ? (
            <textarea
              className="nb-editor"
              aria-label="报告 Markdown 正文"
              value={draft.markdown}
              onChange={(event) => { setDraft((old) => ({ ...old, markdown: event.target.value })); setEditorDirty(true) }}
              spellCheck={false}
            />
          ) : (
            <div className="nb-preview report-preview" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: preview }} />
          )}
        </>
      )}
      {notice && <div className="nb-notice" role="status">{notice}</div>}
    </section>
  )
}
