import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_PROJECT_KEY,
  activeProjectId,
  applyProjectText,
  isDiskNewer,
  projectNameFromFileKey,
  projectTextFromStores,
  readDraftProjectId,
  rememberDraftProjectId,
  resolveProjectIdentity,
  stableProjectId,
  undoLastPatch,
} from './projectFile'
import { useWorkflowStore } from './useWorkflowStore'
import { getStoredDataset, useDataStore } from './useDataStore'
import { useAnnotationStore } from './useAnnotationStore'
import { useNotebookStore } from './useNotebookStore'
import { useNodeOutputStore } from './nodeOutputStore'
import { ANNOTATION_KINDS } from '../workflow/annotations'
import { textToProject } from '../workflow/project'
import { nodeFingerprint } from '../engine/plan'
import { buildDatasetRef } from '../kernel/dataset'
import { featuresOf, timeColumnOf } from './useDataStore'
import type { StoredDataset } from '../data/columnStore'

/**
 * "保存人改的、打开 agent 改的"是轮流干活的主干道，而它出错的方式都是静默的：
 * 视图丢了、列开关没套上、数据认错了。靠手点一遍验不出来，所以在这里钉住。
 *
 * 这一层跑在 Node 里（zustand 本身与浏览器无关），不需要真浏览器。
 */

function dataset(id: string, name: string, rowCount: number): StoredDataset {
  const values = Float32Array.from({ length: rowCount }, (_, i) => i)
  return {
    id,
    name,
    source: `${name}.csv`,
    importedAt: 1,
    rowCount,
    timeColumn: '时间',
    time: Float64Array.from({ length: rowCount }, (_, i) => i),
    stepSeconds: 1,
    columns: [
      { name: '时间', type: 'number', role: 'time', enabled: false, stats: stats() },
      { name: '液位', type: 'number', role: 'continuous', enabled: true, stats: stats() },
      { name: '流量', type: 'number', role: 'continuous', enabled: true, stats: stats() },
    ],
    data: { 液位: values, 流量: values },
  }
}

const stats = () => ({ min: 0, max: 1, mean: 0, zeros: 0, missing: 0, nonNumeric: 0 })

function reset(): void {
  useDataStore.getState().setProjectDatasetRefs([])
  useDataStore.setState({ imported: [] })
  useAnnotationStore.setState({ annotations: [], selectedIds: [] })
  useNodeOutputStore.setState({ modelArtifacts: [] })
  useWorkflowStore.getState().setWorkflow({
    id: 'w',
    name: '轮流示例',
    description: '人搭了一半',
    nodes: [
      { id: 'n1', type: 'data.source', label: '数据源', params: { datasetId: 'ds-local' }, position: { x: 0, y: 0 } },
      { id: 'n2', type: 'data.preview', label: '预览', params: { rows: 5 }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: 'e1', source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' }],
  })
}

test('保存：图 + 数据集身份 + 列视图都写进文件', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })

  const text = await projectTextFromStores()
  assert.match(text, /^version: 1$/m)
  assert.match(text, /name: 轮流示例/)
  assert.match(text, /contentHash: sha256:[0-9a-f]{64}/)
  assert.match(text, /path: 锅炉数据\.csv/)
  assert.match(text, /rowCount: 600/)
  assert.match(text, /- name: 液位\n\s+type: number\n\s+role: continuous\n\s+enabled: true/)
  assert.match(text, /- name: 时间\n\s+type: number\n\s+role: time\n\s+enabled: false/)
})

test('往返：存下来的能原样打开，节点与列视图都回来', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })
  const text = await projectTextFromStores()

  // 模拟"agent 在命令行上改了这份文件"：关掉一列
  const edited = text.replace(
    '- name: 流量\n        type: number\n        role: continuous\n        enabled: true',
    '- name: 流量\n        type: number\n        role: continuous\n        enabled: false',
  )
  assert.notEqual(edited, text, '替换没生效，测试自身有问题')

  // 清空界面状态，再打开
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })
  useWorkflowStore.getState().setWorkflow({ id: 'x', name: '空的', description: '', nodes: [], edges: [] })

  const result = applyProjectText(edited, 'wf-test')
  assert.equal(result.ok, true, result.error)
  assert.equal(useWorkflowStore.getState().workflow.nodes.length, 2)
  assert.equal(useWorkflowStore.getState().workflow.edges.length, 1)

  const stored = useDataStore.getState().imported[0]
  assert.equal(stored.columns.find((c) => c.name === '流量')?.enabled, false, 'agent 关掉的列必须跟着关掉')
  assert.equal(stored.columns.find((c) => c.name === '液位')?.enabled, true)
})

