import { useWorkflowStore } from './useWorkflowStore'
import { useAnnotationStore } from './useAnnotationStore'
import { useNotebookStore } from './useNotebookStore'
import { useNodeOutputStore } from './nodeOutputStore'
import { suspendCanvasHistory } from './canvasHistory'
import { annotationSummary } from '../workflow/annotations'
import { notebookLength } from '../workflow/notebook'
import { useReportStore } from './useReportStore'
import {
  datasetIdentityOf,
  featuresOf,
  findDatasetByIdentity,
  getStoredDataset,
  hasDataset,
  localDatasetIdFor,
  timeColumnOf,
  useDataStore,
} from './useDataStore'
import { buildDatasetRef } from '../kernel/dataset'
import {
  PROJECT_VERSION,
  projectToText,
  textToProject,
  PATCH_HISTORY_LIMIT,
  type Project,
  type ProjectDatasetRef,
  type ProjectPatchRecord,
} from '../workflow/project'
import type { PortContext } from '../workflow/ports'
import type { Workflow } from '../workflow/types'
import { applyPatch } from '../kernel/patch'
import type { PatchOp } from '../contract/ops'

/**
 * 工程文件 ↔ 界面状态的那一层胶水。
 *
 * 刻意从组件里抽出来放在这里，而不是写在按钮的 onClick 里：这样它能被 `node --test`
 * 直接跑。**"保存人改的、打开 agent 改的"是轮流干活的主干道**，它出错的方式又都是
 * 静默的（视图丢了、列开关没套上、数据认错了），靠手点一遍是验不出来的。
 */

/** 端口上下文：与 YamlDialog 用的是同一套（含按身份认回失效的数据集 id） */
export const projectFilePortContext: PortContext = {
  featuresOf,
  timeColumnOf,
  hasDataset,
  identityOf: datasetIdentityOf,
  findByIdentity: findDatasetByIdentity,
}

/** 磁盘上那份文件的时间戳与大小。用来判断"它有没有被别人动过" */
export interface FileStamp {
  lastModified: number
  size: number
}

/**
 * 磁盘上的文件是不是比我们手里这份新。
 *
 * 判据只有"时间戳或大小变了"。没有事件可听 —— File System Access API 不提供变更通知，
 * 只能在窗口重新获得焦点时主动 `getFile()` 看一眼。所以这个判断要保守：
 * 拿不到就当作没变（提示重载比误报一堆更烦人）。
 */
export function isDiskNewer(known: FileStamp | null, current: FileStamp | null): boolean {
  if (!known || !current) return false
  return current.lastModified !== known.lastModified || current.size !== known.size
}

/**
 * 打开工程时读进来的改动记录。
 *
 * 必须跨"保存"活着：人打开一份 agent 改过的工程、又保存一次之后，
 * 如果历史被抹掉，"撤销那次改动"就再也点不了了。所以它跟着会话走。
 */
let loadedPatches: ProjectPatchRecord[] = []
let currentProjectId: string | undefined

function newProjectId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 浏览器 localStorage 里那一个键；只存寻址用的工程 id，不存任何内容。 */
export const DRAFT_PROJECT_KEY = 'sciviz.draftProjectId'

export interface DraftIdentityStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** FNV-1a 32 位：同步、无依赖 —— 身份派生不能依赖 `crypto.subtle` 那种异步 API。 */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * 由**文件**派生的稳定工程身份：同一份文件每次打开都是同一个 id。
 *
 * 存在理由是一条实测：旧工程文件里没有 `projectId` 时，代码每次打开都当场随机一个 id，
 * 于是"重开工程 → 对话记录空白"，而对话本身一条没丢、全写在互不相认的随机身份下。
 * 拼成 UUID 形状是必须的：文件里那条 `projectId` 的读取校验是严格的 UUID，
 * 派生出来的 id 迟早要写进文件（保存一次就会），不合法就等于把身份写坏。
 */
