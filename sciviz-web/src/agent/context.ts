import type { Project } from '../workflow/project'
import type { Workflow, WorkflowNode } from '../workflow/types'

export const ENVELOPE_VERSION = 1

export type ChatMode = 'readonly' | 'proposal' | 'automatic'

/** 一个节点在整张（可能嵌套的）图里的一处位置。 */
export interface NodeMatch {
  groupPath: string[]
  groupLabels: string[]
  label: string
}

/** 同一个 id 命中多层时的如实自述。`note` 是给模型看的那句话，只有一处措辞。 */
export interface NodeAmbiguity {
  ambiguous: number
  matches: NodeMatch[]
  note: string
}

export interface NodeContext {
  id: string
  label: string
  type: string
  params: Record<string, string | number | boolean>
  neighbors: string[]
  /**
   * 这个块在哪一层子空间里（组块节点 id，从外到内）。
   *
   * 没有它，模型只拿得到 id，却不知道这个 id 属于哪一层 —— 而补丁的每条 op 都要用
   * `path` 指到那一层（见 `contract/ops.ts`）。根图里找不到子空间内部的块，
   * 于是"知道要改哪个块"和"改得到那个块"之间差一步靠猜。
   */
  groupPath?: string[]
  /** 与 groupPath 一一对应的组块标签，给人看 */
  groupLabels?: string[]
  /**
   * 这个 id 在几层里出现过（>1 才带）。id 只在本层唯一，所以重名不是异常，
   * 是必须如实说出来的事实：静默取第一处，症状就是模型改了一个"看起来不存在的块"。
   */
  ambiguous?: number
  /** 与 ambiguous 配套：每一处命中的层级与名字 */
  matches?: NodeMatch[]
  codeDigest?: string
  codeLines?: number
  code?: string
}

/**
 * 整图骨架里的一项：一个节点在整张图里的位置。
 *
 * 故意不带参数、不带端口、不带连线 —— 骨架要回答的只有"这张图上有哪些块、它们分别在哪一层"。
 * 连线仍然由 `inspect`（不传 nodeId）给全量节点与边，这样骨架的体积只跟节点数成正比。
 */
export interface OutlineNode extends NodeMatch {
  id: string
  type: string
}

export interface DatasetContext {
  id: string
  name: string
  rowCount?: number
  columns: Array<{ name: string; type: string; role: string; enabled: boolean }>
  timeColumn?: string | null
  rows?: Array<Record<string, unknown>>
}

export interface IssueContext {
  code: string
  message: string
  nodeId?: string
  portId?: string
}

export interface EvidenceContext {
  kind: string
  ref: string
  digest?: string
  summary?: string
}

export interface ExternalContent {
  source: string
  text: string
}

export interface ContextEnvelope {
  envelopeVersion: 1
  promptVersion: string
  project: {
    projectId: string
    name: string
    editFingerprint: string
    nodeCount: number
    edgeCount: number
    validation: { errors: number; warnings: number }
  }
  references: NodeContext[]
  neighbors: NodeContext[]
  outline: OutlineNode[]
  datasets: DatasetContext[]
  issues: IssueContext[]
  recentEvidence: EvidenceContext[]
  externalContent: ExternalContent[]
  permissions: { mode: ChatMode; includeRows: boolean; includeCode: boolean }
  dropped: Array<{ section: string; reason: string; count?: number }>
  digest: string
}

export interface ContextInput {
  project: Project
  projectId?: string
  editFingerprint: string
  promptVersion: string
  references?: string[]
  issues?: IssueContext[]
  recentEvidence?: EvidenceContext[]
  externalContent?: ExternalContent[]
  mode?: ChatMode
  includeRows?: boolean
  /** 是否允许工具把代码正文发给当前模型服务。 */
  includeCode?: boolean
  /** 初始消息内联代码正文；默认关闭，正文通过可分页 inspect 工具按需读取。 */
  includeCodeInContext?: boolean
  rows?: Record<string, Array<Record<string, unknown>>>
  validation?: { errors: number; warnings: number }
  budget?: number
}

const SECRET_KEY = /(token|key|secret|password|credential)/i

function sanitizeParams(params: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === 'code') continue
    if (SECRET_KEY.test(key)) out[key] = '<redacted>'
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

