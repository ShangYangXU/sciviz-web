import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildInputBindings,
  isEngineNode,
  needsUserFn,
  nodeFingerprint,
  outputPortSpecs,
  planEvaluation,
  selectModelArtifact,
  trainingIdentity,
} from './plan'
import type { PortContext } from '../workflow/ports'
import { allNodeDefs } from '../workflow/nodeRegistry'
import { createGroupFromSelection, expandWorkflowGroups, runtimeNodeIdForPath } from '../workflow/groups'
import type { NodeRuntime } from './protocol'
import type { Workflow, WorkflowNode } from '../workflow/types'

const node = (
  id: string,
  type: string,
  params: Record<string, string | number | boolean> = {},
): WorkflowNode => ({ id, type, label: id, params, position: { x: 0, y: 0 } })

type EdgeTuple = [source: string, sourcePort: string, target: string, targetPort: string]

const wf = (nodes: WorkflowNode[], edges: EdgeTuple[]): Workflow => ({
  id: 'w',
  name: 'w',
  description: '',
  nodes,
  edges: edges.map(([source, sourcePort, target, targetPort]) => ({
    id: `${source}|${sourcePort}|${target}|${targetPort}`,
    source,
    sourcePort,
    target,
    targetPort,
  })),
})

const ctxWith = (features: string[] = ['a', 'b'], time: string | null = null): PortContext => ({
  featuresOf: () => features,
  timeColumnOf: () => time,
})

const FN = 'def f(x, th=0.5):\n    return {"y": x}\n'

test('参数中文短注释不改变计算指纹', () => {
  const plain = node('fn', 'custom.script', { code: FN, th: 0.5 })
  const annotated = { ...plain, paramNotes: { th: '判断阈值' } }
  assert.equal(
    nodeFingerprint(plain, {}, {}, ctxWith()),
    nodeFingerprint(annotated, {}, {}, ctxWith()),
  )
})
const runtime = (over: Partial<NodeRuntime> = {}): NodeRuntime => ({
  status: 'ready',
  outputVersion: 1,
  inputsFingerprint: null,
  ...over,
})

const TRAIN_FUNCTION_CODE =
  'def fit_model(model_factory, train_data, test_data, device, env, epochs=1):\n' +
  '    return {"metrics": {"轮次": epochs}}\n'

/* ------------------------------------------------------------------ */
/* 输入绑定                                                            */
/* ------------------------------------------------------------------ */

test('接了线就用上游，没接线的形参用代码里的默认值', () => {
  const fn = node('fn', 'custom.script', { code: FN })
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const w = wf([src, fn], [['src', 'a', 'fn', 'x']])

  const { inputs, missing } = buildInputBindings(fn, w, ctxWith())
  assert.deepEqual(inputs.x, { kind: 'port', nodeId: 'src', portId: 'a' })
  // 关键：默认值不在 node.params 里，只能从端口的 paramSpec 兜底
  assert.deepEqual(inputs.th, { kind: 'literal', value: 0.5 })
  assert.deepEqual(missing, [])
})

test('用户在节点上改过的形参优先于代码默认值', () => {
  const fn = node('fn', 'custom.script', { code: FN, th: 0.9 })
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const w = wf([src, fn], [['src', 'a', 'fn', 'x']])

  const { inputs } = buildInputBindings(fn, w, ctxWith())
  assert.deepEqual(inputs.th, { kind: 'literal', value: 0.9 })
})

test('无默认值又没接线 → 计入缺失，而不是悄悄给个 undefined', () => {
  const fn = node('fn', 'custom.script', { code: 'def f(x, y):\n    return {"z": x}\n' })
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const w = wf([src, fn], [['src', 'a', 'fn', 'x']])

  const { missing } = buildInputBindings(fn, w, ctxWith())
  assert.deepEqual(missing, ['y'])
})

test('数据源没有输入端口，不会凭空报缺失', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const { inputs, missing } = buildInputBindings(src, wf([src], []), ctxWith())
  assert.deepEqual(inputs, {})
  assert.deepEqual(missing, [])
})