/* ---------------- 批注（表格 / 思维图 / 图片） ---------------- */

test('批注往返：写进文件、清空、再打开，内容与位置都回来', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })
  useAnnotationStore.getState().setAll([
    {
      id: 'a1',
      kind: 'mindmap',
      position: { x: 40, y: 80 },
      title: '',
      root: { id: 'm9', text: '第三组换了密封，振动降了一半', children: [] },
    },
    {
      id: 'a2',
      kind: 'table',
      position: { x: 300, y: 80 },
      title: '三组工况读数',
      columns: ['工况', '峰值'],
      rows: [
        ['900', '0.42'],
        ['1200', '0.71'],
      ],
    },
    {
      id: 'a3',
      kind: 'mindmap',
      position: { x: 600, y: 80 },
      title: '',
      root: {
        id: 'm1',
        text: '振动偏大',
        children: [{ id: 'm2', text: '密封？', children: [] }],
      },
    },
    {
      id: 'a4',
      kind: 'image',
      position: { x: 80, y: 360 },
      title: '',
      src: 'data:image/png;base64,abc',
      alt: '截图',
      width: 320,
      height: 180,
      source: '剪贴板截图',
    },
  ])

  const text = await projectTextFromStores()
  assert.match(text, /^annotations:$/m)
  assert.match(text, /kind: mindmap/)
  assert.match(text, /第三组换了密封/)
  assert.match(text, /kind: table/)
  assert.match(text, /三组工况读数/)
  assert.match(text, /kind: image/)
  assert.match(text, /data:image\/png/)

  // 换一份工程打开：批注必须整体换掉，不能跟旧的混在一起
  useAnnotationStore.getState().setAll([
    { id: 'old', kind: 'table', position: { x: 0, y: 0 }, title: '', columns: ['旧的'], rows: [['1']] },
  ])
  const result = applyProjectText(text, 'wf-test')
  assert.equal(result.ok, true, result.error)

  const back = useAnnotationStore.getState().annotations
  assert.equal(back.length, 4, '四条都要回来')
  assert.equal(back.some((a) => a.id === 'old'), false, '打开新工程还留着上一份的便签 = 把别人的读数当成这份工程的')

  const mindmap = back.find((a) => a.id === 'a1')
  assert.equal(mindmap?.kind, 'mindmap')
  if (mindmap?.kind === 'mindmap') {
    assert.equal(mindmap.root.text, '第三组换了密封，振动降了一半')
    assert.deepEqual(mindmap.position, { x: 40, y: 80 }, '位置是版面，要原样')
  }

  const table = back.find((a) => a.id === 'a2')
  assert.equal(table?.kind, 'table')
  if (table?.kind === 'table') {
    assert.deepEqual(table.columns, ['工况', '峰值'])
    assert.deepEqual(table.rows, [['900', '0.42'], ['1200', '0.71']], '数字形的读数按文字原样回来')
  }

  const map = back.find((a) => a.id === 'a3')
  assert.equal(map?.kind, 'mindmap')
  if (map?.kind === 'mindmap') {
    assert.equal(map.root.text, '振动偏大')
    assert.equal(map.root.children[0]?.text, '密封？')
    assert.equal(map.root.children[0]?.id, 'm2', '分支 id 要稳定：加子支靠它找父亲')
  }

  const image = back.find((a) => a.id === 'a4')
  assert.equal(image?.kind, 'image')
  if (image?.kind === 'image') {
    assert.equal(image.src, 'data:image/png;base64,abc')
    assert.deepEqual({ width: image.width, height: image.height }, { width: 320, height: 180 })
    assert.equal(image.source, '剪贴板截图')
  }

  const report = result.report?.lines.find((l) => l.includes('批注'))
  assert.ok(report?.includes('4 条'), '打开报告里要说一句批注的数量，否则人不知道它们存在')
  assert.ok(report?.includes('2 行 × 2 列'), '摘要要能看出表格多大')
})

