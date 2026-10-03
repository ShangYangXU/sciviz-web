import { toolSpecOf, type ToolName } from './tools'
import type { ModelContent } from './modelContext'

export type SessionState =
  | 'idle'
  | 'assembling'
  | 'persisting-egress'
  | 'requesting-model'
  | 'streaming'
  | 'awaiting-policy'
  | 'awaiting-user-choice'
  | 'executing-tool'
  | 'recording-result'
  | 'completed'
  | 'failed'
  | 'aborting'
  | 'aborted'

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; callId: string; name: ToolName; arguments: unknown; complete?: boolean }
  | { type: 'done'; providerMessageId?: string }
  | { type: 'error'; code: string; message: string }

export interface ModelTurnRequest {
  messages: Array<{ role: 'system' | 'user' | 'tool'; content: ModelContent }>
  tools: readonly unknown[]
}

export interface ModelTurnClient {
  complete(request: ModelTurnRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}

export interface ToolResultEnvelope {
  toolPayloadVersion: 1
  callId: string
  tool: string
  ok: boolean
  status: 'done' | 'partial' | 'failed' | 'cancelled' | 'rejected'
  data?: unknown
  error?: { code: string; message: string; explain?: string }
  evidence: Array<{ kind: string; ref: string; digest?: string }>
  truncated?: { fullRef: string }
}

export interface ToolExecutor {
  execute(name: ToolName, args: unknown, signal: AbortSignal): Promise<ToolResultEnvelope>
}

export interface SessionEvent {
  schemaVersion: 1
  seq: number
  at: string
  projectId: string
  sessionId: string
  turnId: string
  type: 'session' | 'user' | 'context' | 'egress' | 'assistant' | 'tool_call' | 'tool_result' | 'patch' | 'code' | 'error' | 'aborted'
  payload: Record<string, unknown>
}

export interface SessionJournal {
  append(events: SessionEvent[], expectedSeq: number): Promise<number>
}

export interface SessionTurnInput {
  text: string
  request: ModelTurnRequest
  signal?: AbortSignal
  mode?: 'readonly' | 'proposal' | 'automatic'
}

export interface SessionTurnResult {
  state: SessionState
  text: string
  toolResults: ToolResultEnvelope[]
  error?: { code: string; message: string }
}

export interface SessionOptions {
  projectId: string
  sessionId: string
  model: ModelTurnClient
  tools: ToolExecutor
  journal: SessionJournal
  maxProviderTurns?: number
  maxToolCalls?: number
  /** 写工具在进入执行态前必须由 UI/宿主确认 exact plan；未注入时默认拒绝。 */
  approveTool?: (name: ToolName, args: unknown, mode: SessionTurnInput['mode']) => boolean | Promise<boolean>
  onState?: (state: SessionState) => void
  now?: () => string
}

const abortError = (signal: AbortSignal): Error | null => signal.aborted ? new Error('W_CHAT_ABORTED') : null

export class SessionMachine {
  private state: SessionState = 'idle'
  private seq = 0
  private turnCounter = 0
  private readonly seenCalls = new Map<string, ToolResultEnvelope>()
  private readonly seenCallArguments = new Map<string, string>()
  private readonly maxProviderTurns: number
  private readonly maxToolCalls: number
  private readonly now: () => string

  constructor(private readonly options: SessionOptions) {
    this.maxProviderTurns = options.maxProviderTurns ?? 64
    this.maxToolCalls = options.maxToolCalls ?? 128
    this.now = options.now ?? (() => new Date().toISOString())
  }

  get currentState(): SessionState { return this.state }

  stop(): void {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'aborted' || this.state === 'idle') return
    this.setState('aborting')
  }

  private setState(state: SessionState): void {
    this.state = state
    this.options.onState?.(state)
  }

  private isAborting(): boolean {
    return this.state === 'aborting'
  }

  private async append(type: SessionEvent['type'], turnId: string, payload: Record<string, unknown>): Promise<void> {
    const event: SessionEvent = {
      schemaVersion: 1,
      seq: this.seq + 1,
      at: this.now(),
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      turnId,
      type,
      payload,
    }
    this.seq = await this.options.journal.append([event], this.seq)
  }

