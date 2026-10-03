/**
 * SciViz 的最薄 MCP stdio 壳。
 *
 * 壳只做 JSON-RPC 传输和 camelCase → CLI 参数翻译；实际动作统一转给
 * sciviz.mjs 的 runCli，工具声明统一来自 src/agent/tools.ts。这里没有契约、
 * 端口、校验或执行逻辑，因而不会成为第二个执行面。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCli } from './sciviz.mjs'
import { toolsForSurface } from '../src/agent/tools.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MCP_ROOT = path.resolve(process.env.SCIVIZ_MCP_ROOT ?? path.resolve(HERE, '../..'))
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_CACHED_FIGURES = 40
const MAX_CACHED_FIGURE_BYTES = 48 * 1024 * 1024
let queue = Promise.resolve()
let callCounter = 0
const figureCache = new Map()

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

function rpcError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

function flag(argv, name, value) {
  if (value === undefined || value === null || value === '') return
  argv.push(`--${name}`, String(value))
}

function mapArgs(name, input) {
  const args = input && typeof input === 'object' ? input : {}
  const argv = []
  if (name === 'new') {
    argv.push(String(args.file ?? ''))
    flag(argv, 'name', args.name)
    flag(argv, 'description', args.description)
    flag(argv, 'force', args.force ? 'true' : undefined)
  } else if (name === 'catalog') {
    if (args.type) argv.push(String(args.type))
  } else if (name === 'validate') {
    argv.push(String(args.file ?? ''))
    for (const [key, columns] of Object.entries(args.columns ?? {})) flag(argv, 'columns', `${key}=${Array.isArray(columns) ? columns.join(',') : columns}`)
    for (const [key, time] of Object.entries(args.time ?? {})) flag(argv, 'time', `${key}=${time}`)
  } else if (name === 'explain') {
    if (args.list) flag(argv, 'list', 'true')
    else argv.push(String(args.code ?? ''))
    if (args.nodeId) flag(argv, 'node', args.nodeId)
    if (args.portId) flag(argv, 'port', args.portId)
  } else if (name === 'plan') {
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : args
    argv.push(String(args.file ?? patch.file ?? ''))
    for (const [key, value] of Object.entries(args.data ?? {})) flag(argv, 'data', `${key}=${value}`)
  } else if (name === 'patch') {
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : args
    argv.push(String(args.file ?? patch.file ?? ''))
    const ops = args.ops ?? patch.ops
    if (ops === undefined) throw new Error('patch 需要 ops')
    const reason = patch.reason ?? args.reason
    const patchFile = {
      // Keep the field present even when omitted so the CLI routes MCP calls through
      // applyPatchGuarded and returns E_PATCH_BASE_MISMATCH instead of writing unguarded.
      baseFingerprint: patch.baseFingerprint ?? args.baseFingerprint ?? '',
      ...(reason === undefined ? {} : { reason }),
      ops,
    }
    const filename = path.join(HERE, '..', '.tmp', 'mcp', `ops-${++callCounter}.json`)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, `${JSON.stringify(patchFile, null, 2)}\n`, 'utf8')
    flag(argv, 'ops', filename)
    if (args.dryRun) flag(argv, 'dry-run', 'true')
  } else if (name === 'undo') {
    argv.push(String(args.file ?? ''))
    flag(argv, 'undo', 'true')
  } else if (name === 'run') {
    argv.push(String(args.file ?? ''))
    for (const [key, value] of Object.entries(args.data ?? {})) flag(argv, 'data', `${key}=${value}`)
    flag(argv, 'out', args.out)
    flag(argv, 'host', args.host)
    flag(argv, 'capture-figures', args.includeFigures ? 'true' : undefined)
  } else if (name === 'inspect') {
    argv.push(String(args.file ?? ''))
    flag(argv, 'canvas', 'true')
    flag(argv, 'node-id', args.nodeId)
    flag(argv, 'node', args.node)
    if (Array.isArray(args.groupPath)) flag(argv, 'group-path', JSON.stringify(args.groupPath))
    flag(argv, 'port', args.portId ?? args.port)
    flag(argv, 'rows', args.rows)
    flag(argv, 'row-offset', args.rowOffset)
    flag(argv, 'code', args.code ? 'true' : undefined)
    flag(argv, 'code-offset', args.codeOffset)
    flag(argv, 'code-limit', args.codeLimit)
    flag(argv, 'offset', args.offset)
    flag(argv, 'limit', args.limit)
    flag(argv, 'from', args.from)
    for (const [key, value] of Object.entries(args.data ?? {})) flag(argv, 'data', `${key}=${value}`)
    flag(argv, 'host', args.host)
  } else if (name === 'inspect_figure') {
    if (!args.file || !args.nodeId) throw new Error('inspect_figure 需要 file 与 nodeId')
    argv.push(String(args.file))
    flag(argv, 'node', args.nodeId)
    flag(argv, 'port', args.portId)
    flag(argv, 'from', args.from ?? 'latest')
    flag(argv, 'image', 'true')
  } else if (name === 'read') {
    if (!args.path) throw new Error('read 需要工作区相对路径 path')
    argv.push(MCP_ROOT)
    flag(argv, 'action', 'read')
    flag(argv, 'path', args.path)
    flag(argv, 'start', args.startLine)
    flag(argv, 'end', args.endLine)
  } else if (name === 'report') {
    if (!args.file || !args.action) throw new Error('report 需要 file 与 action')
    argv.push(String(args.file))
    flag(argv, 'action', args.action)
    flag(argv, 'report-id', args.reportId)
    flag(argv, 'expected-sha256', args.expectedSha256)
    flag(argv, 'offset', args.offset)
    flag(argv, 'limit', args.limit)
    if (args.action === 'save') {
      if (typeof args.title !== 'string' || typeof args.markdown !== 'string') throw new Error('report save 需要 title 与 markdown')
      const figures = (args.figures ?? []).map((requested) => {
        const cached = figureCache.get(String(requested.sha256 ?? '').toLowerCase())
        if (!cached) throw new Error(`报告图像 ${String(requested.sha256 ?? '').slice(0, 12)} 不在本 MCP 会话的已捕获图像中`)
        return { figure: cached.figure, caption: String(requested.caption ?? cached.figure.label) }
      })
      const input = { id: args.reportId, title: args.title, markdown: args.markdown, figures }
      const filename = path.join(HERE, '..', '.tmp', 'mcp', `report-${++callCounter}.json`)
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, `${JSON.stringify(input)}\n`, 'utf8')
      flag(argv, 'report', filename)
    }
  } else if (name === 'canvas') {
    if (!args.action) throw new Error('canvas 需要 action')
    const filename = path.join(HERE, '..', '.tmp', 'mcp', `canvas-${++callCounter}.json`)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, `${JSON.stringify(args)}\n`, 'utf8')
    flag(argv, 'action', args.action)
    flag(argv, 'payload', filename)
    flag(argv, 'host', args.host)
  } else if (name === 'doctor' || name === 'verify') {
    if (name === 'verify' && args.fixtureId) argv.push(String(args.fixtureId))
    flag(argv, 'host', args.host)
  } else {
    throw new Error(`没有对应 CLI 动词：${name}`)
  }
  argv.push('--json')
  return argv
}

function cacheFigure(figure, bytes, runId) {
  const sha256 = String(figure.sha256 ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('图像缺少有效 SHA-256')
  const actual = (awaitlessHash(bytes))
  if (actual !== sha256) throw new Error('图像内容与 SHA-256 不匹配')
  const dataUrl = `data:${figure.mimeType ?? 'image/png'};base64,${bytes.toString('base64')}`
  const normalized = {
    dataUrl,
    sha256,
    ...(figure.fingerprintSha256 ? { sourceFingerprintSha256: String(figure.fingerprintSha256) } : {}),
    width: Number(figure.width),
    height: Number(figure.height),
    nodeId: String(figure.nodeId ?? ''),
    groupPath: Array.isArray(figure.groupPath) ? figure.groupPath.map(String) : [],
    label: String(figure.label ?? figure.nodeId ?? '图表'),
    runtimeId: String(figure.runtimeId ?? figure.nodeId ?? ''),
    portId: String(figure.portId ?? 'figure'),
  }
  figureCache.delete(sha256)
  figureCache.set(sha256, { figure: normalized, bytes: Buffer.byteLength(dataUrl, 'utf8'), runId })
  let total = [...figureCache.values()].reduce((sum, item) => sum + item.bytes, 0)
  while (figureCache.size > MAX_CACHED_FIGURES || total > MAX_CACHED_FIGURE_BYTES) {
    const oldest = figureCache.keys().next().value
    if (!oldest) break
    total -= figureCache.get(oldest)?.bytes ?? 0
    figureCache.delete(oldest)
  }
  return normalized
}

function awaitlessHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function captureRunFigures(structured) {
  if (!Array.isArray(structured?.figures) || structured.figures.length === 0) return []
  if (!structured.manifestPath) throw new Error('运行结果缺少 manifestPath，无法读取捕获的图像')
  const manifestPath = path.resolve(structured.manifestPath)
  const runDir = path.dirname(manifestPath)
  const runDirReal = fs.realpathSync(runDir)
  const blocks = []
  let total = 0
  for (const artifact of structured.figures) {
    const imagePath = path.resolve(runDir, String(artifact.path ?? ''))
    const relative = path.relative(runDir, imagePath)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('运行清单里的图像路径越出了本次运行目录')
    }
    const imagePathReal = fs.realpathSync(imagePath)
    const realRelative = path.relative(runDirReal, imagePathReal)
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error('运行图像的实际路径越出了本次运行目录')
    }
    const bytes = fs.readFileSync(imagePathReal)
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024 || total + bytes.length > 24 * 1024 * 1024) {
      throw new Error('本次运行图像为空或超过 MCP 返回上限')
    }
    total += bytes.length
    const figure = cacheFigure(artifact, bytes, structured.runId)
    blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
    artifact.sha256 = figure.sha256
  }
  return blocks
}

function captureInspectedFigure(structured) {
  const raw = structured?.figure
  if (!raw || typeof raw.data !== 'string' || raw.mimeType !== 'image/png') throw new Error('inspect_figure 没有返回 PNG 图像')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)) throw new Error('inspect_figure 返回了无效的图像编码')
  const bytes = Buffer.from(raw.data, 'base64')
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) throw new Error('inspect_figure 图像为空或超过 8 MiB')
  cacheFigure(raw, bytes, structured.runId)
  const figure = { ...raw }
  delete figure.data
  return {
    structured: { ...structured, figure },
    image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
  }
}

function parseStructured(stdout) {
  try { return JSON.parse(stdout) } catch { return undefined }
}

function truncate(text, command) {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_RESPONSE_BYTES) return { text, truncated: false }
  const dir = path.join(HERE, '..', '.tmp', 'mcp')
  fs.mkdirSync(dir, { recursive: true })
  const filename = path.join(dir, `response-${++callCounter}.json`)
  fs.writeFileSync(filename, text, 'utf8')
  return { text: `${Buffer.from(text).subarray(0, MAX_RESPONSE_BYTES).toString('utf8')}\n{"truncated":true,"full":${JSON.stringify(filename)}}`, truncated: true }
}

async function callTool(id, name, input) {
  const spec = toolsForSurface('mcp').find((tool) => tool.name === name)
  if (!spec) return rpcError(id, -32602, `未知或未暴露的 MCP 工具：${name}`)
  try {
    const started = Date.now()
    const result = await runCli([spec.command.split(' ')[0], ...mapArgs(name, input)])
    let structured = parseStructured(result.stdout)
    let responseText = result.stdout
    const content = []
    if (name === 'run' && input?.includeFigures && result.code !== 2 && structured) {
      content.push(...captureRunFigures(structured))
    }
    if (name === 'inspect_figure' && result.code === 0 && structured) {
      const captured = captureInspectedFigure(structured)
      structured = captured.structured
      responseText = `${JSON.stringify(structured, null, 2)}\n`
      content.push(captured.image)
    }
    if (name === 'canvas' && structured?.image && typeof structured.image === 'object') {
      const image = structured.image
      const data = typeof image.data === 'string' ? image.data : ''
      if (!data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw new Error('实时画布截图不是有效的 base64 PNG')
      }
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024 || image.mimeType !== 'image/png') {
        throw new Error('实时画布 PNG 为空、格式无效或超过 8 MiB')
      }
      content.push({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' })
      structured = {
        ...structured,
        image: {
          mimeType: 'image/png',
          width: image.width,
          height: image.height,
          byteLength: bytes.length,
        },
      }
      responseText = `${JSON.stringify(structured, null, 2)}\n`
    }
    const bounded = truncate(responseText, name)
    if (content.length === 0) content.push({ type: 'text', text: bounded.text || result.stderr })
    else content.unshift({ type: 'text', text: bounded.text || result.stderr })
    const responseStructured = bounded.truncated ? { truncated: true, full: bounded.text } : structured
    const isError = result.code === 2
    write({
      jsonrpc: '2.0',
      id,
      result: {
        content,
        ...(responseStructured === undefined ? {} : { structuredContent: responseStructured }),
        isError,
        _meta: { command: spec.command, exitCode: result.code, ok: result.code === 0, durationMs: Date.now() - started, ...(result.stderr ? { stderr: result.stderr.slice(-4096) } : {}) },
      },
    })
  } catch (error) {
    rpcError(id, -32603, error instanceof Error ? error.message : String(error))
  }
}

function handle(request) {
  if (request.method === 'initialize') {
    return write({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sciviz', version: '0.1.0' } } })
  }
  if (request.method === 'notifications/initialized' || request.method === 'ping') {
    if (request.id !== undefined) write({ jsonrpc: '2.0', id: request.id, result: {} })
    return
  }
  if (request.method === 'tools/list') {
    const tools = toolsForSurface('mcp').map((spec) => ({ name: `sciviz_${spec.name}`, description: spec.description, inputSchema: spec.inputSchema }))
    return write({ jsonrpc: '2.0', id: request.id, result: { tools } })
  }
  if (request.method === 'tools/call') {
    const name = String(request.params?.name ?? '').replace(/^sciviz_/, '')
    queue = queue.then(() => callTool(request.id, name, request.params?.arguments ?? {}))
    return
  }
  if (request.id !== undefined) rpcError(request.id, -32601, `不支持的方法：${request.method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try { handle(JSON.parse(line)) } catch (error) { rpcError(null, -32700, error instanceof Error ? error.message : String(error)) }
  }
})
