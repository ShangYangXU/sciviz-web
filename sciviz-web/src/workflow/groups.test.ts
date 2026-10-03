import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAnnotationGroup,
  createGroupFromSelection,
  expandWorkflowGroups,
  nodeIdFromRuntimeId,
  pruneGroupParameterBindings,
  runtimeIdMoves,
  runtimeNodeIdForPath,
  runtimeIdsByNodeId,
  setWorkflowParam,
  syncGroupParameterMirrors,
  ungroupNode,
  workflowAtGroupPath,
} from './groups'
import { makeEdgeId, type PortContext } from './ports'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

const ctx: PortContext = {
  featuresOf: () => [],
  timeColumnOf: () => null,
}

const source: WorkflowNode = {
  id: 'source',
  type: 'data.source',
  label: '输入数据',
  params: { datasetId: 'ds1' },
  position: { x: 0, y: 0 },
}

const score: WorkflowNode = {
  id: 'score',
  type: 'eval.score',
  label: '评估',
  params: { y_true: 'actual', y_pred: 'guess', task: '分类' },
  position: { x: 300, y: 120 },
}

const chart: WorkflowNode = {
  id: 'chart',
  type: 'viz.chart',
  label: '图表',
  params: {},
  position: { x: 600, y: 120 },
}

function edge(sourceNode: string, sourcePort: string, targetNode: string, targetPort: string): WorkflowEdge {
  return {
    id: makeEdgeId(sourceNode, sourcePort, targetNode, targetPort),
    source: sourceNode,
    sourcePort,
    target: targetNode,
    targetPort,
  }
}

function basicWorkflow(): Workflow {
  return {
    id: 'wf',
    name: '测试图',
    description: 'for group tests',
    nodes: [source, score, chart],
    edges: [
      edge('source', '__table__', 'score', 'data'),
      edge('score', 'matrix', 'chart', 'data'),
    ],
  }
}

const semanticEdges = (workflow: Workflow) =>
  workflow.edges
    .map(({ source: s, sourcePort, target, targetPort }) => [s, sourcePort, target, targetPort])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

test('纯批注子空间不增加计算节点，解散后恢复为普通空白画布', () => {
  const original = basicWorkflow()
  const result = createAnnotationGroup(original, 'annotation-scope', { x: 20, y: 30 })
  assert.equal(result.node.group?.workflow.nodes.length, 0)
  assert.equal(result.node.group?.inputs.length, 0)
  assert.equal(result.node.group?.outputs.length, 0)
  assert.deepEqual(expandWorkflowGroups(result.workflow).nodes.map((node) => node.id), ['source', 'score', 'chart'])
  assert.deepEqual(semanticEdges(expandWorkflowGroups(result.workflow)), semanticEdges(original))
  assert.deepEqual(ungroupNode(result.workflow, 'annotation-scope'), original)
})

test('封装节点时只移动选中子图，映射跨界端口并提升未连线参数', () => {
  const workflow = basicWorkflow()
  const before = structuredClone(workflow)

  const result = createGroupFromSelection(workflow, ['score'], ctx, 'g1', '评估组')
  const groupNode = result.node
  assert.equal(groupNode.type, 'workflow.group')
  assert.equal(result.workflow.nodes.some((node) => node.id === 'score'), false)
  assert.deepEqual(
    result.workflow.nodes.map((node) => node.id),
    ['source', 'g1', 'chart'],
  )
  assert.deepEqual(groupNode.group?.workflow.nodes.map((node) => node.id), ['score'])
  assert.deepEqual(groupNode.group?.workflow.edges, [])
  assert.equal(groupNode.group?.inputs.length, 1)
  assert.equal(groupNode.group?.inputs[0].targetPortId, 'data')
  assert.ok(groupNode.group?.outputs.some((output) => output.sourcePortId === 'matrix'))
  assert.ok(groupNode.group?.parameters.some((parameter) => parameter.paramKey === 'task'))
  assert.equal(groupNode.params[groupNode.group!.parameters.find((p) => p.paramKey === 'task')!.key], '分类')
  assert.equal(result.workflow.edges.find((e) => e.target === 'g1')?.source, 'source')
  assert.equal(result.workflow.edges.find((e) => e.source === 'g1')?.target, 'chart')
  assert.deepEqual(workflow, before, '封装不能改动原工作流对象')
})

