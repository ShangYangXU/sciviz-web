import test from 'node:test'
import assert from 'node:assert/strict'
import { runGraphPatch, runGraphUndo, shortDiff } from './graphTools'
import { projectEditFingerprint } from '../kernel/editFingerprint'
import { emptyProject, type Project } from '../workflow/project'
import { emptyWorkflow } from '../workflow/defaultWorkflow'
import { defaultParams, getNodeTypeDef } from '../workflow/nodeRegistry'

/**
 * 对话栏改图那一条路（`patch` / `undo` 工具）的钉子。
 *
 * 它守的是一个**用户亲眼看到的现象**："我和 AI 说话，它改不了块。" 实测那个现象
 * 由两处叠加造成：补丁被别处的静态问题一律拒掉（而拒绝理由是空的），界面再把空理由
 * 谎报成"基线不符"，模型就换一版基线重试，再失败 —— 整轮对话原地打转。
 *
 * 所以这里的判据只有一句：**失败必须说出真的那条理由，而且只有这条 op 自己落不下去
 * 才算失败。**
 */

const node = (id: string, type: string, params: Record<string, string | number | boolean> = {}) => ({
  id,
  type,
  label: id,
  params: { ...defaultParams(getNodeTypeDef(type)), ...params },
  position: { x: 0, y: 0 },
})

const projectWith = (nodes: ReturnType<typeof node>[]): Project => {
  const base = emptyProject(emptyWorkflow('wf-chat'))
  return {
    ...base,
    datasets: [
      {
        id: 'ds-1',
        name: '数据',
        timeColumn: null,
        columns: [{ name: '液位', type: 'number', role: 'continuous', enabled: true }],
      },
    ],
    graph: { ...base.graph, nodes, edges: [] },
  }
}

test('改图：基线对、op 落得下，人确认之后才写回', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' })])
  const baseFingerprint = await projectEditFingerprint(project)
  let written: Project | null = null
  const result = await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    'c1',
    { confirm: () => true, write: (applied) => { written = applied; return { ok: true } } },
  )
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.status, 'done')
  assert.equal((written as unknown as Project).graph.nodes.length, 2)
  assert.ok(Array.isArray((result.data as { changes: string[] }).changes))
})

test('别处的静态问题不否决改动：它进 l1Issues，而不是变成一次失败', async () => {
  const project = projectWith([
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    // 半截实验：代码还没写，参数却已经填了 —— 这是工程里很普通的一处 L1 问题
    node('half', 'custom.script', { cutoff: 5 }),
  ])
  const baseFingerprint = await projectEditFingerprint(project)
  let wrote = false
  const result = await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    'c2',
    { confirm: () => true, write: () => { wrote = true; return { ok: true } } },
  )
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(wrote, true, '改动要真的写回去')
  const data = result.data as { l1Issues: Array<{ code: string; nodeId?: string }> }
  assert.ok(data.l1Issues.some((issue) => issue.nodeId === 'half'), JSON.stringify(data.l1Issues))
})

test('某条 op 自己落不下去：报它自己的码，不许谎报成基线不符', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'data.preview')])
  const baseFingerprint = await projectEditFingerprint(project)
  let wrote = false
  const result = await runGraphPatch(
    project,
    {
      patch: {
        baseFingerprint,
        ops: [{ op: 'connect', source: 'n1', sourcePort: '没有这一列', target: 'n2', targetPort: 'data' }],
      },
    },
    'c3',
    { confirm: () => true, write: () => { wrote = true; return { ok: true } } },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'E_UNKNOWN_PORT')
  assert.equal(wrote, false, '被拒的补丁不许留下一半')
})

