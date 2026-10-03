/**
 * wire 层的两条新语义（待办 T7）。
 *
 * 它们只在"消息怎么唤醒等待方"这一层，测试不碰 socket、也不碰 Python：
 * 一个假的派发器就够了 —— 真正容易写错的正是"哪条消息该唤醒谁"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { EngineDispatcher } from './dispatch'
import { CancelledError } from './errors'

test('进度是过程量：它不唤醒这一次求值，但能被订阅者看到', async () => {
  const dispatcher = new EngineDispatcher()
  const seen: [string, number, string][] = []
  dispatcher.onProgress((nodeId, ratio, message) => seen.push([nodeId, ratio, message]))

  const pending = dispatcher.awaitEval('n1')
  let settled: string | null = null
  void pending.then(
    () => (settled = 'resolved'),
    () => (settled = 'rejected'),
  )

  dispatcher.handle({ type: 'nodeProgress', nodeId: 'n1', ratio: 0.25, message: '' })
  dispatcher.handle({ type: 'nodeProgress', nodeId: 'n1', ratio: 0.5, message: '第 3/6 轮' })
  assert.deepEqual(seen, [
    ['n1', 0.25, ''],
    ['n1', 0.5, '第 3/6 轮'],
  ])

  // 让微任务队列跑一轮：如果进度错误地唤醒了求值，这里就会看到 settled
  await Promise.resolve()
  assert.equal(settled, null, '进度不该结束这次求值 —— 那正是"求值还没完"的意思')

  dispatcher.handle({ type: 'nodeResult', nodeId: 'n1', refs: {} })
  await pending
  assert.equal(settled, 'resolved')
})

test('取消：这次求值以 CancelledError 结束，而不是笼统的 EngineError', async () => {
  const dispatcher = new EngineDispatcher()
  const pending = dispatcher.awaitEval('n1')
  dispatcher.handle({ type: 'nodeCancelled', nodeId: 'n1', message: '已取消' })

  // 类型必须能被认出来：上层据此走"可以重试"，而不是把它记成一次失败
  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof CancelledError, `期望 CancelledError，实际 ${String(err)}`)
    assert.equal(err.message, '已取消')
    return true
  })
})

test('进度订阅可以退订：界面关掉之后不该还有回调', () => {
  const dispatcher = new EngineDispatcher()
  let count = 0
  const off = dispatcher.onProgress(() => (count += 1))
  dispatcher.handle({ type: 'nodeProgress', nodeId: 'n1', ratio: 0.1, message: '' })
  off()
  dispatcher.handle({ type: 'nodeProgress', nodeId: 'n1', ratio: 0.9, message: '' })
  assert.equal(count, 1)
})
