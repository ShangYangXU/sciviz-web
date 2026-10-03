import test from 'node:test'
import assert from 'node:assert/strict'
import { editableProjectView, projectEditFingerprint, projectPersistenceFingerprint } from './editFingerprint'
import { emptyProject } from '../workflow/project'
import { emptyWorkflow } from '../workflow/defaultWorkflow'

test('edit fingerprint 排除运行记录与 patch 历史', async () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  const before = await projectEditFingerprint(project)
  project.runs = { lastRunId: 'r1' }
  project.patches = [{ at: 1, ops: [], reverse: [] }]
  assert.equal(await projectEditFingerprint(project), before)
  project.name = 'changed'
  assert.notEqual(await projectEditFingerprint(project), before)
  assert.equal('runs' in editableProjectView(project), false)
})

test('persistence fingerprint 包含批注、笔记与工程补丁历史', async () => {
  const project = emptyProject(emptyWorkflow('wf-persist'))
  const before = await projectPersistenceFingerprint(project)
  project.notebook = '# 实验记录'
  assert.notEqual(await projectPersistenceFingerprint(project), before)
  const withNotebook = await projectPersistenceFingerprint(project)
  project.patches = [{ at: 1, ops: [], reverse: [] }]
  assert.notEqual(await projectPersistenceFingerprint(project), withNotebook)
})

/**
 * 报告是"跟着工程走"的内容，但它不是**图**。两件事分开钉：
 * 写完报告不该让 agent 手上的补丁基准失效（否则每次交报告都要重读一遍工程）；
 * 同时报告没落盘就必须算"有未保存的改动"（否则报告会悄悄丢）。
 */
test('项目报告不进计算指纹，但进持久化指纹', async () => {
  const project = emptyProject(emptyWorkflow('wf-report'))
  const editableBefore = await projectEditFingerprint(project)
  const persistedBefore = await projectPersistenceFingerprint(project)

  project.reports = [{
    id: 'report-1',
    title: '工作段对比实验报告',
    markdown: '# 工作段对比\n',
    createdAt: '2026-09-26T01:00:00.000Z',
    updatedAt: '2026-09-26T01:00:00.000Z',
    figures: [],
  }]

  assert.equal(await projectEditFingerprint(project), editableBefore)
  assert.notEqual(await projectPersistenceFingerprint(project), persistedBefore)
})
