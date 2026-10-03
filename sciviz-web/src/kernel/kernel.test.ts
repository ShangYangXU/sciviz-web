import test from 'node:test'
import assert from 'node:assert/strict'
import { DatasetCatalog, buildDatasetRef } from './dataset'
import { runGraph } from './kernel'
import type { KernelAdapter } from './types'
import { CancelledError, EngineError } from '../engine/errors'
import type { StoredDataset } from '../data/columnStore'
import type {
  ArtifactRef,
  DatasetPayload,
  EvalResult,
  NodeMeta,
  NodeResultRefsBody,
} from '../engine/protocol'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../workflow/types'
import { createGroupFromSelection, runtimeNodeIdForPath } from '../workflow/groups'

/**
 * 无头核的行为钉子。
 *
 * 这里守的是**调度语义**，不是某个算子算得对不对（那是 verify-operator-truth 的事）：
 * 谁该重算、谁该被拦住、失败之后版本号加不加、换了数据要不要重送。
 * 这四件事错了都不会报错，只会给出一个看起来正常的错结果 —— 所以必须有测试。
 */

const node = (id: string, type: string, params: Record<string, string | number | boolean> = {}): WorkflowNode => ({
  id,
  type,
  label: id,
  params,
  position: { x: 0, y: 0 },
})

