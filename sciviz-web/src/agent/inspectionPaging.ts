/** Chat inspect 的分页判据：每页足够大，并把下一页位置显式返回。 */

export const CODE_PAGE_CHARS = 8_000
export const GRAPH_PAGE_NODES = 10
export const GRAPH_PAGE_MAX_NODES = 25

export function pageCode(code: string, requestedOffset: unknown, _legacyLimit?: unknown): {
  code: string
  codeOffset: number
  nextCodeOffset: number | null
  codeComplete: boolean
} {
  const requested = Number(requestedOffset)
  const codeOffset = Number.isFinite(requested)
    ? Math.max(0, Math.min(code.length, Math.floor(requested)))
    : 0
  const end = Math.min(code.length, codeOffset + CODE_PAGE_CHARS)
  return {
    code: code.slice(codeOffset, end),
    codeOffset,
    nextCodeOffset: end < code.length ? end : null,
    codeComplete: end >= code.length,
  }
}

export function pageGraph<T extends { runtimeId: unknown }, E extends { sourceRuntimeId: unknown }>(
  nodes: T[], edges: E[], requestedOffset: unknown, requestedLimit: unknown,
): {
  nodes: T[]
  edges: E[]
  nodeCount: number
  edgeCount: number
  offset: number
  nextOffset: number | null
  complete: boolean
} {
  const rawOffset = Number(requestedOffset)
  const rawLimit = Number(requestedLimit)
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.min(nodes.length, Math.floor(rawOffset))) : 0
  // A provider may suggest a very small limit. Never turn a whole graph into hundreds of calls.
  const limit = Number.isFinite(rawLimit)
    ? Math.max(GRAPH_PAGE_NODES, Math.min(GRAPH_PAGE_MAX_NODES, Math.floor(rawLimit)))
    : GRAPH_PAGE_NODES
  const nodePage = nodes.slice(offset, offset + limit)
  const sourceIds = new Set(nodePage.map((node) => node.runtimeId))
  const next = offset + nodePage.length
  return {
    nodes: nodePage,
    edges: edges.filter((edge) => sourceIds.has(edge.sourceRuntimeId)),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    offset,
    nextOffset: next < nodes.length ? next : null,
    complete: next >= nodes.length,
  }
}