test('批注认不出来时报数，不静默少一条', () => {
  reset()
  const text = `version: 1
name: 手改过的工程
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: { datasetId: ds-x }, position: { x: 0, y: 0 } }
  edges: []
annotations:
  - { id: a1, kind: table, columns: [读数], rows: [[1]] }
  - { id: a2, kind: 折线 }
`
  const result = applyProjectText(text, 'wf-test')
  assert.equal(result.ok, true, `一条坏批注不该让整份工程打不开：${result.error ?? ''}`)
  assert.equal(useAnnotationStore.getState().annotations.length, 1)
  const warned = result.report?.lines.some((l) => l.includes('认不出来') && l.includes('1 条'))
  assert.ok(warned, '跳过了几条必须说出来 —— "我写的表格没了"是这批功能里最难查的失败')
})

test('批注不进图：它落在 annotations 段里，不在 graph.nodes 里', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })
  useAnnotationStore.getState().add('table', { x: 10, y: 10 })
  const text = await projectTextFromStores()
  /*
   * 按结构判，不按文本里有没有"table"这几个字判 —— 边上的端口名 `__table__`
   * 就含 table，用文本匹配会假报警（第一版就是这么写的，跑出来才发现）。
   */
  const parsed = textToProject(text)
  const project = parsed.project
  assert.ok(project, parsed.error)
  assert.equal((project.graph.nodes as { type: string }[]).some((n) => (ANNOTATION_KINDS as string[]).includes(n.type)), false, '批注出现在图里 = 它会被当成算子去求值')
  assert.equal(project.annotations.length, 1)
  assert.equal(project.graph.nodes.length, 2, '图里还是原来那两个节点')
})

test('只记了读数、还没搭图的工程打得开', () => {
  reset()
  const text = `version: 1
name: 先记两笔
description: 图还没搭
graph:
  nodes: []
  edges: []
annotations:
  - id: a1
    kind: table
    position: { x: 40, y: 80 }
    columns: [工况, 峰值]
    rows: [[换密封后, 0.42]]
  - id: a2
    kind: mindmap
    position: { x: 300, y: 80 }
    root: { id: m1, text: 振动偏大, children: [{ id: m2, text: 密封？ }] }
`
  const result = applyProjectText(text, 'wf-test')
  assert.equal(result.ok, true, `空图不该让整份文件打不开：${result.error ?? ''}`)
  const kept = useAnnotationStore.getState().annotations
  assert.equal(kept.length, 2, '读数表与思维图都要在')
  assert.equal(useWorkflowStore.getState().workflow.nodes.length, 0)
  if (kept[1]?.kind === 'mindmap') {
    assert.equal(kept[1].root.children[0]?.text, '密封？', '嵌套的分支也要原样回来')
  } else {
    assert.fail('第二条应该是思维图')
  }
})

test('旧工程的便签：读进来时忽略并报数（记录已经搬到实验笔记栏）', () => {
  reset()
  const text = `version: 1
name: 手改过的工程
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: { datasetId: ds-x }, position: { x: 0, y: 0 } }
  edges: []
annotations:
  - { id: a1, kind: note, text: 记一下, tone: 便签, position: { x: 240, y: 10 } }
  - { id: a2, kind: note, text: 另一条, tone: 结论, position: { x: 240, y: 200 } }
  - { id: a3, kind: table, columns: [工况], rows: [[900]], position: { x: 240, y: 400 } }
`
  const result = applyProjectText(text, 'wf-test')
  assert.equal(result.ok, true, result.error)
  const kept = useAnnotationStore.getState().annotations
  assert.equal(kept.length, 1, '便签不读进来，表格照常')
  assert.equal(kept[0]?.kind, 'table')
  const warned = result.report?.lines.some((line) => line.includes('便签') && line.includes('2 条'))
  assert.ok(warned, '丢了两条人写的字必须报出来，还要说清去哪儿记 —— 静默丢掉是最伤的一种失败')
})