test('基线真的不符时才说基线不符，并告诉模型去哪儿取值', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' })])
  const result = await runGraphPatch(
    project,
    { patch: { baseFingerprint: 'sha256:stale', ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    'c4',
    { confirm: () => true, write: () => ({ ok: true }) },
  )
  assert.equal(result.error?.code, 'E_PATCH_BASE_MISMATCH')
  assert.match(result.error?.message ?? '', /editFingerprint|当前工程/)
})

test('缺 baseFingerprint 时给出可执行的一句话，而不是让它去猜', async () => {
  const project = projectWith([])
  const result = await runGraphPatch(
    project,
    { patch: { ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    'c5',
    { confirm: () => true, write: () => ({ ok: true }) },
  )
  assert.equal(result.error?.code, 'E_PARAM_INVALID')
  assert.match(result.error?.message ?? '', /baseFingerprint/)
})

test('人点了取消：状态是 rejected，一个字节都不写', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' })])
  const baseFingerprint = await projectEditFingerprint(project)
  let wrote = false
  const result = await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    'c6',
    { confirm: () => false, write: () => { wrote = true; return { ok: true } } },
  )
  assert.equal(result.status, 'rejected')
  assert.equal(wrote, false)
  assert.ok(Array.isArray((result.data as { changes: string[] }).changes), '提案本身仍要交回给模型')
})

test('「完全访问权限」档：一个弹窗都不弹，改动照样落，且如实记下它是自动落的', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' })])
  const baseFingerprint = await projectEditFingerprint(project)
  let asked = 0
  let written: Project | null = null
  const result = await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    'c7',
    {
      confirm: () => { asked += 1; return true },
      write: (applied) => { written = applied; return { ok: true } },
      mode: 'full',
    },
  )
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(asked, 0, '自动档不许弹确认 —— 用户报的就是这个')
  assert.equal((written as unknown as Project).graph.nodes.length, 2)
  assert.equal((result.data as { appliedWith: string }).appliedWith, 'auto')
})

test('「请求批准」档仍然问，且记下这一笔是人点的头', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' })])
  const baseFingerprint = await projectEditFingerprint(project)
  let asked = 0
  const result = await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    'c8',
    { confirm: () => { asked += 1; return true }, write: () => ({ ok: true }), mode: 'ask' },
  )
  assert.equal(asked, 1)
  assert.equal((result.data as { appliedWith: string }).appliedWith, 'user-confirm')
})

/**
 * 中间那一档（「帮我批准」）的判据只有一条：**普通写不问，破坏性写才问**。
 *
 * 两头都得钉住 —— 只会问的那一档等于「请求批准」，永远不问的那一档等于完全访问权限，
 * 只有正好落在"丢掉用户已有表达"上，这个档位才有存在的理由。
 */
test('「帮我批准」档：普通改图不问，删块 / 删数据集 / 覆盖代码 / 重置参数才问', async () => {
  const project = projectWith([node('n1', 'custom.script', { code: 'def run(x):\n    return x * 2' })])
  const baseFingerprint = await projectEditFingerprint(project)
  let asked = 0
  const deps = {
    confirm: () => { asked += 1; return true },
    write: () => ({ ok: true }),
    mode: 'smart' as const,
  }

  const added = await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'addNode', id: 'n2', type: 'data.preview' }] } },
    's1',
    deps,
  )
  assert.equal(added.ok, true, JSON.stringify(added.error))
  assert.equal(asked, 0, '普通改图不该问 —— 中间档的价值就在这里')
  assert.equal((added.data as { appliedWith: string }).appliedWith, 'auto')

  const covered = await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'setParam', id: 'n1', key: 'code', value: 'def run(x):\n    return x' }] } },
    's2',
    deps,
  )
  assert.equal(asked, 1, '覆盖人写过的代码要提高一级')
  assert.equal((covered.data as { appliedWith: string }).appliedWith, 'user-confirm')

  asked = 0
  await runGraphPatch(project, { patch: { baseFingerprint, ops: [{ op: 'removeNode', id: 'n1' }] } }, 's3', deps)
  assert.equal(asked, 1, '删掉带代码的块要提高一级')

  asked = 0
  await runGraphPatch(project, { patch: { baseFingerprint, ops: [{ op: 'removeDataset', id: 'ds-1' }] } }, 's4', deps)
  assert.equal(asked, 1, '删数据集要提高一级')

  asked = 0
  await runGraphPatch(project, { patch: { baseFingerprint, ops: [{ op: 'resetParams', id: 'n1' }] } }, 's5', deps)
  assert.equal(asked, 1, '重置参数要提高一级')
})