test('数据源不论是否绑定数据集都只有一个整表端口', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const specs = outputPortSpecs(src, ctxWith(['a', 'b'], 't'))
  assert.deepEqual(
    specs.map((s) => [s.id, s.shape]),
    [['__table__', 'table']],
  )
  assert.deepEqual(outputPortSpecs(node('unbound', 'data.source'), ctxWith([], null)).map((p) => p.id), [
    '__table__',
  ])
})

test('显式启动节点在未请求时进入 deferred，请求后才进入求值队列', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const model = node('model', 'custom.model', { code: 'class Model:\n    pass\n' })
  const trainer = node('trainer', 'train.function', { code: TRAIN_FUNCTION_CODE, device: 'cpu' })
  const workflow = wf(
    [src, model, trainer],
    [
      ['src', '__table__', 'trainer', 'train'],
      ['model', 'model', 'trainer', 'model'],
    ],
  )
  const deferred = planEvaluation(
    workflow,
    {},
    ctxWith(),
    {},
    (candidate) => candidate.id === 'trainer' ? '等待点击开始训练' : null,
  )
  assert.deepEqual(deferred.deferred.map((item) => item.node.id), ['trainer'])
  assert.equal(deferred.evaluate.some((item) => item.node.id === 'trainer'), false)

  const started = planEvaluation(workflow, {}, ctxWith(), {}, () => null)
  assert.equal(started.evaluate.some((item) => item.node.id === 'trainer'), true)
})

/* ------------------------------------------------------------------ */
/* 输入指纹                                                            */
/* ------------------------------------------------------------------ */

test('指纹对"参数变化"敏感', () => {
  const fn = node('fn', 'custom.script', { code: FN })
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const w = wf([src, fn], [['src', 'a', 'fn', 'x']])
  const ctx = ctxWith()
  const { inputs } = buildInputBindings(fn, w, ctx)

  const before = nodeFingerprint(fn, inputs, { src: 1 }, ctx)
  const after = nodeFingerprint({ ...fn, params: { ...fn.params, th: 2 } }, inputs, { src: 1 }, ctx)
  assert.notEqual(before, after)
})

/**
 * 数据源的指纹必须认**数据内容**，不只是列名与时间列。
 *
 * 只认列的话，"换了一份数据、但列一样"时指纹一模一样，界面会把上一次的结果继续当成
 * 这一次的结果显示（图、参数、列、时间列全都对，只有数是别人的 —— 契约规格 R3.2）。
 * 这条也是跨运行缓存的前提：缓存键若认不出数据换了，复用就是拿旧数据冒充新数据。
 */
test('指纹对"数据集内容"敏感 —— 换数据不换列也必须变', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const a = { ...ctxWith(), contentHashOf: () => 'sha256:aaa' }
  const b = { ...ctxWith(), contentHashOf: () => 'sha256:bbb' }
  assert.notEqual(nodeFingerprint(src, {}, {}, a), nodeFingerprint(src, {}, {}, b))

  // 拿不到哈希时退化成旧行为（而不是编一个值出来）：指纹里这一项为空，仍然是稳定的
  const unknown = ctxWith()
  assert.equal(nodeFingerprint(src, {}, {}, unknown), nodeFingerprint(src, {}, {}, unknown))
  assert.notEqual(nodeFingerprint(src, {}, {}, unknown), nodeFingerprint(src, {}, {}, a))
})

test('指纹对"上游版本变化"敏感', () => {
  const fn = node('fn', 'custom.script', { code: FN })
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const w = wf([src, fn], [['src', 'a', 'fn', 'x']])
  const ctx = ctxWith()
  const { inputs } = buildInputBindings(fn, w, ctx)

  assert.notEqual(
    nodeFingerprint(fn, inputs, { src: 1 }, ctx),
    nodeFingerprint(fn, inputs, { src: 2 }, ctx),
  )
})

/**
 * 指纹必须**沿着链路认内容**，不能只认"上游的版本号"。
 *
 * 版本号在每次会话里都从 1 重新数：两张图只要结构相同，节点的下游指纹就一模一样 ——
 * 哪怕上游喂的根本是两份不同的数据。这个缺陷在加跨运行缓存时当场露了出来：
 * 两个不同的实验（同一份 CSV 的不同列、不同窗长）里，"时域特征"被判成同一份缓存，
 * 于是第二个实验直接拿到了第一个实验的数，而清单、日志、数字看起来全都正常。
 */
