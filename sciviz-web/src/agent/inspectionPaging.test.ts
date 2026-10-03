import assert from 'node:assert/strict'
import test from 'node:test'
import { pageCode, pageGraph } from './inspectionPaging'

test('TCN 代码即使请求百字页面，也能在两次读取后取得完整原文', () => {
  const code = 'x'.repeat(10_890)
  const first = pageCode(code, 0, 120)
  assert.equal(first.code.length, 8_000)
  assert.equal(first.nextCodeOffset, 8_000)
  assert.equal(first.codeComplete, false)
  const second = pageCode(code, first.nextCodeOffset)
  assert.equal(first.code + second.code, code)
  assert.equal(second.nextCodeOffset, null)
  assert.equal(second.codeComplete, true)
})

test('整图分页覆盖全部节点和连线，边跨页也只出现一次', () => {
  const nodes = Array.from({ length: 27 }, (_, index) => ({ runtimeId: `n${index}` }))
  const edges = [{ sourceRuntimeId: 'n0', targetRuntimeId: 'n26' }, { sourceRuntimeId: 'n26', targetRuntimeId: 'n0' }]
  const first = pageGraph(nodes, edges, 0, 1)
  const second = pageGraph(nodes, edges, first.nextOffset, 1)
  const third = pageGraph(nodes, edges, second.nextOffset, 1)
  const pages = [first, second, third]
  assert.deepEqual(pages.map((page) => page.nodes.length), [10, 10, 7])
  assert.equal(pages.flatMap((page) => page.nodes).length, 27)
  assert.deepEqual(pages.flatMap((page) => page.edges), edges)
  assert.equal(pages.at(-1)?.complete, true)
})