test('展开组块后恢复等价边界、参数值并为子节点生成稳定命名空间', () => {
  const result = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const parameter = result.node.group!.parameters.find((candidate) => candidate.paramKey === 'task')!
  result.node.params[parameter.key] = '回归'

  const flat = expandWorkflowGroups(result.workflow)
  const expandedScoreId = runtimeNodeIdForPath(['g1'], 'score')
  const expandedScore = flat.nodes.find((node) => node.id === expandedScoreId)
  assert.ok(expandedScore)
  assert.equal(expandedScore.params.task, '回归')
  assert.equal(flat.nodes.some((node) => node.type === 'workflow.group'), false)
  assert.deepEqual(
    semanticEdges(flat),
    [
      ['source', '__table__', expandedScoreId, 'data'],
      [expandedScoreId, 'matrix', 'chart', 'data'],
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  )
  assert.equal(runtimeNodeIdForPath(['g1'], 'score'), runtimeNodeIdForPath(['g1'], 'score'))
})

test('结构变化时的运行时 id 对照：整棵子树跟着搬，解散时搬回来', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'inner', '内层')

  // 再封装一层：inner 自己挪到 outer 里，它内部的 score 跟着更深一层
  const intoOuter = runtimeIdMoves(grouped.node, [], ['outer'])
  assert.equal(intoOuter.get('inner'), runtimeNodeIdForPath(['outer'], 'inner'))
  assert.equal(
    intoOuter.get(runtimeNodeIdForPath(['inner'], 'score')),
    runtimeNodeIdForPath(['outer', 'inner'], 'score'),
  )

  // 解散：把这一层组路径去掉
  const outAgain = runtimeIdMoves(grouped.node, ['outer'], [])
  assert.equal(outAgain.get(runtimeNodeIdForPath(['outer'], 'inner')), 'inner')
  assert.equal(
    outAgain.get(runtimeNodeIdForPath(['outer', 'inner'], 'score')),
    runtimeNodeIdForPath(['inner'], 'score'),
  )
})

test('复制组块：组内节点的新运行时 id 走**改名后**的组块路径', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'inner', '内层')

  // 粘贴组块时只有载荷里的节点换 id（组块自己），组内节点的 id 不变、位置由路径表达。
  const moves = runtimeIdMoves(grouped.node, [], [], (id) => (id === 'inner' ? 'inner-copy' : id))
  assert.equal(moves.get('inner'), 'inner-copy')
  assert.equal(
    moves.get(runtimeNodeIdForPath(['inner'], 'score')),
    runtimeNodeIdForPath(['inner-copy'], 'score'),
    '副本里的块要算在副本那层里 —— 写成旧组块 id 的话，按运行时 id 归属的制品引用会落到空处',
  )

  // 粘到别的层里时两件事一起发生：路径变深 + 组块改名
  const nested = runtimeIdMoves(grouped.node, [], ['outer'], (id) => (id === 'inner' ? 'inner-copy' : id))
  assert.equal(
    nested.get(runtimeNodeIdForPath(['inner'], 'score')),
    runtimeNodeIdForPath(['outer', 'inner-copy'], 'score'),
  )
})

test('组块不会把声明默认值补写进内部节点：params 进指纹，补写等于换个算法', () => {
  const script: WorkflowNode = {
    id: 'script',
    type: 'custom.script',
    label: '脚本',
    // th 用代码里的默认值，没有写进 params —— 界面里没碰过它的节点就是这个样子
    params: { code: 'def run(data, th=0.5):\n    return {"out": data}\n' },
    position: { x: 200, y: 0 },
  }
  const loose: Workflow = {
    id: 'w',
    name: 'w',
    description: '',
    nodes: [source, script],
    edges: [edge('source', '__table__', 'script', 'data')],
  }
  const grouped = createGroupFromSelection(loose, ['script'], ctx, 'g1', '脚本组')
  const parameter = exposedParameter(grouped.node, 'script', 'th')

  const innerOf = (workflow: Workflow) =>
    expandWorkflowGroups(workflow).nodes.find(
      (node) => node.id === runtimeNodeIdForPath(['g1'], 'script'),
    )

  assert.equal(grouped.node.params[parameter.key], 0.5, '对外值就是声明默认值')
  assert.equal(
    innerOf(grouped.workflow)?.params.th,
    undefined,
    '展开时不该补写：求值时端口会用同一份默认值兜底，值没变、指纹就不该变',
  )
  assert.equal(
    innerParams(syncGroupParameterMirrors(grouped.workflow), ['g1'], 'script')?.th,
    undefined,
    '读工程时的对齐也守同一条判据，否则打开一次就把指纹改了',
  )

  const changed = setWorkflowParam(grouped.workflow, [], 'g1', parameter.key, 0.9)
  assert.equal(innerOf(changed)?.params.th, 0.9, '对外值真的改了才写进内部副本')
})

