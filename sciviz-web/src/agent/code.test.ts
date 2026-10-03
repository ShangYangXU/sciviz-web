import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyCodePlan, CodeGateError, listCodeFiles, loadCodeRecord, MAX_CODE_FILE_BYTES, planCodePatch, readCodeFile, undoCodePatch } from './code'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sciviz-code-'))
  await fs.mkdir(path.join(root, 'docs'), { recursive: true })
  await fs.writeFile(path.join(root, 'docs', 'note.md'), 'alpha\nbeta\n', 'utf8')
  return root
}

test('源码闸门只允许围栏内的相对路径，并返回有限行段与摘要', async () => {
  const root = await fixture()
  try {
    const listed = await listCodeFiles(root, 'docs/**/*')
    assert.equal(listed.length, 1)
    const read = await readCodeFile(root, 'docs/note.md', 2, 2)
    assert.equal(read.text, 'beta')
    await assert.rejects(() => readCodeFile(root, '../outside.txt'), (error: unknown) => error instanceof CodeGateError && error.code === 'E_CODE_PATH_OUTSIDE')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('全仓库清单会流式纳入大文本文件，但跳过不安全条目', async () => {
  const root = await fixture()
  try {
    await fs.writeFile(path.join(root, 'too-large.txt'), Buffer.alloc(MAX_CODE_FILE_BYTES + 1, 65))
    const listed = await listCodeFiles(root)
    assert.equal(listed.some((entry) => entry.path === 'too-large.txt'), true)
    assert.equal(listed.some((entry) => entry.path === 'docs/note.md'), true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('源码计划应用后可按基线撤销，重复或旧摘要会被拒绝', async () => {
  const root = await fixture()
  try {
    const current = await readCodeFile(root, 'docs/note.md')
    const plan = await planCodePatch(root, [{ kind: 'replaceText', path: 'docs/note.md', expectSha256: current.sha256, oldText: 'beta', newText: 'gamma' }])
    const applied = await applyCodePlan(root, plan, plan.approvalToken, { skipGates: true })
    assert.equal(applied.ok, true)
    assert.equal((await readCodeFile(root, 'docs/note.md')).text, 'alpha\ngamma')
    const record = await loadCodeRecord(root, plan.planId)
    const undone = await undoCodePatch(root, record, { skipGates: true })
    assert.equal(undone.ok, true)
    assert.equal((await readCodeFile(root, 'docs/note.md')).text, 'alpha\nbeta')
    await assert.rejects(() => planCodePatch(root, [{ kind: 'replaceText', path: 'docs/note.md', expectSha256: 'sha256:bad', oldText: 'beta', newText: 'x' }]), (error: unknown) => error instanceof CodeGateError && error.code === 'E_CODE_BASE_MISMATCH')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('固定闸门失败会回滚已写入的源码', async () => {
  const root = await fixture()
  try {
    const current = await readCodeFile(root, 'docs/note.md')
    const plan = await planCodePatch(root, [{ kind: 'replaceText', path: 'docs/note.md', expectSha256: current.sha256, oldText: 'beta', newText: 'broken' }])
    const result = await applyCodePlan(root, plan, plan.approvalToken, { gateRunner: async () => ({ ok: false, output: 'failed' }) })
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'E_CODE_GATE_FAILED')
    assert.equal((await readCodeFile(root, 'docs/note.md')).text, 'alpha\nbeta')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('批准令牌不能把计划摘要替换成另一份动作', async () => {
  const root = await fixture()
  try {
    const current = await readCodeFile(root, 'docs/note.md')
    const plan = await planCodePatch(root, [{ kind: 'replaceText', path: 'docs/note.md', expectSha256: current.sha256, oldText: 'beta', newText: 'gamma' }])
    const tampered = { ...plan, operations: [{ ...plan.operations[0], newText: 'malicious' }] }
    await assert.rejects(() => applyCodePlan(root, tampered, plan.approvalToken, { skipGates: true }), (error: unknown) => error instanceof CodeGateError && error.code === 'E_PARAM_INVALID')
    assert.equal((await readCodeFile(root, 'docs/note.md')).text, 'alpha\nbeta')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