test('实验笔记：写进工程文件、读回来，正文原样', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })
  const body = [
    '# 实验 1：原始信号',
    '',
    '换了 3 号泵的密封，振动峰值从 0.71 降到 0.42。',
    '',
    '![谱图](data:image/png;base64,AAA)',
    '',
    '上游见 @[时域特征](node:n1)。',
    '',
  ].join('\n')
  useNotebookStore.getState().setAll(body)

  const text = await projectTextFromStores()
  assert.match(text, /^notebook:$/m)
  assert.ok(text.includes('换了 3 号泵的密封'), '笔记正文要在文件里（block scalar，人能 diff）')

  useNotebookStore.getState().setAll('')
  const result = applyProjectText(text, 'wf-test')
  assert.equal(result.ok, true, result.error)
  assert.equal(useNotebookStore.getState().markdown, body, '往返一次正文一个字符都不该变')
  const reported = result.report?.lines.some((line) => line.includes('实验笔记'))
  assert.ok(reported, '打开工程要说一句笔记有多少字 —— 不然人不知道它跟着工程走了')
})

test('工程往返保留模型制品引用，同一制品可被多个节点引用', async () => {
  reset()
  const shared = {
    artifactId: 'a'.repeat(32),
    trainingFingerprint: 'train-fingerprint-v1',
    manifestSha256: 'b'.repeat(64),
    createdAt: '2026-09-18T08:00:00Z',
  }
  useNodeOutputStore.getState().setModelArtifacts([
    { nodeId: 'trainer-a', ...shared },
    { nodeId: 'trainer-b', ...shared },
  ])

  const text = await projectTextFromStores()
  assert.match(text, /^modelArtifacts:$/m)
  assert.match(text, new RegExp(`artifactId: ${shared.artifactId}`))
  useNodeOutputStore.getState().setModelArtifacts([])
  const opened = applyProjectText(text, 'wf-artifact-roundtrip')
  assert.equal(opened.ok, true, opened.error)
  assert.ok(
    opened.report?.lines.some((line) => line.includes('打开工程后本机宿主会自动按训练指纹与校验值恢复')),
    '打开工程必须明确告知模型制品会自动恢复',
  )
  assert.deepEqual(
    useNodeOutputStore.getState().modelArtifacts.map((ref) => ref.nodeId),
    ['trainer-a', 'trainer-b'],
    '两个工程节点共用制品时必须完整保留两条引用，不能因一条被清理而丢另一条',
  )
  assert.equal(
    useNodeOutputStore.getState().modelArtifacts[0]?.artifactId,
    useNodeOutputStore.getState().modelArtifacts[1]?.artifactId,
  )
})

test('但旧版工作流 YAML 里空图仍然报错（那里空文件没有别的内容）', () => {
  const result = applyProjectText('name: 空的\nnodes: []\nedges: []\n', 'wf-test')
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /nodes 列表是空的/)
})

test('打开一份 id 对不上的工程：按名字与行数认回本机那份数据', async () => {
  const text = `version: 1
name: 别处导出的
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: { datasetId: ds-别的会话 }, position: { x: 0, y: 0 } }
  edges: []
datasets:
  - id: ds-别的会话
    name: 锅炉数据
    rowCount: 600
    columns:
      - { name: 液位, type: number, role: continuous, enabled: false }
      - { name: 流量, type: number, role: continuous, enabled: true }
`
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })

  const result = applyProjectText(text, 'wf-test')
  assert.equal(result.ok, true)
  assert.equal(result.report?.lines.some((l) => l.includes('不在本机')), false, '本机有这份数据，不该报缺')
  assert.equal(
    useWorkflowStore.getState().workflow.nodes[0]?.params.datasetId,
    'ds-别的会话',
    '工程里的稳定 ID 必须保留，否则已保存模型的训练指纹会改变',
  )
  assert.equal(getStoredDataset('ds-别的会话')?.id, 'ds-local', '执行数据通过绑定映射到本机导入 ID')
  assert.equal(useDataStore.getState().imported[0].columns.find((c) => c.name === '液位')?.enabled, false)
})

