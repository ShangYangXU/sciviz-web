import test from 'node:test'
import assert from 'node:assert/strict'
import { useWorkflowStore } from './useWorkflowStore'
import { useNodeOutputStore } from './nodeOutputStore'
import { useAnnotationStore } from './useAnnotationStore'
import {
  nodeExecutionForcesTraining,
  nodeExecutionRequested,
  resetNodeExecutionRequests,
} from '../engine/nodeExecutionControl'
import type { PortContext } from '../workflow/ports'
import { defaultParams, getNodeTypeDef } from '../workflow/nodeRegistry'
import type { ParamSpec, Workflow, WorkflowNode } from '../workflow/types'
import { createAnnotation } from '../workflow/annotations'
import {
  createAnnotationGroup,
  createGroupFromSelection,
  expandWorkflowGroups,
  runtimeNodeIdForPath,
} from '../workflow/groups'

/**
 * 回归保护：数据源的固定整表端口不依赖当前会话能否找到原数据集，
 * 导入旧工程后不应因为数据集尚未重新绑定而丢失这条线。
 */

const FN = 'def working_rows(data, th=1.0):\n    return {"工作数据": data}\n'

const node = (
  id: string,
  type: string,
  params: Record<string, string | number | boolean> = {},
): WorkflowNode => ({ id, type, label: id, params, position: { x: 0, y: 0 } })

const ctx: PortContext = {
  featuresOf: () => ['液位'],
  timeColumnOf: () => '时间',
  hasDataset: (id) => id === 'ds-known',
}

test('替换工作流后仍有效的批注层级保留，失效组路径回到主画布', () => {
  const root: Workflow = { id: 'scopes', name: 'scopes', description: '', nodes: [], edges: [] }
  const next = createAnnotationGroup(root, 'kept-group', { x: 0, y: 0 }).workflow
  useAnnotationStore.setState({
    annotations: [
      createAnnotation('table', 'orphan', { x: 1, y: 2 }, () => 'b1', ['removed-group']),
      createAnnotation('table', 'kept', { x: 3, y: 4 }, () => 'b2', ['kept-group']),
    ],
    selectedIds: ['orphan'],
  })

  useWorkflowStore.getState().setWorkflow(next)

  const annotations = useAnnotationStore.getState().annotations
  assert.deepEqual(annotations.map((annotation) => annotation.groupPath), [[], ['kept-group']])
  assert.deepEqual(useAnnotationStore.getState().selectedIds, [])
  useAnnotationStore.setState({ annotations: [], selectedIds: [] })
})

test('复制一个训过的块：副本沿用那份权重（指纹一样就是同一个计算）', () => {
  const trainer = getNodeTypeDef('train.function')
  const artifact = {
    artifactId: 'f'.repeat(32),
    trainingFingerprint: 'train-fingerprint-v1',
    manifestSha256: '0'.repeat(64),
    createdAt: '2026-09-21T08:00:00Z',
  }
  useNodeOutputStore.getState().setModelArtifacts([{ nodeId: 'trainer', ...artifact }])
  useWorkflowStore.getState().setWorkflow({
    id: 'w',
    name: 'w',
    description: '',
    nodes: [node('trainer', 'train.function', defaultParams(trainer))],
    edges: [],
  })

  useWorkflowStore.getState().setNodeSelection(['trainer'])
  const payload = useWorkflowStore.getState().copySelection()
  assert.ok(payload, '有选择才复制得出来')
  const pasted = useWorkflowStore.getState().pasteClipboard(payload!, { x: 400, y: 0 })
  assert.ok(pasted)
  const copyId = pasted!.nodeIds[0]
  assert.notEqual(copyId, 'trainer')

  const refs = useNodeOutputStore.getState().modelArtifacts
  assert.deepEqual(
    refs.map((ref) => ref.nodeId).sort(),
    ['trainer', copyId].sort(),
    '原件留着，副本也拿到同一份权重引用',
  )
  assert.equal(new Set(refs.map((ref) => ref.artifactId)).size, 1)
})

