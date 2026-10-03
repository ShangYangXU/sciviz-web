/**
 * 拆列节点的端口解析。
 *
 * 它与其他动态端口节点（数据源、拼表、函数）的差别在于：**列名来自数据**，
 * 而不是来自参数或代码。所以这里要钉住的是两件事：

 * 1. 列名有两个来源时以谁为准（写在节点上的那几个是用户的显式意图）；
 * 2. 算不出列名时**不能**被当成"端口被删了" —— 那会让用户刚接好的线被静默清掉。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COLUMNS_TYPE,
  groupNodePorts,
  portsTrustworthy,
  resolveFigureUpstreamTable,
  resolvePorts,
  parseFeatureIndices,
  upstreamDatasetId,
  type PortContext,
} from './ports'
import { defaultParams, getNodeTypeDef } from './nodeRegistry'
import type { WorkflowNode } from './types'

function columnsNode(params: Record<string, string> = {}, id = 'c1'): WorkflowNode {
  return { id, type: COLUMNS_TYPE, label: '拆列', params, position: { x: 0, y: 0 } }
}

function ctxWith(columns: string[] | null): PortContext {
  return {
    featuresOf: () => [],
    timeColumnOf: () => null,
    columnsOf: (nodeId, portId) => (nodeId === 'c1' && portId === 'data' ? columns : null),
    featureColumnsOf: (nodeId, portId) => (nodeId === 'c1' && portId === 'data' ? columns : null),
  }
}

const outputIds = (node: WorkflowNode, ctx: PortContext) =>
  resolvePorts(node, ctx).outputs.map((p) => p.id)

test('留空时按上游实际的列长端口', () => {
  assert.deepEqual(outputIds(columnsNode(), ctxWith(['温度', '压力', '流量'])), ['温度', '压力', '流量'])
})

test('填了 1-based 特征索引就只拆对应特征，不受上游多出来的列影响', () => {
  const node = columnsNode({ columns: '1, 3' })
  assert.deepEqual(outputIds(node, ctxWith(['温度', '压力', '流量'])), ['温度', '流量'])
})

/**
 * 「逗号分隔」得认中文输入法：用户打出来的多半是「，」。
 *
 * 只认半角的话，端口的名字会变成「液位，流量」，然后引擎报"表里没有这一列" ——
 * 提示里说用逗号分隔、用户照做了，却没有任何线索知道问题出在标点上。
 * 前端这条规则与算子里的 `_names_param` 必须一致（否则界面长出来的端口
 * 与算子认的列名会对不上，而那种错表现为"线连着却没数据"）。
 */
test('特征索引分隔符认全角逗号 / 分号 / 换行，也认多余的空格', () => {
  for (const text of ['1,3', '1，3', '1;3', '1；3', '1\n3']) {
    const node = columnsNode({ columns: text })
    assert.deepEqual(outputIds(node, ctxWith(['温度', '压力', '流量'])), ['温度', '流量'], text)
  }
  const spaced = columnsNode({ columns: ' 1 ， 3 ， ' })
  assert.deepEqual(outputIds(spaced, ctxWith(['温度', '压力', '流量'])), ['温度', '流量'])
})

test('JSON 数组形式的特征索引可供工程/agent 写入', () => {
  assert.deepEqual(parseFeatureIndices('[1, 3]').map((token) => token.index), [1, 3])
})

test('特征索引不受上游列名影响，按特征位置解析', () => {
  const node = columnsNode({ columns: '2' })
  assert.deepEqual(outputIds(node, ctxWith(['时间', '压力', '流量'])), ['压力'])
})

test('上游列两边都没有：没有输出端口，但**不能**当成端口被删', () => {
  const node = columnsNode()
  const ctx = ctxWith(null)
  assert.deepEqual(outputIds(node, ctx), [])
  assert.equal(
    portsTrustworthy(node, ctx),
    false,
    '算不出列名时若判成"可信"，用户刚接好的线会被静默清掉',
  )
})

test('节点上填了特征索引时，端口列表就是可信的（不依赖有没有跑过）', () => {
  assert.equal(portsTrustworthy(columnsNode({ columns: '1,2' }), ctxWith(null)), true)
})

