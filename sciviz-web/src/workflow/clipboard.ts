import {
  ANNOTATION_IMAGE_SIZE_LIMITS,
  cloneAnnotation,
  copyAnnotationScope,
  reattachCopiedAnnotations,
  ANNOTATION_KINDS,
  type Annotation,
  type MindBranch,
} from './annotations'
import { cloneWorkflowNode, WORKFLOW_GROUP_TYPE } from './groups'
import { makeEdgeId } from './ports'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

/**
 * 画布上「块」的剪贴板内容（纯逻辑，`node --test` 直接跑）。
 *
 * ## 为什么这件事要单独成一层
 *
 * 复制粘贴看起来是交互细节，其实里面全是**契约判断**：哪些连线跟着走、组块的内联子图怎么
 * 复制、批注的 `groupPath` 挂到哪一层、id 怎么重发、重名怎么办。这些判断错了不会报错 ——
 * 粘贴出来的图看起来完全正常，只是少了一条线、或者某条批注从此再也看不见。所以它们
 * 一条也不写在组件里：组件只负责"按了哪个键、剪贴板里有什么"。
 *
 * ## 载荷走哪儿
 *
 * 载荷是一段 JSON 文本（`marker` 表明它是本应用的），放进**系统剪贴板**。于是"复制一段图、
 * 在另一个标签页里粘出来"自然成立，也不必让界面去猜"剪贴板里这堆字是不是我们的" ——
 * 认 marker 就行。传输那一层（`navigator.clipboard`、超大载荷的内存兜底）在
 * `src/canvas/blockClipboard.ts`。
 *
 * 坐标在载荷里是**相对**的（减去包围盒左上角）：粘贴到哪一层、画布当前滚到哪儿都不影响
 * 内容之间的相对位置，"复制的一小块"不会被拆散。
 */

export const CLIPBOARD_MARKER = 'sciviz/clipboard'
export const CLIPBOARD_VERSION = 1
/**
 * 超过这个字符数就不往系统剪贴板写。
 *
 * 批注里的图片是 data URL（一张截图几百 KB 起），而剪贴板是**全系统共享**的资源：
 * 往里塞十几 MB 的文本会让别的程序跟着卡。超限时退成"应用内剪贴板"（见 blockClipboard.ts），
 * 本应用里照样能粘，同时在提示里说清楚为什么。
 */
export const CLIPBOARD_TEXT_LIMIT = 2_000_000
/**
 * 载荷里允许的最大条目数。系统剪贴板的内容是外部输入，不能无条件相信。
 *
 * 定得比"正常人会复制的图"宽得多（2000 个块）而不是抠着算：这条上限的用途是**挡住**
 * 一整块乱码，不是替用户判断他的图有多大 —— 真有一张 2000 个块的图要复制，拒绝它就是缺陷。
 */
const CLIPBOARD_MAX_ITEMS = 2000
/** 思维图子树的深度上限（剪贴板里的树是递归结构，挡住病态的深树） */
const MINDMAP_MAX_DEPTH = 256

export interface ClipboardNode {
  /** 来源图里的节点 id。粘贴时按它重映射连线与批注路径 */
  id: string
  /** 节点本体（已深拷贝）。`position` 已相对化 */
  node: WorkflowNode
}