test('把训好的块封装进组块：制品引用跟着搬到新的运行时 id，解散后搬回来', () => {
  const trainer = getNodeTypeDef('train.function')
  const artifact = {
    artifactId: 'a'.repeat(32),
    trainingFingerprint: 'train-fingerprint-v1',
    manifestSha256: 'b'.repeat(64),
    createdAt: '2026-09-21T08:00:00Z',
  }
  useNodeOutputStore.getState().setModelArtifacts([{ nodeId: 'trainer', ...artifact }])
  useWorkflowStore.getState().setWorkflow({
    id: 'w',
    name: 'w',
    description: '',
    nodes: [node('trainer', 'train.function', defaultParams(trainer))],
    edges: [],
  })

  useWorkflowStore.getState().setNodeSelection(['trainer'])
  const groupId = useWorkflowStore.getState().groupSelection(ctx)
  assert.ok(groupId, '封装要成功')
  const innerId = runtimeNodeIdForPath([groupId!], 'trainer')
  assert.deepEqual(
    useNodeOutputStore.getState().modelArtifacts.map((ref) => ref.nodeId),
    [innerId],
    '权重是跟着块走的：块进了子空间，引用也要跟进去',
  )

  useWorkflowStore.getState().selectNode(groupId)
  useWorkflowStore.getState().ungroupSelection()
  assert.deepEqual(
    useNodeOutputStore.getState().modelArtifacts.map((ref) => ref.nodeId),
    ['trainer'],
    '解散之后同样要跟回来',
  )
  assert.equal(useNodeOutputStore.getState().modelArtifacts[0]?.artifactId, artifact.artifactId)
})

/*
 * 复制一整个子空间（里面有训过的块）是用户最常用的组合动作之一：子实验整块复制一份，
 * 两边各自接着改。副本里那个训练块的运行时 id 会变成 `group:["副本组 id"]:…`，
 * 而组块自己的 id 在粘贴时也换了 —— 两件事必须一起算对，否则副本的引用指向一个
 * 不存在的组块，症状就是"复制出来的那份读不到权重"。
 */
/*
 * 撤回一次封装 = 把换之前那张图整份放回来（画布历史是整图快照）。这时制品引用不能
 * 跟着快照整份回滚 —— 封装之后、撤回之前可能又训过一次，那份新引用不在快照里，
 * 整份回滚会把它一起抹掉。规则与打开工程同一条：按**节点身份**重新对上。
 */
test('撤回一次封装：引用按节点身份回到本层，且不丢掉撤回前新训的那一条', () => {
  const trainer = getNodeTypeDef('train.function')
  const first = {
    artifactId: '1'.repeat(32),
    trainingFingerprint: 'fp-1',
    manifestSha256: 'a'.repeat(64),
    createdAt: '2026-09-22T01:00:00Z',
  }
  const second = {
    artifactId: '2'.repeat(32),
    trainingFingerprint: 'fp-2',
    manifestSha256: 'b'.repeat(64),
    createdAt: '2026-09-22T02:00:00Z',
  }
  useNodeOutputStore.getState().setModelArtifacts([{ nodeId: 'trainer', ...first }])
  useWorkflowStore.getState().setWorkflow({
    id: 'w',
    name: 'w',
    description: '',
    nodes: [node('trainer', 'train.function', defaultParams(trainer))],
    edges: [],
  })

  const before = useWorkflowStore.getState().workflow
  useWorkflowStore.getState().setNodeSelection(['trainer'])
  const groupId = useWorkflowStore.getState().groupSelection(ctx)
  assert.ok(groupId)
  const innerId = runtimeNodeIdForPath([groupId!], 'trainer')
  // 封装之后又训了一次：引用是新加的，任何快照里都没有它
  useNodeOutputStore
    .getState()
    .setModelArtifacts([{ nodeId: innerId, ...second }, ...useNodeOutputStore.getState().modelArtifacts])

  useWorkflowStore.getState().setWorkflow(before)

  assert.deepEqual(
    useNodeOutputStore.getState().modelArtifacts.map((ref) => ref.nodeId),
    ['trainer', 'trainer'],
    '两条引用都要跟着块回到本层 —— 按身份对上，而不是整份回滚成快照',
  )
  assert.deepEqual(
    useNodeOutputStore.getState().modelArtifacts.map((ref) => ref.artifactId).sort(),
    [first.artifactId, second.artifactId].sort(),
  )
})