test('保存和重开会递归收集并重绑组块内部的数据源', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-before-restart', '锅炉数据', 600)] })
  useWorkflowStore.getState().setWorkflow({
    id: 'wf-group-dataset',
    name: '组内数据源',
    description: '',
    nodes: [{
      id: 'group-1',
      type: 'workflow.group',
      label: '数据准备',
      params: {},
      position: { x: 0, y: 0 },
      group: {
        workflow: {
          id: 'inner-wf',
          name: '内部',
          description: '',
          nodes: [{
            id: 'source-inner',
            type: 'data.source',
            label: '数据源',
            params: { datasetId: 'ds-before-restart' },
            position: { x: 0, y: 0 },
          }],
          edges: [],
        },
        inputs: [],
        outputs: [],
        parameters: [],
      },
    }],
    edges: [],
  })

  const text = await projectTextFromStores()
  assert.match(text, /id: ds-before-restart/, '工程要登记组内节点使用的数据集')
  useDataStore.setState({ imported: [dataset('ds-after-restart', '锅炉数据', 600)] })

  const opened = applyProjectText(text, 'wf-reopened')
  assert.equal(opened.ok, true, opened.error)
  const innerSource = useWorkflowStore.getState().workflow.nodes[0]?.group?.workflow.nodes[0]
  assert.equal(innerSource?.params.datasetId, 'ds-before-restart')
  assert.equal(getStoredDataset('ds-before-restart')?.id, 'ds-after-restart')
  assert.ok(opened.report?.lines.some((line) => line.includes('绑定到本机导入项')))
})

test('先打开工程后导入 CSV：激活稳定 ID 绑定并恢复工程列视图', () => {
  reset()
  const text = `version: 1
name: 先开工程
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: { datasetId: ds-project }, position: { x: 0, y: 0 } }
  edges: []
datasets:
  - id: ds-project
    name: 锅炉数据
    rowCount: 600
    columns:
      - { name: 液位, type: number, role: continuous, enabled: false }
      - { name: 流量, type: number, role: continuous, enabled: true }
`
  const opened = applyProjectText(text, 'wf-open-first')
  assert.equal(opened.ok, true, opened.error)
  assert.equal(useWorkflowStore.getState().workflow.nodes[0]?.params.datasetId, 'ds-project')
  assert.equal(getStoredDataset('ds-project'), undefined)

  useDataStore.getState().addImported(dataset('ds-imported-later', '锅炉数据', 600))

  assert.equal(getStoredDataset('ds-project')?.id, 'ds-imported-later')
  assert.equal(getStoredDataset('ds-project')?.columns.find((column) => column.name === '液位')?.enabled, false)
})

test('重新导入同一份数据后，数据源训练指纹保持不变', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-before-restart', '锅炉数据', 600)] })
  useWorkflowStore.getState().setWorkflow({
    id: 'wf-fingerprint',
    name: '指纹往返',
    description: '',
    nodes: [{
      id: 'source',
      type: 'data.source',
      label: '数据源',
      params: { datasetId: 'ds-before-restart' },
      position: { x: 0, y: 0 },
    }],
    edges: [],
  })

  const fingerprint = async () => {
    const node = useWorkflowStore.getState().workflow.nodes[0]
    const stored = getStoredDataset(String(node?.params.datasetId ?? ''))
    assert.ok(node && stored)
    const ref = await buildDatasetRef(stored)
    return nodeFingerprint(node, {}, {}, {
      featuresOf,
      timeColumnOf,
      contentHashOf: () => ref.contentHash,
    })
  }
  const before = await fingerprint()
  const text = await projectTextFromStores()

  useDataStore.setState({ imported: [dataset('ds-after-restart', '锅炉数据', 600)] })
  const opened = applyProjectText(text, 'wf-fingerprint-reopened')
  assert.equal(opened.ok, true, opened.error)

  assert.equal(useWorkflowStore.getState().workflow.nodes[0]?.params.datasetId, 'ds-before-restart')
  assert.equal(await fingerprint(), before, '工程参数 ID、数据内容与列视图一致时，权重匹配用的指纹也要一致')
})

test('数据不在本机时：图照样打开、连线保留，并说清去哪儿补', () => {
  const text = `version: 1
name: 别人的工程
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: { datasetId: ds-xyz }, position: { x: 0, y: 0 } }
  edges: []
datasets:
  - id: ds-xyz
    name: 没有这份数据
    rowCount: 100
`
  reset()
  const result = applyProjectText(text, 'wf-test')
  assert.equal(result.ok, true, '数据不在不该让工程打不开')
  assert.equal(useWorkflowStore.getState().workflow.nodes.length, 1)
  assert.ok(result.report?.lines.some((l) => l.includes('没有这份数据') && l.includes('导入数据')))
})