test('指纹沿链路认上游内容：上游数据不同，下游指纹必须不同', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const win = node('win', 'data.preview')
  const feat = node('feat', 'data.preview')
  const w = wf([src, win, feat], [['src', '__table__', 'win', 'data'], ['win', 'data', 'feat', 'data']])

  const ctxA = { ...ctxWith(), contentHashOf: () => 'sha256:AAA' }
  const ctxB = { ...ctxWith(), contentHashOf: () => 'sha256:BBB' }

  const srcA = nodeFingerprint(src, {}, {}, ctxA)
  const srcB = nodeFingerprint(src, {}, {}, ctxB)
  assert.notEqual(srcA, srcB, '数据源自己就该认出数据换了')

  const winA = nodeFingerprint(win, { data: { kind: 'port', nodeId: 'src', portId: '__table__' } }, { src: 1 }, ctxA, () => srcA)
  const winB = nodeFingerprint(win, { data: { kind: 'port', nodeId: 'src', portId: '__table__' } }, { src: 1 }, ctxB, () => srcB)
  assert.notEqual(winA, winB)

  const featInputs = { data: { kind: 'port' as const, nodeId: 'win', portId: 'data' } }
  const featA = nodeFingerprint(feat, featInputs, { win: 1 }, ctxA, (id) => (id === 'win' ? winA : null))
  const featB = nodeFingerprint(feat, featInputs, { win: 1 }, ctxB, (id) => (id === 'win' ? winB : null))
  assert.notEqual(featA, featB, '下游必须跟着变 —— 同一个版本号不等于同一份输入')

  // 而"上游确实换了内容"这件事在版本号里是看不出来的：两条链路的版本号都是 1
  assert.equal(w.edges.length, 2)
})

test('指纹对"无关节点变化"不敏感 —— 否则整张图会跟着一起重算', () => {
  const fn = node('fn', 'custom.script', { code: FN })
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const w = wf([src, fn], [['src', 'a', 'fn', 'x']])
  const ctx = ctxWith()
  const { inputs } = buildInputBindings(fn, w, ctx)

  assert.equal(
    nodeFingerprint(fn, inputs, { src: 1 }, ctx),
    nodeFingerprint(fn, inputs, { src: 1, unrelated: 77 }, ctx),
  )
})

test('版面挪动不进指纹：同一个算子换了个位置，还是同一个算子', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const fn = node('fn', 'custom.script', { code: FN })
  const ctx = ctxWith()
  const loose = wf([src, fn], [['src', 'a', 'fn', 'x']])
  const moved: typeof loose = {
    ...loose,
    nodes: [
      { ...src, position: { x: 999, y: 999 } },
      { ...fn, position: { x: 0, y: 0 } },
    ],
  }
  const fingerprintOf = (workflow: typeof loose) => {
    const { inputs } = buildInputBindings(fn, workflow, ctx)
    return nodeFingerprint(workflow.nodes[1], inputs, { src: 1 }, ctx)
  }
  assert.equal(
    fingerprintOf(loose),
    fingerprintOf(moved),
    '位置只是版面：挪一下不该让上一个结果失效（更不该触发重算）',
  )
})

test('封装进组块不进指纹：块换了个位置，计算没换', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  // th 用代码里的默认值、没写进 params —— 封装会给它提升一个对外参数，
  // 但对外值就是同一份默认值，所以有效值没变，指纹也不该变
  const fn = node('fn', 'custom.script', { code: FN })
  const ctx = ctxWith()
  const loose = wf([src, fn], [['src', 'a', 'fn', 'x']])
  const fingerprintOf = (workflow: Workflow, nodeId: string, versions: Record<string, number>) => {
    const target = workflow.nodes.find((candidate) => candidate.id === nodeId)!
    const { inputs } = buildInputBindings(target, workflow, ctx)
    return nodeFingerprint(target, inputs, versions, ctx, () => 'upstream-fp')
  }

  const before = fingerprintOf(loose, 'fn', { src: 1 })
  const grouped = createGroupFromSelection(loose, ['src', 'fn'], ctx, 'g1', '训练组').workflow
  const inner = expandWorkflowGroups(grouped)
  const innerSrc = runtimeNodeIdForPath(['g1'], 'src')
  const innerFn = runtimeNodeIdForPath(['g1'], 'fn')

  assert.equal(
    fingerprintOf(inner, innerFn, { [innerSrc]: 1 }),
    before,
    '位置进指纹的后果是"训好的权重认不出自己"：工程引用与宿主 meta.json 都按指纹严格比对',
  )
})