test('复制含训练块的组块：副本的引用指向副本那层，不指向原件或空处', () => {
  const trainer = getNodeTypeDef('train.function')
  const artifact = {
    artifactId: 'c'.repeat(32),
    trainingFingerprint: 'train-fingerprint-v1',
    manifestSha256: 'd'.repeat(64),
    createdAt: '2026-09-21T08:00:00Z',
  }
  useNodeOutputStore.getState().setModelArtifacts([{ nodeId: 'trainer', ...artifact }])
  useWorkflowStore.getState().setWorkflow({
    id: 'w',
    name: 'w',
    description: '',
    nodes: [node('trainer', 'train.function', defaultParams(trainer))],
    edges: [],
  })

  useWorkflowStore.getState().setNodeSelection(['trainer'])
  const groupId = useWorkflowStore.getState().groupSelection(ctx)
  assert.ok(groupId)
  const innerId = runtimeNodeIdForPath([groupId!], 'trainer')
  assert.deepEqual(useNodeOutputStore.getState().modelArtifacts.map((ref) => ref.nodeId), [innerId])

  // 复制整个组块再粘一份
  useWorkflowStore.getState().selectNode(groupId!)
  const payload = useWorkflowStore.getState().copySelection()
  assert.ok(payload, '选中组块才复制得出来')
  const pasted = useWorkflowStore.getState().pasteClipboard(payload!, { x: 600, y: 0 })
  assert.ok(pasted)
  const copyGroupId = pasted!.nodeIds[0]
  assert.notEqual(copyGroupId, groupId)

  const copyInnerId = runtimeNodeIdForPath([copyGroupId], 'trainer')
  const refs = useNodeOutputStore.getState().modelArtifacts
  assert.deepEqual(
    refs.map((ref) => ref.nodeId).sort(),
    [innerId, copyInnerId].sort(),
    '原件留着，副本的引用要落在副本自己那层里',
  )
  assert.equal(new Set(refs.map((ref) => ref.artifactId)).size, 1, '内容一样 ⇒ 同一份权重')
})