export interface ClipboardEdge {
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

export interface ClipboardAnnotation {
  annotation: Annotation
  /** 归属路径，相对载荷原点：空数组 = 载荷这一层；非空时第一段是被复制的组块 id */
  path: string[]
}

export interface ClipboardPayload {
  marker: string
  version: number
  /** 复制时所在的画布层级。只用于提示，不决定能粘到哪一层 */
  from: string[]
  /** 复制内容包围盒的左上角在来源画布里的坐标 */
  at: { x: number; y: number }
  /** 包围盒尺寸（只按节点坐标算，不含卡片的真实宽高）。跟随鼠标落点时用它居中 */
  size: { width: number; height: number }
  nodes: ClipboardNode[]
  edges: ClipboardEdge[]
  annotations: ClipboardAnnotation[]
  /** 只有一端在选择里、因此没跟着走的连线数。只用于提示 */
  droppedEdges: number
}

export interface ClipboardPaste {
  workflow: Workflow
  annotations: Annotation[]
  /** 这次粘进去的节点（已带最终 id 与落点） */
  nodes: WorkflowNode[]
  /** 这次粘进去的批注 id，供界面把它们选上 */
  annotationIds: string[]
  /** 这次粘进去的内部连线 */
  edges: WorkflowEdge[]
  /**
   * 载荷里的节点 id → 粘出来的新 id。
   *
   * 给"按运行时 id 归属的东西"用：模型制品引用就是按 id 存的，粘出来的块如果内容与原件
   * 一样（指纹一样），它本来就该继续用那份权重 —— 训练一次就够了。组块**内部**节点的 id
   * 不在表里（它们没改名，新位置由组路径表达）。
   */
  nodeIdMap: Map<string, string>
}

/**
 * 把当前选择打包成一个载荷。
 *
 * 三条口径（每一条都是为了"粘贴出来的图和复制的那一块是同一件事"）：
 * 1. **只有两端都在选择里的连线跟走。** 跨边界的线没有另一端可接 —— 复制一小段流程去
 *    别处复用是常见操作，把半条线也搬过去只会得到一根悬空的线；
 * 2. **组块整体复制**：内联子图、边界映射、参数绑定与子空间里的批注一起进载荷；
 * 3. **什么都没选就是没得复制**（返回 `null`），调用方据此**不去动剪贴板** ——
 *    "在空白画布上按 Ctrl+C"不该把用户刚才复制的别的东西冲掉。
 */
export function buildClipboardPayload(
  workflow: Workflow,
  annotations: readonly Annotation[],
  sourcePath: readonly string[],
  nodeIds: Iterable<string>,
  annotationIds: Iterable<string> = [],
): ClipboardPayload | null {
  const selected = new Set(nodeIds)
  const nodes = workflow.nodes.filter((node) => selected.has(node.id))
  const selectedAnnotations = new Set(annotationIds)
  const copiedGroupIds = new Set(
    nodes.filter((node) => node.group).map((node) => node.id),
  )
  const scope = copyAnnotationScope(annotations, sourcePath, selectedAnnotations, copiedGroupIds)
  if (nodes.length === 0 && scope.length === 0) return null

  const xs = [...nodes.map((node) => node.position.x), ...scope.map((item) => item.annotation.position.x)]
  const ys = [...nodes.map((node) => node.position.y), ...scope.map((item) => item.annotation.position.y)]
  const at = { x: Math.min(...xs), y: Math.min(...ys) }

  const insideEdges = workflow.edges.filter(
    (edge) => selected.has(edge.source) && selected.has(edge.target),
  )
  const droppedEdges = workflow.edges.filter(
    (edge) => selected.has(edge.source) !== selected.has(edge.target),
  ).length

  return {
    marker: CLIPBOARD_MARKER,
    version: CLIPBOARD_VERSION,
    from: [...sourcePath],
    at,
    size: {
      width: Math.max(...xs) - at.x,
      height: Math.max(...ys) - at.y,
    },
    nodes: nodes.map((node) => ({
      id: node.id,
      node: {
        ...cloneWorkflowNode(node),
        position: { x: node.position.x - at.x, y: node.position.y - at.y },
      },
    })),
    edges: insideEdges.map(({ source, sourcePort, target, targetPort }) => ({
      source,
      sourcePort,
      target,
      targetPort,
    })),
    annotations: scope.map((item) => ({
      annotation: {
        ...cloneAnnotation(item.annotation),
        position: {
          x: item.annotation.position.x - at.x,
          y: item.annotation.position.y - at.y,
        },
      },
      path: [...item.path],
    })),
    droppedEdges,
  }
}

/** 载荷 → 剪贴板文本。就是 JSON，没有第二层包装 —— 认 marker 比认前缀稳。 */
export function clipboardPayloadText(payload: ClipboardPayload): string {
  return JSON.stringify(payload)
}

/**
 * 这段文字**像不像**本应用的载荷（只看 marker，不解析）。
 *
 * 用途只有一个：`parseClipboardPayload` 返回 null 时，把"这是我们的东西但读不出来"
 * （版本对不上、载荷被改坏、条目太多）和"这压根不是我们的东西"分开。前者必须说出来 ——
 * 不然用户按了 Ctrl+V、什么都没发生、也没人告诉他为什么。
 */
export function looksLikeClipboardPayload(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(CLIPBOARD_MARKER)
}

/**
 * 剪贴板文本 → 载荷。认不出来一律返回 `null`。
 *
 * 这里必须**彻底不信任输入**：剪贴板里可能是任何东西（别的程序的 JSON、人手改坏的载荷、
 * 几 MB 的乱码）。所以逐字段重建出一个干净的对象，而不是把解析结果直接摊进工程状态 ——
 * 后者的后果是一堆没声明过的字段悄悄跟着图跑进 `.sciviz`。
 *
 * 与"宽容解析"（`normalizeAnnotation`）的区别在于对象不同：工程文件是**自己人**写的，
 * 读不动要尽力救；剪贴板是**外人**给的，读不动就当没有，界面什么也不做。
 */
export function parseClipboardPayload(text: string | null | undefined): ClipboardPayload | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  // 便宜的预筛：本应用的载荷一定是 JSON 对象。剪贴板里绝大多数内容（截图、随手复制的文字）
  // 到这一步就返回了，不必走解析。
  if (!trimmed.startsWith('{')) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.marker !== CLIPBOARD_MARKER || o.version !== CLIPBOARD_VERSION) return null

  const nodes: ClipboardNode[] = []
  const nodeIds = new Set<string>()
  if (Array.isArray(o.nodes)) {
    if (o.nodes.length > CLIPBOARD_MAX_ITEMS) return null
    for (const entry of o.nodes) {
      const item = asRecord(entry)
      const id = asText(item?.id)
      const node = parseNode(item?.node)
      if (!id || !node || nodeIds.has(id)) return null
      nodeIds.add(id)
      nodes.push({ id, node })
    }
  }
  const edges: ClipboardEdge[] = []
  if (Array.isArray(o.edges)) {
    if (o.edges.length > CLIPBOARD_MAX_ITEMS) return null
    for (const entry of o.edges) {
      const edge = asRecord(entry)
      const source = asText(edge?.source)
      const sourcePort = asText(edge?.sourcePort)
      const target = asText(edge?.target)
      const targetPort = asText(edge?.targetPort)
      // 引用不在载荷里的节点 = 载荷本身就是坏的：整条丢掉，而不是粘出一根悬空的线
      if (!nodeIds.has(source) || !nodeIds.has(target)) return null
      if (!sourcePort || !targetPort) return null
      edges.push({ source, sourcePort, target, targetPort })
    }
  }

  const annotations: ClipboardAnnotation[] = []
  if (Array.isArray(o.annotations)) {
    if (o.annotations.length > CLIPBOARD_MAX_ITEMS) return null
    for (const entry of o.annotations) {
      const item = asRecord(entry)
      const annotation = parseAnnotation(item?.annotation)
      if (!annotation) return null
      const path = Array.isArray(item?.path)
        ? item.path.filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
        : []
      annotations.push({ annotation, path })
    }
  }

  const at = parsePoint(o.at) ?? { x: 0, y: 0 }
  const size = parsePoint(o.size) ?? { x: 0, y: 0 }
  // 空载荷当"不是我们的东西"处理：粘贴一个什么都没带的载荷只会让人以为程序没反应
  if (nodes.length === 0 && annotations.length === 0) return null
  return {
    marker: CLIPBOARD_MARKER,
    version: CLIPBOARD_VERSION,
    from: Array.isArray(o.from)
      ? o.from.filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
      : [],
    at,
    size: { width: Math.max(0, size.x), height: Math.max(0, size.y) },
    nodes,
    edges,
    annotations,
    droppedEdges: 0,
  }
}

