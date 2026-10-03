import type { SessionEvent } from './session'
import { stableStringify } from './context'

export interface ReplayResult {
  events: SessionEvent[]
  userMessages: string[]
  assistantMessages: string[]
  toolCalls: number
  writes: number
  lastSeq: number
  errors: Array<{ code: string; message: string; line?: number }>
  digest: string
}

function deterministicDigest(value: unknown): string {
  const text = stableStringify(value)
  let hash = 1469598103934665603n
  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0) ?? 0)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}

export function replaySession(lines: Iterable<string>, untilSeq?: number): ReplayResult {
  const events: SessionEvent[] = []
  const errors: ReplayResult['errors'] = []
  let lineNumber = 0
  let lastSeq = 0
  let projectId: string | undefined
  let sessionId: string | undefined
  for (const line of lines) {
    lineNumber += 1
    if (!line.trim()) continue
    let event: SessionEvent
    try {
      event = JSON.parse(line) as SessionEvent
    } catch (error) {
      errors.push({ code: 'E_CHAT_SESSION_IO', message: `第 ${lineNumber} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, line: lineNumber })
      continue
    }
    if (!event || event.schemaVersion !== 1 || typeof event.seq !== 'number' || typeof event.type !== 'string') {
      errors.push({ code: 'E_CHAT_SESSION_IO', message: `第 ${lineNumber} 行缺少会话事件必需字段`, line: lineNumber })
      continue
    }
    if (untilSeq !== undefined && event.seq > untilSeq) break
    if (event.seq <= lastSeq) errors.push({ code: 'E_CHAT_SESSION_IO', message: `事件 seq 未严格递增：${event.seq}`, line: lineNumber })
    lastSeq = Math.max(lastSeq, event.seq)
    if (projectId === undefined) projectId = event.projectId
    if (sessionId === undefined) sessionId = event.sessionId
    if (event.projectId !== projectId || event.sessionId !== sessionId) errors.push({ code: 'E_CHAT_SESSION_IO', message: `事件 ${event.seq} 的工程或会话身份不一致`, line: lineNumber })
    events.push(event)
  }
  const body = {
    events,
    userMessages: events.filter((event) => event.type === 'user').map((event) => String(event.payload.text ?? '')),
    assistantMessages: events.filter((event) => event.type === 'assistant').map((event) => String(event.payload.text ?? '')),
    toolCalls: events.filter((event) => event.type === 'tool_call').length,
    writes: events.filter((event) => event.type === 'patch' || event.type === 'code').length,
  }
  return {
    ...body,
    lastSeq,
    errors,
    digest: deterministicDigest(body),
  }
}

export function replayIsReadOnly(result: ReplayResult): boolean {
  return result.writes === 0
}

/** 将录制事件中的运行时 id 归一，供人工审查后的 fixture 使用。 */
export function normalizeRecordedEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const calls = new Map<string, string>()
  let nextCall = 1
  return events.map((event) => {
    const payload = { ...event.payload }
    if (typeof payload.callId === 'string') {
      const normalized = calls.get(payload.callId) ?? `call-${nextCall++}`
      calls.set(payload.callId, normalized)
      payload.callId = normalized
    }
    return { ...event, payload }
  })
}

/** 读取回放结果时只返回证据摘要；绝不调用任何写工具。 */
export function replayDigest(result: ReplayResult): string {
  return deterministicDigest({ digest: result.digest, toolCalls: result.toolCalls, writes: result.writes })
}