test('节点身份是节点 id：运行时 id 能剥回它，节点 id 能查出它此刻在哪儿', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const index = runtimeIdsByNodeId(grouped.workflow)

  assert.deepEqual(index.get('score'), [runtimeNodeIdForPath(['g1'], 'score')])
  assert.deepEqual(index.get('source'), ['source'])
  assert.equal(nodeIdFromRuntimeId(runtimeNodeIdForPath(['g1'], 'score')), 'score')
  assert.equal(nodeIdFromRuntimeId('source'), 'source')
  assert.equal(nodeIdFromRuntimeId('group:["g1"]:'), null, '取不出来就不取，不拿半截字符串猜节点')
  assert.equal(nodeIdFromRuntimeId(''), null)
})

test('嵌套组块递归展开并按完整组路径区分内部节点 id', () => {
  const onceGrouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'inner', '内层').workflow
  const twiceGrouped = createGroupFromSelection(onceGrouped, ['inner'], ctx, 'outer', '外层').workflow
  const flat = expandWorkflowGroups(twiceGrouped)
  const nestedScoreId = runtimeNodeIdForPath(['outer', 'inner'], 'score')
  assert.ok(flat.nodes.some((node) => node.id === nestedScoreId))
  assert.equal(flat.nodes.length, 3)
  assert.equal(flat.nodes.some((node) => node.type === 'workflow.group'), false)
  assert.equal(new Set(flat.nodes.map((node) => node.id)).size, flat.nodes.length)
})

test('解散组块时参数值写回内部，并把外部连线接回原有端点', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const taskParameter = grouped.node.group!.parameters.find((candidate) => candidate.paramKey === 'task')!
  grouped.node.params[taskParameter.key] = '回归'
  const before = structuredClone(grouped.workflow)

  const ungrouped = ungroupNode(grouped.workflow, 'g1')
  assert.ok(!ungrouped.nodes.some((node) => node.id === 'g1'))
  assert.equal(ungrouped.nodes.find((node) => node.id === 'score')?.params.task, '回归')
  assert.deepEqual(
    semanticEdges(ungrouped),
    [
      ['source', '__table__', 'score', 'data'],
      ['score', 'matrix', 'chart', 'data'],
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  )
  assert.deepEqual(grouped.workflow, before, '解散组块不能改动输入对象')
})

/** 取组块公开的某个内部参数（按"哪个内部节点的哪个键"找，不硬编码 key 的拼法）。 */
function exposedParameter(node: WorkflowNode, innerNodeId: string, innerParamKey: string) {
  const parameter = node.group?.parameters.find(
    (entry) => entry.nodeId === innerNodeId && entry.paramKey === innerParamKey,
  )
  assert.ok(parameter, `组块没有公开 ${innerNodeId}.${innerParamKey}`)
  return parameter
}

const innerParams = (workflow: Workflow, path: string[], innerNodeId: string) =>
  workflowAtGroupPath(workflow, path).nodes.find((node) => node.id === innerNodeId)?.params

test('在子图里改一个被公开的参数：对外值跟着改，引擎拿到的就是新值', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const parameter = exposedParameter(grouped.node, 'score', 'task')

  const edited = setWorkflowParam(grouped.workflow, ['g1'], 'score', 'task', '回归')

  assert.equal(innerParams(edited, ['g1'], 'score')?.task, '回归')
  assert.equal(
    edited.nodes.find((node) => node.id === 'g1')?.params[parameter.key],
    '回归',
    '对外值没改的话，展开时会把内部这次编辑盖掉',
  )
  const flat = expandWorkflowGroups(edited)
  assert.equal(
    flat.nodes.find((node) => node.id === runtimeNodeIdForPath(['g1'], 'score'))?.params.task,
    '回归',
  )
})

test('在组块面板上改对外参数：内部节点的副本同步成同一个值', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const parameter = exposedParameter(grouped.node, 'score', 'task')

  const edited = setWorkflowParam(grouped.workflow, [], 'g1', parameter.key, '回归')

  assert.equal(innerParams(edited, ['g1'], 'score')?.task, '回归')
  assert.equal(
    expandWorkflowGroups(edited).nodes.find(
      (node) => node.id === runtimeNodeIdForPath(['g1'], 'score'),
    )?.params.task,
    '回归',
  )
})

