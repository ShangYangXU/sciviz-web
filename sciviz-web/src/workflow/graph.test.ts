import test from 'node:test'
import assert from 'node:assert/strict'
import { graphFocus } from './graph'
import type { Workflow, WorkflowNode } from './types'

/** 这些测试只关心"谁连着谁"：节点长什么样、参数是什么都不影响遍历 */
const node = (id: string): WorkflowNode => ({
  id,
  type: 'data.source',
  label: id,
  params: {},
  position: { x: 0, y: 0 },
})

const wf = (ids: string[], links: [string, string][]): Workflow => ({
  id: 'w',
  name: '',
  description: '',
  nodes: ids.map(node),
  edges: links.map(([source, target], index) => ({
    id: `e${index}`,
    source,
    sourcePort: 'out',
    target,
    targetPort: 'in',
  })),
})

const sorted = (set: Set<string>) => [...set].sort()

test('整条链：上游与下游一次全拿到', () => {
  const workflow = wf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']])
  const focus = graphFocus(workflow, 'b')
  assert.deepEqual(sorted(focus.nodes), ['a', 'b', 'c', 'd'])
  assert.deepEqual(sorted(focus.edges), ['e0', 'e1', 'e2'])
})

test('只看直接邻居：隔一层的拿不到', () => {
  const workflow = wf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']])
  const focus = graphFocus(workflow, 'b', 1)
  assert.deepEqual(sorted(focus.nodes), ['a', 'b', 'c'], '上游 a、下游 c 都在；d 隔了一层')
  assert.deepEqual(sorted(focus.edges), ['e0', 'e1'], '与 c 相连的 e2 不算：c 本身是邻居，但 d 不是')
})

test('分叉与汇合都算在同一张关系网里', () => {
  const workflow = wf(['a', 'b', 'c', 'd'], [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']])
  assert.deepEqual(sorted(graphFocus(workflow, 'a').nodes), ['a', 'b', 'c', 'd'])
  assert.deepEqual(sorted(graphFocus(workflow, 'd').nodes), ['a', 'b', 'c', 'd'])
  assert.deepEqual(sorted(graphFocus(workflow, 'b', 1).nodes), ['a', 'b', 'd'])
})

test('孤立的节点只有它自己', () => {
  const workflow = wf(['a', 'b'], [])
  const focus = graphFocus(workflow, 'a')
  assert.deepEqual(sorted(focus.nodes), ['a'])
  assert.deepEqual(sorted(focus.edges), [])
})

test('悬空连线不算：不存在的节点不该被点亮', () => {
  const workflow = wf(['a', 'b'], [['a', 'ghost']])
  const focus = graphFocus(workflow, 'a')
  assert.deepEqual(sorted(focus.nodes), ['a'])
  assert.deepEqual(sorted(focus.edges), [])
})

test('环也不会转圈（手改 YAML 能造出来）', () => {
  const workflow = wf(['a', 'b'], [['a', 'b'], ['b', 'a']])
  const focus = graphFocus(workflow, 'a')
  assert.deepEqual(sorted(focus.nodes), ['a', 'b'])
  assert.deepEqual(sorted(focus.edges), ['e0', 'e1'])
})

test('焦点不在图里时什么都不亮（比如刚删掉的那个块）', () => {
  const workflow = wf(['a'], [])
  assert.deepEqual(sorted(graphFocus(workflow, 'gone').nodes), ['gone'])
  assert.deepEqual(sorted(graphFocus(workflow, 'gone').edges), [])
})