test('制品匹配看"同一个计算的身份"：老指纹里的组路径不算内容', () => {
  const oldStyle = 'train.mlp\u0002epochs=50\u0002train=port:group:["g1"]:"n1":__table__@up#1'
  const newStyle = 'train.mlp\u0002epochs=50\u0002train=port:n1:__table__@up#1'

  assert.equal(
    trainingIdentity(oldStyle),
    trainingIdentity(newStyle),
    '同一个块换个位置放，权重还该认得它（2026-09-21 之前的指纹里写着运行时 id）',
  )
  assert.equal(
    trainingIdentity(trainingIdentity(newStyle)),
    trainingIdentity(newStyle),
    '归一是一次性的：同一个指纹归一两次还是同一个身份',
  )
  assert.notEqual(
    trainingIdentity(oldStyle),
    trainingIdentity('train.mlp\u0002epochs=99\u0002train=port:group:["g1"]:"n1":__table__@up#1'),
    '位置以外的差别照旧算不同 —— 抹掉的只是位置',
  )
  assert.equal(
    trainingIdentity('train.mlp\u0002epochs=50\u0001train=port:n1:__table__@up#1'),
    trainingIdentity('train.mlp\u0002epochs=50\u0001train=port:n1:__table__@up#7'),
    '会话内"第几次算"也不是内容：它每次开工程都从 1 重新数，拿它比对等于要求训练那天上游刚好只算过一遍',
  )
  assert.ok(
    trainingIdentity('train.mlp\u0002label="液位#1"').includes('液位#1'),
    '参数值里的 #1 不能被当成版本号抹掉（版本号后面一定跟分隔符或结尾）',
  )
})

/*
 * 2026-09-22：这一步进指纹是为了缓存与复现，但**不能进制品身份**。
 * 反例是当天实测的：宿主侧实现一改，`impl=` 就变，工程里所有训练节点的引用当场
 * 全部"不匹配"，节点回到"等待开始训练"，下游评估/图表块跟着停摆 —— 而用户自己的
 * 参数、代码、数据一个字节都没动。这里把"实现变了仍认得自己"钉住。
 */
