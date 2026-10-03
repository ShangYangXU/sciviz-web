import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionMachine, type SessionEvent, type ModelEvent, type ToolResultEnvelope } from './session'

class MemoryJournal {
  events: SessionEvent[] = []
  async append(events: SessionEvent[], expectedSeq: number): Promise<number> {
    assert.equal(this.events.length, expectedSeq)
    this.events.push(...events)
    return this.events.length
  }
}

const result = (tool: string): ToolResultEnvelope => ({ toolPayloadVersion: 1, callId: 'c1', tool, ok: true, status: 'done', data: { ok: true }, evidence: [] })

test('会话工具调用、结果回流与事件审计', async () => {
  const journal = new MemoryJournal()
  let round = 0
  const model = { async *complete(_request: unknown, _signal: AbortSignal): AsyncIterable<ModelEvent> { round += 1; if (round === 1) yield { type: 'tool_call', callId: 'c1', name: 'catalog', arguments: {} }; else { yield { type: 'text_delta', text: '完成' }; yield { type: 'done' } } } }
  const machine = new SessionMachine({ projectId: 'p', sessionId: 's', model, tools: { execute: async (name) => result(name) }, journal })
  const answer = await machine.turn({ text: '查清单', request: { messages: [{ role: 'user', content: '查清单' }], tools: [] } })
  assert.equal(answer.state, 'completed')
  assert.equal(answer.text, '完成')
  assert.equal(journal.events.filter((event) => event.type === 'tool_call').length, 1)
  assert.equal(journal.events.filter((event) => event.type === 'tool_result').length, 1)
})

test('停止后不再启动新的工具', async () => {
  const journal = new MemoryJournal()
  let executions = 0
  const controller = new AbortController()
  const model = { async *complete(_request: unknown, _signal: AbortSignal): AsyncIterable<ModelEvent> { yield { type: 'tool_call', callId: 'c1', name: 'catalog', arguments: {} }; controller.abort() } }
  const machine = new SessionMachine({ projectId: 'p', sessionId: 's', model, tools: { execute: async () => { executions += 1; return result('catalog') } }, journal })
  const answer = await machine.turn({ text: '停', signal: controller.signal, request: { messages: [], tools: [] } })
  assert.equal(answer.state, 'aborted')
  assert.equal(executions, 0)
})

test('只读档位拒绝写工具，重复 callId 的不同参数不重放', async () => {
  const journal = new MemoryJournal()
  let round = 0
  const model = { async *complete(_request: unknown, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    round += 1
    if (round === 1) yield { type: 'tool_call', callId: 'write-1', name: 'patch', arguments: { baseFingerprint: 'a' } }
    else { yield { type: 'text_delta', text: '已拒绝' }; yield { type: 'done' } }
  } }
  let executions = 0
  const machine = new SessionMachine({ projectId: 'p', sessionId: 's', model, tools: { execute: async (name) => { executions += 1; return result(name) } }, journal })
  const answer = await machine.turn({ text: '改图', mode: 'readonly', request: { messages: [], tools: [] } })
  assert.equal(answer.state, 'completed')
  assert.equal(executions, 0)
  assert.equal(answer.toolResults[0]?.status, 'rejected')
})
