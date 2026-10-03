import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch } from './patch'
import { diffLines } from './diff'
import { projectToText, textToProject, type Project } from '../workflow/project'
import type { PatchFile } from '../contract/ops'
import type { WorkflowNode } from '../workflow/types'
import { defaultParams, getNodeTypeDef } from '../workflow/nodeRegistry'

/**
 * 补丁应用器的钉子。
 *
 * 守的是三条：**原子**（一条不行就一条都不落）、**不比 validate 更严**（图没接完是
 * 正常中间状态）、**结构性错误必须在写入前拦住**。第三条最重要 —— agent 改图时
 * 最容易犯的错（接到不存在的端口、接反类型、接出环）如果放过去了，
 * 人打开看到的是一张坏图，而坏图不会自己报错。
 */

/**
 * 造一个节点。**默认值要补全**：界面里建的节点天然带着全部默认参数，而读工程文件
 * 时也会补上（`yaml.ts` 的 `{ ...defaultParams(def) }`）。测试里手写一份"只有我要改的
 * 那几个参数"看起来更干净，但它和产品里真实存在的节点不是一回事 —— 撤消那种
 * "一字不差回到原样"的断言会因此假失败。
 */
const node = (
  id: string,
  type: string,
  params: Record<string, string | number | boolean> = {},
): WorkflowNode => ({
  id,
  type,
  label: id,
  params: { ...defaultParams(getNodeTypeDef(type)), ...params },
  position: { x: 0, y: 0 },
})

const project = (nodes: WorkflowNode[] = [node('n1', 'data.source', { datasetId: 'ds-1' })]): Project => ({
  version: 1,
  name: '轮流示例',
  description: '',
  graph: { id: 'g', name: '轮流示例', description: '', nodes, edges: [] },
  annotations: [],
  notebook: '',
  reports: [],
  datasets: [
    {
      id: 'ds-1',
      name: '锅炉数据',
      timeColumn: null,
      columns: [
        { name: '液位', type: 'number', role: 'continuous', enabled: true },
        { name: '流量', type: 'number', role: 'continuous', enabled: true },
      ],
    },
  ],
  environment: {},
  runs: {},
  modelArtifacts: [],
  patches: [],
})

const patch = (...ops: PatchFile['ops']): PatchFile => ({ reason: '测试', ops })
const codes = (r: ReturnType<typeof applyPatch>) => r.rejections.map((x) => x.code)

/*
 * agent / CLI 改图的唯一通道就是补丁。封装与解散会改内部节点的运行时 id，而模型制品
 * 引用是按运行时 id 归属的 —— 补丁这条路不搬，训好的权重就再也读不到（界面只会显示
 * "等待开始训练"或"当前训练设置与已保存制品不匹配"，没有线索说明为什么）。
 * 判据：搬过去、解散搬回来、写出去再读回来一个字不差。
 */
test('补丁封装 / 解散子空间：模型制品引用跟着块走（与界面同一条规则）', () => {
  const artifact = {
    artifactId: 'e'.repeat(32),
    trainingFingerprint: 'train-fingerprint-v1',
    manifestSha256: 'f'.repeat(64),
    createdAt: '2026-09-22T02:00:00Z',
  }
  const withTrainer: Project = {
    ...project([node('n1', 'data.source', { datasetId: 'ds-1' }), node('trainer', 'train.function')]),
    modelArtifacts: [{ nodeId: 'trainer', ...artifact }],
  }

  const grouped = applyPatch(withTrainer, patch({ op: 'createGroup', id: 'g1', label: '训练组', nodeIds: ['trainer'] }))
  assert.equal(grouped.ok, true, JSON.stringify(grouped.rejections))
  assert.deepEqual(
    grouped.project.modelArtifacts.map((ref) => ref.nodeId),
    [`group:["g1"]:"trainer"`],
    '块进了子空间，引用也要跟进去',
  )
  assert.equal(grouped.project.modelArtifacts[0]?.artifactId, artifact.artifactId)

  // 写出去再读回来：搬过的引用必须进得了文件，不许掉在序列化那一段
  const reopened = textToProject(projectToText(grouped.project))
  assert.deepEqual(reopened.project?.modelArtifacts.map((ref) => ref.nodeId), [`group:["g1"]:"trainer"`])

  const ungrouped = applyPatch(grouped.project, patch({ op: 'ungroup', id: 'g1' }))
  assert.equal(ungrouped.ok, true, JSON.stringify(ungrouped.rejections))
  assert.deepEqual(
    ungrouped.project.modelArtifacts.map((ref) => ref.nodeId),
    ['trainer'],
    '解散之后同样要跟回来',
  )

  // 撤销也是补丁（反向动作），同样要搬回去
  const undone = applyPatch(grouped.project, patch(...grouped.reverse))
  assert.equal(undone.ok, true, JSON.stringify(undone.rejections))
  assert.deepEqual(undone.project.modelArtifacts.map((ref) => ref.nodeId), ['trainer'])
})

