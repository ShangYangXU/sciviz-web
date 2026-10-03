import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowToYaml, yamlToWorkflow } from './yaml'
import { portsTrustworthy, resolvePorts, type PortContext } from './ports'
import { createAnnotationGroup } from './groups'
import type { Workflow, WorkflowGroupDefinition, WorkflowNode } from './types'

/**
 * 这组测试钉住的是一次实测踩到的坑：
 *
 * 导出的 YAML 里只记了数据集 id，而 id 是导入时现生成的 —— 换次会话必然失效。
 * 导入回来时数据源节点算不出任何端口，画布接着"清理无效连线"，把那条
 * 「整表 → 函数」的线静默删掉，用户再把数据集选回来也长不回去。
 */

const node = (
  id: string,
  type: string,
  params: Record<string, string | number | boolean> = {},
  label = id,
): WorkflowNode => ({ id, type, label, params, position: { x: 0, y: 0 } })

const FN = 'def working_rows(data, th=1.0):\n    return {"工作数据": data}\n'

const wf = (nodes: WorkflowNode[], edges: [string, string, string, string][]): Workflow => ({
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

/** 本机只有一份叫「二号锅炉全量」的数据，id 与导出时那份不同 */
function ctxWith(datasetId: string | null, rowCount = 1048575): PortContext {
  return {
    featuresOf: () => (datasetId ? ['液位', '蒸汽流量'] : []),
    timeColumnOf: () => (datasetId ? '时间' : null),
    hasDataset: (id) => !!datasetId && id === datasetId,
    identityOf: (id) =>
      datasetId && id === datasetId ? { name: '二号锅炉全量', rowCount } : null,
    findByIdentity: (identity) =>
      datasetId && identity.name === '二号锅炉全量'
        ? { id: datasetId, exact: identity.rowCount === rowCount }
        : null,
  }
}

const userFlow = () =>
  wf(
    [
      node('n1', 'data.source', { datasetId: 'ds-1-mtybznc9' }, '数据源'),
      node('n2', 'custom.script', { code: FN }, '函数'),
      node('n3', 'data.preview', { rows: 5 }, '数据预览'),
    ],
    [
      ['n1', '__table__', 'n2', 'data'],
      ['n2', '工作数据', 'n3', 'data'],
    ],
  )

const leafWorkflow: Workflow = {
  id: 'inner-flow',
  name: '内部步骤',
  description: '可复用的处理逻辑',
  nodes: [
    node(
      'inner-source',
      'data.source',
      { datasetId: 'ds-1-mtybznc9' },
      '内部数据源',
    ),
    node(
      'inner-script',
      'custom.script',
      { code: 'def scaled(data, factor=2, mask=None):\n    return {"scaled": data * factor if mask is None else data * mask}\n', factor: 2 },
      '内部函数',
    ),
  ],
  edges: [
    {
      id: 'inner-source|__table__|inner-script|data',
      source: 'inner-source',
      sourcePort: '__table__',
      target: 'inner-script',
      targetPort: 'data',
    },
  ],
}

const leafGroup: WorkflowGroupDefinition = {
  workflow: leafWorkflow,
  inputs: [
    {
      id: 'data',
      label: '数据',
      port: { id: 'data', label: '数据', type: 'table' },
      targetNodeId: 'inner-script',
      targetPortId: 'mask',
    },
  ],
  outputs: [
    {
      id: 'scaled',
      label: '处理结果',
      port: { id: 'scaled', label: '处理结果', type: 'any' },
      sourceNodeId: 'inner-script',
      sourcePortId: 'scaled',
    },
  ],
  parameters: [
    {
      key: 'factor',
      label: '倍率',
      nodeId: 'inner-script',
      paramKey: 'factor',
      spec: { key: 'factor', label: '倍率', type: 'number', default: 2, min: 0, step: 0.5 },
    },
  ],
}

const nestedGroupNode: WorkflowNode = {
  id: 'nested-group',
  type: 'workflow.group',
  label: '预处理组',
  params: { factor: 3 },
  position: { x: 120, y: 80 },
  group: leafGroup,
}

const reusableGroupNode: WorkflowNode = {
  id: 'reusable-group',
  type: 'workflow.group',
  label: '可复用组块',
  params: {},
  position: { x: 360, y: 160 },
  group: {
    workflow: wf([nestedGroupNode], []),
    inputs: [],
    outputs: [],
    parameters: [],
  },
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

test('参数中文短注释随工程图往返，旧节点没有注释也能读取', () => {
  const script = { ...node('fn', 'custom.script', { code: FN }), paramNotes: { th: '判断阈值' } }
  const text = workflowToYaml(wf([script], []))
  assert.match(text, /paramNotes:/)
  const parsed = yamlToWorkflow(text, 'w')
  assert.ok(parsed.workflow, parsed.error)
  assert.deepEqual(parsed.workflow.nodes[0].paramNotes, { th: '判断阈值' })
  assert.equal(parsed.workflow.nodes[0].params.code, FN)
  assert.equal(yamlToWorkflow(workflowToYaml(wf([node('plain', 'custom.script', { code: FN })], [])), 'w').workflow?.nodes[0].paramNotes, undefined)
})

test('导出时把数据集身份写进 YAML：只有 id 的话换会话必然对不上', () => {
  // 导出时那份 id 在本机是有效的，身份才写得出来
  const text = workflowToYaml(userFlow(), ctxWith('ds-1-mtybznc9'))
  assert.match(text, /dataset:/)
  assert.match(text, /name: 二号锅炉全量/)
  assert.match(text, /rowCount: 1048575/)
  // 函数 / 预览这类没引用数据集的节点不写这一段，免得噪声
  assert.equal((text.match(/dataset:/g) ?? []).length, 1)
})

test('YAML 递归保存组块、绑定与内部图；嵌套数据源仍按身份重绑', () => {
  const text = workflowToYaml(wf([reusableGroupNode], []), ctxWith('ds-1-mtybznc9'))
  assert.match(text, /group:/)
  assert.match(text, /inner-flow/)
  assert.match(text, /targetNodeId: inner-script/)
  assert.match(text, /spec:/)

  const parsed = yamlToWorkflow(text, 'outer-flow', ctxWith('ds-1-today'))
  assert.equal(parsed.error, undefined, parsed.error)
  const outer = parsed.workflow!.nodes[0]
  assert.equal(outer.group?.workflow.id, 'w', '最外层 group 子图的 workflow id 应保留')
  const nested = outer.group!.workflow.nodes[0]
  const reboundLeafWorkflow: Workflow = {
    ...leafWorkflow,
    nodes: leafWorkflow.nodes.map((child) =>
      child.id === 'inner-source'
        ? { ...child, params: { ...child.params, datasetId: 'ds-1-today' } }
        : child,
    ),
  }
  assert.deepEqual(nested.group, { ...leafGroup, workflow: reboundLeafWorkflow })
  assert.equal(
    nested.group!.workflow.nodes.find((candidate) => candidate.id === 'inner-source')!.params.datasetId,
    'ds-1-today',
    '子图内部的数据源也应按导出身份重绑',
  )
  assert.ok(parsed.warnings.some((warning) => warning.includes('重新绑定')))
})

test('只放批注的组块（内部空图）能导出也能读回来；最外层空图仍然报错', () => {
  // 产品自己造得出来的状态：画布批注子空间内部没有任何计算节点（CANVAS-2）
  const withAnnotationScope = createAnnotationGroup(userFlow(), 'group-notes', { x: 10, y: 20 }).workflow
  const text = workflowToYaml(withAnnotationScope, ctxWith('ds-1-mtybznc9'))

  const parsed = yamlToWorkflow(text, 'wf-imported', ctxWith('ds-1-mtybznc9'))
  assert.equal(parsed.error, undefined, parsed.error)
  const scope = parsed.workflow!.nodes.find((candidate) => candidate.id === 'group-notes')
  assert.ok(scope, '只放批注的组块必须还在，不能整份文件打不开')
  assert.deepEqual(scope.group?.workflow.nodes, [])
  assert.equal(parsed.workflow!.nodes.length, withAnnotationScope.nodes.length)

  // 最外层空图还是错：一份工作流 YAML 一个节点都没有 = 空文件（理由见 YamlParseOptions）
  const empty = yamlToWorkflow('name: 空的\nnodes: []\nedges: []\n', 'wf-empty')
  assert.equal(empty.workflow, undefined)
  assert.match(empty.error ?? '', /nodes 列表是空的/)
})

test('损坏的组块结构会明确报错，不会作为普通节点静默丢掉', () => {
  const text = workflowToYaml(wf([reusableGroupNode], []))
  const broken = text.replace('targetNodeId: inner-script', 'targetNodeId: missing-node')
  const parsed = yamlToWorkflow(broken, 'wf')
  assert.equal(parsed.workflow, undefined)
  assert.match(parsed.error ?? '', /组块.*不存在的内部节点/)
})

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

test('导入：YAML 里的 id 失效，但身份对得上 → 按名字重绑，连线照旧', () => {
  const exported = workflowToYaml(userFlow(), ctxWith('ds-1-mtybznc9'))
  const res = yamlToWorkflow(exported, 'wf-x', ctxWith('ds-1-today'))

  assert.equal(res.error, undefined)
  const src = res.workflow!.nodes.find((n) => n.id === 'n1')!
  assert.equal(src.params.datasetId, 'ds-1-today')
  assert.equal(res.workflow!.edges.length, 2)
  assert.ok(res.warnings.some((w) => w.includes('重新绑定')))
})

test('导入：id 和身份都认不回来 → 连线必须原样保留，并说清怎么办', () => {
  const exported = workflowToYaml(userFlow(), ctxWith('ds-1-mtybznc9'))
  const res = yamlToWorkflow(exported, 'wf-x', ctxWith(null))

  assert.equal(res.error, undefined)
  assert.equal(res.workflow!.edges.length, 2, '线不能被静默删掉')
  const src = res.workflow!.nodes.find((n) => n.id === 'n1')!
  assert.equal(src.params.datasetId, 'ds-1-mtybznc9', '认不回来时保留原 id，不瞎猜')
  assert.ok(res.warnings.some((w) => w.includes('不在本会话里')))
})

test('旧版 YAML（没有 dataset 段）也能进：连线保留，提示数据集不在本会话', () => {
  const legacy = `name: 老文件
nodes:
  - id: n1
    type: data.source
    label: 数据源
    params:
      datasetId: ds-1-mtybznc9
  - id: n2
    type: custom.script
    label: 函数
    params:
      code: |
        def working_rows(data, th=1.0):
            return {"工作数据": data}
edges:
  - source: n1
    sourcePort: __table__
    target: n2
    targetPort: data
`
  const res = yamlToWorkflow(legacy, 'wf-old', ctxWith(null))
  assert.equal(res.error, undefined)
  assert.equal(res.workflow!.edges.length, 1)
  assert.ok(res.warnings.some((w) => w.includes('不在本会话里')))
  assert.ok(res.warnings.some((w) => w.includes('ds-1-mtybznc9')))
})

test('旧图表独立选择的数据集迁移为显式数据源与输入连线', () => {
  const legacy = `name: 老图表
nodes:
  - id: chart
    type: viz.chart
    label: 图表
    dataset:
      name: 二号锅炉全量
      rowCount: 1048575
    params:
      datasetId: ds-1-old
      chartType: scatter
edges: []
`
  const res = yamlToWorkflow(legacy, 'wf-old-chart', ctxWith('ds-1-today'))

  assert.equal(res.error, undefined)
  const chart = res.workflow!.nodes.find((candidate) => candidate.id === 'chart')!
  const source = res.workflow!.nodes.find((candidate) => candidate.type === 'data.source')!
  assert.equal(chart.params.datasetId, undefined)
  assert.equal(source.params.datasetId, 'ds-1-today')
  assert.deepEqual(res.workflow!.edges.map((edge) => [edge.source, edge.sourcePort, edge.target, edge.targetPort]), [
    [source.id, '__table__', 'chart', 'data'],
  ])
  assert.ok(res.warnings.some((warning) => warning.includes('迁移为')))
})

test('旧图表已有上游时保留上游，不再保留独立数据集回退', () => {
  const legacy = `name: 老图表
nodes:
  - id: source
    type: data.source
    label: 数据源
    params:
      datasetId: ds-1-today
  - id: chart
    type: viz.chart
    label: 图表
    params:
      datasetId: ds-1-old
edges:
  - source: source
    sourcePort: __table__
    target: chart
    targetPort: data
`
  const res = yamlToWorkflow(legacy, 'wf-chart-upstream', ctxWith('ds-1-today'))

  assert.equal(res.error, undefined)
  assert.equal(res.workflow!.nodes.filter((candidate) => candidate.type === 'data.source').length, 1)
  assert.equal(res.workflow!.nodes.find((candidate) => candidate.id === 'chart')!.params.datasetId, undefined)
  assert.equal(res.workflow!.edges.length, 1)
  assert.equal(res.workflow!.edges[0].source, 'source')
})

test('数据源没选数据集时导入：固定整表端口连线仍可保留', () => {
  const text = workflowToYaml(
    wf(
      [
        node('n1', 'data.source', { datasetId: '' }, '数据源'),
        node('n2', 'custom.script', { code: FN }, '函数'),
      ],
      [['n1', '__table__', 'n2', 'data']],
    ),
    ctxWith(null),
  )
  const res = yamlToWorkflow(text, 'wf-x', ctxWith(null))
  assert.equal(res.workflow!.edges.length, 1, '线要留着，等数据集选上就接上')
  assert.deepEqual(resolvePorts(res.workflow!.nodes[0], ctxWith(null)).outputs.map((p) => p.id), ['__table__'])
})

/* ------------------------------------------------------------------ */
/* 端口可不可信 —— 清理连线的判据                                       */
/* ------------------------------------------------------------------ */

test('数据源没绑定数据集时，固定整表端口仍可信', () => {
  const ctx = ctxWith(null)
  const src = node('n1', 'data.source', { datasetId: 'ds-1-mtybznc9' })
  assert.equal(portsTrustworthy(src, ctx), true, '数据源端口固定，不依赖数据集是否绑定')
  // 列名来自上游运行结果的拆列节点，在上游未算前端口仍不可信
  assert.equal(portsTrustworthy(src, ctxWith('ds-1-mtybznc9')), true)
  assert.equal(portsTrustworthy(node('n0', 'data.source', {}), ctx), true)
})

test('旧数据源的特征/时间轴直连迁移为整表加拆列，原下游连线保留', () => {
  const text = `name: 旧数据源连线
nodes:
  - id: src
    type: data.source
    label: 数据
    params: { datasetId: ds-live }
  - id: fn
    type: custom.script
    label: 函数
    params:
      code: |
        def use_columns(level, timestamp):
            return {"out": level}
edges:
  - { source: src, sourcePort: 液位, target: fn, targetPort: level }
  - { source: src, sourcePort: __time__, target: fn, targetPort: timestamp }
`
  const r = yamlToWorkflow(text, 'wf', ctxWith('ds-live'))
  assert.ok(r.workflow, r.error)

  const source = r.workflow.nodes.find((n) => n.id === 'src')!
  const adapter = r.workflow.nodes.find((n) => n.type === 'data.columns')!
  assert.deepEqual(resolvePorts(source, ctxWith('ds-live')).outputs.map((p) => p.id), ['__table__'])
  assert.deepEqual(resolvePorts(adapter, ctxWith('ds-live')).outputs.map((p) => p.id), ['液位', '__time__'])
  assert.equal(adapter.params.columns, '液位,__time__')

  assert.deepEqual(
    r.workflow.edges.map((e) => [e.source, e.sourcePort, e.target, e.targetPort]),
    [
      [adapter.id, '液位', 'fn', 'level'],
      [adapter.id, '__time__', 'fn', 'timestamp'],
      ['src', '__table__', adapter.id, 'data'],
    ],
  )
  assert.ok(r.warnings.some((w) => w.includes('旧列端口已迁移')))
})

test('函数代码解析不出签名时，端口列表同样不可信', () => {
  const ctx = ctxWith('ds-1-now')
  assert.equal(portsTrustworthy(node('n2', 'custom.script', { code: '' }), ctx), false)
  assert.equal(portsTrustworthy(node('n2', 'custom.script', { code: 'x = 1' }), ctx), false)
  assert.equal(portsTrustworthy(node('n2', 'custom.script', { code: FN }), ctx), true)
})

/*
 * 列拼表从「col_1…col_N 个槽位 + 一个列数参数」改成了一个多入端口（契约规格 R13）。
 * 旧文件必须能打开，而且**不能掉线**：`pruneInvalidEdges` 会清掉目标端口不存在的连线，
 * 所以"读进来时改写"是唯一安全的时机 —— 留给用户重连等于把人家搭好的东西删了。
 */
test('旧文件里连到拼表槽位的线，读进来改写到多入端口（不掉线、不串序）', () => {
  const text = [
    'name: 旧的拼表',
    'nodes:',
    '  - { id: src, type: data.source, label: 数据, params: { datasetId: d1 }, position: { x: 0, y: 0 } }',
    '  - { id: col, type: data.collect, label: 列拼表, params: { slots: 2 }, position: { x: 300, y: 0 } }',
    'edges:',
    '  - { source: src, sourcePort: a, target: col, targetPort: col_1 }',
    '  - { source: src, sourcePort: b, target: col, targetPort: col_2 }',
  ].join('\n')

  const r = yamlToWorkflow(text, 'wf')
  assert.ok(r.workflow, r.error)
  assert.deepEqual(
    r.workflow.edges.filter((e) => e.target === 'col').map((e) => e.targetPort),
    ['in', 'in'],
    '槽位端口要改写，否则这些线会被静默删掉',
  )
  assert.deepEqual(
    r.workflow.edges.filter((e) => e.target === 'col').map((e) => e.sourcePort),
    ['a', 'b'],
    '先后顺序就是拼出来的列序，迁移不能把它打乱',
  )
  assert.equal(
    r.workflow.edges.find((e) => e.target === 'col')?.id,
    'src__legacy_columns|a|col|in',
    '连线迁移后，边 id 要按新端口重算',
  )
  assert.deepEqual(r.workflow.nodes.find((n) => n.id === 'col')?.params, {}, '「列数」参数已经不存在了，别留着让人吃校验错')
})

test('同一个来源端口被接到两个槽位时，去重要说出来，不能静默', () => {
  const text = [
    'name: 重复的拼表',
    'nodes:',
    '  - { id: src, type: data.source, label: 数据, params: { datasetId: d1 }, position: { x: 0, y: 0 } }',
    '  - { id: col, type: data.collect, label: 列拼表, params: {}, position: { x: 300, y: 0 } }',
    'edges:',
    '  - { source: src, sourcePort: a, target: col, targetPort: col_1 }',
    '  - { source: src, sourcePort: a, target: col, targetPort: col_2 }',
  ].join('\n')
  const r = yamlToWorkflow(text, 'wf')
  assert.ok(r.workflow, r.error)
  assert.equal(r.workflow.edges.filter((e) => e.target === 'col').length, 1, '改写后两条变成同一条，只保留先来的')
  assert.ok(r.warnings.some((w) => w.includes('同一个拼表入口')), `要去重要说出来：${r.warnings.join(' / ')}`)
})