/**
 * 把载荷粘进目标子图。
 *
 * 与复制对称的三条：重发**节点 id**（粘贴两次不能得到同一批 id，否则 React Flow 会把两组
 * 节点当成一组）、按新 id 重算内部连线的 id 与端点、批注按目标层级重挂（跨组块粘贴因此成立）。
 * 与目标图重名的块加「副本」后缀 —— 名字在这个项目里是能被点名的身份
 * （`inspect --node 名字`），两个块同名等于那个名字作废。
 */
export function pasteClipboardPayload(
  payload: ClipboardPayload,
  target: {
    workflow: Workflow
    annotations: readonly Annotation[]
    path: readonly string[]
    origin: { x: number; y: number }
    ids: { node: () => string; annotation: () => string }
    /**
     * 这个算子类型在当前会话里存不存在（`nodeRegistry.hasNodeType`）。
     *
     * 由调用方注入而不是在这里 import 注册表：注册表连着自建模块的 store，而这一层要能在
     * `node --test` 里直接跑。**必须查**：粘进来一个没注册的类型，画布渲染时会当场抛异常
     * （整个界面白屏），所以宁可不粘并说清原因。
     */
    isKnownType: (type: string) => boolean
  },
): ClipboardPaste | null {
  if (payload.nodes.length === 0 && payload.annotations.length === 0) return null
  const unknown = [...new Set(payload.nodes.map((entry) => entry.node.type))].filter(
    (type) => !target.isKnownType(type),
  )
  if (unknown.length > 0) {
    throw new Error(
      `剪贴板里有本会话没有的算子：${unknown.join('、')}。先导入对应的自建模块，再粘贴。`,
    )
  }
  const takenIds = new Set(target.workflow.nodes.map((node) => node.id))
  const takenLabels = new Set(target.workflow.nodes.map((node) => node.label))
  const idMap = new Map<string, string>()
  const nodes: WorkflowNode[] = []

  for (const entry of payload.nodes) {
    let id = target.ids.node()
    for (let guard = 0; takenIds.has(id) && guard < 1000; guard += 1) id = target.ids.node()
    takenIds.add(id)
    idMap.set(entry.id, id)
    nodes.push({
      ...cloneWorkflowNode(entry.node),
      id,
      label: uniqueLabel(entry.node.label, takenLabels),
      position: {
        x: target.origin.x + entry.node.position.x,
        y: target.origin.y + entry.node.position.y,
      },
    })
  }

  const edges: WorkflowEdge[] = payload.edges.map((edge) => {
    const source = idMap.get(edge.source)!
    const targetNode = idMap.get(edge.target)!
    return {
      id: makeEdgeId(source, edge.sourcePort, targetNode, edge.targetPort),
      source,
      sourcePort: edge.sourcePort,
      target: targetNode,
      targetPort: edge.targetPort,
    }
  })

  const existingAnnotationIds = new Set(target.annotations.map((annotation) => annotation.id))
  const { annotations: pastedAnnotations, ids: annotationIds } = reattachCopiedAnnotations(
    payload.annotations,
    target.path,
    idMap,
    target.origin,
    () => {
      let id = target.ids.annotation()
      for (let guard = 0; existingAnnotationIds.has(id) && guard < 1000; guard += 1) {
        id = target.ids.annotation()
      }
      existingAnnotationIds.add(id)
      return id
    },
  )

  return {
    workflow: {
      ...target.workflow,
      nodes: [...target.workflow.nodes, ...nodes],
      edges: [...target.workflow.edges, ...edges],
    },
    annotations: [...target.annotations, ...pastedAnnotations],
    nodes,
    annotationIds,
    edges,
    nodeIdMap: idMap,
  }
}

