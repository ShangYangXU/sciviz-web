import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'scripts', 'sciviz-mcp.mjs')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
let buffer = ''
const pending = new Map()
let nextId = 1
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    const value = JSON.parse(line)
    const entry = pending.get(value.id)
    if (entry) { pending.delete(value.id); clearTimeout(entry.timer); entry.resolve(value) }
  }
})
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)) }, 15_000)
  pending.set(id, { resolve, timer })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})

try {
  const initialized = await request('initialize')
  assert.equal(initialized.result.serverInfo.name, 'sciviz')
  const listed = await request('tools/list')
  assert.ok(listed.result.tools.some((tool) => tool.name === 'sciviz_catalog'))
  assert.equal(listed.result.tools.some((tool) => tool.name === 'sciviz_sciviz_code'), false)
  const catalog = await request('tools/call', { name: 'sciviz_catalog', arguments: {} })
  assert.equal(catalog.result.isError, false)
  assert.match(catalog.result.content[0].text, /"operatorCount"\s*:\s*\d+/)
  const selected = await request('tools/call', { name: 'sciviz_catalog', arguments: { type: 'data.source' } })
  assert.equal(selected.result.isError, false)
  const payload = JSON.parse(selected.result.content[0].text)
  assert.equal(payload.operatorCount, 1)
  assert.deepEqual(payload.operators.map((operator) => operator.type), ['data.source'])
  const unknown = await request('tools/call', { name: 'sciviz_catalog', arguments: { type: 'fake.unknown' } })
  assert.equal(unknown.result.isError, true)
  process.stdout.write('mcp smoke passed\n')
} finally {
  child.kill()
}
