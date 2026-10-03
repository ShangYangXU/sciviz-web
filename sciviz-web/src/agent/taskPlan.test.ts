import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTaskCheckpoint, canAutoContinueTask, successfulToolCallIds, taskFromEvents, TASK_AUTO_RUN_LIMITS } from './taskPlan'

const defs = [{ id: 'baseline', title: '测量基线', successCriteria: '保存当前指标和图像证据' }]
const evidence = new Set(['run-1', 'inspect-1', 'verify-1'])

test('长程任务先保存明确目标、完成判据和待办阶段', () => {
  const result = applyTaskCheckpoint(null, { action: 'plan', goal: '比较两种工作段的频谱效果', steps: defs }, 'task-1', evidence, '2026-09-24T10:00:00.000Z')
  assert.equal(result.ok, true)
  assert.equal(result.task?.status, 'active')
  assert.equal(result.task?.steps[0].status, 'pending')
  assert.equal(result.task?.steps[0].successCriteria, defs[0].successCriteria)
})

test('步骤不能引用失败或不存在的工具结果作为完成证据', () => {
  const planned = applyTaskCheckpoint(null, { action: 'plan', goal: '验证改变参数后的输出', steps: defs }, 'task-1', evidence)
  const result = applyTaskCheckpoint(planned.task ?? null, { action: 'update', stepId: 'baseline', status: 'completed', evidenceRefs: ['missing'] }, 'checkpoint-1', evidence)
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'E_PARAM_INVALID')
})

test('不同步骤不能仅凭同一个旧回执标记完成', () => {
  const steps = [
    { id: 'baseline', title: '测量基线', successCriteria: '取得基线结果' },
    { id: 'compare', title: '运行对照', successCriteria: '取得对照结果' },
  ]
  const planned = applyTaskCheckpoint(null, { action: 'plan', goal: '比较两个实验', steps }, 'task-1', evidence)
  const baseline = applyTaskCheckpoint(planned.task ?? null, { action: 'update', stepId: 'baseline', status: 'completed', evidenceRefs: ['inspect-1'] }, 'checkpoint-1', evidence)
  const reused = applyTaskCheckpoint(baseline.task ?? null, { action: 'update', stepId: 'compare', status: 'completed', evidenceRefs: ['inspect-1'] }, 'checkpoint-2', evidence)
  assert.equal(reused.ok, false)
  assert.match(reused.message, /未被其它已完成步骤使用/)
  const compared = applyTaskCheckpoint(baseline.task ?? null, { action: 'update', stepId: 'compare', status: 'completed', evidenceRefs: ['inspect-1', 'run-1'] }, 'checkpoint-3', evidence)
  assert.equal(compared.ok, true)
  assert.deepEqual(compared.task?.steps[1].evidenceRefs, ['inspect-1', 'run-1'])
})

test('实验报告只能在全部阶段完成且引用成功结果后保存', () => {
  const planned = applyTaskCheckpoint(null, { action: 'plan', goal: '验证改变参数后的输出', steps: defs }, 'task-1', evidence)
  const incomplete = applyTaskCheckpoint(planned.task ?? null, { action: 'finish', summary: '完成', report: '# 实验\n'.padEnd(90, 'x'), evidenceRefs: ['run-1'] }, 'finish-1', evidence)
  assert.equal(incomplete.ok, false)
  const completed = applyTaskCheckpoint(planned.task ?? null, { action: 'update', stepId: 'baseline', status: 'completed', evidenceRefs: ['run-1'] }, 'checkpoint-1', evidence)
  const finished = applyTaskCheckpoint(completed.task ?? null, {
    action: 'finish',
    summary: '已完成基线测量与对照分析',
    report: '# 实验报告\n\n'.padEnd(100, '已记录条件、指标、图像和局限。\n'),
    evidenceRefs: ['run-1', 'inspect-1'],
  }, 'finish-1', evidence)
  assert.equal(finished.ok, true)
  assert.equal(finished.task?.status, 'completed')
  assert.match(finished.task?.report ?? '', /实验报告/)
  const autoFinished = applyTaskCheckpoint(completed.task ?? null, {
    action: 'finish',
    summary: '已完成基线测量与对照分析',
    report: '# 实验报告\n\n'.padEnd(100, '已记录条件、指标、图像和局限。\n'),
  }, 'finish-2', evidence)
  assert.equal(autoFinished.ok, true)
  assert.deepEqual(autoFinished.task?.finalEvidenceRefs, ['run-1'])
})

