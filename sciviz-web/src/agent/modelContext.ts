/**
 * Provider 出口的模型上下文管理。
 *
 * `ContextEnvelope` 只负责本轮工程事实的装配；工具循环和历史消息是另一条增长路径，
 * 必须在真正发给 provider 前再做一次预算。完整工具结果仍留在会话审计里，模型只拿到
 * 面向推理的有界投影。
 */

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ModelTextPart {
  type: 'text'
  text: string
}

export interface ModelImagePart {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export type ModelContent = string | Array<ModelTextPart | ModelImagePart>

export interface ModelToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ModelMessage {
  role: ModelMessageRole
  content: ModelContent
  tool_call_id?: string
  tool_calls?: ModelToolCall[]
}

export interface ModelContextOptions {
  /** provider 不一定公开自己的窗口，使用比常见百万级窗口保守得多的安全分区。 */
  maxTokens?: number
  /** 旧会话只保留最近多少条 user/assistant 消息；当前轮工具链不算在这里。 */
  maxHistoryMessages?: number
  /** 单个工具结果给模型看的最大字符数。完整结果只在审计事件里保留。 */
  maxToolResultChars?: number
  /** 普通历史文本与代码正文的模型侧上限。 */
  maxTextChars?: number
}

export interface ModelContextReport {
  messages: ModelMessage[]
  estimatedTokens: number
  droppedHistoryMessages: number
  compactedToolResults: number
  truncatedToolResults: number
  withinBudget: boolean
}

export const DEFAULT_MODEL_CONTEXT_TOKENS = 180_000
export const DEFAULT_TOOL_RESULT_CHARS = 48_000
export const DEFAULT_HISTORY_MESSAGES = 12
export const DEFAULT_MODEL_TEXT_CHARS = 12_000

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** 与上下文装配器同一口径的保守估算：不是 provider 精确 tokenizer，而是出口安全预算。 */
export function estimateModelTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil(utf8Bytes(text ?? '') / 3)
}

