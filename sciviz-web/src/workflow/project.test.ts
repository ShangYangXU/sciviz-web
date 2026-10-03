import test from 'node:test'
import assert from 'node:assert/strict'
import { PROJECT_VERSION, emptyProject, projectPortContext, projectToText, textToProject, type Project, type ProjectReport } from './project'
import type { Workflow, WorkflowNode } from './types'
import { defaultParams, getNodeTypeDef } from './nodeRegistry'
import { createAnnotation, createImageAnnotation } from './annotations'
import { createGroupFromSelection, runtimeNodeIdForPath } from './groups'
import { resolvePorts } from './ports'

/**
 * 工程文件的钉子。
 *
 * 这份文件是人与 agent 共用的状态，所以它的性质不是"能存能读"这么简单：
 * - **同样的工程必须写出同样的文本** —— 否则 diff 里全是噪声，"看差异"就废了；
 * - **旧的 YAML 必须还能读** —— 不然人手上已有的文件一夜失效；
 * - **列视图必须往返无损** —— 它是 agent 能不能接手"人做了一半"的关键。
 */

const GRAPH: Workflow = {
  id: 'wf',
  name: '示例工程',
  description: '一句话说明',
  nodes: [
    {
      id: 'n1',
      type: 'data.source',
      label: '数据源',
      params: { datasetId: 'ds-1' },
      position: { x: 12.4, y: -3.6 },
    },
    {
      id: 'n2',
      type: 'data.preview',
      label: '预览',
      // 默认参数补全：界面里建的、以及从文件里读回来的节点都是这个样子。
      // 手写一份"只有我要改的那几个"会让"读回来再写出去还是同一份文本"这条
      // 性质假失败 —— 那不是产品的问题，是 fixture 不像真实节点
      params: { ...defaultParams(getNodeTypeDef('data.preview')), rows: 5 },
      position: { x: 260, y: 0 },
    },
  ],
  edges: [{ id: 'e1', source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' }],
}

const PROJECT: Project = {
  ...emptyProject(GRAPH),
  datasets: [
    {
      id: 'ds-1',
      name: '锅炉数据',
      path: 'data/boiler2.csv',
      contentHash: 'sha256:' + 'a'.repeat(64),
      rowCount: 1048575,
      timeColumn: '时间',
      sampleRate: 1000,
      columns: [
        { name: '时间', type: 'number', role: 'time', enabled: false },
        { name: '液位', type: 'number', role: 'continuous', enabled: true },
        { name: '给水流量', type: 'number', role: 'continuous', enabled: false },
      ],
    },
  ],
  environment: { coreVersion: '0.1.0' },
  runs: { index: 'runs/index.json', lastRunId: '20260913-134045-abcd' },
}

const GROUP_NODE: WorkflowNode = {
  id: 'group-1',
  type: 'workflow.group',
  label: '预处理',
  params: {},
  position: { x: 500, y: 120 },
  group: {
    workflow: {
      id: 'inner-1',
      name: '预处理内部',
      description: '一段可复用逻辑',
      nodes: [
        {
          id: 'preview-inner',
          type: 'data.preview',
          label: '内部预览',
          params: { ...defaultParams(getNodeTypeDef('data.preview')), rows: 7 },
          position: { x: 160, y: 40 },
        },
      ],
      edges: [],
    },
    inputs: [],
    outputs: [],
    parameters: [],
  },
}

test('往返无损：图、位置、参数、数据集视图都读得回来', () => {
  const parsed = textToProject(projectToText(PROJECT))
  assert.equal(parsed.error, undefined)
  const p = parsed.project!

  assert.equal(p.version, PROJECT_VERSION)
  assert.equal(p.name, '示例工程')
  assert.equal(p.description, '一句话说明')
  assert.equal(p.graph.nodes.length, 2)
  assert.deepEqual(p.graph.nodes[0].position, { x: 12, y: -4 }, '位置取整后原样保留')
  assert.deepEqual(p.graph.nodes[1].params, {
    ...defaultParams(getNodeTypeDef('data.preview')),
    rows: 5,
  })
  assert.equal(p.graph.edges[0].sourcePort, '__table__')

  assert.equal(p.datasets.length, 1)
  const d = p.datasets[0]
  assert.equal(d.name, '锅炉数据')
  assert.equal(d.path, 'data/boiler2.csv')
  assert.equal(d.timeColumn, '时间')
  assert.equal(d.sampleRate, 1000)
  assert.deepEqual(
    d.columns?.map((c) => `${c.name}:${c.enabled}`),
    ['时间:false', '液位:true', '给水流量:false'],
    '人的列视图必须往返无损 —— agent 靠它接手',
  )
  assert.equal(p.environment.coreVersion, '0.1.0')
  assert.equal(p.runs.lastRunId, '20260913-134045-abcd')
})

test('打开工程时按节点身份把制品引用重新对上组块里的节点', () => {
  // 一个"训练节点被封装进组块"的工程：引用还写着封装前那个 id
  const grouped = createGroupFromSelection(
    GRAPH,
    ['n2'],
    { featuresOf: () => [], timeColumnOf: () => null },
    'g1',
    '训练组',
  )
  const artifact = {
    artifactId: 'c'.repeat(32),
    trainingFingerprint: 'train-fingerprint-v1',
    manifestSha256: 'd'.repeat(64),
    createdAt: '2026-09-21T08:00:00Z',
  }
  const project: Project = {
    ...PROJECT,
    graph: grouped.workflow,
    modelArtifacts: [
      { nodeId: 'n2', ...artifact },
      { nodeId: 'nobody-here', ...artifact, artifactId: 'e'.repeat(32) },
    ],
  }

  const parsed = textToProject(projectToText(project))
  assert.equal(parsed.error, undefined, parsed.error)
  assert.deepEqual(
    parsed.project?.modelArtifacts.map((ref) => ref.nodeId),
    [runtimeNodeIdForPath(['g1'], 'n2'), 'nobody-here'],
    '唯一对得上的那条按节点身份修好；对不上的原样留着，不猜',
  )
  const lines = parsed.warnings.join('\n')
  assert.match(lines, /1 条模型制品引用按节点身份重新对上/)
  assert.match(lines, /1 条模型制品引用在当前图里找不到对应节点/)
})

test('制品引用本来就对得上时，打开工程一个字都不动', () => {
  const project: Project = {
    ...PROJECT,
    modelArtifacts: [
      {
        nodeId: 'n2',
        artifactId: 'c'.repeat(32),
        trainingFingerprint: 'train-fingerprint-v1',
        manifestSha256: 'd'.repeat(64),
        createdAt: '2026-09-21T08:00:00Z',
      },
    ],
  }
  const parsed = textToProject(projectToText(project))
  assert.deepEqual(parsed.project?.modelArtifacts.map((ref) => ref.nodeId), ['n2'])
  assert.ok(
    !parsed.warnings.some((warning) => warning.includes('模型制品引用')),
    '没动就别说话',
  )
})

test('同样的工程写出同样的文本 —— 这是"看差异"的前提', () => {
  const a = projectToText(PROJECT)
  const b = projectToText(textToProject(a).project!)
  assert.equal(a, b)
})

test('工程数据集上下文按特征索引解析直连拆列', () => {
  const graph: Workflow = {
    ...GRAPH,
    nodes: [
      GRAPH.nodes[0],
      {
        id: 'split',
        type: 'data.columns',
        label: '拆列',
        params: { ...defaultParams(getNodeTypeDef('data.columns')), columns: '1' },
        position: { x: 260, y: 0 },
      },
    ],
    edges: [{ id: 'e1', source: 'n1', sourcePort: '__table__', target: 'split', targetPort: 'data' }],
  }
  const ctx = projectPortContext({ ...PROJECT, graph })
  assert.deepEqual(ctx.columnsOf?.('split', 'data'), ['时间', '液位'])
  assert.deepEqual(ctx.featureColumnsOf?.('split', 'data'), ['液位'])
  assert.deepEqual(resolvePorts(graph.nodes[1], ctx).outputs.map((port) => port.id), ['液位'])
})

test('.sciviz 递归保存组块定义，并保持稳定文本往返', () => {
  const project: Project = {
    ...PROJECT,
    graph: { ...GRAPH, nodes: [...GRAPH.nodes, GROUP_NODE] },
  }
  const text = projectToText(project)
  const parsed = textToProject(text)
  assert.equal(parsed.error, undefined, parsed.error)
  assert.deepEqual(parsed.project!.graph.nodes.find((node) => node.id === 'group-1')?.group, GROUP_NODE.group)
  assert.equal(projectToText(parsed.project!), text)
})

test('.sciviz 往返保留组内图片和批注归属，旧批注默认属于主画布', () => {
  const project: Project = {
    ...PROJECT,
    graph: { ...GRAPH, nodes: [...GRAPH.nodes, GROUP_NODE] },
    annotations: [
      createAnnotation('table', 'root-table', { x: 8, y: 12 }, () => 'branch-root'),
      {
        ...createImageAnnotation(
          'group-image',
          { x: 40, y: 60 },
          'data:image/png;base64,abc',
          { width: 240, height: 120 },
          '组内截图',
          '剪贴板截图',
          ['group-1'],
        ),
        title: '组内截图：启动阶段',
      },
    ],
  }
  const text = projectToText(project)
  assert.match(text, /groupPath:\s*\n\s*- group-1/)
  const parsed = textToProject(text)
  assert.equal(parsed.error, undefined, parsed.error)
  assert.deepEqual(parsed.project!.annotations, project.annotations)
  assert.equal(projectToText(parsed.project!), text)

  const legacy = textToProject(`
version: 1
name: 旧批注
graph: { nodes: [], edges: [] }
annotations:
  - { id: old-table, kind: table, columns: [读数], rows: [[1]], position: { x: 0, y: 0 } }
`)
  assert.deepEqual(legacy.project!.annotations[0].groupPath, [], '旧文件没写 groupPath 的批注归主画布')
})

test('旧的工作流 YAML（没有 version / graph / datasets）照样能读', () => {
  const legacy = `
name: 老文件
nodes:
  - id: n1
    type: data.source
    label: 数据源
    params: { datasetId: ds-9 }
    dataset: { name: 锅炉数据, rowCount: 100 }
    position: { x: 0, y: 0 }
edges: []
`
  const parsed = textToProject(legacy)
  assert.ok(parsed.project, '不能因为"没有版本号"就让人的老文件失效')
  assert.equal(parsed.project!.version, 0)
  assert.equal(parsed.project!.graph.name, '老文件')
  assert.equal(parsed.project!.datasets.length, 0, '旧文件没有 datasets 段')
  assert.ok(parsed.warnings.some((w) => w.includes('旧版')))
})

test('读不懂的字段不炸，只忽略', () => {
  const text = `${projectToText(PROJECT)}\nfutureFeature:\n  whatever: 1\n`
  const parsed = textToProject(text)
  assert.ok(parsed.project)
  assert.equal(parsed.project!.graph.nodes.length, 2)
})

test('列视图缺 enabled 时按启用处理（与导入默认一致）', () => {
  const text = `
version: 1
name: 缺字段
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: { datasetId: ds-1 }, position: { x: 0, y: 0 } }
  edges: []
datasets:
  - id: ds-1
    name: 锅炉数据
    columns:
      - { name: 液位, type: number, role: continuous }
`
  const p = textToProject(text).project!
  assert.equal(p.datasets[0].columns?.[0].enabled, true)
})

/**
 * 项目报告是 2026-09-26 加的（FILE-2）：它是**文件格式**的一部分，不是界面缓存。
 * 所以这里钉的是"报告能跟着工程走"这件事本身：正文、Agent 来源、图像出处
 * 都要能从写出去的文本里原样读回来，而且加了报告不许动图。
 */
const REPORT: ProjectReport = {
  id: 'report-1',
  title: '工作段对比实验报告',
  markdown: `# 工作段对比\n\n![工作段 1](${`data:image/png;base64,${Buffer.alloc(24, 3).toString('base64')}`})\n\n*图源：对比曲线；SHA-256 \`${'a'.repeat(64)}\`。*\n`,
  createdAt: '2026-09-26T01:00:00.000Z',
  updatedAt: '2026-09-26T02:00:00.000Z',
  source: { kind: 'agent-task', sessionId: 'session-1', taskId: 'task-1', evidenceRefs: ['call-figure'] },
  figures: [
    {
      id: 'a'.repeat(64),
      nodeId: 'chart-1',
      groupPath: ['组块 A'],
      runtimeId: 'g1:chart-1',
      portId: 'figure',
      label: '对比曲线',
      caption: '工作段 1',
      sha256: 'a'.repeat(64),
      sourceFingerprintSha256: 'b'.repeat(64),
      width: 640,
      height: 400,
    },
  ],
}

test('项目报告随工程往返：正文、Agent 来源与图像出处都读得回来', () => {
  const project: Project = { ...PROJECT, reports: [REPORT] }
  const parsed = textToProject(projectToText(project))
  assert.equal(parsed.error, undefined)

  assert.deepEqual(parsed.project!.reports, [REPORT])
  assert.ok(parsed.project!.reports[0].markdown.includes('data:image/png;base64,'), '图片要内嵌在正文里，报告才能单独带走')
  assert.equal(parsed.project!.reports[0].source?.sessionId, 'session-1')
  assert.deepEqual(parsed.project!.reports[0].figures[0].groupPath, ['组块 A'])
  const withoutReports = textToProject(projectToText({ ...PROJECT, reports: [] })).project!
  assert.deepEqual(parsed.project!.graph, withoutReports.graph, '报告与图并列：写一次报告不该动到图')
  assert.equal(projectToText(parsed.project!), projectToText(project), '报告往返之后文本要一模一样')
})

test('reports 里的坏条目跳过并说出来，不拿它挡住整个工程', () => {
  const text = projectToText({ ...PROJECT, reports: [REPORT, { ...REPORT, title: '重复身份的报告' }] })
  const parsed = textToProject(text)

  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.project!.reports, [REPORT], 'id 重复的那份丢掉，第一份留下')
  assert.match(parsed.warnings.join('\n'), /reports 中有缺少 id、标题或正文，或 id 重复的条目/)
  assert.equal(parsed.project!.graph.nodes.length, 2, '坏报告不该把图一起带走')
})