test('空表（上游真的一列都没有）与"还没算过"都要判成不可信，交给上游去解释', () => {
  const node = columnsNode()
  assert.equal(portsTrustworthy(node, ctxWith([])), false)
})

test('除了数据输入，拆列节点不该多出别的输入端口', () => {
  assert.deepEqual(resolvePorts(columnsNode(), ctxWith(['a'])).inputs.map((p) => p.id), ['data'])
})

/**
 * 采样率是**数据的属性**（契约规格 R3.4）：要知道一份数据实际的 fs，得沿输入端口的线
 * 一路走回数据源节点。这里的三种 null 都是"老实说不知道"，调用方拿到它之后**不许猜**。
 */
test('沿上游找数据集：穿过中间节点，来源不止一个就说不知道', () => {
  const node = (id: string, type: string, params: Record<string, string> = {}): WorkflowNode => ({
    id,
    type,
    label: id,
    params,
    position: { x: 0, y: 0 },
  })
  const edge = (source: string, target: string, targetPort = 'data') => ({
    id: `${source}->${target}`,
    source,
    sourcePort: 'data',
    target,
    targetPort,
  })

  // 数据源 → 预览 → 密度图：中间隔了节点也要一路走回去
  const linear = {
    id: 'wf',
    name: 'w',
    description: '',
    nodes: [
      node('n1', 'data.source', { datasetId: 'ds-1' }),
      node('n2', 'data.preview'),
      node('n3', 'viz.density'),
    ],
    edges: [edge('n1', 'n2'), edge('n2', 'n3')],
  }
  assert.equal(upstreamDatasetId(linear, 'n3'), 'ds-1')

  // 没选数据集的数据源：不知道就是不知道
  const unbound = { ...linear, nodes: [node('n1', 'data.source', {}), node('n3', 'viz.density')], edges: [] }
  assert.equal(upstreamDatasetId(unbound, 'n3'), null)

  // 列拼表把两份数据合在一起：这时"这份数据的采样率"本身就没有唯一答案
  const merged = {
    id: 'wf',
    name: 'w',
    description: '',
    nodes: [
      node('a', 'data.source', { datasetId: 'ds-1' }),
      node('b', 'data.source', { datasetId: 'ds-2' }),
      node('m', 'data.collect'),
      node('n3', 'viz.density'),
    ],
    edges: [edge('a', 'm', 'c1'), edge('b', 'm', 'c2'), edge('m', 'n3')],
  }
  assert.equal(upstreamDatasetId(merged, 'n3'), null)
})

test('自定义出图函数的输入端口不必叫 data，且 scaler 线不作为绘图数据', () => {
  const workflow = {
    id: 'wf',
    name: 'w',
    description: '',
    nodes: [
      { id: 'train', type: 'data.source', label: '训练集', params: {}, position: { x: 0, y: 0 } },
      { id: 'scale', type: 'custom.script', label: '标准化', params: {}, position: { x: 0, y: 0 } },
      { id: 'chart', type: 'custom.chart', label: '绘图', params: {}, position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'scale-to-chart', source: 'scale', sourcePort: 'scaler', target: 'chart', targetPort: 'scaler' },
      { id: 'train-to-chart', source: 'train', sourcePort: '__table__', target: 'chart', targetPort: 'train' },
    ],
  }
  assert.deepEqual(resolveFigureUpstreamTable(workflow, 'chart'), {
    nodeId: 'train',
    portId: '__table__',
    label: '训练集',
  })
})

test('自定义绘图函数的 Literal 字符串参数在节点卡片上生成下拉选项', () => {
  const def = getNodeTypeDef('custom.chart')
  const node: WorkflowNode = {
    id: 'chart',
    type: 'custom.chart',
    label: def.label,
    params: {
      ...defaultParams(def),
      code:
        'from typing import Literal\n' +
        'def plot(model, data, segment_id: int = 1, feature_name: Literal["压力", "流量"] = "压力"):\n' +
        '    return {"figure": None}\n',
    },
    position: { x: 0, y: 0 },
  }

  const ports = resolvePorts(node, {
    ...ctxWith(null),
    columnsOf: (nodeId, portId) =>
      nodeId === 'chart' && portId === 'data' ? ['上游动态列'] : null,
  })
  const feature = ports.inputs.find((port) => port.id === 'feature_name')
  assert.equal(feature?.paramSpec?.type, 'select')
  assert.equal(feature?.paramSpec?.default, '压力')
  assert.deepEqual(feature?.paramSpec?.options, [
    { value: '压力', label: '压力' },
    { value: '流量', label: '流量' },
  ])
  assert.equal(ports.inputs.find((port) => port.id === 'segment_id')?.paramSpec?.type, 'number')
})