/** 重名时给出可点名的唯一标签：先「副本」，再「副本 2」…（与手写的图能一眼分开，又能一起排） */
function uniqueLabel(label: string, taken: Set<string>): string {
  const base = label.trim() || '块'
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  const once = `${base} 副本`
  if (!taken.has(once)) {
    taken.add(once)
    return once
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base} 副本 ${n}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parsePoint(value: unknown): { x: number; y: number } | null {
  const o = asRecord(value)
  if (!o) return null
  const x = Number(o.x)
  const y = Number(o.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function parseNode(value: unknown): WorkflowNode | null {
  const o = asRecord(value)
  if (!o) return null
  const id = asText(o.id)
  const type = asText(o.type)
  const label = asText(o.label)
  const position = parsePoint(o.position)
  const params = asRecord(o.params)
  if (!id || !type || !label || !position || !params) return null
  const group = asRecord(o.group)
  if (o.group !== undefined && !group) return null
  // 只有组块类型才允许带 group 定义（与 `yamlToWorkflow` 同一条判据）
  if (group && type !== WORKFLOW_GROUP_TYPE) return null
  return {
    id,
    type,
    label,
    params: { ...params } as WorkflowNode['params'],
    position,
    // 组定义整段交给 `cloneWorkflowNode` 与运行时校验：这里逐字段重建它只会变成第二处解析器，
    // 而"组块能不能用"的判据在 `groups.ts`（`E_GROUP_INVALID`）。
    ...(group ? { group: group as unknown as WorkflowNode['group'] } : {}),
  }
}

function parseAnnotation(value: unknown): Annotation | null {
  const o = asRecord(value)
  if (!o) return null
  const id = asText(o.id)
  const kind = o.kind
  const position = parsePoint(o.position)
  if (!id || !position) return null
  if (typeof kind !== 'string' || !(ANNOTATION_KINDS as string[]).includes(kind)) return null
  const title = typeof o.title === 'string' ? o.title : ''
  const groupPath = Array.isArray(o.groupPath)
    ? o.groupPath.filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
    : []
  if (kind === 'table') {
    const columns = Array.isArray(o.columns) ? o.columns.map((column) => (typeof column === 'string' ? column : '')) : []
    if (columns.length === 0) return null
    const rows = Array.isArray(o.rows)
      ? o.rows.map((row) => (Array.isArray(row) ? row.map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))) : []))
      : []
    return { id, kind, position, groupPath, title, columns, rows }
  }
  if (kind === 'mindmap') {
    const root = parseBranch(o.root)
    if (!root) return null
    return { id, kind, position, groupPath, title, root }
  }
  const src = typeof o.src === 'string' ? o.src : ''
  if (!src) return null
  const source = typeof o.source === 'string' && o.source ? o.source : undefined
  return {
    id,
    kind: 'image',
    position,
    groupPath,
    title,
    src,
    alt: typeof o.alt === 'string' && o.alt ? o.alt : '画布图片',
    width: clampSize(o.width, 380),
    height: clampSize(o.height, 260),
    ...(source ? { source } : {}),
  }
}

/** 图片显示尺寸收进画布允许的范围：载荷是外部输入，一个负数宽高会让整块画布渲染不出来 */
function clampSize(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(ANNOTATION_IMAGE_SIZE_LIMITS.max, Math.max(ANNOTATION_IMAGE_SIZE_LIMITS.min, n))
}

function parseBranch(value: unknown, depth = 0): MindBranch | null {
  if (depth > MINDMAP_MAX_DEPTH) return null
  const o = asRecord(value)
  if (!o) return null
  const id = asText(o.id)
  if (!id) return null
  const children = Array.isArray(o.children) ? o.children : []
  const parsed: MindBranch[] = []
  for (const child of children) {
    const branch = parseBranch(child, depth + 1)
    if (!branch) return null
    parsed.push(branch)
  }
  return { id, text: typeof o.text === 'string' ? o.text : '', children: parsed }
}
