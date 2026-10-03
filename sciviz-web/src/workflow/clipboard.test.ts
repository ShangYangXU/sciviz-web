import assert from 'node:assert/strict'
import test from 'node:test'

import { createImageAnnotation, type Annotation } from './annotations'
import {
  CLIPBOARD_MARKER,
  buildClipboardPayload,
  clipboardPayloadText,
  looksLikeClipboardPayload,
  parseClipboardPayload,
  pasteClipboardPayload,
  type ClipboardPayload,
} from './clipboard'
import { createGroupFromSelection } from './groups'
import { makeEdgeId, type PortContext } from './ports'
import type { Workflow, WorkflowEdge, WorkflowNode } from './types'

const ctx: PortContext = {
  featuresOf: () => [],
  timeColumnOf: () => null,
}

const node = (id: string, type: string, label: string, x: number, y: number, params = {}): WorkflowNode => ({
  id,
  type,
  label,
  params,
  position: { x, y },
})

function edge(source: string, sourcePort: string, target: string, targetPort: string): WorkflowEdge {
  return { id: makeEdgeId(source, sourcePort, target, targetPort), source, sourcePort, target, targetPort }
}

/**
 * 一张小图：数据源 → 拆列 → 图表，外加一个没接上的评估节点。
 * "拆列 → 图表" 是内部连线，"数据源 → 拆列" 跨出选择 —— 前者该跟着走，后者不该。
 */
function basicWorkflow(): Workflow {
  return {
    id: 'wf',
    name: '测试图',
    description: '',
    nodes: [
      node('source', 'data.source', '输入数据', 0, 0, { datasetId: 'ds1' }),
      node('columns', 'data.columns', '拆列', 300, 60),
      node('chart', 'viz.chart', '图表', 600, 60),
      node('score', 'eval.score', '评估', 900, 400),
    ],
    edges: [
      edge('source', '__table__', 'columns', 'data'),
      edge('columns', 'a', 'chart', 'data'),
    ],
  }
}

/** 粘贴时用的 id 生成器：可预期，测起来才看得出"谁换成了谁" */
function idGen(prefix: string): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

const pasteIds = (): { node: () => string; annotation: () => string } => ({
  node: idGen('new-'),
  annotation: idGen('a-new-'),
})

/** 这一批内置算子在本会话里"已注册"。测"剪贴板里有没注册的算子"时用它当判据 */
const KNOWN_TYPES = new Set(['data.source', 'data.columns', 'viz.chart', 'eval.score', 'workflow.group'])
const isKnownType = (type: string) => KNOWN_TYPES.has(type)

test('复制：只带走两端都在选择里的连线，跨边界的那条不跟并报数', () => {
  const workflow = basicWorkflow()
  const payload = buildClipboardPayload(workflow, [], [], ['columns', 'chart'])!
  assert.deepEqual(payload.nodes.map((item) => item.id), ['columns', 'chart'])
  assert.deepEqual(payload.edges, [{ source: 'columns', sourcePort: 'a', target: 'chart', targetPort: 'data' }])
  assert.equal(payload.droppedEdges, 1, '数据源 → 拆列 跨出了选择，必须报出来而不是静默丢')
})

test('复制：坐标相对化到包围盒左上角，粘贴到别处也不会把这一块拆散', () => {
  const workflow = basicWorkflow()
  const payload = buildClipboardPayload(workflow, [], [], ['columns', 'chart'])!
  assert.deepEqual(payload.at, { x: 300, y: 60 })
  assert.deepEqual(payload.size, { width: 300, height: 0 })
  assert.deepEqual(payload.nodes.map((item) => item.node.position), [{ x: 0, y: 0 }, { x: 300, y: 0 }])

  const pasted = pasteClipboardPayload(payload, {
    workflow: { id: 'wf2', name: '第二张', description: '', nodes: [], edges: [] },
    annotations: [],
    path: [],
    origin: { x: 1000, y: 500 },
    ids: pasteIds(),
    isKnownType,
  })!
  assert.deepEqual(pasted.nodes.map((item) => item.position), [{ x: 1000, y: 500 }, { x: 1300, y: 500 }])
  assert.deepEqual(pasted.nodes.map((item) => item.id), ['new-1', 'new-2'])
  assert.deepEqual(pasted.edges, [
    {
      id: makeEdgeId('new-1', 'a', 'new-2', 'data'),
      source: 'new-1',
      sourcePort: 'a',
      target: 'new-2',
      targetPort: 'data',
    },
  ])
})