test('重规划只增加新步骤并保留已完成步骤的证据', () => {
  const planned = applyTaskCheckpoint(null, { action: 'plan', goal: '比较工作段', steps: defs }, 'task-1', evidence)
  const completed = applyTaskCheckpoint(planned.task ?? null, { action: 'update', stepId: 'baseline', status: 'completed', evidenceRefs: ['run-1'] }, 'checkpoint-1', evidence)
  const replan = applyTaskCheckpoint(completed.task ?? null, {
    action: 'replan',
    rationale: '基线显示还需要比较第二个工作段',
    steps: [{ id: 'segment2', title: '运行第二工作段', successCriteria: '取得第二组图像与指标' }],
  }, 'replan-1', evidence)
  assert.equal(replan.ok, true)
  assert.equal(replan.task?.steps[0].status, 'completed')
  assert.deepEqual(replan.task?.steps[0].evidenceRefs, ['run-1'])
  assert.equal(replan.task?.steps[1].status, 'pending')
})

test('会话恢复只读取最新有效检查点，并只开放成功工具结果作证据', () => {
  const plan = applyTaskCheckpoint(null, { action: 'plan', goal: '验证对照', steps: defs }, 'task-1', evidence)
  const events = [
    { type: 'tool_result', payload: { callId: 'bad-run', tool: 'run', ok: false, status: 'failed' } },
    { type: 'tool_result', payload: { callId: 'run-1', tool: 'run', ok: true, status: 'done' } },
    { type: 'tool_result', payload: { callId: 'task-1', tool: 'task_checkpoint', ok: true, data: { task: plan.task } } },
  ]
  assert.equal(taskFromEvents(events)?.goal, '验证对照')
  assert.deepEqual([...successfulToolCallIds(events)], ['run-1'])
})

test('已持久化项目报告的身份与工程文件保存状态随检查点恢复', () => {
  const planned = applyTaskCheckpoint(null, { action: 'plan', goal: '生成工程报告', steps: defs }, 'task-1', evidence).task!
  const completed = applyTaskCheckpoint(planned, { action: 'update', stepId: 'baseline', status: 'completed', evidenceRefs: ['run-1'] }, 'checkpoint-1', evidence).task!
  const finished = applyTaskCheckpoint(completed, { action: 'finish', summary: '完成', report: '# 报告\n'.padEnd(90, '已检查。') }, 'checkpoint-2', evidence).task!
  const saved = { ...finished, reportId: 'report-task-1', reportFileSaved: false }
  const restored = taskFromEvents([{ type: 'tool_result', payload: { tool: 'task_checkpoint', ok: true, data: { task: saved } } }])
  assert.equal(restored?.reportId, 'report-task-1')
  assert.equal(restored?.reportFileSaved, false)
  assert.equal(restored?.report, finished.report)
})

test('长任务在窗口额度内自动续跑，到完成、受阻或时间上限时停止', () => {
  const planned = applyTaskCheckpoint(null, { action: 'plan', goal: '比较实验并出报告', steps: defs }, 'task-1', evidence).task!
  assert.equal(canAutoContinueTask(planned, 1, 1_000), true)
  assert.equal(canAutoContinueTask(planned, TASK_AUTO_RUN_LIMITS.windows, 1_000), false)
  assert.equal(canAutoContinueTask(planned, 1, TASK_AUTO_RUN_LIMITS.elapsedMs), false)
  const blocked = applyTaskCheckpoint(planned, { action: 'update', stepId: 'baseline', status: 'blocked', note: '缺少数据' }, 'checkpoint-1', evidence).task!
  assert.equal(canAutoContinueTask(blocked, 1, 1_000), false)
  const done = applyTaskCheckpoint(planned, { action: 'update', stepId: 'baseline', status: 'completed', evidenceRefs: ['run-1'] }, 'checkpoint-2', evidence).task!
  assert.equal(canAutoContinueTask(done, 1, 1_000), false)
})