test('制品匹配不看算子实现哈希：我们自己改一次算子，用户训好的权重还认得自己', () => {
  const HASH_A = '4945d798cab797340752c3bf7fabae2174b828dab4dccf6a2513f0742e20fe74'
  const HASH_B = '4f20827a98dccc32965914b87dac045894b7eed4fd9d974229050fac91576031'
  const NESTED_A = 'be5c486a59422fa28eb63ec24c78b6268d10d8684e3b5381dbae4e658efc74d2'
  const NESTED_B = '8983eee514ea019543cc5bca5b9a91d4c96c336865412a33491a32c34f943b41'
  const fingerprint = (impl: string, upstreamImpl: string) =>
    `train.function\u0002impl=${impl}\u0002epochs=50\u0001train=port:n1:__table__@train.function\u0002impl=${upstreamImpl}\u0002code="def fit_model(...)"#1`

  const before = fingerprint(HASH_A, NESTED_A)
  const after = fingerprint(HASH_B, NESTED_B)

  assert.notEqual(before, after, '指纹本身必须变：实现换了，缓存与清单要能看出来')
  assert.equal(
    trainingIdentity(before),
    trainingIdentity(after),
    '但制品身份不该变：这份权重还是同一个实验算出来的',
  )
  const normalized = trainingIdentity(before)
  assert.ok(normalized.includes('epochs=50'), '参数留在身份里')
  assert.ok(normalized.includes('code="def fit_model(...)"'), '用户代码留在身份里')
  assert.ok(normalized.includes('port:n1:__table__'), '上游身份留在身份里')
  assert.equal(/[0-9a-f]{64}/.test(normalized), false, '实现哈希被抹干净（两层都抹）')

  // 参数、上游身份这些是内容，照旧算得上差别 —— 归一不是"什么都认"
  assert.notEqual(
    trainingIdentity(before),
    trainingIdentity(fingerprint(HASH_B, NESTED_B).replace('epochs=50', 'epochs=99')),
    '参数变了就是另一次计算',
  )
  assert.notEqual(
    trainingIdentity(before),
    trainingIdentity(fingerprint(HASH_B, NESTED_B).replace('port:n1:', 'port:n2:')),
    '上游换成另一个块，也不是同一次计算',
  )

  // 同一条规则要能从"工程里的旧引用"找到"今天的指纹" —— 这正是重开工程时发生的事
  const refs = [{ nodeId: 'n2', trainingFingerprint: before, artifactId: 'old-artifact' }]
  assert.equal(
    selectModelArtifact(refs, 'n2', after)?.artifactId,
    'old-artifact',
    '实现变过一次之后，旧引用仍然要被选中（否则用户只能重训）',
  )
  assert.equal(selectModelArtifact(refs, 'n3', after), undefined, '别的节点仍然不许串过来')
})

test('挑制品：只认同一个节点 + 同一个计算，同指纹多次训练取最近那条', () => {
  const refs = [
    { nodeId: 'n2', trainingFingerprint: 'fp-a', artifactId: '1' },
    { nodeId: 'n3', trainingFingerprint: 'fp-a', artifactId: '2' },
    { nodeId: 'n2', trainingFingerprint: 'fp-a', artifactId: '3' },
    { nodeId: 'n2', trainingFingerprint: 'fp-b', artifactId: '4' },
  ]

  assert.equal(selectModelArtifact(refs, 'n2', 'fp-a')?.artifactId, '3', '同节点同指纹取最后一条')
  assert.equal(selectModelArtifact(refs, 'n3', 'fp-a')?.artifactId, '2', '别的节点的引用不能串过来')
  assert.equal(selectModelArtifact(refs, 'n2', 'fp-c'), undefined, '对不上就是没有，不猜')
  assert.equal(selectModelArtifact([], 'n2', 'fp-a'), undefined)
})

test('数据源的指纹必须并入启用列与时间列（它们在数据面板里，不在节点参数里）', () => {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const fp = (features: string[], time: string | null) =>
    nodeFingerprint(src, {}, {}, ctxWith(features, time))

  assert.notEqual(fp(['a', 'b'], null), fp(['a'], null), '关掉一列必须触发重算')
  assert.notEqual(fp(['a'], null), fp(['a'], 't'), '出现时间列必须触发重算')
  assert.equal(fp(['a', 'b'], 't'), fp(['a', 'b'], 't'))
})

/* ------------------------------------------------------------------ */
/* 求值计划                                                            */
/* ------------------------------------------------------------------ */

/** 源 → 列拼表 → 函数 → 预览 */
function chain() {
  const src = node('src', 'data.source', { datasetId: 'd1' })
  const collect = node('collect', 'data.collect')
  const fn = node('fn', 'custom.script', { code: FN })
  const prev = node('prev', 'data.preview', { rows: 5 })
  const w = wf(
    [src, collect, fn, prev],
    [
      // 两根线接在同一个多入端口上（契约规格 R13）：先后 = 拼出来的列序
      ['src', 'a', 'collect', 'in'],
      ['src', 'b', 'collect', 'in'],
      ['collect', 'data', 'fn', 'x'],
      ['fn', 'y', 'prev', 'data'],
    ],
  )
  return { w, src, collect, fn, prev }
}

/*
 * 多入端口（R13）的两条判据。
 *
 * 第一条防的是"第二根线被丢掉"：拼表只吃到 a，出来的表少一列，而图上明明接了两根线。
 * 第二条防的是更隐蔽的一种：两路都吃了，但顺序按字典序或按完成先后重排过 ——
 * 那会让"先接 a 后接 b"与"先接 b 后接 a"算出同一个指纹，于是换了列序**不重算**，
 * 界面继续把旧列序的结果显示成最新。
 */