test('加节点 + 连线：落在图上，改动清单说得清，diff 非空', () => {
  const result = applyPatch(
    project(),
    patch(
      { op: 'addNode', id: 'n2', type: 'data.preview', params: { rows: 5 } },
      { op: 'connect', source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' },
    ),
  )
  assert.equal(result.ok, true, JSON.stringify(result.rejections))
  assert.equal(result.project.graph.nodes.length, 2)
  assert.equal(result.project.graph.edges.length, 1)
  assert.equal(result.changes.length, 2)
  assert.match(result.changes[0], /加了节点 n2/)
  assert.match(result.changes[1], /接上/)
  assert.match(result.diff, /^\+ /m, 'diff 里要能看见新增的行')
})

/*
 * 批注与图住在同一个文件里（工程文件顶层的 `annotations:` 段），而 agent 只通过补丁改
 * 那个文件。于是有一条必须钉死的性质：**补丁只动图，不许顺手抹掉人记的读数**。
 * 这里连文本往返一起验 —— 掉在 applyPatch 里、或掉在 projectToText / textToProject
 * 任何一段，症状都是同一个：人打开画布，便签和表格不见了。
 */
test('补丁只动图：批注一条都不掉，写出去再读回来也一字不差', () => {
  const notes: Project['annotations'] = [
    {
      id: 'a1',
      kind: 'table',
      groupPath: [],
      position: { x: 40, y: 200 },
      title: '三组工况读数',
      columns: ['工况', '峰值'],
      rows: [['900', '0.42']],
    },
    {
      id: 'a2',
      kind: 'mindmap',
      groupPath: [],
      position: { x: 40, y: 400 },
      title: '',
      root: { id: 'm1', text: '换密封之后振动降了一半', children: [] },
    },
  ]
  const withNotes: Project = { ...project(), annotations: notes }

  const result = applyPatch(withNotes, patch({ op: 'addNode', id: 'n2', type: 'data.preview' }))
  assert.equal(result.ok, true, JSON.stringify(result.rejections))
  assert.deepEqual(result.project.annotations, notes, 'agent 加节点不该动批注')

  const back = textToProject(projectToText(result.project)).project
  assert.ok(back, '写出去的文件要读得回来')
  assert.deepEqual(back.annotations, notes, '往返一次，读数必须一字不差')
  assert.equal(back.graph.nodes.length, 2, '顺带确认图那部分确实改了（不是整段被丢掉）')
})

test('原子：其中一条被拒，整批都不落', () => {
  const before = project()
  const result = applyPatch(
    before,
    patch(
      { op: 'addNode', id: 'n2', type: 'data.preview' },
      { op: 'setParam', id: '不存在的节点', key: 'window', value: 1024 },
    ),
  )
  assert.equal(result.ok, false)
  assert.deepEqual(codes(result), ['E_UNKNOWN_REF'])
  assert.equal(result.project.graph.nodes.length, 1, '一条不行就一条都不落')
  assert.equal(result.diff, '')
})

test('未知算子 / 重复 id 都拦得住', () => {
  assert.ok(codes(applyPatch(project(), patch({ op: 'addNode', type: 'no.such' }))).includes('E_UNKNOWN_OPERATOR'))
  assert.ok(
    codes(applyPatch(project(), patch({ op: 'addNode', id: 'n1', type: 'data.preview' }))).includes(
      'E_DUPLICATE_NODE_ID',
    ),
  )
})

test('引用不存在的东西：E_UNKNOWN_REF，且说清是哪一个', () => {
  const missing = applyPatch(project(), patch({ op: 'removeNode', id: 'nope' }))
  assert.deepEqual(codes(missing), ['E_UNKNOWN_REF'])
  assert.match(missing.rejections[0].message, /nope/)

  const noEdge = applyPatch(project(), patch({ op: 'disconnect', edgeId: 'n1|out|n2|data' }))
  assert.deepEqual(codes(noEdge), ['E_UNKNOWN_REF'])
})

test('端口不存在：把现有端口列出来，别只说"错了"', () => {
  const result = applyPatch(
    project([node('n1', 'data.source', { datasetId: 'ds-1' }), node('n2', 'data.preview')]),
    patch({ op: 'connect', source: 'n1', sourcePort: '没有这一列', target: 'n2', targetPort: 'data' }),
  )
  assert.deepEqual(codes(result), ['E_UNKNOWN_PORT'])
  assert.match(result.rejections[0].message, /现有：/)
  assert.match(result.rejections[0].message, /__table__/)
})

test('类型不兼容：figure 接不进 table', () => {
  const result = applyPatch(
    project([node('n6', 'viz.chart'), node('n3', 'data.collect')]),
    patch({ op: 'connect', source: 'n6', sourcePort: 'figure', target: 'n3', targetPort: 'in' }),
  )
  assert.ok(codes(result).includes('E_TYPE_MISMATCH'), JSON.stringify(result.rejections))
})

test('目标端口已被占用：不自动替换，明确要求先断开', () => {
  const result = applyPatch(
    project([
      node('n1', 'data.source', { datasetId: 'ds-1' }),
      node('n2', 'data.preview'),
      node('n3', 'data.preview'),
    ]),
    patch(
      { op: 'connect', source: 'n1', sourcePort: '__table__', target: 'n3', targetPort: 'data' },
      { op: 'connect', source: 'n2', sourcePort: 'head', target: 'n3', targetPort: 'data' },
    ),
  )
  const hit = result.rejections.find((r) => r.code === 'E_PORT_OCCUPIED')
  assert.ok(hit, JSON.stringify(result.rejections))
  assert.match(hit.message, /先 disconnect/)
})

test('成环：拦住并指出是哪两个节点', () => {
  const result = applyPatch(
    project([node('n2', 'data.preview'), node('n3', 'data.preview')]),
    patch(
      { op: 'connect', source: 'n2', sourcePort: 'head', target: 'n3', targetPort: 'data' },
      { op: 'connect', source: 'n3', sourcePort: 'head', target: 'n2', targetPort: 'data' },
    ),
  )
  assert.ok(codes(result).includes('E_CYCLE'), JSON.stringify(result.rejections))
})

test('参数非法：用与校验器同一套判据', () => {
  const bad = applyPatch(project(), patch({ op: 'addNode', id: 'n2', type: 'viz.chart', params: { pointSize: 100 } }))
  assert.ok(codes(bad).includes('E_PARAM_INVALID'), JSON.stringify(bad.rejections))

  const unknownKey = applyPatch(
    project(),
    patch({ op: 'addNode', id: 'n2', type: 'viz.chart', params: { 乱填的键: 1 } }),
  )
  assert.ok(codes(unknownKey).includes('E_PARAM_INVALID'))
})

test('setParam 说得清"从什么改成什么"', () => {
  const result = applyPatch(project(), patch({ op: 'addNode', id: 'n2', type: 'data.preview' }))
  assert.equal(result.ok, true)
  const changed = applyPatch(result.project, patch({ op: 'setParam', id: 'n2', key: 'rows', value: 10 }))
  assert.equal(changed.ok, true)
  assert.match(changed.changes[0], /rows 从 5 改成 10/)
})

test('图没接完不算错误 —— 人可能正搭到一半，agent 也该能接着搭', () => {
  const result = applyPatch(project(), patch({ op: 'addNode', id: 'n2', type: 'data.preview' }))
  assert.equal(result.ok, true, '缺输入不该让补丁失败')
  assert.ok(result.incomplete.length > 0, '但要如实说"还缺什么"')
  assert.match(result.incomplete[0], /必需输入「数据」没接线/)
})

/*
 * 这两条是同一个用户诉求的两面："我把很多子实验收进一个子空间省地方，结果 AI
 * 一个块都改不动。" 实测有两处叠加的原因，各钉一条：
 *
 * 1. 整图 L1 曾是一道写入闸门 —— 工程里**任何**一处静态问题（半截实验、子空间边界、
 *    别人留着的坏参数）都会把每一次补丁拒掉，而拒的理由是空的。对话栏那时只能
 *    谎报一个"基线不符"，模型换一版基线重试，再失败，于是整轮对话原地打转。
 * 2. 所有 op 只认根图 —— 子空间内部的节点 id 在根图里不存在，改名、挪动、改代码
 *    全被拒成 E_UNKNOWN_REF。
 */
test('整图 L1 不是写入闸门：别处的静态问题不否决这次改动，但如实报出来', () => {
  const start = project([node('n1', 'data.source', { datasetId: 'ds-1' }), node('bad', 'custom.script', { cutoff: 5 })])
  const before = textToProject(projectToText(start), undefined, 'wf-x').project
  assert.ok(before, '夹具本身要能往返')

  const result = applyPatch(start, patch({ op: 'addNode', id: 'n2', type: 'data.preview' }))
  assert.equal(result.ok, true, '别处的 L1 问题不该让这次改动失败')
  assert.deepEqual(codes(result), [], '拒绝表要空 —— 拒绝必须能归因到某条 op')
  assert.equal(result.project.graph.nodes.length, 3, '改动确实落了')
  assert.ok(
    result.validation?.errors.some((e) => e.code === 'E_PARAM_INVALID' && e.nodeId === 'bad'),
    '整图的问题照样报回来，只是不否决',
  )
})

test('子空间里的块：改名 / 挪动 / 改代码都落得下去（op 带 path）', () => {
  const inner = {
    id: 'g::sub',
    name: '子空间',
    description: '',
    nodes: [node('n9', 'custom.script', { code: 'x: float\ndef run(x):\n    return x' })],
    edges: [],
  }
  const start = project([
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    {
      id: 'sub',
      type: 'workflow.group',
      label: '子空间',
      params: {},
      position: { x: 0, y: 0 },
      group: { workflow: inner, inputs: [], outputs: [], parameters: [] },
    },
  ])

  const result = applyPatch(
    start,
    patch(
      { op: 'renameNode', path: ['sub'], id: 'n9', label: '子实验A' },
      { op: 'moveNode', path: ['sub'], id: 'n9', position: { x: 120, y: 40 } },
      { op: 'setParam', path: ['sub'], id: 'n9', key: 'code', value: 'x: float,y: float\ndef run(x, y):\n    return x + y' },
    ),
  )
  assert.equal(result.ok, true, JSON.stringify(result.rejections))
  const inside = result.project.graph.nodes.find((n) => n.id === 'sub')?.group?.workflow.nodes[0]
  assert.equal(inside?.label, '子实验A')
  assert.deepEqual(inside?.position, { x: 120, y: 40 })
  assert.match(String(inside?.params.code), /def run\(x, y\)/)
  assert.ok(result.changes.every((c) => c.startsWith('在子空间「子空间」里：')), result.changes.join(' / '))
})

test('路径指不到东西：这条 op 拒绝，而且说得出是哪一层', () => {
  const result = applyPatch(project(), patch({ op: 'moveNode', path: ['没有这个块'], id: 'n1', position: { x: 1, y: 1 } }))
  assert.deepEqual(codes(result), ['E_UNKNOWN_REF'])
  assert.match(result.rejections[0].message, /没有这个块/)
})

test('新建子空间自带一份合法定义：空壳组块节点是个删不掉的坏块', () => {
  const result = applyPatch(project(), patch({ op: 'addNode', id: 'sub', type: 'workflow.group', label: '实验组' }))
  assert.equal(result.ok, true, JSON.stringify(result.rejections))
  const created = result.project.graph.nodes.find((n) => n.id === 'sub')
  assert.equal(created?.group?.workflow.nodes.length, 0)
  assert.deepEqual(created?.group?.inputs, [])
  assert.deepEqual(created?.group?.outputs, [])
  assert.equal(created?.label, '实验组')
  // 往它里面加块也走得通
  const inside = applyPatch(result.project, patch({ op: 'addNode', path: ['sub'], id: 'm1', type: 'data.preview' }))
  assert.equal(inside.ok, true, JSON.stringify(inside.rejections))
  assert.equal(inside.project.graph.nodes.find((n) => n.id === 'sub')?.group?.workflow.nodes[0].id, 'm1')
})

test('封装子空间再撤销：不相邻的选择也要回到一字不差的原样', () => {
  const start = project([
    node('a1', 'data.preview', { rows: 1 }),
    node('a2', 'data.preview', { rows: 2 }),
    node('a3', 'data.preview', { rows: 3 }),
  ])
  const applied = applyPatch(start, patch({ op: 'createGroup', id: 'grp', label: '实验组', nodeIds: ['a1', 'a3'] }))
  assert.equal(applied.ok, true, JSON.stringify(applied.rejections))
  assert.equal(applied.project.graph.nodes.length, 2, '三个块收成一个子空间加一个剩下的块')
  assert.equal(applied.project.graph.nodes.find((n) => n.id === 'grp')?.group?.workflow.nodes.length, 2)

  const undone = applyPatch(applied.project, { ops: applied.reverse })
  assert.equal(undone.ok, true, JSON.stringify(undone.rejections))
  assert.equal(projectToText(undone.project), projectToText(start), '撤销后工程文本要逐字回到原样')
})

test('删掉一个子空间再撤销：里面的实验与连线一起回来', () => {
  const start = project([
    node('a1', 'data.preview', { rows: 1 }),
    node('a2', 'data.preview', { rows: 2 }),
  ])
  const grouped = applyPatch(start, patch({ op: 'createGroup', id: 'grp', label: '实验组', nodeIds: ['a1', 'a2'] }))
  assert.equal(grouped.ok, true, JSON.stringify(grouped.rejections))

  const removed = applyPatch(grouped.project, patch({ op: 'removeNode', id: 'grp' }))
  assert.equal(removed.ok, true, JSON.stringify(removed.rejections))
  assert.equal(removed.project.graph.nodes.length, 0)

  const undone = applyPatch(removed.project, { ops: removed.reverse })
  assert.equal(undone.ok, true, JSON.stringify(undone.rejections))
  assert.equal(projectToText(undone.project), projectToText(grouped.project), '空壳子空间不算撤销')
})

test('解散子空间再撤销：封装回去也回到原样', () => {
  const start = project([
    node('a1', 'data.preview', { rows: 1 }),
    node('a2', 'data.preview', { rows: 2 }),
  ])
  const grouped = applyPatch(start, patch({ op: 'createGroup', id: 'grp', label: '实验组', nodeIds: ['a1', 'a2'] }))
  const ungrouped = applyPatch(grouped.project, patch({ op: 'ungroup', id: 'grp' }))
  assert.equal(ungrouped.ok, true, JSON.stringify(ungrouped.rejections))
  assert.equal(ungrouped.project.graph.nodes.length, 2)

  const regrouped = applyPatch(ungrouped.project, { ops: ungrouped.reverse })
  assert.equal(regrouped.ok, true, JSON.stringify(regrouped.rejections))
  assert.equal(projectToText(regrouped.project), projectToText(grouped.project))
})
test('关掉一列：接在那一列上的线一起断，并且记进改动清单', () => {
  const start = project([node('n1', 'data.source', { datasetId: 'ds-1' }), node('n3', 'data.preview')])
  start.graph.edges = [
    { id: 'e1', source: 'n1', sourcePort: '液位', target: 'n3', targetPort: 'data' },
  ]
  const result = applyPatch(start, patch({ op: 'setDatasetView', datasetId: 'ds-1', enabled: ['流量'] }))

  assert.equal(result.ok, true, JSON.stringify(result.rejections))
  assert.equal(result.project.graph.edges.length, 0, '与界面关列的行为一致：那一列的线清掉')
  assert.ok(
    result.changes.some((c) => c.includes('连带断开了') && c.includes('液位')),
    '清掉的线必须出现在改动清单里，不能静默：' + JSON.stringify(result.changes),
  )
  assert.deepEqual(
    result.project.datasets[0].columns?.map((c) => `${c.name}:${c.enabled}`),
    ['液位:false', '流量:true'],
  )
})

test('setDatasetView 引用不存在的列：拒绝并指出是哪一列', () => {
  const result = applyPatch(project(), patch({ op: 'setDatasetView', datasetId: 'ds-1', enabled: ['没有这一列'] }))
  assert.ok(codes(result).includes('E_UNKNOWN_PORT'), JSON.stringify(result.rejections))
  assert.match(result.rejections[0].message, /没有这一列/)
})

test('diff：只显示改动附近的几行，不是整份文件', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
  const after = ['a', 'b', 'c', 'd', 'X', 'f', 'g', 'h', 'i', 'j'].join('\n')
  const d = diffLines(before, after)
  assert.match(d, /^- e$/m)
  assert.match(d, /^\+ X$/m)
  assert.equal(d.includes('a'), false, '离得远的行不该出现')
  assert.equal(diffLines(before, before), '')
})