test('在组块内部改参数会写穿到组块的对外参数 —— 引擎看的就是对外那一份', () => {
  const grouped = createGroupFromSelection(
    {
      id: 'w',
      name: 'w',
      description: '',
      nodes: [
        node('n1', 'data.source', { datasetId: 'ds-known' }),
        node('n2', 'eval.score', { y_true: 'a', y_pred: 'b', task: '分类' }),
      ],
      edges: [
        { id: 'e1', source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' },
      ],
    },
    ['n2'],
    ctx,
    'g1',
    '评估组',
  )
  const parameter = grouped.node.group!.parameters.find((candidate) => candidate.paramKey === 'task')!

  useWorkflowStore.getState().setWorkflow(grouped.workflow)
  useWorkflowStore.getState().enterGroup('g1')
  useWorkflowStore.getState().setParam('n2', 'task', '回归')

  const state = useWorkflowStore.getState()
  assert.deepEqual(state.activeGroupPath, ['g1'])
  assert.equal(state.workflow.nodes.find((n) => n.id === 'g1')!.params[parameter.key], '回归')
  assert.equal(
    expandWorkflowGroups(state.workflow).nodes.find(
      (n) => n.id === runtimeNodeIdForPath(['g1'], 'n2'),
    )?.params.task,
    '回归',
  )
})

function edgesAfterPrune(sourceDatasetId: string, sourcePort: string): string[] {
  const wf: Workflow = {
    id: 'w',
    name: 'w',
    description: '',
    nodes: [
      node('n1', 'data.source', { datasetId: sourceDatasetId }),
      node('n2', 'custom.script', { code: FN }),
    ],
    edges: [
      {
        id: `n1|${sourcePort}|n2|data`,
        source: 'n1',
        sourcePort,
        target: 'n2',
        targetPort: 'data',
      },
    ],
  }
  useWorkflowStore.getState().setWorkflow(wf)
  useWorkflowStore.getState().pruneInvalidEdges(ctx)
  return useWorkflowStore.getState().workflow.edges.map((e) => e.sourcePort)
}

test('数据集在本会话里不存在时，那条「整表」连线要留着 —— 端口只是暂时算不出来', () => {
  assert.deepEqual(edgesAfterPrune('ds-1-mtybznc9', '__table__'), ['__table__'])
  assert.deepEqual(edgesAfterPrune('', '__table__'), ['__table__'])
})

test('数据集在、端口确实没了（比如那一列被关掉）→ 该清的还是清', () => {
  assert.deepEqual(edgesAfterPrune('ds-known', '被关掉的列'), [])
})

test('一切正常时只保留固定整表端口', () => {
  assert.deepEqual(edgesAfterPrune('ds-known', '__table__'), ['__table__'])
  assert.deepEqual(edgesAfterPrune('ds-known', '液位'), [])
})

test('同步通用训练函数参数时保留仍有效的值、补默认值并清除失效参数', () => {
  const trainer = getNodeTypeDef('train.function')
  useWorkflowStore.getState().setWorkflow({
    id: 'wf',
    name: '训练参数同步',
    description: '',
    nodes: [
      node('trainer', 'train.function', {
        ...defaultParams(trainer),
        patience: 9,
        removed_argument: 3,
      }),
    ],
    edges: [],
  })

  const specs: ParamSpec[] = [
    { key: 'patience', label: 'patience', type: 'number', default: 4 },
    { key: 'weight_decay', label: 'weight_decay', type: 'number', default: 0.01 },
  ]
  useWorkflowStore.getState().syncTrainingFunctionParams('trainer', specs)

  const params = useWorkflowStore.getState().workflow.nodes[0].params
  assert.equal(params.patience, 9)
  assert.equal(params.weight_decay, 0.01)
  assert.equal(params.removed_argument, undefined)
  assert.equal(params.device, 'auto')
  assert.equal(typeof params.code, 'string')
  assert.equal(params.batch, undefined)
})

test('旧训练函数签名保留 0.1.0 的数据适配参数，只作为旧工程兼容', () => {
  const trainer = getNodeTypeDef('train.function')
  useWorkflowStore.getState().setWorkflow({
    id: 'legacy-training',
    name: '旧训练函数',
    description: '',
    nodes: [
      node('trainer', 'train.function', {
        ...defaultParams(trainer),
        code:
          'def fit_model(model, train_loader, val_loader, device, spec, params, env, epochs=2):\n' +
          '    return {"model": model, "metrics": {"轮次": epochs}}\n',
        label: '3',
        features: '1,2',
        task: '回归',
        batch: 32,
        seed: 7,
      }),
    ],
    edges: [],
  })

  useWorkflowStore.getState().syncTrainingFunctionParams('trainer', [
    { key: 'epochs', label: 'epochs', type: 'number', default: 2 },
  ])
  const params = useWorkflowStore.getState().workflow.nodes[0].params
  assert.equal(params.label, '3')
  assert.equal(params.features, '1,2')
  assert.equal(params.batch, 32)
  assert.equal(params.seed, 7)
})

test('训练节点开始按钮产生会话级执行请求，并清掉上一次结果状态', () => {
  resetNodeExecutionRequests()
  const trainer = getNodeTypeDef('train.function')
  useWorkflowStore.getState().setWorkflow({
    id: 'explicit-training',
    name: '显式训练',
    description: '',
    nodes: [node('trainer', 'train.function', defaultParams(trainer))],
    edges: [],
  })
  useNodeOutputStore.getState().setRuntime('trainer', {
    status: 'ready',
    outputVersion: 3,
    inputsFingerprint: 'old',
    reused: true,
  })
  useWorkflowStore.getState().startNode('trainer')

  const runtime = useNodeOutputStore.getState().runtimes.trainer
  assert.equal(nodeExecutionRequested('trainer'), true)
  assert.equal(nodeExecutionForcesTraining('trainer'), true)
  assert.equal(runtime.status, 'idle')
  assert.equal(runtime.inputsFingerprint, null)
  assert.equal(runtime.reused, undefined)
  resetNodeExecutionRequests()
})