  async turn(input: SessionTurnInput): Promise<SessionTurnResult> {
    if (this.state !== 'idle' && this.state !== 'completed' && this.state !== 'failed' && this.state !== 'aborted') {
      return { state: this.state, text: '', toolResults: [], error: { code: 'E_PARAM_INVALID', message: '已有一轮对话正在进行' } }
    }
    const signal = input.signal ?? new AbortController().signal
    const turnId = `turn-${++this.turnCounter}`
    const textParts: string[] = []
    const toolResults: ToolResultEnvelope[] = []
    let providerTurns = 0
    let toolCalls = 0
    try {
      this.setState('assembling')
      await this.append('user', turnId, { text: input.text, mode: input.mode ?? 'proposal' })
      while (providerTurns < this.maxProviderTurns) {
        const stopped = abortError(signal)
        if (stopped || this.isAborting()) return await this.finishAborted(turnId, textParts.join(''), toolResults)
        providerTurns += 1
        this.setState('persisting-egress')
        await this.append('egress', turnId, { request: input.request, providerTurn: providerTurns })
        this.setState('requesting-model')
        const calls: Array<{ callId: string; name: ToolName; arguments: unknown }> = []
        this.setState('streaming')
        for await (const event of this.options.model.complete(input.request, signal)) {
          if (this.isAborting() || signal.aborted) return await this.finishAborted(turnId, textParts.join(''), toolResults)
          if (event.type === 'text_delta') textParts.push(event.text)
          else if (event.type === 'tool_call') {
            const existing = calls.find((call) => call.callId === event.callId)
            if (existing) existing.arguments = event.arguments
            else calls.push({ callId: event.callId, name: event.name, arguments: event.arguments })
          } else if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`)
        }
        if (this.isAborting() || signal.aborted) return await this.finishAborted(turnId, textParts.join(''), toolResults)
        if (calls.length === 0) {
          this.setState('completed')
          const text = textParts.join('')
          await this.append('assistant', turnId, { text })
          return { state: 'completed', text, toolResults }
        }
        this.setState('awaiting-policy')
        for (const call of calls) {
          if (++toolCalls > this.maxToolCalls) {
            const error = { code: 'E_TOOL_LIMIT_EXCEEDED', message: '本轮内部工具调用额度已用尽' }
            await this.append('error', turnId, error)
            this.setState('failed')
            return { state: 'failed', text: textParts.join(''), toolResults, error }
          }
          const prior = this.seenCalls.get(call.callId)
          if (prior) {
            const normalized = JSON.stringify(call.arguments ?? {})
            if (this.seenCallArguments.get(call.callId) !== normalized) {
              const error = { code: 'E_PARAM_INVALID', message: `callId ${call.callId} 的参数与首次调用不同` }
              await this.append('error', turnId, error)
              this.setState('failed')
              return { state: 'failed', text: textParts.join(''), toolResults, error }
            }
            toolResults.push(prior)
            continue
          }
          const spec = toolSpecOf(call.name)
          if (!spec) {
            const result: ToolResultEnvelope = { toolPayloadVersion: 1, callId: call.callId, tool: call.name, ok: false, status: 'rejected', error: { code: 'E_PARAM_INVALID', message: `未注册的工具：${call.name}` }, evidence: [] }
            toolResults.push(result)
            await this.append('tool_result', turnId, { ...result })
            continue
          }
          const mode = input.mode ?? 'proposal'
          if (spec.effect === 'graph-write' || spec.effect === 'code-write') {
            const approved = mode !== 'readonly' && this.options.approveTool ? await this.options.approveTool(call.name, call.arguments, mode) : false
            if (!approved) {
              const result: ToolResultEnvelope = { toolPayloadVersion: 1, callId: call.callId, tool: call.name, ok: false, status: 'rejected', error: { code: 'E_PARAM_INVALID', message: mode === 'readonly' ? '只读档位禁止写工具' : '写工具需要人工确认 exact plan' }, evidence: [] }
              this.seenCalls.set(call.callId, result)
              this.seenCallArguments.set(call.callId, JSON.stringify(call.arguments ?? {}))
              toolResults.push(result)
              await this.append('tool_call', turnId, { callId: call.callId, tool: call.name, arguments: call.arguments, policy: 'rejected' })
              await this.append('tool_result', turnId, { ...result })
              continue
            }
          }
          await this.append('tool_call', turnId, { callId: call.callId, tool: call.name, arguments: call.arguments })
          this.setState(spec.effect === 'interaction' ? 'awaiting-user-choice' : 'executing-tool')
          const executed = await this.options.tools.execute(call.name, call.arguments, signal)
          const result: ToolResultEnvelope = executed.callId === call.callId ? executed : { ...executed, callId: call.callId }
          this.seenCalls.set(call.callId, result)
          this.seenCallArguments.set(call.callId, JSON.stringify(call.arguments ?? {}))
          toolResults.push(result)
          await this.append('tool_result', turnId, { ...result })
          this.setState('recording-result')
        }
        // Provider adapter 的 request builder 会把最新 tool_result 放进下一轮；
        // 纯状态机只负责发出事件，不偷偷拼第二份消息协议。
        input = { ...input, request: { ...input.request, messages: [...input.request.messages, ...toolResults.slice(-calls.length).map((result) => ({ role: 'tool' as const, content: JSON.stringify(result) }))] } }
      }
      const error = { code: 'E_TOOL_LIMIT_EXCEEDED', message: '本轮模型往返已达到上限' }
      await this.append('error', turnId, error)
      this.setState('failed')
      return { state: 'failed', text: textParts.join(''), toolResults, error }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'W_CHAT_ABORTED' || signal.aborted || this.isAborting()) return await this.finishAborted(turnId, textParts.join(''), toolResults)
      const failure = { code: message.split(':', 1)[0] || 'E_CHAT_PROVIDER_FAILED', message }
      await this.append('error', turnId, failure)
      this.setState('failed')
      return { state: 'failed', text: textParts.join(''), toolResults, error: failure }
    }
  }

  private async finishAborted(turnId: string, text: string, toolResults: ToolResultEnvelope[]): Promise<SessionTurnResult> {
    this.setState('aborted')
    await this.append('aborted', turnId, { phase: 'turn', text, committedWrites: toolResults.some((result) => result.status === 'done' && result.tool !== 'inspect') })
    return { state: 'aborted', text, toolResults, error: { code: 'W_CHAT_ABORTED', message: '用户已停止本轮对话' } }
  }
}