test('多入端口：一个端口拿到全部连线，按连线先后成列表', () => {
  const { w } = chain()
  const plan = planEvaluation(w, {}, ctxWith(), {})
  const collect = plan.evaluate.find((i) => i.node.id === 'collect')
  assert.ok(collect, '列拼表该被求值')
  const bound = collect.inputs.in
  assert.ok(Array.isArray(bound), `多入端口的值该是列表，实际是 ${JSON.stringify(bound)}`)
  assert.deepEqual(
    (bound as { portId: string }[]).map((b) => b.portId),
    ['a', 'b'],
    '顺序就是连线在图里的先后',
  )
})

test('多入端口：换连线先后必须换指纹（否则换列序不会重算）', () => {
  const { w } = chain()
  const swapped = wf(
    w.nodes,
    [
      ['src', 'b', 'collect', 'in'],
      ['src', 'a', 'collect', 'in'],
      ['collect', 'data', 'fn', 'x'],
      ['fn', 'y', 'prev', 'data'],
    ],
  )
  const fp = (workflow: typeof w) =>
    planEvaluation(workflow, {}, ctxWith(), {}).evaluate.find((i) => i.node.id === 'collect')?.fingerprint
  assert.ok(fp(w) && fp(swapped))
  assert.notEqual(fp(w), fp(swapped), '两路换了先后，指纹必须不同 —— 不然换列序就不重算了')
})

test('全新工作流：链路全算一遍，且每个节点只出现一次', () => {
  const { w } = chain()
  const plan = planEvaluation(w, {}, ctxWith(), {})
  assert.deepEqual(
    plan.evaluate.map((i) => i.node.id),
    ['src', 'collect', 'fn', 'prev'],
  )
  assert.equal(new Set(plan.evaluate.map((i) => i.node.id)).size, 4)
})

/**
 * 假设整条链已经**跑到不动**（与核的定点循环一致）。
 *
 * 要点是它必须迭代：一次 plan 只推进一层 —— 下游这一轮拿到的还是"上游上一次的指纹"，
 * 上游这一轮更新完，下游要下一轮才跟着变。迭代到"没有要算的"为止，才是真的整齐状态。
 */
function settle(w: Workflow, ctx: PortContext, versions: Record<string, number>) {
  let runtimes: Record<string, NodeRuntime> = {}
  for (let round = 0; round < 12; round += 1) {
    const plan = planEvaluation(w, runtimes, ctx, versions)
    if (plan.evaluate.length === 0) break
    for (const item of plan.evaluate) {
      runtimes[item.node.id] = runtime({ inputsFingerprint: item.fingerprint })
    }
  }
  return runtimes
}

const withParam = (w: Workflow, id: string, key: string, value: string | number | boolean): Workflow => ({
  ...w,
  nodes: w.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, [key]: value } } : n)),
})

test('整齐状态下改一个参数：单次 plan 只推进一层，源与列拼表不动', () => {
  const { w } = chain()
  const ctx = ctxWith()
  const V = { src: 1, collect: 1, fn: 1, prev: 1 }
  const runtimes = settle(w, ctx, V)

  const plan = planEvaluation(withParam(w, 'fn', 'th', 0.7), runtimes, ctx, V)
  assert.deepEqual(
    plan.evaluate.map((i) => i.node.id),
    ['fn'],
  )
  assert.deepEqual(plan.unchanged.sort(), ['collect', 'prev', 'src'])
})