export function stableProjectId(fileKey: string): string {
  const hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => fnv1a(`${seed}:${fileKey}`, seed).toString(16).padStart(8, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * 打开文件后对人和 agent 展示的工程名。
 *
 * 文件名是用户真正选择的工程身份；文件内容里的旧 `name` 可能还是默认的
 * 「未命名工作流」，也可能是另一份工程留下的名称。统一在打开边界处理一次，后续
 * `workflow.name`、`.sciviz` 顶层 `name` 与 Agent 上下文就不会各说各的。
 */
export function projectNameFromFileKey(fileKey: string): string | undefined {
  const base = fileKey.trim().replace(/^.*[\\/]/, '')
  if (!base) return undefined
  const name = base.replace(/\.(?:sciviz|ya?ml|txt)$/i, '').trim()
  return name || undefined
}

/**
 * 没保存过的工程也要有稳定身份：否则刷新一次就换一个 projectId，
 * 昨天几十条对话全都还躺在磁盘上，却再也认不出属于这份工程。
 */
export function readDraftProjectId(store: DraftIdentityStore | undefined): string | undefined {
  if (!store) return undefined
  try {
    const value = store.getItem(DRAFT_PROJECT_KEY)
    return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

export function rememberDraftProjectId(store: DraftIdentityStore | undefined, id: string): void {
  if (!store) return
  try {
    store.setItem(DRAFT_PROJECT_KEY, id)
  } catch {
    // 隐私模式/配额满：会话仍在磁盘上，只是刷新后要打开工程文件才认回来
  }
}

function browserStorage(): DraftIdentityStore | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/** 对话栏寻址当前工程；尚未保存时也给只读会话一个可审计的临时身份。 */
export function activeProjectId(): string {
  if (currentProjectId) return currentProjectId
  const storage = browserStorage()
  const draft = readDraftProjectId(storage)
  currentProjectId = draft ?? newProjectId()
  if (!draft) rememberDraftProjectId(storage, currentProjectId)
  return currentProjectId
}

/** 这个浏览器之前有没有记过工程身份（用来判断"要不要问一句要不要认领"）。 */
export function hasStoredDraftProjectId(): boolean {
  return readDraftProjectId(browserStorage()) !== undefined
}

/** 工程图可能把数据源藏在复合组块里；收集时与打开时都递归走同一棵图。 */
function datasetIdsInWorkflow(workflow: Workflow, ids = new Set<string>()): Set<string> {
  for (const node of workflow.nodes) {
    if (node.type === 'data.source') {
      const id = String(node.params.datasetId ?? '')
      if (id) ids.add(id)
    }
    if (node.group) datasetIdsInWorkflow(node.group.workflow, ids)
  }
  return ids
}

/**
 * 把当前状态（图 + 每份数据的身份与**视图**）收拾成一份工程。
 *
 * 只收集图里真正引用的数据集：把没用到的东西写进工程，下一个人打开时会困惑
 * "这份数据为什么在这儿"。
 */
export async function buildProjectFromStores(): Promise<Project> {
  const workflow = useWorkflowStore.getState().workflow
  const ids = datasetIdsInWorkflow(workflow)
  const datasets: ProjectDatasetRef[] = []
  for (const id of ids) {
    const stored = getStoredDataset(id)
    if (!stored) continue
    const ref = await buildDatasetRef(stored)
    datasets.push({
      id,
      name: ref.name,
      // 浏览器里拿不到完整路径，只有来源文件名。CLI 按它相对工程文件解析
      path: stored.source,
      contentHash: ref.contentHash,
      rowCount: ref.rowCount,
      timeColumn: ref.timeColumn,
      sampleRate: ref.sampleRate,
      columns: ref.columns.map((c) => ({
        name: c.name,
        type: c.type,
        role: c.role,
        enabled: c.enabled,
      })),
    })
  }
  return {
    version: PROJECT_VERSION,
    projectId: activeProjectId(),
    name: workflow.name,
    description: workflow.description,
    graph: workflow,
    // 批注跟着工程走：换台机器打开，人记的读数还在
    annotations: useAnnotationStore.getState().annotations,
    notebook: useNotebookStore.getState().markdown,
    reports: useReportStore.getState().reports,
    datasets,
    // 制品只序列化工程引用；权重文件仍留在宿主 `.artifacts` 目录
    modelArtifacts: useNodeOutputStore.getState().modelArtifacts,
    environment: {},
    runs: {},
    // 带上读进来的改动记录：否则人一保存，agent 那次改动就再也撤不回去了
    patches: loadedPatches,
  }
}

export function projectTextFromStores(): Promise<string> {
  return buildProjectFromStores().then(projectToText)
}

export interface OpenReport {
  project: Project
  /** 给人看的一行行说明。没有告警时只有规模那一行 */
  lines: string[]
  /** 文件里带着几条待审的改动记录 */
  patchCount: number
  /** 最近一次改动是干什么的 */
  lastPatchReason?: string
}

export interface OpenResult {
  ok: boolean
  error?: string
  report?: OpenReport
}

/**
 * 这份工程的对话身份该用哪个 —— 对话栏设计 §10.1 那张表就这一个实现处。
 *
 * 顺序：**文件里的 `projectId`** > **由文件名派生** > 随机（只给未保存的新工程）。
 * 写成一个纯函数是为了让那张表能被 `node --test` 逐行钉住：任何一行写错，
 * 症状都是"重开工程，对话记录又是空白"，而它在界面上没有任何痕迹。
 *
 * 注意这里**没有**"把身份换成别处的某一份历史"这一档：身份换来换去正是这个缺陷的成因。
 * 散在别的身份下的旧对话由宿主 `chat_store.merge_project` **复制**进当前工程，
 * 身份本身不动（见对话栏设计 §10.1 的认领一节）。
 */
export function resolveProjectIdentity(
  fileProjectId: string | undefined,
  fileKey: string | undefined,
): { projectId: string; derived: boolean } {
  if (fileProjectId) return { projectId: fileProjectId, derived: false }
  if (fileKey) return { projectId: stableProjectId(fileKey), derived: true }
  return { projectId: newProjectId(), derived: false }
}

/**
 * 打开一份工程文本：建图 + 把工程里记的数据视图套到本机已有的数据上。
 *
 * 两件事拿不到就如实说，不假装：数据不在本机时连线原样保留（等导入 CSV 后自己复活）；
 * 时间列不一致时只提示（界面目前不支持改时间列）。
 *
 * `identity.fileKey` 是**这份文件**的稳定键（浏览器只给得到文件名，拿不到路径）。传了它、
 * 文件里又没有 `projectId` 时，本次身份由文件名确定性派生 —— 同一份文件每次打开都是同一个身份。
 * 不传它（撤销、界面写回这类"文本自带身份"的路径）行为与原样一致。
 * `identity.store` 只是给测试注入内存存储用；生产永远走 `localStorage`。
 */
export function applyProjectText(text: string, fallbackId: string, identity: { fileKey?: string; store?: DraftIdentityStore } = {}): OpenResult {
  const parsed = textToProject(text, projectFilePortContext, fallbackId, { preserveDatasetIds: true })
  if (!parsed.project) return { ok: false, error: parsed.error ?? '解析失败' }

  const project = parsed.project
  const storage = identity.store ?? browserStorage()
  const fileKey = identity.fileKey
  /*
   * 身份判定的顺序（与对话栏设计 §10.1 那张表一一对应）：
   * ① 文件里的 `projectId` —— 文件是真相；
   * ② 由文件名派生 —— 旧文件没有身份，也**不许**每次打开随机一个新的（那正是"重开就空白"）；
   * ③ 都没有（未保存的新工程）：随机 id + 草稿键，刷新还在。
   */
  const resolved = resolveProjectIdentity(project.projectId, fileKey)
  currentProjectId = resolved.projectId
  if (!project.projectId) rememberDraftProjectId(storage, currentProjectId)
  // 保存工程里的稳定 ID → 本机随机 ID 绑定。图参数保持原样，避免训练指纹因重开变化。
  useDataStore.getState().setProjectDatasetRefs(project.datasets)
  const missing: string[] = []
  const unmatchedColumns: string[] = []
  const timeNotes: string[] = []
  const reboundDatasets: string[] = []
  const identityWarnings: string[] = []
  const datasetViewLines: string[] = []

  for (const ref of project.datasets) {
    // 工程里的 id 是别处生成的，先按 id、再按身份（名字 + 行数）认回本机那一份
    const localId = localDatasetIdFor(ref.id)
    const stored = getStoredDataset(ref.id)
    if (!stored) {
      missing.push(ref.name)
      continue
    }
    if (localId !== ref.id) reboundDatasets.push(ref.name)
    const exactIdentity = stored.id === ref.id ||
      (stored.name === ref.name && stored.rowCount === ref.rowCount)
    if (!exactIdentity) {
      identityWarnings.push(
        `${ref.name}：本机唯一同名数据的行数与工程记录不同，已绑定以便检查；模型权重仍须通过训练指纹校验`,
      )
    }
    if (ref.columns && ref.columns.length > 0) {
      const localNames = new Set(stored.columns.map((c) => c.name))
      const unknown = ref.columns.filter((c) => !localNames.has(c.name)).map((c) => c.name)
      if (unknown.length) unmatchedColumns.push(`${ref.name}：${unknown.join('、')}`)
      const enabled = ref.columns.filter((c) => c.enabled).map((c) => c.name)
      const disabled = ref.columns.filter((c) => !c.enabled).map((c) => c.name)
      datasetViewLines.push(`数据集「${ref.name}」：按工程里的视图启用 ${enabled.length} 列、关闭 ${disabled.length} 列`)
    }
    if (ref.timeColumn !== undefined && ref.timeColumn !== stored.timeColumn) {
      timeNotes.push(
        `${ref.name}：工程记的是「${ref.timeColumn ?? '无'}」，本机识别出来的是「${stored.timeColumn ?? '无'}」`,
      )
    }
  }

  loadedPatches = project.patches
  // 工程切换后不沿用上一份图的易失节点输出；后续由当前工程自己的制品引用恢复。
  useNodeOutputStore.getState().reset()
  useNodeOutputStore.getState().setModelArtifacts(project.modelArtifacts)
  suspendCanvasHistory(() => {
    useWorkflowStore.getState().setWorkflow(project.graph)
    /*
     * 批注整体替换，而不是合并。
     *
     * 合并听着更"不丢东西"，实际是错的：画布上留着上一份工程的表格，用户会把它当成
     * 这份工程里的数据来读 —— 而这些数字与图里任何一次计算都没有关系，没有任何地方
     * 能提醒他。换工程就清空，是"看到的都是这份工程的"这条底线的代价最小的实现。
     */
    useAnnotationStore.getState().setAll(project.annotations)
    useNotebookStore.getState().setAll(project.notebook)
    useReportStore.getState().setAll(resolved.projectId, project.reports)
  })

  const lines: string[] = [
    `${project.graph.nodes.length} 个节点 · ${project.graph.edges.length} 条连线`,
  ]
  /*
   * 身份这件事必须说出来："我有对话历史吗"取决于它，而用户看不到。
   * 而且这句话本身就是修复的判据 —— 打开同一份文件两次，这里每次都应给出同一个 id。
   */
  if (resolved.derived) {
    lines.push(
      `这份工程文件里没有工程身份，本次按文件名认作 ${currentProjectId?.slice(0, 8)}；` +
        '下次保存会把完整身份写进文件，之后换机器也认得出',
    )
  }
  if (project.modelArtifacts.length > 0) {
    lines.push(`${project.modelArtifacts.length} 条模型制品引用；打开工程后本机宿主会自动按训练指纹与校验值恢复`)
  }
  if (project.annotations.length > 0) {
    const brief = project.annotations.slice(0, 4).map(annotationSummary).join('；')
    lines.push(
      `✎ 画布上有 ${project.annotations.length} 条批注：${brief}` +
        (project.annotations.length > 4 ? '…' : ''),
    )
  }
  if (project.notebook.trim()) {
    lines.push(`✎ 实验笔记 ${notebookLength(project.notebook)} 字（右侧「实验笔记」栏）`)
  }
  if (project.reports.length > 0) {
    lines.push(`▤ 项目报告 ${project.reports.length} 份（右侧「项目报告」栏）`)
  }
  if (reboundDatasets.length > 0) {
    lines.push(`数据源已按工程数据集记录绑定到本机导入项：${[...new Set(reboundDatasets)].join('、')}`)
  }
  lines.push(...datasetViewLines)

  if (missing.length) {
    lines.push(
      `⚠ 这些数据不在本机，连线已原样保留：${missing.join('、')} —— 用「导入数据」导入对应的 CSV 即可复活`,
    )
  }
  if (unmatchedColumns.length) lines.push(`⚠ 工程里有本机数据没有的列：${unmatchedColumns.join('；')}`)
  if (timeNotes.length) lines.push(`⚠ 时间列不一致（界面暂不支持改时间列）：${timeNotes.join('；')}`)
  for (const warning of identityWarnings) lines.push(`⚠ ${warning}`)
  for (const w of parsed.warnings.slice(0, 6)) lines.push(`· ${w}`)

  const last = loadedPatches[loadedPatches.length - 1]
  if (last) {
    lines.push(
      `✎ 这份文件里有 ${loadedPatches.length} 次改动记录，最近一次：${last.reason ?? '（没有写原因）'}` +
        `（${last.ops.length} 处）—— 要撤销点下面的按钮`,
    )
  }

  return {
    ok: true,
    report: {
      project,
      lines,
      patchCount: loadedPatches.length,
      ...(last?.reason ? { lastPatchReason: last.reason } : {}),
    },
  }
}

export interface UndoResult {
  ok: boolean
  error?: string
  /** 撤销后的工程文本。调用方应当把它写回文件，否则文件与画布不一致 */
  text?: string
  changes?: string[]
}

/**
 * 撤销最近一次改动。
 *
 * 用反向动作，而不是"回到某个旧版本"：反向动作是那次改动的完整反面，
 * 不需要另存旧文件，也不会把之前别处改的东西一起推回去（那些改动在反向动作里
 * 没有被碰）。
 */
export async function undoLastPatch(): Promise<UndoResult> {
  const last = loadedPatches[loadedPatches.length - 1]
  if (!last) return { ok: false, error: '这份工程里没有可撤销的改动记录' }

  const project = await buildProjectFromStores()
  const result = applyPatch(project, { ops: last.reverse as unknown as PatchOp[], reason: `撤销：${last.reason ?? ''}` })
  if (!result.ok) {
    // 反向动作落不下去，只有一种可能：这条改动之后图又被改过，原处已经不是它了。
    // （整图 L1 不再否决写入 —— 撤销也一样。）
    const why = result.rejections.map((r) => `${r.code} ${r.message}`).join('；') || '反向动作与当前图对不上'
    return { ok: false, error: `撤不回去：${why}。可能图已经被改过了` }
  }

  const undone: Project = {
    ...result.project,
    patches: loadedPatches.slice(0, -1).slice(-PATCH_HISTORY_LIMIT),
  }
  const text = projectToText(undone)
  // 套回界面：走同一条打开路径，免得两处各写一遍"工程 → 界面状态"
  const applied = applyProjectText(text, `wf-undo-${Date.now().toString(36)}`)
  if (!applied.ok) return { ok: false, error: applied.error ?? '撤销后的工程读不回来' }
  return { ok: true, text, changes: result.changes }
}
