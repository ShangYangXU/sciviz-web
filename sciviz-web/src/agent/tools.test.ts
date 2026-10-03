import test from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, toolNamesForSurface, toolSpecOf, toolsForSurface } from './tools'

test('chat 与 MCP 工具集合来自同一份声明', () => {
  assert.deepEqual(toolNamesForSurface('mcp'), TOOLS.filter((tool) => (tool.surfaces as readonly string[]).includes('mcp')).map((tool) => tool.name))
  assert.ok(toolNamesForSurface('chat').includes('sciviz_code'))
  assert.equal(toolNamesForSurface('mcp').includes('sciviz_code'), false)
  assert.equal(toolSpecOf('missing'), undefined)
})

test('侧边问答只暴露纯读取工具', () => {
  assert.deepEqual(toolNamesForSurface('sidebar'), ['catalog', 'validate', 'explain', 'inspect', 'read'])
  assert.ok(toolsForSurface('sidebar').every((tool) => tool.effect === 'read'))
  assert.equal(toolNamesForSurface('sidebar').some((name) => ['patch', 'undo', 'run', 'verify', 'sciviz_code', 'task_checkpoint'].includes(name)), false)
})

test('每个工具都有版本、执行位置、效果与风险', () => {
  for (const tool of toolsForSurface('chat')) {
    assert.equal(tool.payloadVersion, 1)
    assert.ok(tool.command)
    assert.ok(tool.inputSchema)
    assert.ok(tool.surfaces.length)
  }
})

test('inspect 声明了读块内代码与所在层级的入口', () => {
  // 客户端的执行分支按这两个参数取名；声明里少一个，模型就看不到这条能力，
  // 症状是"它只会说要先读代码，却从不真去读"（2026-09-22 实测过一轮）。
  const inspect = toolSpecOf('inspect')
  assert.ok(inspect)
  assert.ok(inspect.inputSchema.properties?.code)
  assert.ok(inspect.inputSchema.properties?.nodeId)
  assert.match(inspect.description, /path/)
})

test('报告配图工具只在 Chat 中开放，返回本机项目报告引用', () => {
  const figure = toolSpecOf('report_figure')
  assert.ok(figure)
  assert.deepEqual(figure.surfaces, ['chat'])
  assert.deepEqual(figure.inputSchema.required, ['nodeId'])
  assert.ok(figure.inputSchema.properties?.groupPath)
  assert.ok(figure.inputSchema.properties?.caption)
  assert.match(figure.description, /本机/)
})
