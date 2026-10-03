import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationGrounding } from './conversationGrounding'

test('跨轮保留用户纠正与机器事实，不把助手猜测或原始数据当证据重送', () => {
  const events: Array<{ seq: number; type: string; payload: unknown }> = [
    { seq: 1, type: 'user', payload: { text: '比较训练目标 1 步与 6 步，评估都取第 1 步。' } },
    { seq: 2, type: 'assistant', payload: { text: '错误结论：问题已证明出在通道错位。' } },
    { seq: 3, type: 'tool_result', payload: { tool: 'inspect', ok: true, status: 'done', data: {
      nodeId: 'chart', label: '对照评估', groupPath: ['experiment'], params: { step: 1, code: '不应外发的代码', apiKey: 'secret' },
      code: '不应外发的代码', codeLength: 8300, codeComplete: false, nextCodeOffset: 8000,
      table: { rows: [['不应外发的行值']] },
    } } },
    ...Array.from({ length: 12 }, (_, index) => ({ seq: index + 4, type: 'user', payload: { text: `后续短消息 ${index}` } })),
    { seq: 16, type: 'user', payload: { text: '我的真实对照是同样的数据和评估，只改变训练输出：过去 60 点预测未来 1 点，对比过去 60 点预测未来 6 点，然后两边都只评估第 1 点。' } },
    { seq: 17, type: 'tool_result', payload: { tool: 'inspect_figure', ok: true, status: 'done', data: {
      runtimeId: 'chart', label: '对照评估', width: 800, height: 600, sha256: 'abc', image: '不应外发的像素',
    } } },
  ]
  const grounding = conversationGrounding(events)
  assert.match(grounding, /只改变训练输出/)
  assert.match(grounding, /比较训练目标 1 步与 6 步/)
  assert.match(grounding, /"codeComplete":false/)
  assert.match(grounding, /"sha256":"abc"/)
  assert.doesNotMatch(grounding, /错误结论|不应外发|secret/)
})
