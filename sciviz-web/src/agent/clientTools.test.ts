import test from 'node:test'
import assert from 'node:assert/strict'
import { executeClientTool } from './clientTools'
import { emptyProject } from '../workflow/project'
import { emptyWorkflow } from '../workflow/defaultWorkflow'

test('客户端只读工具能返回 catalog、校验与错误解释', () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  assert.equal(executeClientTool('catalog', {}, project, 'c1').ok, true)
  assert.equal(executeClientTool('validate', {}, project, 'c2').ok, true)
  assert.equal(executeClientTool('explain', { code: 'E_PARAM_INVALID' }, project, 'c3').ok, true)
})

test('plan 只产生 dry-run 结果，不写工程', () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  const result = executeClientTool('plan', { patch: { ops: [] } }, project, 'c4')
  assert.equal(result.ok, true)
  assert.equal(project.graph.nodes.length, 0)
})

test('工具失败自动附带稳定错误码解释', () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  const result = executeClientTool('plan', { patch: {} }, project, 'c5')
  assert.equal(result.ok, false)
  assert.match(result.error?.explain ?? '', /E_PARAM_INVALID/)
})
