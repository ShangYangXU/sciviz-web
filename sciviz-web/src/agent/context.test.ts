import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleContext, describeNode, locateNodes, outlineOf, stableStringify } from './context'
import { emptyProject } from '../workflow/project'
import { emptyWorkflow } from '../workflow/defaultWorkflow'
import type { Project } from '../workflow/project'

test('stableStringify 不受对象键序影响', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }))
})

test('上下文默认不携带行值，引用节点携带邻居', async () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  const envelope = await assembleContext({ project, editFingerprint: 'fp', promptVersion: 'p1', references: ['missing'] })
  assert.equal(envelope.datasets.length, 0)
  assert.equal(envelope.project.editFingerprint, 'fp')
  assert.match(envelope.digest, /^sha256:[0-9a-f]{64}$/)
})

test('预算不足时按顺序裁剪并留下记录', async () => {
  const project = emptyProject(emptyWorkflow('wf-test'))
  project.datasets = [{ id: 'd1', name: '数据', rowCount: 100, columns: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, type: 'number', role: 'continuous', enabled: true })) }]
  const envelope = await assembleContext({ project, editFingerprint: 'fp', promptVersion: 'p1', externalContent: [{ source: 'note', text: 'x'.repeat(1000) }], budget: 300 })
  assert.ok(envelope.dropped.length > 0)
})

/** 一个块被封装进子空间之后，它的 id 在根图上就找不到了 —— 上下文必须把层级一起给出来 */
function projectWithGroupedChart(): Project {
  const project = emptyProject(emptyWorkflow('wf-test'))
  project.graph.nodes = [
    {
      id: 'g1',
      type: 'workflow.group',
      label: 'LSTM训练空间',
      params: {},
      position: { x: 0, y: 0 },
      group: {
        workflow: {
          id: 'g1-inner',
          name: 'g1',
          description: '',
          nodes: [
            { id: 'n1', type: 'custom.chart', label: 'SFTF评估', params: { point: 300, code: 'def draw(data):\n    return None\n' }, position: { x: 0, y: 0 } },
          ],
          edges: [],
        },
        inputs: [],
        outputs: [],
        parameters: [],
      },
    },
  ]
  return project
}

test('定位块时带上所在层级，补丁才知道用哪条 path', async () => {
  const project = projectWithGroupedChart()
  assert.deepEqual(locateNodes(project, 'n1').map((hit) => hit.groupPath), [['g1']])
  assert.deepEqual(locateNodes(project, 'g1').map((hit) => hit.groupPath), [[]])
  assert.deepEqual(locateNodes(project, 'nope'), [])

  const described = await describeNode(project, 'n1', false)
  assert.equal(described?.label, 'SFTF评估')
  assert.deepEqual(described?.groupPath, ['g1'])
  assert.deepEqual(described?.groupLabels, ['LSTM训练空间'])
  assert.equal(described?.params.point, 300)
})

test('块内代码默认只给指纹，授权后才给正文', async () => {
  const project = projectWithGroupedChart()
  const without = await describeNode(project, 'n1', false)
  assert.equal(without?.code, undefined)
  assert.equal(without?.codeLines, 3)
  assert.match(without?.codeDigest ?? '', /^sha256:[0-9a-f]{64}$/)

  const withCode = await describeNode(project, 'n1', true)
  assert.match(withCode?.code ?? '', /def draw/)

  const envelope = await assembleContext({ project, editFingerprint: 'fp', promptVersion: 'p1', references: ['n1'], includeCode: true, includeCodeInContext: true })
  assert.equal(envelope.references.length, 1)
  assert.equal(envelope.permissions.includeCode, true)
  assert.match(envelope.references[0].code ?? '', /def draw/)
})

/** 同一个 id 撞在两层里：`@` 覆盖到子空间内部之后，这种事才第一次变得可达 */
function projectWithDuplicateId(): Project {
  const project = projectWithGroupedChart()
  project.graph.nodes.push({ id: 'n1', type: 'custom.chart', label: '根图上的同名块', params: {}, position: { x: 10, y: 10 } })
  return project
}

test('整图骨架含每一层子空间内部，并带上各自层级', () => {
  const project = projectWithGroupedChart()
  const outline = outlineOf(project.graph)
  assert.deepEqual(outline.map((item) => [item.id, item.groupPath]), [['g1', []], ['n1', ['g1']]])
  assert.deepEqual(outline[1].groupLabels, ['LSTM训练空间'])
  assert.equal(outline[1].type, 'custom.chart')
})

test('上下文每轮带整图骨架：模型不必为了"图上有哪些块"再跑一趟 inspect', async () => {
  const project = projectWithGroupedChart()
  const envelope = await assembleContext({ project, editFingerprint: 'fp', promptVersion: 'p1' })
  assert.deepEqual(envelope.outline.map((item) => item.id), ['g1', 'n1'])
})

test('同一个 id 命中多层时如实报出，不静默取第一处', async () => {
  const project = projectWithDuplicateId()
  assert.equal(locateNodes(project, 'n1').length, 2)

  const described = await describeNode(project, 'n1', false)
  assert.equal(described?.ambiguous, 2)
  assert.deepEqual(described?.matches?.map((hit) => hit.groupPath), [['g1'], []])

  const envelope = await assembleContext({ project, editFingerprint: 'fp', promptVersion: 'p1', references: ['n1'] })
  assert.equal(envelope.references[0].ambiguous, 2)
  assert.equal(envelope.references[0].matches?.length, 2)
})

test('预算吃紧时整图骨架最后才丢', async () => {
  const project = projectWithGroupedChart()
  project.datasets = [{ id: 'd1', name: '数据', rowCount: 100, columns: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, type: 'number', role: 'continuous', enabled: true })) }]
  const envelope = await assembleContext({
    project,
    editFingerprint: 'fp',
    promptVersion: 'p1',
    externalContent: [{ source: 'note', text: 'x'.repeat(1000) }],
    budget: 300,
  })
  assert.ok(envelope.dropped.some((entry) => entry.section === 'datasets'), '这个预算下数据集说明应当先被丢掉')
  assert.equal(envelope.outline.length, 2, '数据集说明都丢了，骨架还在')
})
