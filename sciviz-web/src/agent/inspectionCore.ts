import type { OutputRefBody } from '../engine/protocol'
import type { OutputSummary, RunManifestNode } from '../kernel/manifest'

export interface InspectablePort {
  portId: string
  kind: OutputRefBody['kind']
  rows: boolean
  columns?: string[]
  rowCount?: number
  timeColumn?: string | null
  stats?: OutputRefBody['stats']
  identity?: string
  lineage?: string[]
}

export interface InspectablePortOptions {
  /** CLI/审计可保留完整身份；模型侧必须关闭，避免把含代码的求值指纹外发。 */
  includeIdentity?: boolean
}

type ResultNode = Pick<RunManifestNode, 'nodeId' | 'label' | 'outputs'>

export function inspectablePorts(
  outputs: Record<string, OutputSummary | OutputRefBody> | undefined,
  options: InspectablePortOptions = {},
): InspectablePort[] {
  return Object.entries(outputs ?? {}).map(([portId, output]) => ({
    portId,
    kind: output.kind,
    rows: output.kind === 'table',
    ...(output.columns ? { columns: output.columns } : {}),
    ...(output.rowCount !== undefined ? { rowCount: output.rowCount } : {}),
    ...(output.timeColumn !== undefined ? { timeColumn: output.timeColumn } : {}),
    ...(output.stats ? { stats: output.stats } : {}),
    ...(options.includeIdentity === false ? {} : output.identity ? { identity: output.identity } : {}),
    ...(output.lineage ? { lineage: output.lineage } : {}),
  }))
}

export type NodeSelection =
  | { ok: true; nodes: ResultNode[] }
  | { ok: false; message: string; availableNodes: { nodeId: string; label: string }[] }

/** id 优先；标签只有唯一匹配时才接受。 */
export function selectResultNodes(nodes: ResultNode[], selector?: string): NodeSelection {
  if (!selector) return { ok: true, nodes }
  const byId = nodes.find((node) => node.nodeId === selector)
  if (byId) return { ok: true, nodes: [byId] }

  const byLabel = nodes.filter((node) => node.label === selector)
  if (byLabel.length === 1) return { ok: true, nodes: byLabel }
  const availableNodes = nodes.map(({ nodeId, label }) => ({ nodeId, label }))
  if (byLabel.length > 1) {
    return {
      ok: false,
      message: `节点标签「${selector}」不唯一（${byLabel.map((node) => node.nodeId).join('、')}），请改用节点 id`,
      availableNodes,
    }
  }
  return { ok: false, message: `没有节点 id 或标签「${selector}」`, availableNodes }
}

export type RowPortSelection =
  | { ok: true; portId: string; availablePorts: InspectablePort[] }
  | { ok: false; message: string; availablePorts: InspectablePort[] }

export class InspectionSelectionError extends Error {
  readonly availableNodes?: { nodeId: string; label: string }[]
  readonly availablePorts?: InspectablePort[]

  constructor(message: string, details: { availableNodes?: { nodeId: string; label: string }[]; availablePorts?: InspectablePort[] } = {}) {
    super(message)
    this.name = 'InspectionSelectionError'
    this.availableNodes = details.availableNodes
    this.availablePorts = details.availablePorts
  }
}

/** 为 inspect 选择表端口：省略时只接受唯一 table，绝不猜 train/val/test。 */
export function selectRowPort(outputs: Record<string, OutputSummary | OutputRefBody> | undefined, requested?: string): RowPortSelection {
  const availablePorts = inspectablePorts(outputs)
  if (requested) {
    const hit = availablePorts.find((port) => port.portId === requested)
    if (!hit) return { ok: false, message: `没有输出端口「${requested}」${formatAvailablePorts(availablePorts)}`, availablePorts }
    if (!hit.rows) return { ok: false, message: `输出端口「${requested}」是 ${hit.kind}，不能读取行值${formatAvailablePorts(availablePorts)}`, availablePorts }
    return { ok: true, portId: hit.portId, availablePorts }
  }
  const tables = availablePorts.filter((port) => port.rows)
  if (tables.length === 1) return { ok: true, portId: tables[0].portId, availablePorts }
  if (tables.length === 0) return { ok: false, message: `这个节点没有可读取行值的 table 输出${formatAvailablePorts(availablePorts)}`, availablePorts }
  return { ok: false, message: `这个节点有多个 table 输出（${tables.map((port) => port.portId).join('、')}），请用 --port 明确选择`, availablePorts }
}

function formatAvailablePorts(ports: InspectablePort[]): string {
  if (ports.length === 0) return '；这个节点没有产出任何端口'
  return `；现有端口：${ports.map((port) => `${port.portId}(${port.kind})`).join('、')}`
}
