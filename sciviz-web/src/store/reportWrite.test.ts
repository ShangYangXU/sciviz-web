import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createProjectReport,
  registerReportProjectWriter,
  reportWriteFailureText,
  useReportStore,
  type ProjectWriteFailure,
  type ProjectWriteOutcome,
} from './useReportStore'
import { journalRead } from './reportJournal'

/**
 * 报告"写回工程文件"这一步的失败口径。
 *
 * 事发背景：2026-09-27 一次真机会话里，`task_checkpoint.finish` 连续两次报
 * 「报告未能写回已打开的工程文件；本地草稿已保留，请检查文件权限或磁盘变化」，
 * 而磁盘、权限、占用全都没问题 —— 真正的原因是浏览器还没给这个文件写权限，
 * 而写权限只能在用户手势里申请。这里钉住的是：**四种失败必须各说各的**，
 * 并且**报告没进工程文件时，本机草稿必须还在**（它是那一刻唯一的一份）。
 */

interface PendingDraft {
  base: string
  reports: unknown[]
}

function reset(projectId: string): void {
  useReportStore.getState().setAll(projectId, [])
}

function failWith(outcome: ProjectWriteOutcome) {
  registerReportProjectWriter(async () => outcome)
}

test('没有写权限：说清是权限（并指出「允许写回」），草稿留在本机', async () => {
  const projectId = 'p-write-permission'
  reset(projectId)
  failWith({ ok: false, reason: 'permission' })

  await assert.rejects(
    () => createProjectReport(projectId),
    (error: unknown) => {
      const message = (error as Error).message
      assert.match(message, /写权限/)
      assert.match(message, /允许写回/)
      assert.doesNotMatch(message, /磁盘/, '没有证据就不能把人往磁盘上引')
      return true
    },
  )

  const pending = await journalRead<PendingDraft>(`reports:${projectId}`)
  assert.equal(pending?.reports.length, 1, '报告没进工程文件时，本机草稿就是唯一副本，不能在失败路径上被丢掉')
  assert.equal(useReportStore.getState().reports.length, 1, '界面也得看得见这份草稿')
})

test('还没打开工程文件：按「待保存」处理，不算失败', async () => {
  const projectId = 'p-write-no-handle'
  reset(projectId)
  failWith({ ok: false, reason: 'no-handle' })

  const saved = await createProjectReport(projectId)
  assert.equal(saved.projectFileSaved, false)
  const pending = await journalRead<PendingDraft>(`reports:${projectId}`)
  assert.equal(pending?.reports.length, 1)
})

test('磁盘上的文件被别处改过：让人先重新载入，不许静默覆盖', async () => {
  const projectId = 'p-write-disk-changed'
  reset(projectId)
  failWith({ ok: false, reason: 'disk-changed' })

  await assert.rejects(() => createProjectReport(projectId), /重新载入/)
  const pending = await journalRead<PendingDraft>(`reports:${projectId}`)
  assert.equal(pending?.reports.length, 1)
})

test('写入被浏览器拒绝：把原话（异常名）带进消息，别藏在 catch 里', async () => {
  const projectId = 'p-write-error'
  reset(projectId)
  failWith({ ok: false, reason: 'write-error', detail: 'NotFoundError: 文件已被移动或删除' })

  await assert.rejects(() => createProjectReport(projectId), /NotFoundError/)
})

test('写回成功：草稿清掉，报告算真的进了工程文件', async () => {
  const projectId = 'p-write-ok'
  reset(projectId)
  failWith({ ok: true })

  const saved = await createProjectReport(projectId)
  assert.equal(saved.projectFileSaved, true)
  assert.equal(await journalRead<PendingDraft>(`reports:${projectId}`), undefined, '写进文件之后草稿必须消失，否则下次打开会拿到两份“真相”')
})

test('四种失败的说法各不相同，工具条用的短句也不等于工具结果里的长句', () => {
  const reasons: ProjectWriteFailure['reason'][] = ['no-handle', 'permission', 'disk-changed', 'write-error']
  const full = reasons.map((reason) => reportWriteFailureText({ ok: false, reason }))
  const brief = reasons.map((reason) => reportWriteFailureText({ ok: false, reason }, 'brief'))
  assert.equal(new Set(full).size, 4)
  assert.equal(new Set(brief).size, 4)
  for (const [index, reason] of reasons.entries()) {
    assert.ok(brief[index].length < full[index].length, `${reason} 的短句应当比长句短`)
  }
  assert.match(reportWriteFailureText({ ok: false, reason: 'write-error', detail: 'NotAllowedError: 拒绝' }), /NotAllowedError/)
})