const edge = (source: string, sourcePort: string, target: string, targetPort: string): WorkflowEdge => ({
  id: `${source}|${sourcePort}|${target}|${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
})

const wf = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []): Workflow => ({
  id: 'wf',
  name: '测试图',
  description: '',
  nodes,
  edges,
})

function dataset(id: string, cols: Record<string, number[]>, time?: number[]): StoredDataset {
  const names = Object.keys(cols)
  return {
    id,
    name: id,
    source: `${id}.csv`,
    importedAt: 0,
    rowCount: cols[names[0]]?.length ?? 0,
    timeColumn: time ? '时间' : null,
    time: time ? Float64Array.from(time) : null,
    stepSeconds: time && time.length > 1 ? 1 : null,
    columns: [
      ...(time
        ? [{ name: '时间', type: 'number' as const, role: 'time' as const, stats: stats(time), enabled: false }]
        : []),
      ...names.map((n) => ({
        name: n,
        type: 'number' as const,
        role: 'continuous' as const,
        stats: stats(cols[n]),
        enabled: true,
      })),
    ],
    data: Object.fromEntries(names.map((n) => [n, Float32Array.from(cols[n])])),
  }
}

const stats = (a: number[]) => ({
  min: Math.min(...a),
  max: Math.max(...a),
  mean: a.reduce((s, v) => s + v, 0) / a.length,
  zeros: a.filter((v) => v === 0).length,
  missing: 0,
  nonNumeric: 0,
})

/** 记录调用的假适配器。算不出真值的节点直接抛错，模拟"这一步是模拟实现" */
class FakeAdapter implements KernelAdapter {
  readonly datasetsSent: DatasetPayload[] = []
  readonly evals: string[] = []
  /** 每次求值的完整入参。拆列这类"端口由上游决定"的节点要靠它验证端口传对了没有 */
  readonly evalArgs: Array<{
    nodeId: string
    outputPorts: Array<{ id: string }>
    fingerprint?: string
    restoreArtifactId?: string
    restoreArtifactSha256?: string
    sampleRate?: number | null
    cacheable?: boolean
  }> = []
  /** 求值产出的摘要，模拟引擎侧的输出目录。columnsOf 从它读列名 */
  readonly refs: Record<string, NodeResultRefsBody> = {}
  /** 这些节点"这一次是复用缓存"（假适配器据此回 cached: true） */
  readonly reusedNodes = new Set<string>()
  readonly fns: string[] = []
  /** 节点类型 → 该节点产出哪些列。默认 ['a']，测试要更具体时覆盖它 */
  columnsFor: (nodeId: string) => string[] = () => ['a']
  failures = new Map<string, { message: string; traceback: string }>()
  /** 这些节点在被求值时"被取消"（模拟用户在长任务中间按了取消） */
  readonly cancelledNodes = new Set<string>()
  /** 这个节点会落盘哪些产物。默认没有 —— 只有训练才落盘 */
  artifactsFor: (nodeId: string) => ArtifactRef[] = () => []
  /** 这个节点自报的元信息（设备、版本…）。默认没有 */
  metaFor: (nodeId: string) => Record<string, string | number | boolean> = () => ({})
  counter = 0
  engineInfo = '假引擎'
  readyCalls = 0

  async ensureReady(): Promise<string> {
    this.readyCalls += 1
    return this.engineInfo
  }

  async setDataset(payload: DatasetPayload): Promise<void> {
    this.datasetsSent.push(payload)
  }

  async loadFn(nodeId: string, _code: string, _fnName: string): Promise<void> {
    this.fns.push(nodeId)
  }

  async evalNode(args: {
    nodeId: string
    nodeType: string
    outputPorts: Array<{ id: string }>
    fingerprint?: string
    restoreArtifactId?: string
    restoreArtifactSha256?: string
    sampleRate?: number | null
    cacheable?: boolean
  }): Promise<EvalResult> {
    this.evals.push(args.nodeId)
    this.evalArgs.push({
      nodeId: args.nodeId,
      outputPorts: args.outputPorts,
      fingerprint: args.fingerprint,
      restoreArtifactId: args.restoreArtifactId,
      restoreArtifactSha256: args.restoreArtifactSha256,
      sampleRate: args.sampleRate,
      cacheable: args.cacheable,
    })
    const failure = this.failures.get(args.nodeId)
    if (failure) {
      throw new EngineError(failure.message, failure.traceback)
    }
    if (this.cancelledNodes.has(args.nodeId)) {
      throw new CancelledError('已取消')
    }
    this.counter += 1
    // 按**被要求产出的端口**给摘要：真实引擎就是这么做的（outputPorts 由主线程传下去），
    // 假引擎要是自作主张给 'out'/'data'，就会掩盖"端口名对不上"这类真实故障
    const columns = this.columnsFor(args.nodeId)
    const portIds = args.outputPorts.length > 0 ? args.outputPorts.map((p) => p.id) : ['out']
    const body: NodeResultRefsBody = {}
    for (const id of portIds) {
      body[id] = { kind: 'table', rowCount: this.counter, columns }
    }
    this.refs[args.nodeId] = body
    return {
      refs: body,
      artifacts: this.artifactsFor(args.nodeId),
      meta: this.metaFor(args.nodeId),
      // 这个节点被要求"当作缓存命中"：核必须把这件事记进节点状态
      ...(this.reusedNodes.has(args.nodeId) ? { cached: true } : {}),
    }
  }

  async head(): Promise<never> {
    throw new Error('本测试不取行值')
  }

  dropNode(): void {}
}

async function setup(ds: StoredDataset[]): Promise<DatasetCatalog> {
  const catalog = new DatasetCatalog()
  for (const d of ds) catalog.add(d, await buildDatasetRef(d))
  return catalog
}

/** 测试用的算子事实：所有已注册算子都由真实引擎执行。 */
const factsOf = (_type: string) => ({
  version: '0.0.0-test',
  implementationHash: null,
  runtimeClass: 'engine' as const,
  determinism: 'deterministic' as const,
  execClass: 'interactive' as const,
  requires: null,
})

/** 造一个"只有宿主能跑"的算子：判据来自清单的 requires，不在核里写类型名 */
const hostOnlyFacts = (type: string) =>
  type === 'train.mlp'
    ? {
        ...factsOf(type),
        requires: {
          runtime: 'host' as const,
          packages: ['torch'],
          reason: '真训练要 torch：浏览器里的 Pyodide 没有它',
        },
      }
    : factsOf(type)

const depsOf = (adapter: FakeAdapter, catalog: DatasetCatalog) => ({
  adapter,
  datasets: catalog,
  ctx: catalog.portContext(),
  operatorOf: factsOf,
  clock: () => Date.now(),
})

const LINEAR = wf(
  [
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    node('n2', 'data.preview'),
    node('n3', 'data.preview'),
  ],
  [edge('n1', '__table__', 'n2', 'data'), edge('n2', 'head', 'n3', 'data')],
)

test('kernel runs grouped steps through the ordinary adapter with stable namespaced ids', async () => {
  const adapter = new FakeAdapter()
  const catalog = await setup([dataset('ds-1', { a: [1, 2] })])
  const grouped = createGroupFromSelection(LINEAR, ['n2'], catalog.portContext(), 'group-a').workflow

  const result = await runGraph(depsOf(adapter, catalog), grouped)
  const innerId = runtimeNodeIdForPath(['group-a'], 'n2')
  assert.deepEqual(adapter.evals, ['n1', innerId, 'n3'])
  assert.equal(result.runtimes[innerId]?.status, 'ready')
  assert.equal(result.runtimes.n3?.status, 'ready')
  assert.ok(result.workflow.nodes.every((entry) => entry.type !== 'workflow.group'))
})

const DSM = async () => setup([dataset('ds-1', { 液位: [1, 2, 3, 4], 流量: [5, 6, 7, 8] })])

/**
 * 拆列节点的端口**来自上游算出来的列**，所以它注定是"跑一次才长出来"的。
 *
 * 这个测试守的是那条时序：第一轮上游算完，第二轮拆列才拿得到端口并求值。
 * 如果调度只推一轮就停，用户看到的会是"节点一直空着"，而没有任何报错。
 */
test('拆列节点的端口在上游算完之后才存在，且第二轮就补上', async () => {
  const adapter = new FakeAdapter()
  adapter.columnsFor = (nodeId) => (nodeId === 'n1' ? ['液位', '流量'] : ['液位'])
  const catalog = await DSM()

  const graph = wf(
    [node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'data.columns', {})],
    [edge('n1', '__table__', 'n2', 'data')],
  )

  // 和界面一样：列名从"上一次求值的输出摘要"里读，而不是另算一遍
  const deps = depsOf(adapter, catalog)
  deps.ctx = {
    ...catalog.portContext(),
    columnsOf: (nodeId, portId) => {
      const e = graph.edges.find((x) => x.target === nodeId && x.targetPort === portId)
      if (!e) return null
      const ref = adapter.refs[e.source]?.[e.sourcePort] as { columns?: string[] } | undefined
      return ref?.columns?.length ? ref.columns : null
    },
  }

  const result = await runGraph(deps, graph)

  assert.deepEqual(adapter.evals, ['n1', 'n2'], '上游必须先算，拆列才拿得到列名')
  const splitCall = adapter.evalArgs.find((a) => a.nodeId === 'n2')
  assert.deepEqual(
    splitCall?.outputPorts.map((p) => p.id),
    ['液位', '流量'],
    '拆列的端口必须等于上游实际的列',
  )
  assert.equal(result.runtimes.n2.status, 'ready')
})

test('一条链路全算一遍，每个节点恰好一次，版本号从 1 开始', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const result = await runGraph(depsOf(adapter, catalog), LINEAR)

  assert.deepEqual(adapter.evals, ['n1', 'n2', 'n3'])
  assert.equal(result.runtimes.n1.status, 'ready')
  assert.equal(result.runtimes.n3.status, 'ready')
  for (const id of ['n1', 'n2', 'n3']) assert.equal(result.runtimes[id].outputVersion, 1)
  assert.deepEqual(result.jobs.map((j) => j.status), ['done', 'done', 'done'])
  assert.equal(result.engineInfo, '假引擎')
})

test('数据集只在第一次送进引擎（同一次运行内不重复送）', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  await runGraph(depsOf(adapter, catalog), LINEAR)
  assert.equal(adapter.datasetsSent.length, 1)
  assert.deepEqual(Object.keys(adapter.datasetsSent[0].data).sort(), ['流量', '液位'].sort())
})

/**
 * B4 的回归守卫：**身份是内容哈希，不是形状签名。**
 *
 * 两份列名列数完全相同、数值不同的数据，必须得到不同的哈希。
 * 这条如果不成立，agent 换了数据之后会拿到旧数据算出的值，而且不报错。
 */
test('内容不同 → 哈希不同；内容相同 → 哈希相同（列名列数都一样）', async () => {
  const a = await buildDatasetRef(dataset('ds-1', { 液位: [1, 2, 3, 4], 流量: [5, 6, 7, 8] }))
  const b = await buildDatasetRef(dataset('ds-1', { 液位: [1, 2, 3, 4], 流量: [5, 6, 7, 9] }))
  const c = await buildDatasetRef(dataset('ds-1', { 液位: [1, 2, 3, 4], 流量: [5, 6, 7, 8] }))

  assert.notEqual(a.contentHash, b.contentHash, '换了一个数就该换一个身份')
  assert.equal(a.contentHash, c.contentHash, '内容一样就该是同一个身份')
  assert.match(a.contentHash, /^sha256:[0-9a-f]{64}$/)
})

test('列开关不进身份：同一个文件换个开关还是同一份数据', async () => {
  const raw = dataset('ds-1', { 液位: [1, 2], 流量: [3, 4] })
  const ref1 = await buildDatasetRef(raw)
  const toggled = { ...raw, columns: raw.columns.map((c) => ({ ...c, enabled: false })) }
  const ref2 = await buildDatasetRef(toggled)
  assert.equal(ref1.contentHash, ref2.contentHash)
})

test('上游出错：本节点 error、下游 blocked，且都不加版本号', async () => {
  const adapter = new FakeAdapter()
  adapter.failures.set('n2', { message: '故意炸', traceback: 'trace 行' })
  const catalog = await DSM()
  const result = await runGraph(depsOf(adapter, catalog), LINEAR)

  assert.equal(result.runtimes.n2.status, 'error')
  assert.equal(result.runtimes.n2.error?.message, '故意炸')
  assert.equal(result.runtimes.n2.outputVersion, 0, '失败没有新输出，不能加版本')
  assert.equal(result.runtimes.n3.status, 'blocked')
  assert.match(result.runtimes.n3.error?.message ?? '', /上游/)
  assert.equal(adapter.evals.includes('n3'), false, '上游坏了就不该去算下游')
  assert.equal(result.jobs.find((j) => j.nodeId === 'n2')?.status, 'failed')
})

/**
 * 恢复通路：**改好上游的代码，链路自己活过来。**
 *
 * 这里刻意用"改代码"而不是"重跑一次"：指纹没变就不重算，一个上次失败的节点
 * 不会因为再跑一遍就自愈 —— 这是刻意的设计（否则每次重跑都会把整张图重算一遍）。
 * 恢复的唯一出口是"指纹变了"，而改代码就是让指纹变。
 */
test('上游改好代码之后，链路自己活过来', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const badCode = 'def run(data, k=0.5):\n    raise ValueError("先坏一次")\n'
  const goodCode = 'def run(data, k=0.5):\n    return {"out": data}\n'
  const graph = (code: string) =>
    wf(
      [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('nf', 'custom.script', { code }),
        node('n3', 'data.preview'),
      ],
      [edge('n1', '__table__', 'nf', 'data'), edge('nf', 'out', 'n3', 'data')],
    )

  adapter.failures.set('nf', { message: '先坏一次', traceback: 'trace' })
  const first = await runGraph(depsOf(adapter, catalog), graph(badCode))
  assert.equal(first.runtimes.nf.status, 'error')
  assert.equal(first.runtimes.n3.status, 'blocked')
  assert.equal(first.runtimes.nf.outputVersion, 0, '失败不加版本')

  adapter.failures.delete('nf')
  const second = await runGraph(depsOf(adapter, catalog), graph(goodCode), {
    initialRuntimes: first.runtimes,
  })
  assert.equal(second.runtimes.nf.status, 'ready')
  assert.equal(second.runtimes.n3.status, 'ready')
  assert.equal(second.runtimes.nf.outputVersion, 1)
})

test('自定义图表执行前加载绘图函数，并按真实输入产出 figure', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const graph = wf(
    [
      node('source', 'data.source', { datasetId: 'ds-1' }),
      node('chart', 'custom.chart', {
        code: 'def plot(data, bins=30):\n    return {"figure": data}\n',
      }),
    ],
    [edge('source', '__table__', 'chart', 'data')],
  )

  const result = await runGraph(depsOf(adapter, catalog), graph)

  assert.deepEqual(adapter.fns, ['chart'], '自定义绘图代码必须在求值前装入引擎')
  assert.deepEqual(adapter.evals, ['source', 'chart'])
  assert.equal(result.runtimes.chart.status, 'ready')
  assert.equal(result.runtimes.chart.outputVersion, 1)
})

test('指纹没变的重跑不会自愈 —— 这是刻意的，不是漏网', async () => {
  const adapter = new FakeAdapter()
  adapter.failures.set('n2', { message: '环境问题', traceback: '' })
  const catalog = await DSM()
  const first = await runGraph(depsOf(adapter, catalog), LINEAR)
  assert.equal(first.runtimes.n2.status, 'error')

  adapter.failures.delete('n2')
  const second = await runGraph(depsOf(adapter, catalog), LINEAR, {
    initialRuntimes: first.runtimes,
  })
  assert.equal(second.runtimes.n2.status, 'error', '输入没变就不重算，失败状态留着')
  assert.equal(second.jobs.length, 0)
})

/**
 * 全新图必须**一轮结算**：每个节点恰好算一次。
 *
 * 这条守的是一个既有缺陷：plan 用轮次开始时的版本号算指纹，同一轮里上游 +1 之后，
 * 下游存下的指纹当场过期，于是同一张图要反复算 2–3 遍才稳定。
 */
/**
 * 换了一份数据、但列名与时间列都没变时，**源节点必须重算**。
 *
 * 这条守的是契约规格 R3.2：数据集的身份是内容哈希，不是形状签名。指纹只认列的话，
 * 界面会把上一次的结果继续当成这一次的结果显示 —— 图、参数、列、时间列全都对得上，
 * 只有数是别人的。这也是跨运行缓存能不能安全的前提：缓存键认不出数据换了，
 * 复用就等于拿旧数据冒充新数据。
 */
test('换了数据但列没变：源节点照样重算', async () => {
  const before = new FakeAdapter()
  const catA = await setup([dataset('ds-1', { 液位: [1, 2, 3, 4], 流量: [5, 6, 7, 8] })])
  const first = await runGraph(depsOf(before, catA), LINEAR)

  const after = new FakeAdapter()
  // 列名、行数、类型全一样，只有数值不同 —— 形状签名对这一类完全无感
  const catB = await setup([dataset('ds-1', { 液位: [1, 2, 3, 9], 流量: [5, 6, 7, 8] })])
  const second = await runGraph(depsOf(after, catB), LINEAR, {
    initialRuntimes: first.runtimes,
  })

  assert.deepEqual(after.evals, ['n1', 'n2', 'n3'], '数据换了，整条链路都该重算')
  assert.equal(second.runtimes.n1.outputVersion, 2)
})

test('全新图一轮结算：四个节点各算一次，版本号都是 1', async () => {
  const adapter = new FakeAdapter()
  const catalog = await setup([dataset('ds-1', { 液位: [1, 2, 3, 4] })])
  const long = wf(
    [
      node('a', 'data.source', { datasetId: 'ds-1' }),
      node('b', 'data.preview'),
      node('c', 'data.preview'),
      node('d', 'data.preview', { rows: 20 }),
    ],
    [edge('a', '__table__', 'b', 'data'), edge('b', 'head', 'c', 'data'), edge('c', 'head', 'd', 'data')],
  )
  const result = await runGraph(depsOf(adapter, catalog), long)
  assert.deepEqual(adapter.evals, ['a', 'b', 'c', 'd'], '每个节点只该算一次')
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(result.runtimes[id].outputVersion, 1)
})

test('一切都没变：一个节点都不重算（指纹不变）', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const first = await runGraph(depsOf(adapter, catalog), LINEAR)
  const before = adapter.evals.length
  const second = await runGraph(depsOf(adapter, catalog), LINEAR, {
    initialRuntimes: first.runtimes,
  })
  assert.equal(adapter.evals.length, before, '指纹没变就不该再算一遍')
  assert.equal(second.jobs.length, 0)
  assert.equal(second.runtimes.n3.outputVersion, 1, '版本号也不该动')
})

test('改了上游参数：只重算它和它的下游', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const first = await runGraph(depsOf(adapter, catalog), LINEAR)
  adapter.evals.length = 0

  const edited = wf(
    [
      node('n1', 'data.source', { datasetId: 'ds-1' }),
      node('n2', 'data.preview', { rows: 10 }),
      node('n3', 'data.preview', { rows: 10 }),
    ],
    LINEAR.edges,
  )
  await runGraph(depsOf(adapter, catalog), edited, { initialRuntimes: first.runtimes })
  assert.deepEqual(adapter.evals, ['n2', 'n3'], '源没变就不该重算')
})

test('引擎算不了的节点：状态 manual、记进 notComputed，下游 blocked —— 绝不编数值', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const withTrain = wf(
    [node('n1', 'data.source', { datasetId: 'ds-1' }), node('n9', 'model.train', {}), node('n3', 'data.preview')],
    [edge('n1', '__table__', 'n9', 'data'), edge('n9', 'model', 'n3', 'data')],
  )
  const result = await runGraph(depsOf(adapter, catalog), withTrain)

  assert.equal(result.runtimes.n9.status, 'manual')
  assert.equal(adapter.evals.includes('n9'), false)
  assert.equal(result.refs.n9, undefined, '模拟节点不该有产物')
  assert.equal(result.notComputed.length, 1)
  assert.match(result.notComputed[0].reason, /没有可用的真实执行实现/)
  assert.equal(result.runtimes.n3.status, 'blocked')
})

test('客户端延后的节点等待显式启动，启动后才计算并放行下游', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const waiting = await runGraph(
    { ...depsOf(adapter, catalog), deferNode: (candidate) => candidate.id === 'n2' ? '等待点击开始训练' : null },
    LINEAR,
  )
  assert.equal(waiting.runtimes.n2.status, 'manual')
  assert.match(waiting.runtimes.n2.error?.message ?? '', /开始训练/)
  assert.equal(adapter.evals.includes('n2'), false)
  assert.equal(waiting.runtimes.n3.status, 'blocked')
  /*
   * 下游那句话必须是"还没开始"，不是"出错"：上游只是等用户点一下。
   * 这句话在规划与求值前复查两处各写过一份（一份说"出错"、一份说"没有可用输出"），
   * 现在共用 `blockedByUpstreamReason` —— 判据就是这里读到的那一句。
   */
  assert.match(waiting.runtimes.n3.error?.message ?? '', /还没开始/)
  assert.doesNotMatch(waiting.runtimes.n3.error?.message ?? '', /出错/)

  const started = await runGraph(depsOf(adapter, catalog), LINEAR, {
    initialRuntimes: waiting.runtimes,
  })
  assert.equal(started.runtimes.n2.status, 'ready')
  assert.equal(started.runtimes.n3.status, 'ready')
  assert.equal(adapter.evals.includes('n2'), true)
})

test('缺必需输入：节点进 error 并说清缺哪个口', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const result = await runGraph(depsOf(adapter, catalog), wf([node('n2', 'eval.score')]))
  assert.equal(result.runtimes.n2.status, 'error')
  assert.match(result.runtimes.n2.error?.message ?? '', /缺少必需输入/)
})

test('取消：停在两次求值之间，已算完的保留', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  let calls = 0
  const result = await runGraph(depsOf(adapter, catalog), LINEAR, {
    isCancelled: () => {
      calls += 1
      return calls > 2
    },
  })
  assert.equal(result.cancelled, true)
  assert.ok(result.runtimes.n1?.status === 'ready', '取消前算完的要留着')
  assert.equal(adapter.evals.includes('n3'), false)
})

test('数据集不在这次运行里：报错说清怎么办，而不是拿别的数据顶上', async () => {
  const adapter = new FakeAdapter()
  const catalog = await setup([dataset('ds-other', { a: [1] })])
  const result = await runGraph(depsOf(adapter, catalog), LINEAR)
  assert.equal(result.runtimes.n1.status, 'error')
  assert.match(result.runtimes.n1.error?.message ?? '', /--data/)
})

test('用户函数节点：同一次运行里只编译一次', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const fn = wf(
    [node('n1', 'data.source', { datasetId: 'ds-1' }), node('nf', 'custom.script', { code: 'def run(data):\n    return {"out": data}\n' })],
    [edge('n1', '__table__', 'nf', 'data')],
  )
  await runGraph(depsOf(adapter, catalog), fn)
  assert.deepEqual(adapter.fns, ['nf'])

  adapter.fns.length = 0
  await runGraph(depsOf(adapter, catalog), fn)
  // 编译缓存的生命周期是"一次运行"：新的运行就是新的引擎会话，没有理由假设上一份还在
  assert.deepEqual(adapter.fns, ['nf'])
})

/**
 * 共享边界之外的算子（AGENTS.md R4）只有一个执行面能跑。
 *
 * 这个测试守的是"不静默失败"：在浏览器引擎下点训练节点，用户当场就该知道
 * **为什么**（清单里那句 reason）与**下一步做什么**（启动宿主），
 * 而不是让引擎回报一句含义模糊的"不认识的算子"。
 */
const TRAIN = wf(
  [
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    node('n2', 'train.mlp', { label: '液位' }),
  ],
  [edge('n1', '__table__', 'n2', 'train')],
)

test('只有宿主能跑的算子：浏览器引擎下当场说清原因，且根本不该送进引擎', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const result = await runGraph(
    { ...depsOf(adapter, catalog), operatorOf: hostOnlyFacts, canRunHostOperators: () => false },
    TRAIN,
  )

  assert.equal(result.runtimes.n2.status, 'error')
  const message = result.runtimes.n2.error?.message ?? ''
  assert.match(message, /只能由本地宿主算/, '要说清它归谁算')
  assert.match(message, /torch/, '原因要来自清单，而不是核里写死的类型名')
  assert.match(message, /run-host/, '要给出下一步动作')
  assert.ok(!adapter.evals.includes('n2'), '不该送进引擎再报错')
  assert.equal(adapter.evals.includes('n1'), true, '上游照样算得出来')
})

test('宿主在时，同一个算子照常进引擎算', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const result = await runGraph(
    { ...depsOf(adapter, catalog), operatorOf: hostOnlyFacts, canRunHostOperators: () => true },
    TRAIN,
  )
  assert.ok(adapter.evals.includes('n2'))
  assert.equal(result.runtimes.n2.status, 'ready')
})

test('打开工程后有匹配制品引用会自动恢复并继续求值，不要求手动加载或重训', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const artifact = {
    artifactId: 'a'.repeat(32),
    manifestSha256: 'b'.repeat(64),
    trainingFingerprint: 'fp-训练时那份',
  }
  const result = await runGraph(
    {
      ...depsOf(adapter, catalog),
      operatorOf: hostOnlyFacts,
      canRunHostOperators: () => true,
      modelArtifactForNode: (nodeId) => nodeId === 'n2' ? artifact : undefined,
      // 训练节点在没有工程制品时需要手动启动；匹配引用存在时必须放行自动恢复。
      deferNode: (candidate) => candidate.id === 'n2' ? null : null,
    },
    TRAIN,
  )

  assert.equal(result.runtimes.n2.status, 'ready')
  const restoreCall = adapter.evalArgs.find((entry) => entry.nodeId === 'n2')
  assert.equal(restoreCall?.restoreArtifactId, artifact.artifactId)
  assert.equal(restoreCall?.restoreArtifactSha256, artifact.manifestSha256)
})

test('子空间里的训练节点和外面一样：按工程引用恢复权重，不要求重训', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  const artifact = {
    artifactId: 'c'.repeat(32),
    manifestSha256: 'd'.repeat(64),
    // 封装之前训练时记下的那份指纹（上游还写的是根层 id）—— 引用里保存的就是它
    trainingFingerprint: 'train.mlp train=port:n1:__table__@upstream#1',
  }
  // 训好的训练节点被封装进组块：它的运行时 id 从此带上了组路径
  const grouped = createGroupFromSelection(TRAIN, ['n2'], catalog.portContext(), 'g1').workflow
  const innerId = runtimeNodeIdForPath(['g1'], 'n2')

  const result = await runGraph(
    {
      ...depsOf(adapter, catalog),
      operatorOf: hostOnlyFacts,
      canRunHostOperators: () => true,
      // 制品引用按运行时 id 归属，所以封装之后就是内层这个 id（引用会跟着块搬）
      modelArtifactForNode: (nodeId) => (nodeId === innerId ? artifact : undefined),
      deferNode: () => null,
    },
    grouped,
  )

  assert.equal(result.runtimes[innerId]?.status, 'ready')
  const restoreCall = adapter.evalArgs.find((entry) => entry.nodeId === innerId)
  assert.equal(restoreCall?.restoreArtifactId, artifact.artifactId)
  assert.equal(restoreCall?.restoreArtifactSha256, artifact.manifestSha256)
  assert.equal(
    restoreCall?.fingerprint,
    artifact.trainingFingerprint,
    '恢复请求要带制品自己的指纹：宿主拿它和 meta.json 严格比对，带的必须是工程引用里存的那份',
  )
})

/**
 * 取消（待办 T7）。四件事要一起对，少一件都会让"取消"变成一种更隐蔽的错：
 *
 * 1. 状态是 `cancelled` 而不是 `error` —— 用户按的是取消，不是它坏了；
 * 2. 没有产物（不能拿上一次的顶上）；
 * 3. **指纹照记** —— 否则下一轮调度立刻把它重新跑一遍，那就是"取消看起来没生效"；
 * 4. 下游说清是"上游被取消"，而不是含糊的"取不到上游产物"。
 */
test('取消不是失败：节点回到可重试，下游说清为什么跳过', async () => {
  const adapter = new FakeAdapter()
  adapter.cancelledNodes.add('n2')
  const catalog = await DSM()

  const first = await runGraph(depsOf(adapter, catalog), LINEAR)
  const rt = first.runtimes.n2
  assert.equal(rt.status, 'cancelled')
  assert.equal(rt.error, undefined, '取消不该带一条错误')
  assert.ok(rt.inputsFingerprint, '指纹照记：否则下一轮它会自己重开')
  assert.equal(Object.keys(first.refs.n2 ?? {}).length, 0, '取消不留半截产物')
  assert.equal(
    first.jobs.some((j) => j.nodeId === 'n2'),
    false,
    '取消不该在作业记录里留一条"失败"',
  )
  assert.equal(first.runtimes.n3.status, 'blocked')
  assert.match(first.runtimes.n3.error?.message ?? '', /取消/)
  assert.equal(first.cancelled, false, '单个节点被取消不等于整个运行被中断')

  // 再规划一遍：被取消的节点不该自己重开（这正是"取消没生效"最常见的样子）
  const again = await runGraph(depsOf(adapter, catalog), LINEAR, {
    initialRuntimes: first.runtimes,
  })
  assert.equal(
    adapter.evals.filter((id) => id === 'n2').length,
    1,
    '被取消的节点在下一轮里不该自动重跑',
  )
  assert.equal(again.runtimes.n2.status, 'cancelled', '没人动它，它就一直停在"已取消"')
})

/**
 * 产物落盘（待办 T8）。核要做的只有两件：**把指纹传给引擎**（产物按它归档）、
 * 以及**把引擎登记回来的产物记在节点状态上**（界面与运行清单都从那里取）。
 */
/**
 * 跨运行缓存（T18）的两半：**能不能复用由核按确定性等级决定**，
 * 而"这一次是复用来的"必须一路记到节点状态上。
 *
 * 复用能不能带来正确性后果，全看这两条：判据错了（比如放行 stochastic），
 * 就会把上一次算的冒充成这一次算的；标记丢了，用户就不知道手里的数有多新。
 */
test('能不能复用由算子声明的确定性等级决定（R6.4）', async () => {
  const adapter = new FakeAdapter()
  const catalog = await DSM()
  await runGraph(depsOf(adapter, catalog), LINEAR)

  // factsOf 里的内置算子都是 deterministic
  for (const arg of adapter.evalArgs) {
    assert.equal(arg.cacheable, true, `${arg.nodeId} 是 deterministic，应当允许复用`)
  }

  const train = wf(
    [node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'model.train', {})],
    [edge('n1', '__table__', 'n2', 'train')],
  )
  const stochastic = new FakeAdapter()
  await runGraph(depsOf(stochastic, catalog), train)
  // 用真实训练算子验证：stochastic 必须 cacheable = false
  const trainFacts = (type: string) =>
    type === 'train.mlp'
      ? { ...factsOf(type), determinism: 'stochastic' as const }
      : factsOf(type)
  const real = new FakeAdapter()
  await runGraph(
    { ...depsOf(real, catalog), operatorOf: (t: string) => trainFacts(t) },
    wf(
      [node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'train.mlp', { label: '液位' })],
      [edge('n1', '__table__', 'n2', 'train')],
    ),
  )
  const trainArg = real.evalArgs.find((a) => a.nodeId === 'n2')
  assert.equal(trainArg?.cacheable, false, 'stochastic 的算子绝不允许被复用')
})

test('复用来的结果会被记在节点状态上（reused）', async () => {
  const adapter = new FakeAdapter()
  adapter.reusedNodes.add('n2')
  const catalog = await DSM()
  const result = await runGraph(depsOf(adapter, catalog), LINEAR)

  assert.equal(result.runtimes.n2.reused, true)
  assert.equal(result.runtimes.n1.reused, undefined)
  assert.ok(
    result.logs.some((l) => l.message.includes('复用上一次的结果')),
    '日志里要说清这一步没重算',
  )
})

test('产物随结果回来，并且核会把指纹告诉引擎（按它归档）', async () => {
  const adapter = new FakeAdapter()
  adapter.artifactsFor = (nodeId) =>
    nodeId === 'n3'
      ? [{ kind: 'model', path: '/artifacts/abc123/model.pt', bytes: 4096, fingerprint: 'f-n3' }]
      : []
  const catalog = await DSM()

  const result = await runGraph(depsOf(adapter, catalog), LINEAR)

  // 1. 引擎拿到的指纹就是"求值那一刻"结算出来的那个 —— 少了它，产物没法按输入归档
  const call = adapter.evalArgs.find((a) => a.nodeId === 'n3')
  assert.ok(call?.fingerprint, '求值时必须把指纹传下去')
  assert.equal(call?.fingerprint, result.runtimes.n3.inputsFingerprint)

  // 2. 产物记在节点状态上；没有产物的节点不该凭空多出一个空数组
  assert.deepEqual(result.runtimes.n3.artifacts, [
    { kind: 'model', path: '/artifacts/abc123/model.pt', bytes: 4096, fingerprint: 'f-n3' },
  ])
  assert.equal(result.runtimes.n1.artifacts, undefined, '没有产物就是没有，别写个空数组充数')
})

/**
 * 元信息（待办 T11）：指标只收数值，所以"实际用了什么设备、哪一版 torch"这类事实
 * 单独走一条路。同一张图在 CPU 上跑还是在 3050 上跑，指标看起来都对，靠它才分得开。
 */
test('节点自报的元信息随结果回来，并记在节点状态上', async () => {
  const adapter = new FakeAdapter()
  adapter.metaFor = (nodeId): NodeMeta =>
    nodeId === 'n3' ? { 设备: 'cuda', GPU: 'RTX 3050', torch: '2.13.0+cu126' } : {}
  const catalog = await DSM()

  const result = await runGraph(depsOf(adapter, catalog), LINEAR)

  assert.deepEqual(result.runtimes.n3.meta, {
    设备: 'cuda',
    GPU: 'RTX 3050',
    torch: '2.13.0+cu126',
  })
  assert.equal(result.runtimes.n1.meta, undefined, '没有元信息就不写空对象 —— 空对象会让界面多出一行空的')
})