test('自定义绘图的列名参数直接列出所接表格的实际列', () => {
  const def = getNodeTypeDef('custom.chart')
  const node: WorkflowNode = {
    id: 'chart',
    type: 'custom.chart',
    label: def.label,
    params: {
      ...defaultParams(def),
      code:
        'def plot(model, data, segment_id: int = 1, feature_name: str = "压力"):\n' +
        '    return {"figure": None}\n',
      feature_name: '流量',
    },
    position: { x: 0, y: 0 },
  }
  const ctx: PortContext = {
    ...ctxWith(null),
    columnsOf: (nodeId, portId) =>
      nodeId === 'chart' && portId === 'data' ? ['压力', '流量'] : null,
  }

  const ports = resolvePorts(node, ctx)
  const feature = ports.inputs.find((port) => port.id === 'feature_name')
  assert.equal(feature?.paramSpec?.type, 'select')
  assert.equal(feature?.paramSpec?.default, '压力')
  assert.deepEqual(feature?.paramSpec?.options, [
    { value: '压力', label: '压力' },
    { value: '流量', label: '流量' },
  ])
  assert.equal(ports.inputs.find((port) => port.id === 'segment_id')?.paramSpec?.type, 'number')
})

test('列名暂不可得时保留文本框，已选的失效列名会明确保留', () => {
  const def = getNodeTypeDef('custom.chart')
  const node: WorkflowNode = {
    id: 'chart',
    type: 'custom.chart',
    label: def.label,
    params: {
      ...defaultParams(def),
      code: 'def plot(data, feature_name: str = "压力"):\n    return {"figure": None}\n',
      feature_name: '旧列名',
    },
    position: { x: 0, y: 0 },
  }

  assert.equal(
    resolvePorts(node, ctxWith(null)).inputs.find((port) => port.id === 'feature_name')?.paramSpec?.type,
    'text',
  )

  const ports = resolvePorts(node, {
    ...ctxWith(null),
    columnsOf: (nodeId, portId) =>
      nodeId === 'chart' && portId === 'data' ? ['压力', '流量'] : null,
  })
  assert.deepEqual(ports.inputs.find((port) => port.id === 'feature_name')?.paramSpec?.options, [
    { value: '旧列名', label: '旧列名（当前值不在上游表）' },
    { value: '压力', label: '压力' },
    { value: '流量', label: '流量' },
  ])
})

test('通用训练块保留固定数据端口，训练函数参数按签名自动生成', () => {
  const trainer = getNodeTypeDef('train.function')
  const params = defaultParams(trainer)
  const node: WorkflowNode = {
    id: 'trainer',
    type: 'train.function',
    label: trainer.label,
    params,
    position: { x: 0, y: 0 },
  }
  const ports = resolvePorts(node, ctxWith(null))

  assert.deepEqual(
    ports.inputs.map((port) => port.id),
    ['model', 'train', 'val', 'scaler', 'epochs', 'learning_rate'],
  )
  assert.deepEqual(
    ports.outputs.map((port) => port.id),
    ['model', 'metrics', 'history', 'curve'],
  )
  assert.equal(ports.inputs.find((port) => port.id === 'epochs')?.paramSpec?.default, 20)
  assert.equal(ports.inputs.find((port) => port.id === 'learning_rate')?.paramSpec?.default, 0.001)
  assert.equal(ports.inputs.find((port) => port.id === 'epochs')?.label, '训练轮数')
  assert.equal(ports.inputs.find((port) => port.id === 'learning_rate')?.label, '学习率')
  assert.equal(portsTrustworthy(node, ctxWith(null)), true)
})

