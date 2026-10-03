import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../../scripts/sciviz.mjs', import.meta.url))

async function withHostWithoutTorch(run: (host: string, cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sciviz-verify-cli-'))
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      ok: true, engine: 'test', python: 'test', numpy: 'test', pandas: 'test', scipy: null,
      operators: [], device: { backend: 'cpu', torchVersion: null, gpuNames: [] },
    }))
  })
  // Non-training fixtures must fail instead of acquiring execution results from this stub.
  server.on('upgrade', (_request, socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await run(`http://127.0.0.1:${address.port}`, cwd)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(cwd, { recursive: true, force: true })
  }
}

function verify(host: string, cwd: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--import', import.meta.resolve('tsx'), cliPath, 'verify', ...args, '--host', host],
      { cwd, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('verify reports missing torch as skipped without failing JSON or text output', async () => {
  await withHostWithoutTorch(async (host, cwd) => {
    const json = await verify(host, cwd, ['train.mlp.shape', '--json'])
    assert.equal(json.code, 0, json.stderr)
    const result = JSON.parse(json.stdout)
    assert.equal(result.ok, true)
    assert.equal(result.fixtures.length, 1)
    assert.equal(result.fixtures[0].skipped, true)
    assert.match(result.fixtures[0].reason, /torch/)
    assert.deepEqual(result.fixtures[0].cells, [])
    const text = await verify(host, cwd, ['train.mlp.shape'])
    assert.equal(text.code, 0, text.stderr)
    assert.match(text.stdout, /0\/0 条夹具通过/)
    assert.match(text.stdout, /跳过 1 条/)
  })
})

test('verify still fails when executed fixtures fail alongside a skipped fixture', async () => {
  await withHostWithoutTorch(async (host, cwd) => {
    const json = await verify(host, cwd, ['--json'])
    assert.equal(json.code, 1, json.stderr)
    const result = JSON.parse(json.stdout)
    assert.equal(result.ok, false)
    const skipped = result.fixtures.filter((fixture: { skipped?: boolean }) => fixture.skipped)
    const failures = result.fixtures.filter((fixture: { skipped?: boolean; ok?: boolean }) =>
      !fixture.skipped && fixture.ok === false)
    assert.equal(skipped.length, 1)
    assert.ok(failures.length > 0)
    const text = await verify(host, cwd, [])
    assert.equal(text.code, 1, text.stderr)
    assert.match(text.stdout, new RegExp(`0/${failures.length} 条夹具通过`))
    assert.match(text.stdout, /跳过 1 条/)
  })
})