test('复制组块：内联子图、边界映射与参数一起进载荷，粘贴出来的是独立副本', () => {
  const grouped = createGroupFromSelection(basicWorkflow(), ['columns', 'chart'], ctx, 'block').workflow
  const payload = buildClipboardPayload(grouped, [], [], ['block'])!
  assert.equal(payload.nodes.length, 1)
  assert.ok(payload.nodes[0].node.group, '组合块必须带着内联子图走，否则粘出来的块是空壳')

  const pasted = pasteClipboardPayload(payload, {
    workflow: grouped,
    annotations: [],
    path: [],
    origin: { x: 1200, y: 300 },
    ids: pasteIds(),
    isKnownType,
  })!
  const copy = pasted.nodes[0]
  assert.equal(copy.label, '拆列 / 图表 副本', '与目标图重名时加后缀：名字是能被点名的身份')
  assert.equal(copy.group!.workflow.nodes.length, 2)

  // 副本必须是深拷贝：改组副本内部的一个参数，原件不能跟着变
  const originalNode = grouped.nodes.find((item) => item.id === 'block')!
  copy.group!.workflow.nodes[0].params.injectedByTest = 1
  assert.equal(originalNode.group!.workflow.nodes[0].params.injectedByTest, undefined)
})

test('批量粘贴重名：第一次「副本」，第二次「副本 2」，都能被点名', () => {
  const workflow = basicWorkflow()
  const payload = buildClipboardPayload(workflow, [], [], ['chart'])!
  const target = { workflow, annotations: [], path: [] as string[], ids: pasteIds(), isKnownType }
  const first = pasteClipboardPayload(payload, { ...target, origin: { x: 0, y: 200 } })!
  const second = pasteClipboardPayload(payload, {
    workflow: first.workflow,
    annotations: [],
    path: [],
    origin: { x: 0, y: 400 },
    ids: pasteIds(),
    isKnownType,
  })!
  assert.equal(first.nodes[0].label, '图表 副本')
  assert.equal(second.nodes[0].label, '图表 副本 2')
})

test('批注跟着走：选中的批注与组块内部的图片一起复制，跨层级粘贴时重挂 groupPath', () => {
  const workflow = basicWorkflow()
  const grouped = createGroupFromSelection(workflow, ['columns', 'chart'], ctx, 'block').workflow
  const image = createImageAnnotation('a-image', { x: 10, y: 20 }, 'data:image/png;base64,x')
  const insideGroup: Annotation = { ...image, id: 'a-inner', groupPath: ['block'] }
  const elsewhere: Annotation = { ...image, id: 'a-other', groupPath: ['somebody-else'] }
  const annotations = [insideGroup, elsewhere]

  const payload = buildClipboardPayload(grouped, annotations, [], ['block'])!
  assert.deepEqual(payload.annotations.map((item) => item.annotation.id), ['a-inner'])
  assert.deepEqual(payload.annotations[0].path, ['block'], '载荷里的路径是相对的：粘贴时才换成新 id')

  // 粘到主画布（目标层级为空）：原来在 block 里的图片挂到新块下面
  const pasted = pasteClipboardPayload(payload, {
    workflow: grouped,
    annotations,
    path: [],
    origin: { x: 1000, y: 1000 },
    ids: pasteIds(),
    isKnownType,
  })!
  assert.equal(pasted.annotationIds.length, 1)
  const copy = pasted.annotations[pasted.annotations.length - 1]
  assert.deepEqual(copy.groupPath, [pasted.nodes[0].id])
  // 载荷原点是节点与批注共同的包围盒左上角（这张图里批注更靠左上），所以粘贴位置按那个原点算
  assert.deepEqual(copy.position, { x: 1000, y: 1000 })
})