test('通用训练函数保留旧参数值并只清理已删除的签名参数', () => {
  const trainer = getNodeTypeDef('train.function')
  const node: WorkflowNode = {
    id: 'trainer',
    type: 'train.function',
    label: trainer.label,
    params: {
      ...defaultParams(trainer),
      code: 'def fit_model(model, train_loader, val_loader, device, spec, params, env, patience=4):\n    return {"metrics": {"轮次": patience}}\n',
      patience: 9,
    },
    position: { x: 0, y: 0 },
  }
  const ports = resolvePorts(node, ctxWith(null))
  assert.deepEqual(ports.inputs.map((port) => port.id), ['model', 'train', 'val', 'scaler', 'patience'])
  assert.equal(ports.inputs.find((port) => port.id === 'patience')?.paramSpec?.default, 4)
})

test('训练函数无默认值的带类型参数是必填输入，不偷偷填入占位值', () => {
  const trainer = getNodeTypeDef('train.function')
  const node: WorkflowNode = {
    id: 'trainer',
    type: 'train.function',
    label: trainer.label,
    params: {
      ...defaultParams(trainer),
      code:
        'def fit_model(model, train_loader, val_loader, device, spec, params, env, patience: int):\n' +
        '    return {"metrics": {"轮次": patience}}\n',
    },
    position: { x: 0, y: 0 },
  }
  const port = resolvePorts(node, ctxWith(null)).inputs.find((item) => item.id === 'patience')
  assert.ok(port)
  assert.equal(port.optional, false)
  assert.equal(port.paramSpec?.type, 'number')
  assert.equal(port.paramSpec?.required, true)
  assert.equal(node.params.patience, undefined)
})

test('workflow.group 的定义端口映射为外部端口，保留契约属性并公开组参数', () => {
  const def = getNodeTypeDef('workflow.group')
  assert.deepEqual(def.params, [])
  assert.match(def.description, /复合|封装/)

  const node: WorkflowNode = {
    id: 'g1',
    type: 'workflow.group',
    label: '训练准备',
    params: { epochs: 8 },
    position: { x: 0, y: 0 },
    group: {
      workflow: { id: 'inner', name: '训练准备', description: '', nodes: [], edges: [] },
      inputs: [
        {
          id: 'source_data',
          label: '输入数据',
          port: { id: 'data', label: '内部数据', type: 'table', optional: true, multiple: true },
          targetNodeId: 'fit',
          targetPortId: 'train',
        },
      ],
      outputs: [
        {
          id: 'result',
          label: '训练结果',
          port: { id: 'metrics', label: '内部指标', type: 'metrics' },
          sourceNodeId: 'fit',
          sourcePortId: 'metrics',
        },
      ],
      parameters: [
        {
          key: 'epochs',
          label: '训练轮数',
          nodeId: 'fit',
          paramKey: 'epochs',
          spec: { key: 'epochs', label: '内部轮数', type: 'number', default: 20, min: 1, required: true },
        },
      ],
    },
  }

  const ports = resolvePorts(node, ctxWith(null))
  assert.deepEqual(ports.inputs[0], {
    id: 'source_data',
    label: '输入数据',
    type: 'table',
    optional: true,
    multiple: true,
  })
  assert.deepEqual(ports.inputs[1], {
    id: 'epochs',
    label: '训练轮数',
    type: 'any',
    kind: 'param',
    paramKey: 'epochs',
    optional: false,
    paramSpec: { key: 'epochs', label: '训练轮数', type: 'number', default: 20, min: 1, required: true },
  })
  assert.deepEqual(ports.outputs, [
    { id: 'result', label: '训练结果', type: 'metrics' },
  ])
  assert.deepEqual(groupNodePorts(node), ports)
})

test('workflow.group 缺少定义时端口为空，且端口状态不可信以保留已有连线', () => {
  const node: WorkflowNode = {
    id: 'g1',
    type: 'workflow.group',
    label: '缺少定义的组',
    params: {},
    position: { x: 0, y: 0 },
  }
  assert.deepEqual(resolvePorts(node, ctxWith(null)), { inputs: [], outputs: [] })
  assert.deepEqual(groupNodePorts(node), { inputs: [], outputs: [] })
  assert.equal(portsTrustworthy(node, ctxWith(null)), false)
})
