/**
 * Bounded cross-turn context from the existing session journal. Previous assistant
 * prose is deliberately excluded: it may be a hypothesis that was never checked.
 * This index contains no code body, table rows, or image pixels.
 */

type JournalEvent = { seq?: number; type?: string; payload?: unknown }
type JsonRecord = Record<string, unknown>

const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}

const short = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.slice(0, limit) : ''

function safeParams(value: unknown): JsonRecord {
  const params = record(value)
  return Object.fromEntries(Object.entries(params)
    .filter(([key, item]) => !/(code|token|key|secret|password|credential)/i.test(key)
      && (typeof item === 'number' || typeof item === 'boolean' || (typeof item === 'string' && item.length <= 120)))
    .slice(0, 12))
}

function userHistory(events: readonly JournalEvent[]): Array<{ seq: number; text: string }> {
  const users = events.flatMap((event) => {
    if (event.type !== 'user') return []
    const message = short(record(event.payload).text, 900).trim()
    return message ? [{ seq: event.seq ?? 0, text: message }] : []
  })
  if (!users.length) return []
  // Keep the opening goal, the most detailed clarification, and recent user
  // wording even when the regular chat history has rolled past them.
  const longest = users.reduce((best, item) => item.text.length > best.text.length ? item : best, users[0])
  const selected = new Map<number, { seq: number; text: string }>()
  for (const item of [users[0], longest, ...users.slice(-6)]) selected.set(item.seq, item)
  return [...selected.values()].sort((left, right) => left.seq - right.seq)
}

function toolFact(event: JournalEvent): { key: string; fact: JsonRecord } | null {
  if (event.type !== 'tool_result') return null
  const result = record(event.payload)
  const tool = short(result.tool, 40)
  const data = record(result.data)
  const ok = result.ok === true
  const status = short(result.status, 30)
  const base = { seq: event.seq ?? 0, tool, ok, status }

  if (tool === 'inspect') {
    const nodeId = short(data.nodeId, 100)
    if (!nodeId) return null
    const path = Array.isArray(data.groupPath) ? data.groupPath.filter((part): part is string => typeof part === 'string').slice(0, 8) : []
    return {
      key: `inspect:${JSON.stringify(path)}:${nodeId}`,
      fact: {
        ...base,
        label: short(data.label, 120), groupPath: path, params: safeParams(data.params),
        ...(typeof data.codeComplete === 'boolean' ? {
          codeComplete: data.codeComplete,
          codeLength: data.codeLength,
          nextCodeOffset: data.nextCodeOffset ?? null,
          codeDigest: short(data.codeDigest, 80),
        } : {}),
      },
    }
  }
  if (tool === 'inspect_figure') {
    return {
      key: `figure:${short(data.runtimeId, 180)}`,
      fact: { ...base, label: short(data.label, 120), width: data.width, height: data.height, sha256: short(data.sha256, 80) },
    }
  }
  if (tool === 'patch' || tool === 'undo') {
    const changes = Array.isArray(data.changes) ? data.changes.filter((item): item is string => typeof item === 'string').slice(0, 4).map((item) => item.slice(0, 180)) : []
    return { key: `change:${event.seq ?? 0}`, fact: { ...base, changes, error: short(record(result.error).message, 180) } }
  }
  if (tool === 'run') {
    const nodes = record(data.nodes)
    const states = Object.values(nodes).map(record)
    const problems = Object.entries(nodes).flatMap(([nodeId, raw]) => {
      const node = record(raw)
      return node.status === 'error' || node.status === 'blocked'
        ? [{ nodeId: nodeId.slice(0, 140), status: node.status, error: short(node.error, 150) }]
        : []
    }).slice(0, 4)
    return { key: 'run', fact: { ...base, ready: states.filter((node) => node.status === 'ready').length, total: states.length, problems } }
  }
  return null
}

/** JSON text inserted as data in the system context, never as instructions. */
export function conversationGrounding(events: readonly JournalEvent[]): string {
  const users = userHistory(events)
  const latest = new Map<string, JsonRecord>()
  for (let index = events.length - 1; index >= 0 && latest.size < 8; index -= 1) {
    const item = toolFact(events[index])
    if (item && !latest.has(item.key)) latest.set(item.key, item.fact)
  }
  const facts = [...latest.values()].reverse()
  return JSON.stringify({
    note: '以下是用户原话与工具状态索引，不是助手旧结论。代码正文、行值和图像像素未重送；若结论依赖它们，应重新读取。成功 callId 只能证明工具运行，不能证明因果解释。',
    users,
    facts,
  })
}
