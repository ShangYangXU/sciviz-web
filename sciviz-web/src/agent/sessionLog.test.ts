import test from 'node:test'
import assert from 'node:assert/strict'
import { exportFileName, lastSeqOf, normalizeSessionList, sessionLabel, titleFromText, toJsonl, transcriptFromEvents } from './sessionLog'

const event = (seq: number, type: string, payload: Record<string, unknown>) => ({ schemaVersion: 1, seq, at: `2026-09-22T0${seq}:00:00.000Z`, projectId: 'p', sessionId: 's', turnId: 't', type, payload })

test('列表按宿主顺序读入并补上缺省标题', () => {
  const sessions = normalizeSessionList([
    { sessionId: 's-2', title: '加一个傅里叶块', events: 12, turns: 3, archived: false, updatedAt: '2026-09-22T10:00:00.000Z', preview: '已给出提案' },
    { sessionId: 's-1', seq: 4, createdAt: '2026-09-21T10:00:00.000Z' },
    { nope: true },
  ])
  assert.deepEqual(sessions.map((item) => item.sessionId), ['s-2', 's-1'])
  assert.equal(sessions[0].title, '加一个傅里叶块')
  assert.equal(sessions[1].title, '未命名对话', '没有标题时不拿会话 id 冒充')
  assert.equal(sessions[1].events, 4, '老字段 seq 仍然认')
  assert.equal(sessionLabel(sessions[1]).startsWith('未命名对话 · 4 条'), true)
})

test('归档会话在选择器里带标记，但仍然列出来', () => {
  const [archived] = normalizeSessionList([{ sessionId: 's-9', title: '旧话题', archived: true, events: 2 }])
  assert.equal(archived.archived, true)
  assert.equal(sessionLabel(archived).startsWith('🗄 旧话题'), true)
})

test('标题取自首行并截断', () => {
  assert.equal(titleFromText('第一行\n第二行'), '第一行 第二行')
  assert.equal(titleFromText('   '), '未命名对话')
  assert.equal(titleFromText('字'.repeat(60)).length, 40)
})

test('只有说过/答过的话变成气泡，审计事件不进气泡', () => {
  const entries = transcriptFromEvents([
    event(1, 'session', { provider: 'deepseek' }),
    event(2, 'user', { text: '这张图为什么报错' }),
    event(3, 'context', { digest: 'fnv1a64:0' }),
    event(4, 'egress', { messages: [] }),
    event(5, 'tool_call', { callId: 'c1', tool: 'validate' }),
    event(6, 'tool_result', { callId: 'c1', ok: true, tool: 'validate' }),
    event(7, 'patch', { callId: 'c1' }),
    event(8, 'assistant', { text: '上游没接。' }),
    event(9, 'error', { code: 'E_CHAT_PROVIDER_FAILED', message: 'provider HTTP 401' }),
    event(10, 'aborted', { phase: 'turn' }),
  ])
  assert.deepEqual(entries.map((entry) => entry.role), ['user', 'assistant', 'system', 'system'])
  assert.equal(entries[0].text, '这张图为什么报错')
  assert.equal(entries[1].text, '上游没接。')
  assert.equal(entries[2].error, true)
  assert.match(entries[2].text, /E_CHAT_PROVIDER_FAILED/)
  assert.match(entries[3].text, /已停止/)
})

test('重建出的序号基线取正文最大 seq，坏行不参与', () => {
  assert.equal(lastSeqOf([{ seq: 1 }, { seq: '7' }, { seq: 'x' }, null]), 7)
  assert.equal(lastSeqOf([]), 0)
})

test('导出是原样 JSONL，文件名带会话 id', () => {
  const events = [event(1, 'user', { text: '你好' })]
  assert.equal(toJsonl(events), `${JSON.stringify(events[0])}\n`)
  assert.equal(toJsonl([]), '')
  assert.equal(exportFileName('s-abc'), 'sciviz-chat-s-abc.jsonl')
})