function compactText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const marker = `\n…（模型上下文已省略 ${text.length - maxChars} 个字符；完整内容留在会话审计中）…\n`
  const available = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(available * 0.72)
  const tail = Math.max(0, available - head)
  return { text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`, truncated: true }
}

function compactValue(value: unknown, maxTextChars: number, depth = 0): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') {
    const text = compactText(value, maxTextChars)
    return { value: text.text, truncated: text.truncated }
  }
  if (value === null || typeof value !== 'object') return { value, truncated: false }
  if (depth > 8) return { value: '[模型上下文已省略过深嵌套]', truncated: true }

  if (Array.isArray(value)) {
    const limit = 100
    const items = value.slice(0, limit).map((item) => compactValue(item, maxTextChars, depth + 1))
    const truncated = value.length > limit || items.some((item) => item.truncated)
    return {
      value: truncated
        ? [...items.map((item) => item.value), `…（还有 ${Math.max(0, value.length - limit)} 项已省略）`]
        : items.map((item) => item.value),
      truncated,
    }
  }

  const source = value as Record<string, unknown>
  const entries = Object.entries(source)
  const out: Record<string, unknown> = {}
  let truncated = entries.length > 160
  for (const [key, item] of entries.slice(0, 160)) {
    /* 内部求值指纹可能包含完整 custom code；它是缓存身份，不是模型事实。 */
    if (key === 'identity' && typeof item === 'string' && item.length > 256) {
      out.identity = '[内部输出指纹已隐藏；需要判断时使用端口摘要与 evidence]'
      truncated = true
      continue
    }
    const compacted = compactValue(item, maxTextChars, depth + 1)
    out[key] = compacted.value
    truncated ||= compacted.truncated
  }
  if (entries.length > 160) out.__truncatedKeys = entries.length - 160
  return { value: out, truncated }
}

/** 将一次完整工具回执变成模型专用投影；输入是 JSON 字符串，便于直接接 ChatPanel 的消息。 */
export function compactToolResultContent(
  content: string,
  options: Pick<ModelContextOptions, 'maxToolResultChars' | 'maxTextChars'> = {},
): { content: string; compacted: boolean; truncated: boolean } {
  const maxChars = options.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS
  const maxTextChars = options.maxTextChars ?? DEFAULT_MODEL_TEXT_CHARS
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    const text = compactText(content, maxChars)
    return { content: text.text, compacted: text.truncated, truncated: text.truncated }
  }

  const projected = compactValue(parsed, maxTextChars)
  let encoded = JSON.stringify(projected.value) ?? 'null'
  if (encoded.length <= maxChars) {
    return { content: encoded, compacted: projected.truncated, truncated: projected.truncated }
  }

  const root = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const sourceData = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {}
  // If a page is too large for the model, retain the location and completion flags.
  // Otherwise the model cannot tell which page to retry or whether it saw all data.
  const pageState = Object.fromEntries([
    'nodeId', 'groupPath', 'portId', 'offset', 'nextOffset', 'complete',
    'codeIndexComplete', 'codeOffset', 'nextCodeOffset', 'codeComplete',
    'codeLength', 'codeDigest', 'rowOffset', 'nextRowOffset', 'rowsComplete',
    'nodeCount', 'edgeCount',
  ].filter((key) => sourceData[key] !== undefined).map((key) => [key, sourceData[key]]))
  const fallback: Record<string, unknown> = {
    toolPayloadVersion: root.toolPayloadVersion,
    callId: root.callId,
    tool: root.tool,
    ok: root.ok,
    status: root.status,
    error: root.error,
    evidence: root.evidence,
    data: {
      ...pageState,
      summary: '本页内容超过模型结果预算，正文未送达；请缩小范围或减少 rows，并从本页 offset / rowOffset 重试。nextOffset / nextRowOffset 不代表本页已读。',
    },
    truncated: {
      fullRef: `session:tool_result:${typeof root.callId === 'string' ? root.callId : 'unknown'}`,
      originalChars: content.length,
    },
  }
  encoded = JSON.stringify(fallback)
  if (encoded.length > maxChars) {
    encoded = JSON.stringify({
      tool: typeof root.tool === 'string' ? root.tool : 'unknown',
      ok: root.ok,
      status: root.status,
      truncated: true,
      summary: '工具结果过大，完整内容留在会话审计中。',
    })
  }
  return { content: encoded, compacted: true, truncated: true }
}

function compactMessage(message: ModelMessage, maxTextChars: number, maxToolResultChars: number): { message: ModelMessage; compacted: boolean; truncated: boolean } {
  if (message.role === 'tool') {
    const source = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    const result = compactToolResultContent(source, { maxTextChars, maxToolResultChars })
    return { message: { ...message, content: result.content }, compacted: result.compacted, truncated: result.truncated }
  }
  if (Array.isArray(message.content)) {
    let compacted = false
    const content = message.content.map((part) => {
      if (part.type !== 'text') return part
      const text = compactText(part.text, maxTextChars)
      compacted ||= text.truncated
      return { ...part, text: text.text }
    })
    return { message: { ...message, content }, compacted, truncated: compacted }
  }
  const text = compactText(message.content, maxTextChars)
  return { message: { ...message, content: text.text }, compacted: text.truncated, truncated: text.truncated }
}

function messageTokens(messages: readonly ModelMessage[]): number {
  // Image bytes are transport payload, not text context; count each vision item as a conservative token allowance.
  let imageCount = 0
  const projected = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => {
        if (part.type !== 'image_url') return part
        imageCount += 1
        return { type: 'image', text: '[vision payload]' }
      })
      : message.content,
  }))
  return estimateModelTokens(projected) + imageCount * 2_048
}

/**
 * 生成真正发给 provider 的消息数组。
 *
 * 它不修改原始 `requestMessages`，所以审计仍可保存完整工具回执；只返回一份模型投影。
 *
 * 投影出来的一定是**合法序列**：见 `repairToolPairing`。
 */
export function compactModelMessages(messages: readonly ModelMessage[], options: ModelContextOptions = {}): ModelContextReport {
  const maxTokens = options.maxTokens ?? DEFAULT_MODEL_CONTEXT_TOKENS
  const maxHistoryMessages = options.maxHistoryMessages ?? DEFAULT_HISTORY_MESSAGES
  const maxToolResultChars = options.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS
  const maxTextChars = options.maxTextChars ?? DEFAULT_MODEL_TEXT_CHARS

  const systemIndex = messages.findIndex((message) => message.role === 'system')
  const system = systemIndex >= 0 ? messages[systemIndex] : undefined
  const withoutSystem = messages.filter((_, index) => index !== systemIndex)
  const currentUserIndex = [...withoutSystem].map((message) => message.role).lastIndexOf('user')
  const historyEnd = currentUserIndex >= 0 ? currentUserIndex : withoutSystem.length
  const history = withoutSystem.slice(0, historyEnd).filter((message) => message.role === 'user' || message.role === 'assistant')
  const activeTurn = withoutSystem.slice(historyEnd)
  const keptHistory = history.slice(-maxHistoryMessages)
  let droppedHistoryMessages = history.length - keptHistory.length
  const out: ModelMessage[] = []
  if (system) out.push(system)
  if (droppedHistoryMessages > 0) {
    out.push({ role: 'system', content: `<历史上下文已压缩：省略了 ${droppedHistoryMessages} 条较早的 user/assistant 消息；当前工程事实以本轮上下文和工具结果为准。>` })
  }
  out.push(...keptHistory)

  let compactedToolResults = 0
  let truncatedToolResults = 0
  for (const message of activeTurn) {
    const compacted = compactMessage(message, maxTextChars, maxToolResultChars)
    if (compacted.compacted) compactedToolResults += message.role === 'tool' ? 1 : 0
    if (compacted.truncated && message.role === 'tool') truncatedToolResults += 1
    out.push(compacted.message)
  }

  /* 预算不足时，优先继续收缩工具结果，再丢最早历史；当前轮和系统提示不静默删除。 */
  let toolLimit = maxToolResultChars
  while (messageTokens(out) > maxTokens && toolLimit > 2_000) {
    toolLimit = Math.floor(toolLimit / 2)
    for (let index = 0; index < out.length; index += 1) {
      if (out[index].role !== 'tool') continue
      const content = out[index].content
      const source = typeof content === 'string' ? content : JSON.stringify(content) ?? ''
      const compacted = compactToolResultContent(source, { maxToolResultChars: toolLimit, maxTextChars })
      out[index] = { ...out[index], content: compacted.content }
    }
  }
  let remainingHistory = keptHistory.length
  while (messageTokens(out) > maxTokens && remainingHistory > 0) {
    const firstHistoryIndex = out.findIndex((message) => message.role === 'user' || message.role === 'assistant')
    if (firstHistoryIndex < 0) break
    out.splice(firstHistoryIndex, 1)
    remainingHistory -= 1
    droppedHistoryMessages += 1
  }

  return {
    messages: repairToolPairing(out),
    estimatedTokens: messageTokens(out),
    droppedHistoryMessages,
    compactedToolResults,
    truncatedToolResults,
    withinBudget: messageTokens(out) <= maxTokens,
  }
}

/**
 * 把投影修成 provider 能接受的**合法工具序列**。
 *
 * 规则是 OpenAI-compatible 接口本身定死的：一条带 `tool_calls` 的 assistant 消息，
 * 后面必须跟着它每个 `tool_call_id` 的回执；否则整条请求 400。
 *
 * 这里必须修，是因为本文件的压缩会按角色过滤历史 —— 它留下带 `tool_calls` 的 assistant、
 * 丢掉又长又大的 `tool` 回执，于是**收尾总结那条请求**（历史整段进压缩）必然悬空。
 * 实测症状见开发日志 2026-09-27：先正常调用 `catalog` / `inspect`，带工具结果续接时报
 * `E_CHAT_PROVIDER_FAILED: provider HTTP 400`，而同一轮里每一次**配对完整**的请求都是 200。
 *
 * 修法是保守的：配不齐回执的那条 assistant 只去掉 `tool_calls`、**保留它说过的文字**
 * （那是模型自己的话，不是工具数据）；找不到主子的 `tool` 回执一并丢掉（留着更糟 —— 它会被判成非法序列）。
 * 配对完整时原样返回，所以主循环的每一轮都不受影响。
 */
export function repairToolPairing(messages: readonly ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>()
  const kept = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') answered.add(message.tool_call_id)
  }
  const out: ModelMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      if (message.tool_calls.every((call) => answered.has(call.id))) {
        message.tool_calls.forEach((call) => kept.add(call.id))
        out.push(message)
      } else {
        out.push({ role: message.role, content: message.content })
      }
      continue
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id === 'string' && kept.has(message.tool_call_id)) out.push(message)
      continue
    }
    out.push(message)
  }
  return out
}
