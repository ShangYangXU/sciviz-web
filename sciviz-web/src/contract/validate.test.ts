import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_DATASET_CTX,
  checkConnection,
  seededWithoutSeedParam,
  validateWorkflow,
  type ConnectionAttempt,
} from './validate'
import { allErrorCodes } from './errorCodes'
import { allNodeDefs } from '../workflow/nodeRegistry'
import { createGroupFromSelection } from '../workflow/groups'
import type { PortContext } from '../workflow/ports'
import type { ParamSpec, Workflow, WorkflowEdge, WorkflowNode } from '../workflow/types'

/**
 * L1 校验器的行为钉子。
 *
 * 这里守的不只是"能报错"，还有三条更重要的东西：
 * 1. 一次报全（agent 不该被逼成"改一个跑一次"）；
 * 2. **端口算不出来时不判连线**（这条是真金白银踩出来的，见下）；
 * 3. 没查的规则要说出来，不能让"校验通过"被读成"契约全过"。
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
  id: 'wf-test',
  name: '测试图',
  description: '',
  nodes,
  edges,
})

/** 一份"有列"的数据集：端口因此能算出来，连线才会被真判 */
const WITH_DATASET: PortContext = {
  featuresOf: (id) => (id === 'ds-1' ? ['液位', '流量'] : []),
  timeColumnOf: () => null,
  hasDataset: (id) => id === 'ds-1',
}

const codes = (result: { errors: { code: string }[]; warnings: { code: string }[] }) => [
  ...result.errors.map((e) => e.code),
  ...result.warnings.map((w) => w.code),
]