test('只改训练后的绘图设置不会让模型节点失效或重训', () => {
  const source = node('src', 'data.source', { datasetId: 'd1' })
  const trainer = node('trainer', 'train.mlp', { label: 'b', epochs: 2, seed: 7 })
  const chart = node('chart', 'viz.chart', { chartType: 'line', title: '训练曲线' })
  const workflow = wf(
    [source, trainer, chart],
    [
      ['src', '__table__', 'trainer', 'train'],
      ['trainer', 'history', 'chart', 'data'],
    ],
  )
  const ctx = ctxWith()
  const versions: Record<string, number> = { src: 1, trainer: 1, chart: 1 }
  const runtimes = settle(workflow, ctx, versions)

  const changedDrawing = withParam(workflow, 'chart', 'chartType', 'scatter')
  const plan = planEvaluation(changedDrawing, runtimes, ctx, versions)
  assert.deepEqual(plan.evaluate.map((item) => item.node.id), ['chart'])
  assert.equal(plan.unchanged.includes('trainer'), true)
})

test('级联靠 runner 反复 plan 推到底：改一个参数，最终只重算它和它的下游', () => {
  const { w } = chain()
  const ctx = ctxWith()
  const V: Record<string, number> = { src: 1, collect: 1, fn: 1, prev: 1 }
  const runtimes = settle(w, ctx, V)

  // 模拟 runner 的定点循环：求值成功 → 版本 +1 → 再 plan，直到没有要算的
  const graph = withParam(w, 'fn', 'th', 0.7)
  const computed: string[] = []
  for (let round = 0; round < 10; round++) {
    const plan = planEvaluation(graph, runtimes, ctx, V)
    if (plan.evaluate.length === 0) break
    for (const item of plan.evaluate) {
      computed.push(item.node.id)
      V[item.node.id] = (V[item.node.id] ?? 0) + 1
      runtimes[item.node.id] = runtime({ inputsFingerprint: item.fingerprint })
    }
  }

  assert.deepEqual(computed, ['fn', 'prev'])
  assert.equal(V.src, 1, '源不该被重算')
  assert.equal(V.collect, 1, '列拼表不该被重算')
})

test('一切都没变：一个节点都不重算', () => {
  const { w } = chain()
  const ctx = ctxWith()
  const V = { src: 1, collect: 2, fn: 3, prev: 4 }
  const runtimes = settle(w, ctx, V)

  const plan = planEvaluation(w, runtimes, ctx, V)
  assert.deepEqual(plan.evaluate, [])
  assert.deepEqual(plan.unchanged.sort(), ['collect', 'fn', 'prev', 'src'])
})

test('上游出错且指纹未变 → 下游标 blocked，不拿旧值当新值', () => {
  const { w } = chain()
  const ctx = ctxWith()
  const V = { src: 1, collect: 1, fn: 1, prev: 1 }
  const runtimes = settle(w, ctx, V)
  runtimes.collect = runtime({ inputsFingerprint: runtimes.collect.inputsFingerprint, status: 'error' })

  const plan = planEvaluation(w, runtimes, ctx, V)
  assert.deepEqual(plan.evaluate, [])
  assert.deepEqual(plan.blocked.map((b) => b.node.id).sort(), ['fn', 'prev'])
  assert.match(plan.blocked[0].reason, /上游/)
})

test('上游只是"还没开始"（等显式启动）时，原因不能说成"出错"', () => {
  /*
   * 训练块默认不会自己跑（要用户点「开始训练」），它的下游因此被挡住。
   * 这不是错误，而此前规划这一侧把 `manual` 一律说成"上游…出错"，
   * 于是一张健康的图看起来像坏了 —— 用户会去查一个根本不存在的错误。
   */
  const { w } = chain()
  const ctx = ctxWith()
  const V = { src: 1, collect: 1, fn: 1, prev: 1 }

  // 空运行时：这一轮里 `collect` 真的会被规划到，然后被延后（等用户点「开始训练」）
  const plan = planEvaluation(w, {}, ctx, V, (candidate) =>
    candidate.id === 'collect' ? '等待点击「开始训练」' : null,
  )

  const blockedFn = plan.blocked.find((entry) => entry.node.id === 'fn')
  assert.ok(blockedFn, '下游应当被挡住')
  assert.match(blockedFn.reason, /还没开始/)
  assert.match(blockedFn.reason, /开始训练/)
  assert.doesNotMatch(blockedFn.reason, /出错/)
})

