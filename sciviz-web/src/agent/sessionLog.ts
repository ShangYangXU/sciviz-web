import type { ChatAttachmentSummary } from './chatAttachments'

/**
 * 会话日志 → 界面能用的东西：子对话列表与气泡。
 *
 * 纯逻辑（不 import React / store / node:fs），因为"哪些事件该变成气泡"是个判断，
 * 不是渲染细节：判错了要么回看时看不到说过的话，要么把整条工具流水线重播一遍。
 *
 * 一条规则贯穿全文：**正文是真相，索引只是缓存**。所以列表缺字段时按"未知"显示，
 * 不拿会话 id 冒充标题。
 */

export interface SessionSummary {
  sessionId: string
  title: string
  createdAt: string | null
  updatedAt: string | null
  /** 事件条数（含审计事件），用来判断"这份记录有多大" */
  events: number
  /** 用户发言轮数 */
  turns: number
  archived: boolean
  preview: string
}

export interface ChatChoicePrompt {
  callId: string
  question: string
  options: string[]
  recommended?: string
  answer?: string
  cancelled?: boolean
}

export interface TranscriptEntry {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  at: string
  error?: boolean
  attachments?: ChatAttachmentSummary[]
  questions?: ChatChoicePrompt[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

function attachmentSummaries(value: unknown): ChatAttachmentSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.sha256 !== 'string') return []
    if (item.kind !== 'image' && item.kind !== 'pdf') return []
    if (typeof item.mimeType !== 'string' || typeof item.size !== 'number') return []
    return [{
      id: item.id,
      name: item.name,
      kind: item.kind,
      mimeType: item.mimeType,
      size: item.size,
      sha256: item.sha256,
      ...(typeof item.width === 'number' ? { width: item.width } : {}),
      ...(typeof item.height === 'number' ? { height: item.height } : {}),
      ...(typeof item.pageCount === 'number' ? { pageCount: item.pageCount } : {}),
      ...(Array.isArray(item.renderedPages) ? { renderedPages: item.renderedPages.filter((page): page is number => typeof page === 'number') } : {}),
      ...(typeof item.omittedVisualPages === 'number' ? { omittedVisualPages: item.omittedVisualPages } : {}),
      ...(typeof item.textTruncated === 'boolean' ? { textTruncated: item.textTruncated } : {}),
    }]
  })
}

function choicePrompts(value: unknown): ChatChoicePrompt[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const callId = text(item.callId).trim()
    const question = text(item.question).trim()
    const options = Array.isArray(item.options)
      ? item.options.filter((option): option is string => typeof option === 'string').map((option) => option.trim()).filter(Boolean)
      : []
    if (!callId || !question || (options.length === 1 || options.length > 5)) return []
    const recommended = typeof item.recommended === 'string' && options.includes(item.recommended) ? item.recommended : undefined
    return [{
      callId,
      question,
      options,
      ...(recommended ? { recommended } : {}),
      ...(typeof item.answer === 'string' ? { answer: item.answer } : {}),
      ...(item.cancelled === true ? { cancelled: true } : {}),
    }]
  })
}

export function titleFromText(value: string, limit = 40): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return '未命名对话'
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

export function normalizeSessionSummary(raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const sessionId = text(entry.sessionId).trim()
  if (!sessionId) return null
  const events = Number(entry.events ?? entry.seq ?? 0)
  const turns = Number(entry.turns ?? 0)
  return {
    sessionId,
    title: text(entry.title).trim() || '未命名对话',
    createdAt: text(entry.createdAt) || null,
    updatedAt: text(entry.updatedAt) || null,
    events: Number.isFinite(events) ? events : 0,
    turns: Number.isFinite(turns) ? turns : 0,
    archived: entry.archived === true,
    preview: text(entry.preview),
  }
}

/** 宿主已经排好序，这里保持原顺序（顺序本身是"最近用过"的信息）。 */
export function normalizeSessionList(raw: unknown): SessionSummary[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeSessionSummary).filter((item): item is SessionSummary => item !== null)
}

export function sessionLabel(summary: SessionSummary): string {
  const parts = [`${summary.archived ? '🗄 ' : ''}${summary.title}`]
  if (summary.events > 0) parts.push(`${summary.events} 条`)
  if (summary.updatedAt) parts.push(summary.updatedAt.slice(0, 16).replace('T', ' '))
  return parts.join(' · ')
}

/**
 * 只把"人说过/答过什么"变成气泡：`context`、`egress`、`tool_call`、`tool_result`、`patch`
 * 留在 JSONL 里当审计，不进气泡 —— 回看要看到说过什么，不是重播整条流水线。
 */
export function transcriptFromEvents(events: readonly unknown[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const event = raw as Record<string, unknown>
    if (event.schemaVersion !== 1) continue
    const type = text(event.type)
    const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>
    const at = text(event.at)
    const id = `e-${text(event.seq) || entries.length + 1}`
    if (type === 'user') {
      const body = text(payload.text)
      const attachments = attachmentSummaries(payload.attachments)
      if (body || attachments.length) entries.push({ id, role: 'user', text: body, at, ...(attachments.length ? { attachments } : {}) })
      continue
    }
    if (type === 'assistant') {
      const body = text(payload.text)
      const questions = choicePrompts(payload.questions)
      if (body || questions.length) entries.push({ id, role: 'assistant', text: body, at, ...(questions.length ? { questions } : {}) })
      continue
    }
    if (type === 'error') {
      const code = text(payload.code) || 'E_UNKNOWN'
      entries.push({ id, role: 'system', text: `${code}：${text(payload.message)}`.trim(), at, error: true })
      continue
    }
    if (type === 'aborted') {
      entries.push({ id, role: 'system', text: '本轮对话已停止（未执行的写入都没有落盘）。', at })
    }
  }
  return entries
}

/** 恢复会话时的序号基线：正文最大 seq。空会话是 0。 */
export function lastSeqOf(events: readonly unknown[]): number {
  let last = 0
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue
    const seq = Number((raw as Record<string, unknown>).seq)
    if (Number.isFinite(seq) && seq > last) last = seq
  }
  return last
}

/** 导出的文件名：会话 id 本身就是稳定标识，加个前缀好认。 */
export function exportFileName(sessionId: string): string {
  return `sciviz-chat-${sessionId || 'session'}.jsonl`
}

/** 导出的正文：原样拼回 JSONL（一行一个事件），不裁剪、不改写。 */
export function toJsonl(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
}