test('一张接好的图通过，且不产生任何告警', () => {
  const result = validateWorkflow(
    wf(
      [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('n2', 'data.preview', { rows: 5 }),
        node('n3', 'data.preview', { rows: 5 }),
      ],
      [
        edge('n1', '__table__', 'n2', 'data'),
        edge('n2', 'head', 'n3', 'data'),
      ],
    ),
    WITH_DATASET,
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('重复节点 id 被拦下', () => {
  const result = validateWorkflow(
    wf([node('n1', 'data.source', { datasetId: 'ds-1' }), node('n1', 'data.preview')]),
    WITH_DATASET,
  )
  assert.equal(result.ok, false)
  assert.ok(codes(result).includes('E_DUPLICATE_NODE_ID'))
})

test('未注册的算子被拦下（拼写错误 / 自建模块缺失）', () => {
  const result = validateWorkflow(wf([node('n1', 'feature.tmie')]), WITH_DATASET)
  assert.ok(codes(result).includes('E_UNKNOWN_OPERATOR'))
})

test('悬空连线被拦下', () => {
  const result = validateWorkflow(
    wf([node('n1', 'data.source', { datasetId: 'ds-1' })], [edge('n1', '__table__', 'n9', 'data')]),
    WITH_DATASET,
  )
  assert.ok(codes(result).includes('E_DANGLING_EDGE'))
})

test('成环被拦下，且环被说出来', () => {
  const result = validateWorkflow(
    wf(
      [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('n2', 'data.preview'),
        node('n3', 'data.preview'),
      ],
      [edge('n1', '__table__', 'n2', 'data'), edge('n2', 'head', 'n3', 'data'), edge('n3', 'head', 'n2', 'data')],
    ),
    WITH_DATASET,
  )
  const cycle = result.errors.find((e) => e.code === 'E_CYCLE')
  assert.ok(cycle, '应当报 E_CYCLE')
  assert.match(cycle.actual ?? '', /n2/)
})

test('引用不存在的端口被拦下', () => {
  const result = validateWorkflow(
    wf(
      [node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'data.preview')],
      [edge('n1', '哪个列', 'n2', 'data')],
    ),
    WITH_DATASET,
  )
  assert.ok(codes(result).includes('E_UNKNOWN_PORT'))
})

test('端口类型不兼容被拦下：figure 接不进 table', () => {
  const result = validateWorkflow(
    wf(
      [node('n1', 'viz.chart', {}), node('n2', 'data.collect')],
      [edge('n1', 'figure', 'n2', 'in')],
    ),
    WITH_DATASET,
  )
  const hit = result.errors.find((e) => e.code === 'E_TYPE_MISMATCH')
  assert.ok(hit, '应当报 E_TYPE_MISMATCH')
  assert.equal(hit.expected, 'table')
  assert.equal(hit.actual, 'figure')
})

test('必需输入没接线被拦下', () => {
  const result = validateWorkflow(wf([node('n1', 'eval.score')]), WITH_DATASET)
  assert.ok(codes(result).includes('E_MISSING_INPUT'))
})

test('参数：未知键、选项越界、超出上下限都被拦下', () => {
  const unknownKey = validateWorkflow(
    wf([node('n1', 'viz.chart', { chartType: 'scatter', 乱填: 1 })]),
    WITH_DATASET,
  )
  assert.ok(codes(unknownKey).includes('E_PARAM_INVALID'))

  const badOption = validateWorkflow(wf([node('n1', 'train.custom', { task: '不存在的任务' })]), WITH_DATASET)
  assert.ok(codes(badOption).includes('E_PARAM_INVALID'))

  // overlap 声明的是 0 ≤ x ≤ 0.95，2 越界
  const outOfRange = validateWorkflow(
    wf(
      [node('n1', 'viz.chart', { pointSize: 100 })],
      [],
    ),
    WITH_DATASET,
  )
  const hit = outOfRange.errors.find((e) => e.code === 'E_PARAM_INVALID')
  assert.ok(hit)
  assert.equal(hit.portId, 'pointSize')
})

test('被上游驱动的参数不按字面量判 —— 值此刻只是占位', () => {
  // pointSize 接到上游（属于非法接线，但这里只验"不该报参数越界"这件事）
  const result = validateWorkflow(
    wf(
      [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('n2', 'viz.chart', { pointSize: 100 }),
      ],
      [edge('n1', '__table__', 'n2', 'data'), edge('n1', '液位', 'n2', 'pointSize')],
    ),
    WITH_DATASET,
  )
  assert.equal(result.errors.some((e) => e.code === 'E_PARAM_INVALID' && e.portId === 'pointSize'), false)
})

/** 拆列输出名需要上游表的列；尚无运行结果时只给告警，不判下游边错。 */
test('拆列端口算不出来时不判连线错误，只给告警', () => {
  const result = validateWorkflow(
    wf(
      [
        node('n1', 'data.source', { datasetId: '不在本会话' }),
        node('cols', 'data.columns'),
        node('n2', 'data.preview'),
      ],
      [edge('n1', '__table__', 'cols', 'data'), edge('cols', '液位', 'n2', 'data')],
    ),
    NO_DATASET_CTX,
  )
  assert.equal(result.errors.some((e) => e.code === 'E_UNKNOWN_PORT'), false)
  assert.equal(result.errors.some((e) => e.code === 'E_DANGLING_EDGE'), false)
  assert.ok(codes(result).includes('W_DATASET_UNRESOLVED'))
})

test('一次报全：一张坏图上的多个问题在同一份结果里', () => {
  const result = validateWorkflow(
    wf(
      [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('n2', 'viz.chart', { pointSize: 100 }),
        node('n3', 'data.preview'),
      ],
      [edge('n1', '__table__', 'n2', 'data'), edge('n2', 'figure', 'n3', 'data'), edge('n3', 'head', 'n2', 'data')],
    ),
    WITH_DATASET,
  )
  const seen = new Set(result.errors.map((e) => e.code))
  assert.ok(seen.has('E_CYCLE'), '成环')
  assert.ok(seen.has('E_PARAM_INVALID'), '参数越界/选项错')
  assert.ok(result.errors.length >= 3, `期望至少 3 条错误，实际 ${result.errors.length}`)
})

test('没查的规则被明写出来，不许默默当成通过', () => {
  const result = validateWorkflow(wf([node('n1', 'data.source', { datasetId: 'ds-1' })]), WITH_DATASET)
  const notChecked = new Set(result.notChecked.map((s) => s.code))
  // 这些都要等 PortDescriptor（轴序 / 单位 / split）落地才有判据
  for (const code of ['E_SPLIT_LEAK', 'E_UNIT_MISMATCH', 'E_AXIS_ROLE_MISMATCH']) {
    assert.ok(notChecked.has(code), `${code} 应当出现在 notChecked 里`)
  }
  // determinism 已经落地，所以这条不再是"没查"，而是真查
  assert.ok(!notChecked.has('E_UNSEEDED_STOCHASTIC'), 'E_UNSEEDED_STOCHASTIC 已经有判据了')
})

test('R5：声明了 seeded 就必须真的有一个 seed 参数', () => {
  const param = { key: 'seed' } as ParamSpec
  assert.equal(
    seededWithoutSeedParam({ determinism: 'seeded', params: [] }),
    true,
    '声明可复现却不给固定种子的入口 —— 那是空头支票',
  )
  assert.equal(seededWithoutSeedParam({ determinism: 'seeded', params: [param] }), false)
  assert.equal(
    seededWithoutSeedParam({ determinism: 'deterministic', params: [] }),
    false,
    '确定性算子不需要 seed 参数',
  )
  // 注册表里的算子一个都不许触发它
  for (const def of allNodeDefs()) {
    assert.equal(seededWithoutSeedParam(def), false, `${def.type} 声明了 seeded 却没有 seed 参数`)
  }
})

test('校验器只会产出错误码表里有的码', () => {
  const known = new Set(allErrorCodes().map((d) => d.code))
  const result = validateWorkflow(
    wf(
      [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('n2', 'viz.chart', { pointSize: 100 }),
        node('n3', 'data.preview'),
        node('n4', 'nosuch.op'),
      ],
      [edge('n1', '__table__', 'n2', 'data'), edge('n3', 'head', 'n2', 'data'), edge('n1', '哪个列', 'n3', 'data')],
    ),
    WITH_DATASET,
  )
  for (const it of [...result.errors, ...result.warnings]) {
    assert.ok(known.has(it.code), `错误码「${it.code}」不在表里 —— 表即文档，先补表`)
  }
})

/* ---------------- T4：连线判据只有一处 ---------------- */

/**
 * 拖一条线时，界面用的判据必须与 `sciviz validate` 是同一份。
 *
 * 这条守的不是"能报错"，而是**界面说的与 CLI 说的是同一句**：界面被拒时
 * 拿出来的就是 `checkConnection` 返回的那条 Issue；而把这条线接上去之后，
 * `validateWorkflow` 报出的错误码与人话必须逐字相同。
 *
 * 在此之前界面自己写了一套判断（只回 true/false，用户看不到原因），
 * 校验器另有一套措辞 —— 两边分叉了也没有任何地方会报错。
 */
test('界面拒绝一条线时说的那句话，与 validate 对同一张图说的是同一句', () => {
  const cases: {
    what: string
    nodes: WorkflowNode[]
    edges: WorkflowEdge[]
    conn: ConnectionAttempt
  }[] = [
    {
      what: '类型不兼容',
      nodes: [node('n1', 'viz.chart', {}), node('n2', 'data.collect')],
      edges: [],
      conn: { source: 'n1', sourcePort: 'figure', target: 'n2', targetPort: 'in' },
    },
    {
      what: '端口不存在',
      nodes: [node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'data.preview')],
      edges: [],
      conn: { source: 'n1', sourcePort: '哪个列', target: 'n2', targetPort: 'data' },
    },
    {
      what: '输入端口已被占用',
      nodes: [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('n2', 'data.preview'),
        node('n3', 'data.preview'),
      ],
      edges: [edge('n1', '__table__', 'n2', 'data')],
      conn: { source: 'n3', sourcePort: 'head', target: 'n2', targetPort: 'data' },
    },
    {
      what: '这条线会让图成环',
      nodes: [
        node('n1', 'data.source', { datasetId: 'ds-1' }),
        node('n2', 'data.preview'),
        node('n3', 'data.preview'),
      ],
      edges: [edge('n1', '__table__', 'n2', 'data'), edge('n2', 'head', 'n3', 'data')],
      conn: { source: 'n3', sourcePort: 'head', target: 'n2', targetPort: 'data' },
    },
  ]

  for (const c of cases) {
    const before = wf(c.nodes, c.edges)
    const hit = checkConnection(before, c.conn, WITH_DATASET)
    assert.ok(hit, `${c.what}：判据应当拦下`)

    const after = validateWorkflow(
      wf(c.nodes, [...c.edges, edge(c.conn.source, c.conn.sourcePort, c.conn.target, c.conn.targetPort)]),
      WITH_DATASET,
    )
    const same = after.errors.find((e) => e.code === hit.code && e.message === hit.message)
    assert.ok(
      same,
      `${c.what}：validate 必须报出同一码同一句。\n` +
        `界面：${hit.code} ${hit.message}\n` +
        `validate：${after.errors.map((e) => `${e.code} ${e.message}`).join(' ／ ') || '（没报错）'}`,
    )
  }
})

test('能连的线判据放行；端口算不出来时不判（那是"还不知道"，不是"连错了"）', () => {
  const graph = wf([
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    node('n2', 'data.preview'),
  ])
  assert.equal(
    checkConnection(
      graph,
      { source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' },
      WITH_DATASET,
    ),
    null,
  )

  // 数据源端口固定：没有绑定数据集时，整表连线仍可先搭好。
  const unbound = wf([
    node('n1', 'data.source', {}),
    node('n2', 'data.preview'),
  ])
  assert.equal(
    checkConnection(
      unbound,
      { source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' },
      WITH_DATASET,
    ),
    null,
  )
})

test('组块边界映射损坏时返回 E_GROUP_INVALID', () => {
  const graph = wf(
    [node('source', 'data.source'), node('preview', 'data.preview')],
    [edge('source', '__table__', 'preview', 'data')],
  )
  const grouped = createGroupFromSelection(graph, ['preview'], NO_DATASET_CTX, 'g-invalid')
  const groupNode = grouped.workflow.nodes.find((candidate) => candidate.id === 'g-invalid')!
  groupNode.group!.inputs[0].targetPortId = 'missing-port'

  const result = validateWorkflow(grouped.workflow)
  assert.equal(result.ok, false)
  assert.equal(result.errors[0]?.code, 'E_GROUP_INVALID')
})
