import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRecordedEvents, replayDigest, replaySession, replayIsReadOnly } from './replay'

const event = (seq: number, type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'patch', payload: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, seq, at: '2026-01-01T00:00:00.000Z', projectId: 'p', sessionId: 's', turnId: 't', type, payload })

test('会话回放按 seq 截止、检查身份并默认不执行写动作', () => {
  const result = replaySession([
    event(1, 'user', { text: '读图' }),
    event(2, 'tool_call', { callId: 'provider-uuid', tool: 'catalog' }),
    event(3, 'tool_result', { callId: 'provider-uuid', ok: true }),
    event(4, 'patch', { callId: 'p-1' }),
    event(5, 'assistant', { text: '已完成' }),
  ], 3)
  assert.equal(result.events.length, 3)
  assert.equal(result.writes, 0)
  assert.equal(replayIsReadOnly(result), true)
  assert.equal(replayDigest(result), replayDigest(replaySession(result.events.map((item) => JSON.stringify(item)))))
})

test('录制事件中的 provider call id 可归一为稳定顺序号', () => {
  const result = replaySession([event(1, 'tool_call', { callId: 'random', tool: 'catalog' })])
  const normalized = normalizeRecordedEvents(result.events)
  assert.equal(normalized[0].payload.callId, 'call-1')
})