test('上游修好后（指纹变了）链路能自己活过来', () => {
  const { w } = chain()
  const ctx = ctxWith()
  const V = { src: 1, collect: 1, fn: 1, prev: 1 }
  const runtimes = settle(w, ctx, V)
  runtimes.collect = runtime({ inputsFingerprint: 'stale', status: 'error' })

  const plan = planEvaluation(w, runtimes, ctx, V)
  /*
   * 与"改一个参数只推进一层"不同：这一次变的是**上游自己被记下的输入**（'stale'），
   * 而指纹是沿链路认内容的 —— 下游当场就看到"我的输入不再是原来那份"，
   * 于是同一轮里一起被规划。核按拓扑序先算上游，下游拿到的是刚算出来的新输入，
   * 不会拿旧值凑合（真有算不出来的上游，求值前那道 badUpstream 检查会拦住它）。
   */
  assert.deepEqual(
    plan.evaluate.map((i) => i.node.id),
    ['collect', 'fn'],
  )
  assert.deepEqual(plan.blocked, [])
  assert.deepEqual(plan.unchanged.sort(), ['prev', 'src'])
})

test('自定义模型节点由真实宿主引擎计算', () => {
  assert.equal(isEngineNode('custom.model'), true)
  assert.equal(isEngineNode('train.custom'), true)

  const plan = planEvaluation(wf([node('model', 'custom.model')], []), {}, ctxWith(), {})
  assert.deepEqual(plan.manual, [])
})

test('执行等级由算子清单声明：当前功能全部进入真实引擎', () => {
  assert.equal(isEngineNode('data.source'), true)
  assert.equal(isEngineNode('data.collect'), true)
  assert.equal(isEngineNode('data.preview'), true)
  assert.equal(isEngineNode('custom.script'), true)
  assert.equal(isEngineNode('custom.model'), true)
  assert.equal(isEngineNode('custom.chart'), true)
  assert.equal(isEngineNode('train.custom'), true)
  // 普通图表与概率密度图都从输入端口取得实际数据，由引擎生成 figure。
  assert.equal(isEngineNode('viz.chart'), true)
  /*
   * 密度图 2026-09-14 起进数据面。它原先在主线程靠连线**反查一个数据集 id**，
   * 那有两个后果：隔着一个函数/拆列节点就反查不到（点了运行也什么都不出），
   * 而反查成功时画的是那份数据集**全量**的分布 —— 用户筛完全量再画，看到的仍是筛之前的曲线。
   * 抽稀与"画哪一列"现在都在数据那一侧算，主线程只剩把结果包成图。
   */
  assert.equal(isEngineNode('viz.density'), true, '密度图接上线就该算，不该等一次运行')
})

/**
 * R1 那条债的守卫：**判据只有清单一处**。
 *
 * 白名单与注册表并存时，"新增算子必须同时改两处"靠的是纪律；纪律靠不住，
 * 漏改的表现还是静默的（节点看起来能跑、其实不走真引擎）。这条测试把
 * 「isEngineNode 必须与清单的 runtimeClass 一致」钉死：
 * 谁再引入第二处清单，只要它开始与清单不一致，这里就红。
 */
test('执行等级只有清单一处声明：每个算子都必须声明，且 isEngineNode 与之一致', () => {
  const defs = allNodeDefs()
  assert.ok(defs.length >= 10, '算子清单看起来没取到')
  for (const def of defs) {
    assert.ok(
      def.runtimeClass === 'engine',
      `${def.type} 没声明 runtimeClass`,
    )
    assert.equal(
      isEngineNode(def.type),
      def.runtimeClass === 'engine',
      `${def.type} 的 isEngineNode 与清单声明不一致 —— 说明又出现了第二处判据`,
    )
  }
})

test('只有函数节点需要先把用户代码编译进引擎', () => {
  assert.equal(needsUserFn('custom.script'), true)
  assert.equal(needsUserFn('custom.chart'), true)
  assert.equal(needsUserFn('train.function'), true)
  // 预设算子不应被当成用户函数加载。
  for (const type of [
    'data.source',
    'data.collect',
    'data.preview',
    'viz.chart',
    'viz.density',
  ]) {
    assert.equal(needsUserFn(type), false, `${type} 是内置算子，不该去解析用户代码`)
  }
})