test('载荷文本往返：自己的载荷认得出来，别人的内容一个字都不动', () => {
  const workflow = basicWorkflow()
  const payload = buildClipboardPayload(workflow, [], [], ['columns', 'chart'])!
  const text = clipboardPayloadText(payload)
  assert.equal(parseClipboardPayload(text)?.marker, CLIPBOARD_MARKER)
  assert.deepEqual(parseClipboardPayload(text)?.nodes.map((item) => item.id), ['columns', 'chart'])
  // 正常用文本往返回来的载荷，粘出来的东西与直接粘一样
  assert.deepEqual(
    parseClipboardPayload(text)?.edges,
    payload.edges,
  )
  // "是我们的东西但读不出来"要能与"压根不是我们的东西"分开：前者必须说出来，后者什么都不做
  assert.equal(looksLikeClipboardPayload(text), true)
  assert.equal(looksLikeClipboardPayload(JSON.stringify({ ...payload, version: 99 })), true)
  assert.equal(looksLikeClipboardPayload('随手复制的一段文字'), false)
  assert.equal(looksLikeClipboardPayload(null), false)

  for (const foreign of [
    // 不是本应用的载荷：从截图到随手复制的文字，一律什么都不做
    null,
    undefined,
    '',
    '   ',
    '随手复制的一段文字',
    '{"hello":"world"}',
    '{坏掉的 json',
    JSON.stringify({ ...payload, marker: 'somebody/else' }),
    JSON.stringify({ ...payload, version: 99 }),
    // 是本应用的载荷，但里面是坏的：节点缺字段、连线引用不存在的节点、空载荷
    JSON.stringify({ ...payload, nodes: [{ id: 'a', node: { id: 'a', type: 't', label: 'l' } }] }),
    JSON.stringify({ ...payload, edges: [{ source: 'nope', sourcePort: 'a', target: 'columns', targetPort: 'b' }] }),
    JSON.stringify({ ...payload, nodes: [], annotations: [] }),
  ]) {
    assert.equal(parseClipboardPayload(foreign as string | null), null)
  }
})

test('空载荷：没选中就没得复制，粘也只当没这回事', () => {
  const workflow = basicWorkflow()
  assert.equal(buildClipboardPayload(workflow, [], [], []), null)
  const empty: ClipboardPayload = {
    marker: CLIPBOARD_MARKER,
    version: 1,
    from: [],
    at: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    nodes: [],
    edges: [],
    annotations: [],
    droppedEdges: 0,
  }
  assert.equal(pasteClipboardPayload(empty, { workflow, annotations: [], path: [], origin: { x: 0, y: 0 }, ids: pasteIds(), isKnownType }), null)
})

test('剪贴板里有本会话没有的算子：不粘，并说清是哪个（粘进去会让画布当场渲染不出来）', () => {
  const workflow = basicWorkflow()
  const payload = buildClipboardPayload(workflow, [], [], ['chart'])!
  const fromOtherSession: ClipboardPayload = {
    ...payload,
    nodes: [{ ...payload.nodes[0], node: { ...payload.nodes[0].node, type: 'mymod.custom-op' } }],
    edges: [],
  }
  assert.throws(
    () =>
      pasteClipboardPayload(fromOtherSession, {
        workflow,
        annotations: [],
        path: [],
        origin: { x: 0, y: 0 },
        ids: pasteIds(),
        isKnownType,
      }),
    /mymod\.custom-op/,
  )
})

test('非组块类型带 group 定义：整条载荷当坏的，不进图（与 yamlToWorkflow 同一条判据）', () => {
  const workflow = basicWorkflow()
  const payload = buildClipboardPayload(workflow, [], [], ['chart'])!
  const broken = JSON.stringify({
    ...payload,
    nodes: [
      {
        id: 'chart',
        node: {
          ...payload.nodes[0].node,
          group: { workflow: { id: 'x', name: 'x', description: '', nodes: [], edges: [] }, inputs: [], outputs: [], parameters: [] },
        },
      },
    ],
    edges: [],
  })
  assert.equal(parseClipboardPayload(broken), null)
})
