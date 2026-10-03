/**
 * 不接浏览器、不接 provider 的对话栏闭环回放。
 *
 * 固定假模型故意走完整路径：读工程 → @ 引用（由 user 事件携带）→
 * plan → patch → validate → run → inspect → undo → 汇报。它压的是会话
 * 状态机、工具结果回流、callId 幂等和审计顺序，不是某个模型的措辞。
 */

import assert from 'node:assert/strict'
import { SessionMachine } from '../src/agent/session.ts'

class Journal {
  constructor() { this.events = [] }
  async append(events, expectedSeq) {
    assert.equal(expectedSeq, this.events.length)
    this.events.push(...events)
    return this.events.length
  }
}

const calls = ['catalog', 'validate', 'plan', 'patch', 'run', 'inspect', 'undo']

async function main() {
  const journal = new Journal()
  const invoked = []
  let round = 0
  const model = {
    async *complete() {
      if (round < calls.length) {
        const name = calls[round]
        round += 1
        yield { type: 'tool_call', callId: `fixture-${round}`, name, arguments: name === 'patch' ? { patch: { baseFingerprint: 'sha256:fixture', ops: [] } } : {} }
        return
      }
      yield { type: 'text_delta', text: '回放闭环完成' }
      yield { type: 'done' }
    },
  }
  const tools = {
    async execute(name, _args, _signal) {
      invoked.push(name)
      return { toolPayloadVersion: 1, callId: `fixture-${invoked.length}`, tool: name, ok: true, status: 'done', data: { evidence: name }, evidence: [{ kind: 'fixture', ref: name }] }
    },
  }
  const machine = new SessionMachine({ projectId: 'fixture-project', sessionId: 'fixture-session', model, tools, journal, maxProviderTurns: 8, maxToolCalls: 12, approveTool: async () => true })
  const result = await machine.turn({ text: '@[输入](node:input) 请完成一轮回放', request: { messages: [{ role: 'user', content: '@[输入](node:input) 请完成一轮回放' }], tools: [] } })
  assert.equal(result.state, 'completed')
  assert.deepEqual(invoked, calls)
  assert.equal(journal.events.filter((event) => event.type === 'egress').length, 8)
  assert.equal(journal.events.filter((event) => event.type === 'tool_call').length, 7)
  assert.equal(journal.events.filter((event) => event.type === 'tool_result').length, 7)
  assert.equal(journal.events.at(-1).type, 'assistant')
  process.stdout.write(JSON.stringify({ ok: true, calls: invoked, events: journal.events.length, answer: result.text }) + '\n')
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`)
  process.exitCode = 1
})