test('嵌套两层：最内层改一次，中间层与最外层的对外值一起变', () => {
  const onceGrouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'inner', '内层').workflow
  const twiceGrouped = createGroupFromSelection(onceGrouped, ['inner'], ctx, 'outer', '外层').workflow
  const outerNode = twiceGrouped.nodes.find((node) => node.id === 'outer')!
  const middleNode = outerNode.group!.workflow.nodes.find((node) => node.id === 'inner')!

  const edited = setWorkflowParam(twiceGrouped, ['outer', 'inner'], 'score', 'task', '回归')

  const editedOuter = edited.nodes.find((node) => node.id === 'outer')!
  const editedMiddle = editedOuter.group!.workflow.nodes.find((node) => node.id === 'inner')!
  assert.equal(innerParams(edited, ['outer', 'inner'], 'score')?.task, '回归')
  assert.equal(
    editedMiddle.params[exposedParameter(middleNode, 'score', 'task').key],
    '回归',
    '中间层那份要被一起改，否则展开到最后一步又会盖回去',
  )
  assert.equal(
    editedOuter.params[exposedParameter(outerNode, 'inner', exposedParameter(middleNode, 'score', 'task').key).key],
    '回归',
  )
  assert.equal(
    expandWorkflowGroups(edited).nodes.find(
      (node) => node.id === runtimeNodeIdForPath(['outer', 'inner'], 'score'),
    )?.params.task,
    '回归',
  )
})

test('读工程时把旧文件里不一致的两处对齐到对外值（不是反过来）', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const parameter = exposedParameter(grouped.node, 'score', 'task')
  // 旧编辑器写下的状态：子图里改成"回归"，对外值还是"分类" —— 执行时生效的一直是后者
  const legacy = {
    ...grouped.workflow,
    nodes: grouped.workflow.nodes.map((node) =>
      node.id !== 'g1' || !node.group
        ? node
        : {
            ...node,
            group: {
              ...node.group,
              workflow: {
                ...node.group.workflow,
                nodes: node.group.workflow.nodes.map((inner) =>
                  inner.id === 'score' ? { ...inner, params: { ...inner.params, task: '回归' } } : inner,
                ),
              },
            },
          },
    ),
  }

  const synced = syncGroupParameterMirrors(legacy)

  assert.equal(innerParams(synced, ['g1'], 'score')?.task, '分类')
  assert.equal(innerParams(legacy, ['g1'], 'score')?.task, '回归', '对齐不能改动输入对象')
  assert.equal(synced.nodes.find((node) => node.id === 'g1')?.params[parameter.key], '分类')
})

test('组块参数悬空（封装后又改了内部签名）→ 清掉之后展开恢复正常', () => {
  /*
   * 这是实测踩到的那个"打开工程之后整张画布一个块都不算"：
   * 把一个 `custom.script` 封装成组块时公开了它的 `th`，之后又改了函数签名（`th` 没了），
   * 外层的绑定还留着 —— `expandWorkflowGroups` 会抛异常，而展开在每一轮调度的开头，
   * 于是整张图彻底算不了，界面上却只有控制台里一条未处理的异常。
   */
  const script: WorkflowNode = {
    id: 'script',
    type: 'custom.script',
    label: '脚本',
    params: { code: 'def run(data, th=0.5):\n    return {"out": data}\n' },
    position: { x: 200, y: 0 },
  }
  const plain: Workflow = {
    id: 'w',
    name: 'w',
    description: '',
    nodes: [source, script],
    edges: [edge('source', '__table__', 'script', 'data')],
  }
  const grouped = createGroupFromSelection(plain, ['script'], ctx, 'g1', '脚本组')
  const parameter = exposedParameter(grouped.node, 'script', 'th')

  // 改签名：th 从代码里删掉（界面里"参数由签名推导"的节点就是这个样子）
  const stale: Workflow = {
    ...grouped.workflow,
    nodes: grouped.workflow.nodes.map((node) =>
      node.id !== 'g1' || !node.group
        ? node
        : {
            ...node,
            group: {
              ...node.group,
              workflow: {
                ...node.group.workflow,
                nodes: node.group.workflow.nodes.map((inner) =>
                  inner.id === 'script'
                    ? { ...inner, params: { ...inner.params, code: 'def run(data):\n    return {"out": data}\n' } }
                    : inner,
                ),
              },
            },
          },
    ),
  }
  assert.throws(() => expandWorkflowGroups(stale), /不存在的内部参数/)

  const pruned = pruneGroupParameterBindings(stale)

  assert.equal(pruned.dropped.length, 1)
  assert.equal(pruned.dropped[0].label, parameter.label)
  const groupNode = pruned.workflow.nodes.find((node) => node.id === 'g1')!
  assert.deepEqual(groupNode.group?.parameters, [], '悬空的绑定必须真的消失')
  assert.equal(groupNode.params[parameter.key], undefined, '外层那个值也要一起删')
  // 清完之后展开又能跑 —— 这就是"重新打开工程，画布又开始算了"
  assert.equal(
    expandWorkflowGroups(pruned.workflow).nodes.some(
      (node) => node.id === runtimeNodeIdForPath(['g1'], 'script'),
    ),
    true,
  )
})

