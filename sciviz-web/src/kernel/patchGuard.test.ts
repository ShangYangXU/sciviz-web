import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyProject } from '../workflow/project'
import { emptyWorkflow } from '../workflow/defaultWorkflow'
import { projectEditFingerprint } from './editFingerprint'
import { applyPatchGuarded } from './patch'

test('机器补丁没有当前基线时拒绝，且工程保持原样', async () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  const result = await applyPatchGuarded(project, { ops: [] })
  assert.equal(result.ok, false)
  assert.equal(result.rejections[0]?.code, 'E_PATCH_BASE_MISMATCH')
  assert.equal(result.project, project)
})

test('机器补丁基线匹配后才进入原子补丁应用器', async () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  const baseFingerprint = await projectEditFingerprint(project)
  const result = await applyPatchGuarded(project, { baseFingerprint, ops: [] })
  assert.equal(result.ok, true)
})
