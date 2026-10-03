import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compactModelMessages,
  compactToolResultContent,
  estimateModelTokens,
  type ModelMessage,
} from './modelContext'

/*
 * 悬空的 tool_calls 会被 OpenAI-compatible 接口整条判 400（实测：带工具结果的续接请求，
 * 同一轮里配对完整的请求都是 200）。压缩按角色过滤历史时会留下 assistant 的 tool_calls、
 * 丢掉 tool 回执，所以投影出来之前必须把配对补回来。
 */
test('悬空的 tool_calls 会被修掉：留下文字，不留没有回执的调用', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '帮我看看这张图' },
    { role: 'assistant', content: '我先看一下。', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'catalog', arguments: '{}' } }] },
    { role: 'user', content: '本轮工具的机器记录：成功 0 次' },
  ]
  const prepared = compactModelMessages(messages)
  assert.equal(prepared.messages.some((message) => message.tool_calls !== undefined), false, '一条都不该留')
  assert.equal(prepared.messages.some((message) => message.role === 'tool'), false)
  assert.ok(prepared.messages.some((message) => message.content === '我先看一下。'), '模型说过的话要留着')
  assert.equal(prepared.messages.length, 5, '去掉的只是 tool_calls 字段，消息条数不缩水')
})

test('配对完整的工具链原样保留：这一条保证主循环不受影响', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '帮我看一下' },
    { role: 'assistant', content: '调用中', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inspect', arguments: '{}' } }] },
    { role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' },
  ]
  const prepared = compactModelMessages(messages)
  assert.equal(prepared.messages.filter((message) => message.tool_calls !== undefined).length, 1)
  assert.equal(prepared.messages.filter((message) => message.role === 'tool').length, 1)
})

test('孤立的 tool 回执（前面没有 assistant 调用它）会被丢掉 —— 它自己就是非法序列', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '帮我看一下' },
    { role: 'tool', content: '{"ok":true}', tool_call_id: '没有这条调用' },
  ]
  const prepared = compactModelMessages(messages)
  assert.equal(prepared.messages.some((message) => message.role === 'tool'), false)
})

test('没有主子的 tool 回执会被丢掉：它自己就是非法序列', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: '系统提示' },
    { role: 'tool', content: '{"ok":true}', tool_call_id: '孤儿' },
    { role: 'user', content: '继续' },
  ]
  const prepared = compactModelMessages(messages)
  assert.equal(prepared.messages.some((message) => message.role === 'tool'), false)
})

test('工具结果模型投影会裁掉内部超长 identity，但保留工具状态', () => {
  const raw = JSON.stringify({
    toolPayloadVersion: 1,
    callId: 'c1',
    tool: 'inspect',
    ok: true,
    status: 'done',
    data: { outputs: [{ identity: `train.function\u0002code=${'x'.repeat(100_000)}` }] },
    evidence: [{ kind: 'node-output', ref: 'n1:history' }],
  })
  const projected = compactToolResultContent(raw)
  assert.ok(projected.compacted)
  assert.ok(projected.content.length < 50_000)
  assert.match(projected.content, /内部输出指纹已隐藏/)
  assert.match(projected.content, /"tool":"inspect"/)
})

test('provider 消息只保留最近历史，并压缩工具结果', () => {
  const messages = [
    { role: 'system' as const, content: '系统' },
    ...Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: `旧消息-${index}-${'x'.repeat(1000)}` })),
    { role: 'user' as const, content: '当前问题' },
    // 工具回执必须有主：没有 assistant 的 tool_calls，这条回执本身就是非法序列（会被投影丢掉）。
    { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'inspect', arguments: '{}' } }] },
    { role: 'tool' as const, tool_call_id: 'c1', content: JSON.stringify({ data: { rows: ['x'.repeat(100_000)] } }) },
  ]
  const report = compactModelMessages(messages, { maxTokens: 2_000, maxHistoryMessages: 4, maxToolResultChars: 2_000 })
  assert.equal(report.messages[0]?.role, 'system')
  assert.equal(report.messages.at(-2)?.role, 'assistant')
  assert.equal(report.messages.at(-1)?.role, 'tool')
  assert.ok(report.droppedHistoryMessages >= 16)
  assert.ok(report.compactedToolResults >= 1)
  assert.ok(report.estimatedTokens <= 2_000)
  assert.ok(report.withinBudget)
})

test('估算器对中文和代码采用字节保守口径', () => {
  assert.ok(estimateModelTokens('中文'.repeat(100)) > 50)
  assert.ok(estimateModelTokens('x'.repeat(300)) >= 100)
})

test('工具结果过大时保留分页位置，明确本页正文未送达', () => {
  const raw = JSON.stringify({
    toolPayloadVersion: 1, callId: 'c-page', tool: 'inspect', ok: true, status: 'done',
    data: { nodeId: 'n1', rowOffset: 100, nextRowOffset: 200, rowsComplete: false, table: { rows: ['x'.repeat(5_000)] } },
    evidence: [],
  })
  const result = compactToolResultContent(raw, { maxToolResultChars: 500, maxTextChars: 5_000 })
  assert.equal(result.truncated, true)
  assert.match(result.content, /"rowOffset":100/)
  assert.match(result.content, /正文未送达/)
})