test('旧格式的工作流 YAML 也能从这里打开（向后兼容）', () => {
  const legacy = `
name: 老文件
nodes:
    - { id: n1, type: data.preview, label: 预览, params: {}, position: { x: 0, y: 0 } }
edges: []
`
  reset()
  const result = applyProjectText(legacy, 'wf-test')
  assert.equal(result.ok, true)
  assert.equal(useWorkflowStore.getState().workflow.name, '老文件')
})

test('界面侧撤销：agent 加的两个节点被撤掉，工程回到打开时的样子', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })

  // 一份"agent 改过"的工程：多了一个节点与一条连线，文件里带着改动记录
  const withPatch = `
version: 1
name: 轮流示例
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: { datasetId: ds-local }, position: { x: 0, y: 0 } }
    - { id: n2, type: data.preview, label: 预览, params: { rows: 5 }, position: { x: 200, y: 0 } }
  edges:
    - { source: n1, sourcePort: __table__, target: n2, targetPort: data }
datasets:
  - id: ds-local
    name: 锅炉数据
    rowCount: 600
patches:
  - at: 1
    reason: 加了预览节点
    ops:
      - { op: addNode, id: n2, type: data.preview, label: 预览, params: { rows: 5 } }
      - { op: connect, source: n1, sourcePort: __table__, target: n2, targetPort: data }
    reverse:
      - { op: disconnect, edgeId: "n1|__table__|n2|data" }
      - { op: removeNode, id: n2 }
`
  const opened = applyProjectText(withPatch, 'wf-test')
  assert.equal(opened.ok, true)
  assert.equal(opened.report?.patchCount, 1)
  assert.equal(useWorkflowStore.getState().workflow.nodes.length, 2)

  const undone = await undoLastPatch()
  assert.equal(undone.ok, true, undone.error)
  assert.equal(useWorkflowStore.getState().workflow.nodes.length, 1, 'agent 加的节点该没了')
  assert.equal(useWorkflowStore.getState().workflow.edges.length, 0)
  assert.ok(undone.text && !undone.text.includes('patches:'), '撤销后不该还留着那条改动记录')
})

test('界面侧撤销：没有记录时说清楚，而不是假装撤了', async () => {
  reset()
  useDataStore.setState({ imported: [dataset('ds-local', '锅炉数据', 600)] })
  const result = await undoLastPatch()
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /没有可撤销/)
})

/**
 * "磁盘上那份被 agent 改过了"这件事，浏览器不给变更通知，只能主动看一眼时间戳与大小。
 * 判据本身很朴素，但要保守：拿不到就当作没变 —— 误报一堆"文件变了"比漏报更烦人。
 */
test('磁盘上的文件变了没有：只看时间戳与大小，拿不到就当作没变', () => {
  assert.equal(isDiskNewer(null, { lastModified: 1, size: 10 }), false)
  assert.equal(isDiskNewer({ lastModified: 1, size: 10 }, null), false)
  assert.equal(isDiskNewer({ lastModified: 1, size: 10 }, { lastModified: 1, size: 10 }), false)
  assert.equal(isDiskNewer({ lastModified: 1, size: 10 }, { lastModified: 2, size: 10 }), true, '被改过')
  assert.equal(isDiskNewer({ lastModified: 1, size: 10 }, { lastModified: 1, size: 11 }), true, '大小变了')
})

/**
 * 未保存工程的对话身份：这一条不写住，刷新一次就换一个 projectId，
 * 磁盘上的历史对话全都认不回这份工程 —— 留存机制会变成"写下来了但找不回来"。
 */