/** 一个节点 id 出现在哪一层。id 只在**本层**唯一，所以同一个 id 可能有多处命中。 */
export interface NodeLocation {
  node: WorkflowNode
  workflow: Workflow
  groupPath: string[]
  groupLabels: string[]
}

/**
 * 按节点 id 在整张（可能嵌套的）图里定位，附带它所在的组路径。
 *
 * 纯逻辑、无 IO：上下文装配、界面 `inspect` 与将来的工具共用这一处，
 * 免得"这个块在哪一层"被算两遍还越算越不一样。
 */
export function locateNodes(project: Project, id: string): NodeLocation[] {
  const found: NodeLocation[] = []
  const walk = (workflow: Workflow, groupPath: string[], groupLabels: string[]) => {
    for (const node of workflow.nodes) {
      if (node.id === id) found.push({ node, workflow, groupPath, groupLabels })
      if (node.group) walk(node.group.workflow, [...groupPath, node.id], [...groupLabels, node.label])
    }
  }
  walk(project.graph, [], [])
  return found
}

/**
 * 整张图（含每一层子空间内部）的骨架，按画布顺序。
 *
 * 存在的理由是一条实测：此前模型只知道被 `@` 的块和它的一阶邻居，于是"这张图上还有哪些块、
 * 分别在哪一层"必须靠额外一轮 `inspect` 才能知道 —— 而那一轮本身可能又要用户点确认。
 */
export function outlineOf(root: Workflow): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (workflow: Workflow, groupPath: string[], groupLabels: string[]) => {
    for (const node of workflow.nodes) {
      out.push({ id: node.id, label: node.label, type: node.type, groupPath, groupLabels })
      if (node.group) walk(node.group.workflow, [...groupPath, node.id], [...groupLabels, node.label])
    }
  }
  walk(root, [], [])
  return out
}

/**
 * 一个 id 命中多层时的自述。返回 `undefined` 表示"这个 id 是唯一的，没什么要提醒的"。
 *
 * 措辞只有这一处：上下文装配、界面 `inspect` 与将来的工具共用它，免得同一条提醒被写三遍、
 * 三遍还不一样（R1）。
 */
export function nodeAmbiguity(project: Project, id: string, locations: NodeLocation[] = locateNodes(project, id)): NodeAmbiguity | undefined {
  if (locations.length <= 1) return undefined
  const matches = locations.map((hit) => ({ groupPath: hit.groupPath, groupLabels: hit.groupLabels, label: hit.node.label }))
  const where = locations[0].groupPath.join('/') || '根图'
  return {
    ambiguous: locations.length,
    matches,
    note: `这个 id 在 ${locations.length} 层里都出现过；上面这份是其中第一处（${where}）。要改哪一层请在 op 的 path 里写明，别按 id 猜。`,
  }
}

/** 一个节点的完整自述：参数、邻居、所在层级，以及（被允许时）代码原文。 */
export async function describeNode(project: Project, id: string, includeCode: boolean): Promise<NodeContext | undefined> {
  const locations = locateNodes(project, id)
  const location = locations[0]
  if (!location) return undefined
  const { node, workflow, groupPath, groupLabels } = location
  const neighbors = workflow.edges
    .filter((edge) => edge.source === id || edge.target === id)
    .map((edge) => (edge.source === id ? edge.target : edge.source))
  const code = typeof node.params.code === 'string' ? node.params.code : undefined
  const ambiguity = nodeAmbiguity(project, id, locations)
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    params: sanitizeParams(node.params),
    neighbors: [...new Set(neighbors)].sort(),
    ...(groupPath.length > 0 ? { groupPath, groupLabels } : {}),
    ...(ambiguity ? { ambiguous: ambiguity.ambiguous, matches: ambiguity.matches } : {}),
    ...(code ? { codeDigest: `sha256:${await sha256Hex(code)}`, codeLines: code.split(/\r?\n/).length, ...(includeCode ? { code } : {}) } : {}),
  }
}

export interface CodeBlockDescriptor {
  nodeId: string
  label: string
  type: string
  groupPath: string[]
  groupLabels: string[]
  codeDigest: string
  codeLines: number
  codeLength: number
}