/* ------------------------------------------------------------------ */
/* 反向补丁：撤销                                                      */
/* ------------------------------------------------------------------ */

/**
 * 这条是整个"撤销"功能的地基：**改了再撤，工程必须回到一字不差的原样。**
 *
 * 用"文本相等"来判，而不是逐字段比较 —— 文本相等意味着连字段顺序、缩进、
 * 有没有多一个空段都一样，没有比这更强的判据了。
 */
test('反向补丁：一串动作改完之后撤销，工程回到一字不差的原样', () => {
  const start = project([
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    node('n2', 'data.preview', { rows: 5 }),
  ])
  const ops: PatchFile['ops'] = [
    { op: 'addNode', id: 'n3', type: 'data.preview', params: { rows: 5 } },
    { op: 'connect', source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' },
    { op: 'connect', source: 'n2', sourcePort: 'head', target: 'n3', targetPort: 'data' },
    { op: 'setParam', id: 'n2', key: 'rows', value: 10 },
    { op: 'renameNode', id: 'n2', label: '改了名字的预览' },
    { op: 'moveNode', id: 'n2', position: { x: 999, y: 999 } },
    { op: 'setMeta', name: '改了工程名' },
    { op: 'setDatasetView', datasetId: 'ds-1', enabled: ['液位'] },
  ]
  const applied = applyPatch(start, { ops })
  assert.equal(applied.ok, true, JSON.stringify(applied.rejections))
  assert.ok(applied.reverse.length > 0, '每条 op 都该有反向动作')

  const undone = applyPatch(applied.project, { ops: applied.reverse })
  assert.equal(undone.ok, true, JSON.stringify(undone.rejections))
  assert.equal(projectToText(undone.project), projectToText(start))
})

test('反向补丁：删掉节点再撤销，连带被删的连线也回来', () => {
  const start = project([
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    node('n2', 'data.preview', { rows: 5 }),
  ])
  start.graph.edges = [{ id: 'e1', source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' }]

  const applied = applyPatch(start, { ops: [{ op: 'removeNode', id: 'n2' }] })
  assert.equal(applied.ok, true)
  assert.equal(applied.project.graph.edges.length, 0)

  const undone = applyPatch(applied.project, { ops: applied.reverse })
  assert.equal(undone.ok, true, JSON.stringify(undone.rejections))
  assert.equal(undone.project.graph.edges.length, 1, '连线必须跟着节点一起回来')
  assert.equal(projectToText(undone.project), projectToText(start))
})

test('数据源整表连线不因列开关变化而断开，撤销后图也保持完整', () => {
  const start = project([
    node('n1', 'data.source', { datasetId: 'ds-1' }),
    node('n3', 'data.preview'),
  ])
  start.graph.edges = [{ id: 'e1', source: 'n1', sourcePort: '__table__', target: 'n3', targetPort: 'data' }]

  const applied = applyPatch(start, { ops: [{ op: 'setDatasetView', datasetId: 'ds-1', enabled: ['流量'] }] })
  assert.equal(applied.ok, true, JSON.stringify(applied.rejections))
  assert.equal(applied.project.graph.edges.length, 1, '整表端口不随特征列开关变化')

  const undone = applyPatch(applied.project, { ops: applied.reverse })
  assert.equal(undone.ok, true, JSON.stringify(undone.rejections))
  assert.equal(undone.project.graph.edges.length, 1, '整表连线始终保留')
  assert.equal(projectToText(undone.project), projectToText(start))
})