test('普通块被删不算破坏性：出厂代码不值得拦人', async () => {
  const project = projectWith([node('n1', 'data.preview')])
  const baseFingerprint = await projectEditFingerprint(project)
  let asked = 0
  await runGraphPatch(
    project,
    { patch: { baseFingerprint, ops: [{ op: 'removeNode', id: 'n1' }] } },
    's6',
    { confirm: () => { asked += 1; return true }, write: () => ({ ok: true }), mode: 'smart' },
  )
  assert.equal(asked, 0)
})

test('完全访问权限档不会绕过该有的拦截：op 自己落不下去时，仍然一个字节都不写', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'data.preview')])
  const baseFingerprint = await projectEditFingerprint(project)
  let wrote = false
  const result = await runGraphPatch(
    project,
    {
      patch: {
        baseFingerprint,
        ops: [{ op: 'connect', source: 'n1', sourcePort: '没有这一列', target: 'n2', targetPort: 'data' }],
      },
    },
    'c9',
    { confirm: () => true, write: () => { wrote = true; return { ok: true } }, mode: 'full' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'E_UNKNOWN_PORT')
  assert.equal(wrote, false, '自动档省掉的是弹窗，不是校验')
})

test('撤销：先复核基线，再确认，再走记录里的反向动作', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' })])
  const baseFingerprint = await projectEditFingerprint(project)
  let undone = 0
  const stale = await runGraphUndo(project, { baseFingerprint: 'sha256:stale' }, 'u1', {
    confirm: () => true,
    undo: async () => { undone += 1; return { ok: true } },
  })
  assert.equal(stale.error?.code, 'E_PATCH_BASE_MISMATCH')
  assert.equal(undone, 0, '基线不符时不该动工程')

  const ok = await runGraphUndo(project, { baseFingerprint }, 'u2', {
    confirm: () => false,
    undo: async () => { undone += 1; return { ok: true } },
  })
  assert.equal(ok.status, 'rejected')
  assert.equal(undone, 0, '人没确认时不该动工程')

  const done = await runGraphUndo(project, { baseFingerprint }, 'u3', {
    confirm: () => true,
    undo: async () => { undone += 1; return { ok: true, changes: ['撤回了 1 处'] } },
  })
  assert.equal(done.ok, true)
  assert.equal(undone, 1)
})

test('撤销也可以走完全访问权限档：基线不对照样停，对了一句话不问就撤', async () => {
  const project = projectWith([node('n1', 'data.source', { datasetId: 'ds-1' })])
  const baseFingerprint = await projectEditFingerprint(project)
  let asked = 0
  let undone = 0
  const done = await runGraphUndo(project, { baseFingerprint }, 'u4', {
    confirm: () => { asked += 1; return true },
    undo: async () => { undone += 1; return { ok: true, changes: ['撤回了 1 处'] } },
    mode: 'full',
  })
  assert.equal(done.ok, true)
  assert.equal(asked, 0)
  assert.equal(undone, 1)

  const stale = await runGraphUndo(project, { baseFingerprint: 'sha256:stale' }, 'u5', {
    confirm: () => true,
    undo: async () => { undone += 1; return { ok: true } },
    mode: 'full',
  })
  assert.equal(stale.error?.code, 'E_PATCH_BASE_MISMATCH')
  assert.equal(undone, 1, '自动档省掉的是弹窗，不是基线复核')
})

test('diff 太长时截断，并说清截了多少', () => {
  const long = Array.from({ length: 400 }, (_, i) => `+ 第 ${i} 行`).join('\n')
  const short = shortDiff(long)
  assert.ok(short.split('\n').length < 200)
  assert.match(short, /还有 240 行没显示/)
})