/** 返回整图（含所有嵌套子空间）代码块的可寻址目录，不包含代码正文。 */
export async function codeBlocksOf(project: Project): Promise<CodeBlockDescriptor[]> {
  const blocks: CodeBlockDescriptor[] = []
  const walk = async (workflow: Workflow, groupPath: string[], groupLabels: string[]): Promise<void> => {
    for (const node of workflow.nodes) {
      const code = typeof node.params.code === 'string' ? node.params.code : undefined
      if (code !== undefined) {
        blocks.push({
          nodeId: node.id,
          label: node.label,
          type: node.type,
          groupPath,
          groupLabels,
          codeDigest: `sha256:${await sha256Hex(code)}`,
          codeLines: code.split(/\r?\n/).length,
          codeLength: code.length,
        })
      }
      if (node.group) await walk(node.group.workflow, [...groupPath, node.id], [...groupLabels, node.label])
    }
  }
  await walk(project.graph, [], [])
  return blocks
}

const nodeContext = (project: Project, id: string, includeCode: boolean) => describeNode(project, id, includeCode)

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function estimateTokens(value: unknown): number {
  return Math.ceil(new TextEncoder().encode(stableStringify(value)).byteLength / 3)
}

export async function assembleContext(input: ContextInput): Promise<ContextEnvelope> {
  const mode = input.mode ?? 'proposal'
  const includeRows = input.includeRows === true
  const includeCode = input.includeCode === true
  const refs = (await Promise.all([...new Set(input.references ?? [])]
    .map((id) => nodeContext(input.project, id, input.includeCodeInContext === true))))
    .filter((node): node is NodeContext => Boolean(node))
  const refIds = new Set(refs.map((node) => node.id))
  const neighborIds = new Set(refs.flatMap((node) => node.neighbors).filter((id) => !refIds.has(id)))
  const neighbors = (await Promise.all([...neighborIds].sort().map((id) => nodeContext(input.project, id, false))))
    .filter((node): node is NodeContext => Boolean(node))
  const datasets = input.project.datasets.map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    ...(dataset.rowCount === undefined ? {} : { rowCount: dataset.rowCount }),
    columns: (dataset.columns ?? []).map(({ name, type, role, enabled }) => ({ name, type, role, enabled })),
    ...(dataset.timeColumn === undefined ? {} : { timeColumn: dataset.timeColumn }),
    ...(includeRows && input.rows?.[dataset.id] ? { rows: input.rows[dataset.id].slice(0, 5) } : {}),
  }))
  const envelope: Omit<ContextEnvelope, 'digest'> = {
    envelopeVersion: ENVELOPE_VERSION,
    promptVersion: input.promptVersion,
    project: {
      projectId: input.projectId ?? 'unsaved',
      name: input.project.name,
      editFingerprint: input.editFingerprint,
      nodeCount: input.project.graph.nodes.length,
      edgeCount: input.project.graph.edges.length,
      validation: input.validation ?? { errors: 0, warnings: 0 },
    },
    references: refs,
    neighbors,
    outline: outlineOf(input.project.graph),
    datasets,
    issues: input.issues ?? [],
    recentEvidence: input.recentEvidence ?? [],
    externalContent: (input.externalContent ?? []).map((item) => ({ source: item.source, text: item.text })),
    permissions: { mode, includeRows, includeCode },
    dropped: [],
  }
  const budget = input.budget ?? 24_000
  /*
   * 裁剪顺序里 `outline` 排最后：它是"模型看得见图"的唯一保证，
   * 宁可少给一份数据集说明，也不要让它回到"不知道图上有哪些块"。
   */
  const trim = (section: keyof Pick<ContextEnvelope, 'neighbors' | 'datasets' | 'recentEvidence' | 'externalContent' | 'outline'>, reason: string) => {
    const value = envelope[section]
    if (Array.isArray(value) && value.length > 0) {
      const count = value.length
      ;(envelope[section] as unknown[]).splice(0)
      envelope.dropped.push({ section, reason, count })
    }
  }
  for (const [section, reason] of [
    ['recentEvidence', 'budget'],
    ['neighbors', 'budget'],
    ['externalContent', 'budget'],
    ['datasets', 'budget'],
    ['outline', 'budget'],
  ] as const) {
    if (estimateTokens(envelope) <= budget) break
    trim(section, reason)
  }
  if (estimateTokens(envelope) > budget) throw new Error('E_CHAT_CONTEXT_TOO_LARGE')
  const digest = `sha256:${await sha256Hex(stableStringify(envelope))}`
  return { ...envelope, digest }
}