test('草稿工程身份只认合法的寻址键，坏值当没有', () => {
  const memory = new Map<string, string>()
  const store = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) }
  assert.equal(readDraftProjectId(store), undefined)
  rememberDraftProjectId(store, '57164e48-b780-4da8-a682-42de880e39e0')
  assert.equal(readDraftProjectId(store), '57164e48-b780-4da8-a682-42de880e39e0')
  assert.equal(memory.get(DRAFT_PROJECT_KEY), '57164e48-b780-4da8-a682-42de880e39e0')
  memory.set(DRAFT_PROJECT_KEY, '../别的目录')
  assert.equal(readDraftProjectId(store), undefined, '带路径分隔符的值不能当成工程 id')
  memory.set(DRAFT_PROJECT_KEY, 'x'.repeat(200))
  assert.equal(readDraftProjectId(store), undefined)
  assert.equal(readDraftProjectId(undefined), undefined, '没有 localStorage 时不炸')
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(readDraftProjectId(throwing), undefined)
  rememberDraftProjectId(throwing, 'whatever')
})

/** 一份**没有 `projectId`** 的工程（用户那份 `最终.sciviz` 就是：1.7 MB，`projectId` 出现 0 次） */
const NO_IDENTITY_PROJECT = `version: 1
name: 未命名工作流
graph:
  nodes:
    - { id: n1, type: data.source, label: 数据源, params: {}, position: { x: 0, y: 0 } }
  edges: []
`

/**
 * 用户报的正是这条：「我每次重开这个项目，对话记录又是空白的？」
 *
 * 根因不是没写盘，是**每次打开都换了一个工程身份**：`project.projectId ?? newProjectId()` 对一份
 * 没有 `projectId` 的文件每次随机一个 id，于是 `/agent/session` 在一个从没有过对话的身份下列表。
 * 对话一条没丢，全躺在互不相认的随机身份下面。
 */
test('同一份没有 projectId 的工程文件，重开必须还是同一个身份', () => {
  reset()
  assert.equal(applyProjectText(NO_IDENTITY_PROJECT, 'wf-open-1', { fileKey: '最终.sciviz' }).ok, true)
  const first = activeProjectId()
  assert.equal(applyProjectText(NO_IDENTITY_PROJECT, 'wf-open-2', { fileKey: '最终.sciviz' }).ok, true)
  assert.equal(activeProjectId(), first, '同一份文件重开换了身份 = 对话记录又变空')

  assert.equal(applyProjectText(NO_IDENTITY_PROJECT, 'wf-open-3', { fileKey: '最终 - 副本.sciviz' }).ok, true)
  assert.notEqual(activeProjectId(), first, '换一份文件就该是另一份工程')

  const opened = applyProjectText(NO_IDENTITY_PROJECT, 'wf-open-4', { fileKey: '还没起名的.sciviz' })
  assert.ok(
    opened.report?.lines.some((line) => line.includes('没有工程身份')),
    '身份是派生的就要说出来 —— 用户看不到身份，只看得到"有没有对话"',
  )
})

test('身份判定三行：文件里的 id > 文件名派生 > 随机', () => {
  const derived = resolveProjectIdentity(undefined, '最终.sciviz')
  assert.equal(derived.derived, true)
  assert.equal(derived.projectId, stableProjectId('最终.sciviz'))
  assert.match(
    derived.projectId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    '派生出来的身份必须是合法 UUID 形状：保存时它要写进文件，而读回来那一关是严格校验',
  )

  assert.equal(
    resolveProjectIdentity(undefined, '别的.sciviz').projectId,
    stableProjectId('别的.sciviz'),
    '一份文件一个身份，不能漫到别的工程上',
  )

  const inFile = '8b7c2f10-4d5e-4a1b-9c3d-2f6e7a8b9c0d'
  assert.equal(resolveProjectIdentity(inFile, '最终.sciviz').projectId, inFile, '文件是真相')

  const fresh = resolveProjectIdentity(undefined, undefined)
  assert.equal(fresh.derived, false)
  assert.notEqual(resolveProjectIdentity(undefined, undefined).projectId, fresh.projectId, '没有文件的未保存工程每次都该是新身份')
})

test('打开文件名是工程名：去掉扩展名与路径，空名不覆盖已有名称', () => {
  assert.equal(projectNameFromFileKey('LSTM训练空间.sciviz'), 'LSTM训练空间')
  assert.equal(projectNameFromFileKey('C:\\实验\\最终.yaml'), '最终')
  assert.equal(projectNameFromFileKey('workflow.YML'), 'workflow')
  assert.equal(projectNameFromFileKey('只有扩展名.sciviz'.replace('只有扩展名', '')), undefined)
  assert.equal(projectNameFromFileKey('  '), undefined)
})