test('嵌套两层的旧文件：对齐自上而下，最终听最外层那份公开值', () => {
  const onceGrouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'inner', '内层').workflow
  const twiceGrouped = createGroupFromSelection(onceGrouped, ['inner'], ctx, 'outer', '外层').workflow
  const outerNode = twiceGrouped.nodes.find((node) => node.id === 'outer')!
  const middleNode = outerNode.group!.workflow.nodes.find((node) => node.id === 'inner')!
  const middleKey = exposedParameter(middleNode, 'score', 'task').key
  const outerKey = exposedParameter(outerNode, 'inner', middleKey).key
  // 旧文件：只有最外层被改过（那是执行时唯一生效的一份），里面两层都还是老值
  const legacy = {
    ...twiceGrouped,
    nodes: twiceGrouped.nodes.map((node) =>
      node.id === 'outer' ? { ...node, params: { ...node.params, [outerKey]: '回归' } } : node,
    ),
  }

  const synced = syncGroupParameterMirrors(legacy)

  const syncedOuter = synced.nodes.find((node) => node.id === 'outer')!
  const syncedMiddle = syncedOuter.group!.workflow.nodes.find((node) => node.id === 'inner')!
  assert.equal(syncedMiddle.params[middleKey], '回归')
  assert.equal(innerParams(synced, ['outer', 'inner'], 'score')?.task, '回归')
})

test('组块参数端口被连线驱动时，展开保留连线优先级', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const parameter = grouped.node.group!.parameters.find((candidate) => candidate.paramKey === 'task')!
  grouped.node.params[parameter.key] = '回归'
  grouped.workflow.edges.push(edge('source', '__table__', 'g1', parameter.key))

  const flat = expandWorkflowGroups(grouped.workflow)
  const expandedScoreId = runtimeNodeIdForPath(['g1'], 'score')
  assert.ok(flat.edges.some((candidate) => candidate.target === expandedScoreId && candidate.targetPort === 'task'))
  assert.equal(flat.nodes.find((node) => node.id === expandedScoreId)?.params.task, '分类')
})

test('函数必填参数在未填写时保持缺失，不会被控件占位默认值覆盖', () => {
  const fn: WorkflowNode = {
    id: 'fn',
    type: 'custom.script',
    label: '函数',
    params: { code: 'def run(x):\n    return {"out": x}' },
    position: { x: 100, y: 100 },
  }
  const workflow: Workflow = {
    id: 'required-param',
    name: 'required',
    description: '',
    nodes: [fn],
    edges: [],
  }
  const grouped = createGroupFromSelection(workflow, ['fn'], ctx, 'g-required')
  const required = grouped.node.group!.parameters.find((parameter) => parameter.paramKey === 'x')!
  assert.equal(required.spec.required, true)
  assert.equal(Object.hasOwn(grouped.node.params, required.key), false)

  const flat = expandWorkflowGroups(grouped.workflow)
  const expanded = flat.nodes.find((node) => node.id === runtimeNodeIdForPath(['g-required'], 'fn'))!
  assert.equal(Object.hasOwn(expanded.params, 'x'), false)
})

test('解散组块会把组块参数别名连线还原到内部参数端口', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  const parameter = grouped.node.group!.parameters.find((candidate) => candidate.paramKey === 'task')!
  grouped.workflow.edges.push(edge('source', '__table__', 'g1', parameter.key))

  const ungrouped = ungroupNode(grouped.workflow, 'g1')
  assert.ok(ungrouped.edges.some((candidate) => candidate.target === 'score' && candidate.targetPort === 'task'))
})

test('组块内部映射引用不存在节点时给出清楚错误', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g1', '评估组')
  grouped.node.group!.inputs[0].targetNodeId = 'missing'
  assert.throws(() => expandWorkflowGroups(grouped.workflow), /不存在的内部节点/)
})

test('组块映射端口类型或内部参数失效时拒绝展开', () => {
  const badInputType = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g-type', '坏类型')
  badInputType.node.group!.inputs[0].port.type = 'figure'
  assert.throws(() => expandWorkflowGroups(badInputType.workflow), /类型与内部端口不一致/)

  const badParameter = createGroupFromSelection(basicWorkflow(), ['score'], ctx, 'g-param', '坏参数')
  badParameter.node.group!.parameters[0].paramKey = 'missing_parameter'
  assert.throws(() => expandWorkflowGroups(badParameter.workflow), /不存在的内部参数/)
})
