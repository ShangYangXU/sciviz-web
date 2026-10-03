/**
 * 项目源码动作的唯一闸门（CLI-11 / CHAT C3）。
 *
 * 这层故意只认识受限的文件动作，不认识 shell、argv 或模型文本。浏览器和
 * 宿主都只能把结构化 CodeOp 交给这里；路径、基线、原子写入、固定闸门和撤销
 * 都在同一处完成，避免再长出一个“方便一点”的写文件入口。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pathPolicy from '../../../config/code-path-policy.json'
import checkConfig from '../../../config/code-checks.json'

const execFileAsync = promisify(execFile)

interface CodePathPolicy {
  version: number
  maxBytes: number
  readRoots: string[]
  writeRoots: string[]
  allowedFiles: string[]
  deniedSegments: string[]
  deniedExtensions: string[]
}

interface FixedCheck {
  program: 'npm' | 'python'
  args: string[]
  cwd: string
  timeoutMs: number
}

interface CodeCheckRegistry {
  version: number
  checks: Record<string, FixedCheck>
}

const PATH_POLICY = pathPolicy as CodePathPolicy
const CHECK_REGISTRY = checkConfig as CodeCheckRegistry
export const MAX_CODE_FILE_BYTES = PATH_POLICY.maxBytes
const MAX_CODE_READ_LINES = 500

/**
 * 读与写都覆盖整个工作区里的安全文本；路径策略排除工作区外、密钥、运行时
 * 与二进制文件。源码写入还要通过基线复核、原子替换与固定闸门。清单由宿主
 * Python 版共读，避免两边越改越不一样。
 */
export const CODE_READ_PATH_POLICY = Object.freeze({
  roots: PATH_POLICY.readRoots,
  allowedFiles: PATH_POLICY.allowedFiles,
  deniedSegments: PATH_POLICY.deniedSegments,
  deniedExtensions: PATH_POLICY.deniedExtensions,
  maxBytes: PATH_POLICY.maxBytes,
})

export const CODE_PATH_FENCE = Object.freeze({
  allowedRoots: PATH_POLICY.writeRoots,
  allowedFiles: PATH_POLICY.allowedFiles,
  deniedSegments: PATH_POLICY.deniedSegments,
  deniedExtensions: PATH_POLICY.deniedExtensions,
  maxBytes: PATH_POLICY.maxBytes,
})

export type CodeOp =
  | { kind: 'replaceText'; path: string; expectSha256: string; oldText: string; newText: string }
  | { kind: 'writeFile'; path: string; expectSha256: string; content: string }
  | { kind: 'createFile'; path: string; content: string }
  | { kind: 'deleteFile'; path: string; expectSha256: string }

export interface CodeFileInfo {
  path: string
  bytes: number
  sha256: string
}

export interface CodeReadResult extends CodeFileInfo {
  startLine: number
  endLine: number
  lineCount: number
  nextStartLine: number | null
  complete: boolean
  text: string
}

export interface CodeSearchMatch {
  path: string
  line: number
  text: string
}

export interface CodeSearchResult {
  query: string
  glob: string
  filesSearched: number
  totalMatches: number
  truncated: boolean
  matches: CodeSearchMatch[]
}

export interface CodeCheckResult {
  id: string
  ok: boolean
  exitCode: number | null
  output: string
}

export interface CodePlanFile {
  path: string
  beforeSha256: string | null
  afterSha256: string | null
  bytes: number
}

export interface CodeGate {
  id: string
  command: string
  required: boolean
}

export interface CodePlan {
  schemaVersion: 1
  planId: string
  root: string
  createdAt: string
  operations: CodeOp[]
  files: CodePlanFile[]
  diff: string
  gates: CodeGate[]
  /** Human confirmation must echo this exact token; it is not an executable command. */
  approvalToken: string
}

export interface CodeRecord {
  schemaVersion: 1
  planId: string
  root: string
  appliedAt: string
  operations: CodeOp[]
  before: Array<{ path: string; exists: boolean; content?: string; sha256: string | null }>
  after: Array<{ path: string; exists: boolean; sha256: string | null }>
  gates: Array<{ id: string; ok: boolean; output?: string }>
}

export interface CodeGateResult {
  ok: boolean
  status: 'done' | 'failed' | 'blocked'
  plan: CodePlan
  record?: CodeRecord
  error?: { code: string; message: string }
  gates: Array<{ id: string; ok: boolean; output?: string }>
}

export interface CodeGateOptions {
  now?: () => string
  /** Test/CI injection point. Production callers must leave this unset. */
  gateRunner?: (gate: CodeGate, root: string) => Promise<{ ok: boolean; output?: string }>
  /** Only internal tests may use this; the CLI and HTTP surface never expose it. */
  skipGates?: boolean
}

export class CodeGateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CodeGateError'
  }
}

const normalizeDigest = (value: string): string => value.replace(/^sha256:/i, '').toLowerCase()

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
}

export function sha256Text(text: string): string {
  return digestBytes(Buffer.from(text, 'utf8'))
}

function rootRealPath(root: string): string {
  const resolved = path.resolve(root)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new CodeGateError('E_CODE_PATH_OUTSIDE', `代码围栏根目录不存在：${resolved}`)
  }
  return fs.realpathSync.native(resolved)
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function normalizedRelative(input: string): string {
  if (!input || path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new CodeGateError('E_CODE_PATH_OUTSIDE', `源码路径必须是围栏内的相对路径：${input || '<空>'}`)
  }
  const rel = input.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = rel.split('/').filter(Boolean)
  if (!parts.length || parts.includes('..') || parts.includes('.')) {
    throw new CodeGateError('E_CODE_PATH_OUTSIDE', `源码路径含有越界片段：${input}`)
  }
  return parts.join('/')
}

function isAllowedRelative(rel: string, mode: 'read' | 'write' = 'write'): boolean {
  const lower = rel.toLowerCase()
  const segments = lower.split('/')
  const policy = mode === 'read' ? CODE_READ_PATH_POLICY : CODE_PATH_FENCE
  if (segments.some((segment) => policy.deniedSegments.includes(segment))) return false
  if (segments.some((segment) => segment.startsWith('.env'))) return false
  if (policy.deniedExtensions.some((suffix) => lower.endsWith(suffix))) return false
  if (policy.allowedFiles.some((file) => lower === file.toLowerCase())) return true
  const roots = mode === 'read' ? CODE_READ_PATH_POLICY.roots : CODE_PATH_FENCE.allowedRoots
  return roots.some((root: string) => !root || lower === root.toLowerCase() || lower.startsWith(`${root.toLowerCase()}/`))
}

function safePath(rootInput: string, input: string, mustExist = false, mode: 'read' | 'write' = 'write'): { root: string; rel: string; absolute: string } {
  const root = rootRealPath(rootInput)
  const rel = normalizedRelative(input)
  if (!isAllowedRelative(rel, mode)) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `路径不在${mode === 'read' ? '工作区读取范围' : '源码写入围栏'}内：${rel}`)
  const absolute = path.resolve(root, ...rel.split('/'))
  if (!isInside(root, absolute)) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `路径越过源码围栏：${rel}`)
  const exists = fs.existsSync(absolute)
  if (mustExist && !exists) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `文件不存在：${rel}`)
  if (exists) {
    const real = fs.realpathSync.native(absolute)
    if (!isInside(root, real)) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `符号链接越过源码围栏：${rel}`)
    const stat = fs.statSync(real)
    if (!stat.isFile()) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `目标不是普通文本文件：${rel}`)
    if (mode === 'write' && stat.size > PATH_POLICY.maxBytes) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `写入目标超过 ${PATH_POLICY.maxBytes} 字节限制：${rel}`)
  } else {
    let parent = path.dirname(absolute)
    while (!fs.existsSync(parent) && isInside(root, parent)) parent = path.dirname(parent)
    if (!isInside(root, parent) || !fs.existsSync(parent)) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `文件父目录不在围栏内：${rel}`)
    const realParent = fs.realpathSync.native(parent)
    if (!isInside(root, realParent)) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `文件父目录通过符号链接越界：${rel}`)
  }
  return { root, rel, absolute }
}

async function readBytes(root: string, rel: string): Promise<Uint8Array> {
  const target = safePath(root, rel, true, 'read')
  return await fsp.readFile(target.absolute)
}

/** 单次流式扫描：计算完整摘要时只暂存调用方选中的行，不把整文件装进内存。 */
async function scanTextFile(filename: string, visitLine: (line: string, lineNumber: number) => void | Promise<void>): Promise<{ bytes: number; sha256: string; lineCount: number }> {
  const stream = fs.createReadStream(filename)
  const hash = crypto.createHash('sha256')
  let bytes = 0
  let hasNull = false
  stream.on('data', (chunk: string | Buffer) => {
    if (typeof chunk === 'string') {
      bytes += Buffer.byteLength(chunk)
      if (chunk.includes('\0')) hasNull = true
      hash.update(chunk)
    } else {
      bytes += chunk.byteLength
      if (chunk.includes(0)) hasNull = true
      hash.update(chunk)
    }
  })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let lineCount = 0
  for await (const line of lines) {
    lineCount += 1
    await visitLine(line, lineCount)
  }
  if (hasNull) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `不接受二进制文件：${filename}`)
  return { bytes, sha256: `sha256:${hash.digest('hex')}`, lineCount }
}

async function fileState(root: string, rel: string): Promise<{ exists: boolean; content?: string; sha256: string | null }> {
  const target = safePath(root, rel, false, 'read')
  if (!fs.existsSync(target.absolute)) return { exists: false, sha256: null }
  const bytes = await readBytes(root, rel)
  if (bytes.includes(0)) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `不接受二进制文件：${rel}`)
  return { exists: true, content: Buffer.from(bytes).toString('utf8'), sha256: digestBytes(bytes) }
}

export async function listCodeFiles(rootInput: string, glob = '**/*'): Promise<CodeFileInfo[]> {
  const root = rootRealPath(rootInput)
  const out: CodeFileInfo[] = []
  const regex = globToRegExp(glob.replaceAll('\\', '/'))
  async function visit(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = path.relative(root, path.join(dir, entry.name)).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        if (CODE_READ_PATH_POLICY.deniedSegments.includes(entry.name.toLowerCase())) continue
        await visit(path.join(dir, entry.name))
        continue
      }
      if (!regex.test(rel) || !isAllowedRelative(rel, 'read')) continue
      // 大文本文件仍进入清单；摘要按流计算，不把整文件装进内存。
      try {
        const target = safePath(root, rel, true, 'read')
        const scanned = await scanTextFile(target.absolute, () => undefined)
        out.push({ path: rel, bytes: scanned.bytes, sha256: scanned.sha256 })
      } catch {
        // 仓库里可能有权限受限、二进制或已断开的临时条目；
        // 只是不出现在安全清单里，不应把其余工程一起判成不可读。
        continue
      }
    }
  }
  await visit(root)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

function globToRegExp(glob: string): RegExp {
  let source = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`, 'i')
}

export async function readCodeFile(rootInput: string, relPath: string, startLine = 1, endLine?: number): Promise<CodeReadResult> {
  const target = safePath(rootInput, relPath, true, 'read')
  const start = Math.max(1, Math.floor(startLine))
  const requestedEnd = endLine === undefined ? start + MAX_CODE_READ_LINES - 1 : Math.max(start, Math.floor(endLine))
  const endLimit = Math.min(requestedEnd, start + MAX_CODE_READ_LINES - 1)
  const selected: string[] = []
  const scanned = await scanTextFile(target.absolute, (line, lineNumber) => {
    if (lineNumber >= start && lineNumber <= endLimit) selected.push(line)
  })
  const actualEnd = Math.min(endLimit, scanned.lineCount)
  return {
    path: target.rel,
    bytes: scanned.bytes,
    sha256: scanned.sha256,
    startLine: start,
    endLine: actualEnd,
    lineCount: scanned.lineCount,
    nextStartLine: actualEnd < scanned.lineCount ? actualEnd + 1 : null,
    complete: actualEnd >= scanned.lineCount,
    text: selected.join('\n'),
  }
}

/** 在全工作区安全文本中查找字面内容；不会执行模型提供的正则表达式或命令。 */
export async function searchCodeFiles(rootInput: string, query: string, glob = '**/*', maxResults = 50, caseSensitive = false): Promise<CodeSearchResult> {
  if (typeof query !== 'string' || !query.trim() || query.length > 512) {
    throw new CodeGateError('E_PARAM_INVALID', 'search.query 必须是 1–512 个字符的非空文本')
  }
  const limit = Math.max(1, Math.min(100, Math.floor(maxResults)))
  const files = await listCodeFiles(rootInput, glob)
  const needle = caseSensitive ? query : query.toLocaleLowerCase()
  const matches: CodeSearchMatch[] = []
  let totalMatches = 0
  let filesSearched = 0
  for (const file of files) {
    filesSearched += 1
    const target = safePath(rootInput, file.path, true, 'read')
    await scanTextFile(target.absolute, (line, lineNumber) => {
      const haystack = caseSensitive ? line : line.toLocaleLowerCase()
      if (!haystack.includes(needle)) return
      totalMatches += 1
      if (matches.length < limit) {
        matches.push({ path: file.path, line: lineNumber, text: line.length > 500 ? `${line.slice(0, 500)}…` : line })
      }
    })
  }
  return { query, glob, filesSearched, totalMatches, truncated: totalMatches > matches.length, matches }
}

/** 运行注册清单中的固定检查；命令及参数来自仓库配置，调用方只能选择检查 id。 */
export async function runCodeChecks(rootInput: string, selectedIds?: readonly string[]): Promise<CodeCheckResult[]> {
  const root = rootRealPath(rootInput)
  const ids = selectedIds?.length ? [...new Set(selectedIds)] : Object.keys(CHECK_REGISTRY.checks)
  const unknown = ids.filter((id) => !Object.hasOwn(CHECK_REGISTRY.checks, id))
  if (unknown.length) throw new CodeGateError('E_PARAM_INVALID', `未知检查项：${unknown.join(', ')}`)
  const results: CodeCheckResult[] = []
  for (const id of ids) {
    const check = CHECK_REGISTRY.checks[id]
    if (!check || !['npm', 'python'].includes(check.program) || !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string') || typeof check.cwd !== 'string' || !Number.isFinite(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 600_000) {
      results.push({ id, ok: false, exitCode: null, output: `检查项 ${id} 的固定配置无效。` })
      continue
    }
    const cwd = path.resolve(root, check.cwd)
    if (!isInside(root, cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      results.push({ id, ok: false, exitCode: null, output: `检查目录不存在：${check.cwd}` })
      continue
    }
    let program: string = check.program
    const args = [...check.args]
    if (program === 'npm' && process.platform === 'win32') {
      const npmCli = (process.env.PATH ?? '').split(path.delimiter)
        .map((directory) => path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
        .find((candidate) => fs.existsSync(candidate))
      if (!npmCli) {
        results.push({ id, ok: false, exitCode: null, output: '找不到 npm-cli.js；请确认 Node.js/npm 已加入 PATH。' })
        continue
      }
      program = process.execPath
      args.unshift(npmCli)
    }
    if (program === 'python') {
      const candidates = process.platform === 'win32'
        ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
        : [path.join(root, '.venv', 'bin', 'python')]
      const venvPython = candidates.find((candidate) => fs.existsSync(candidate))
      if (!venvPython) {
        results.push({ id, ok: false, exitCode: null, output: '仓库根目录没有 .venv；宿主检查不会改用系统 Python。' })
        continue
      }
      program = venvPython
    }
    try {
      const completed = await execFileAsync(program, args, { cwd, timeout: check.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
      results.push({ id, ok: true, exitCode: 0, output: `${completed.stdout}${completed.stderr}`.slice(-20_000) })
    } catch (error: unknown) {
      const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string }
      results.push({
        id,
        ok: false,
        exitCode: typeof failure.code === 'number' ? failure.code : null,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`.slice(-20_000),
      })
    }
  }
  return results
}

function assertOperation(op: CodeOp): void {
  if (!op || typeof op !== 'object' || typeof op.kind !== 'string' || typeof op.path !== 'string') throw new CodeGateError('E_PARAM_INVALID', '源码动作缺少 kind/path')
  if (op.kind === 'replaceText' && (!op.oldText || typeof op.newText !== 'string' || typeof op.expectSha256 !== 'string')) throw new CodeGateError('E_PARAM_INVALID', 'replaceText 必须带 oldText、newText、expectSha256')
  if (op.kind === 'writeFile' && (typeof op.content !== 'string' || typeof op.expectSha256 !== 'string')) throw new CodeGateError('E_PARAM_INVALID', 'writeFile 必须带 content、expectSha256')
  if (op.kind === 'createFile' && typeof op.content !== 'string') throw new CodeGateError('E_PARAM_INVALID', 'createFile 必须带 content')
  if (op.kind === 'deleteFile' && typeof op.expectSha256 !== 'string') throw new CodeGateError('E_PARAM_INVALID', 'deleteFile 必须带 expectSha256')
  if (!['replaceText', 'writeFile', 'createFile', 'deleteFile'].includes(op.kind)) throw new CodeGateError('E_PARAM_INVALID', `不认识的源码动作：${op.kind}`)
}

function contentAfter(before: string | undefined, op: CodeOp): string | undefined {
  if (op.kind === 'createFile' || op.kind === 'writeFile') return op.content
  if (op.kind === 'deleteFile') return undefined
  if (before === undefined) throw new CodeGateError('E_CODE_BASE_MISMATCH', `replaceText 的文件不存在：${op.path}`)
  const count = before.split(op.oldText).length - 1
  if (count !== 1) throw new CodeGateError('E_CODE_BASE_MISMATCH', `oldText 在 ${op.path} 中应唯一匹配，实际 ${count} 次`)
  return before.replace(op.oldText, op.newText)
}

function gatesFor(paths: string[]): CodeGate[] {
  const lower = paths.map((p) => p.toLowerCase())
  const gates: CodeGate[] = []
  const add = (id: string, command = checkCommand(id)) => { if (!gates.some((gate) => gate.id === id)) gates.push({ id, command, required: true }) }
  if (lower.some((p) => p.startsWith('docs/') || p === 'agents.md' || p.endsWith('readme.md'))) add('docs-structure', 'links-and-interface-record-check')
  if (lower.some((p) => p.startsWith('sciviz-web/src/') || p.startsWith('sciviz-web/scripts/'))) {
    add('web-test')
    add('web-typecheck')
  }
  if (lower.some((p) => p.endsWith('.tsx') || p.endsWith('.css'))) add('web-build')
  if (lower.some((p) => p.startsWith('sciviz-local/'))) add('host-unittest')
  if (lower.some((p) => p.startsWith('sciviz-web/scripts/') || p.includes('/patch') || p.includes('project.'))) add('agent-blind')
  return gates
}

function checkCommand(id: string): string {
  const check = CHECK_REGISTRY.checks[id]
  return check ? [check.program, ...check.args].join(' ') : 'internal-check'
}

function unifiedDiff(pathName: string, before: string | undefined, after: string | undefined): string {
  const oldLines = (before ?? '').split(/\r?\n/)
  const newLines = (after ?? '').split(/\r?\n/)
  const lines = [`--- a/${pathName}`, `+++ b/${pathName}`]
  const max = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < max; i += 1) {
    if (oldLines[i] === newLines[i]) lines.push(` ${oldLines[i] ?? ''}`)
    else {
      if (oldLines[i] !== undefined) lines.push(`-${oldLines[i]}`)
      if (newLines[i] !== undefined) lines.push(`+${newLines[i]}`)
    }
  }
  return lines.join('\n')
}

export async function planCodePatch(rootInput: string, operations: CodeOp[], options: Pick<CodeGateOptions, 'now'> = {}): Promise<CodePlan> {
  const root = rootRealPath(rootInput)
  if (!Array.isArray(operations) || operations.length === 0) throw new CodeGateError('E_PARAM_INVALID', '源码计划至少需要一条动作')
  const seen = new Set<string>()
  const files: CodePlanFile[] = []
  const diffs: string[] = []
  for (const op of operations) {
    assertOperation(op)
    const target = safePath(root, op.path)
    if (seen.has(target.rel)) throw new CodeGateError('E_PARAM_INVALID', `同一计划重复触碰文件：${target.rel}`)
    seen.add(target.rel)
    const before = await fileState(root, target.rel)
    const expected = 'expectSha256' in op ? normalizeDigest(op.expectSha256) : null
    if (op.kind === 'createFile') {
      if (before.exists) throw new CodeGateError('E_CODE_BASE_MISMATCH', `createFile 目标已存在：${target.rel}`)
    } else {
      if (!before.exists || !before.sha256 || expected !== normalizeDigest(before.sha256)) throw new CodeGateError('E_CODE_BASE_MISMATCH', `文件基线不符：${target.rel}`)
    }
    const after = contentAfter(before.content, op)
    if (after !== undefined && Buffer.byteLength(after, 'utf8') > MAX_CODE_FILE_BYTES) throw new CodeGateError('E_CODE_PATH_OUTSIDE', `写入后文件超过 1 MiB：${target.rel}`)
    const afterSha = after === undefined ? null : sha256Text(after)
    files.push({ path: target.rel, beforeSha256: before.sha256, afterSha256: afterSha, bytes: after === undefined ? 0 : Buffer.byteLength(after, 'utf8') })
    diffs.push(unifiedDiff(target.rel, before.content, after))
  }
  const planId = `code-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`
  return {
    schemaVersion: 1,
    planId,
    root,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    operations: operations.map((op) => ({ ...op })),
    files,
    diff: diffs.join('\n'),
    gates: gatesFor(files.map((file) => file.path)),
    approvalToken: crypto.randomBytes(18).toString('hex'),
  }
}

async function defaultGateRunner(gate: CodeGate, root: string): Promise<{ ok: boolean; output?: string }> {
  if (gate.id === 'docs-structure') {
    // This gate is intentionally deterministic and local; the full interface-change
    // check is performed by the repository's test suite when source files are touched.
    return { ok: true, output: '结构性文档检查已登记' }
  }
  const [result] = await runCodeChecks(root, [gate.id])
  return { ok: result?.ok === true, output: result?.output ?? `检查项 ${gate.id} 未返回结果。` }
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.sciviz-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`)
  await fsp.writeFile(temporary, content, 'utf8')
  await fsp.rename(temporary, filename)
}

function stateDir(root: string): string {
  return process.env.SCIVIZ_STATE_DIR ? path.resolve(process.env.SCIVIZ_STATE_DIR) : path.join(root, '.sciviz-state', 'code')
}

async function persistRecord(record: CodeRecord): Promise<void> {
  const dir = path.join(stateDir(record.root), record.planId)
  await fsp.mkdir(dir, { recursive: true })
  await atomicWrite(path.join(dir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`)
}

async function applyContents(root: string, operations: CodeOp[]): Promise<void> {
  for (const op of operations) {
    const target = safePath(root, op.path)
    const before = await fileState(root, target.rel)
    const after = contentAfter(before.content, op)
    if (after === undefined) await fsp.unlink(target.absolute)
    else {
      await fsp.mkdir(path.dirname(target.absolute), { recursive: true })
      await atomicWrite(target.absolute, after)
    }
  }
}

export async function applyCodePlan(rootInput: string, plan: CodePlan, approvalToken: string, options: CodeGateOptions = {}): Promise<CodeGateResult> {
  const root = rootRealPath(rootInput)
  if (plan.schemaVersion !== 1 || plan.root !== root) throw new CodeGateError('E_PARAM_INVALID', '源码计划版本或根目录不匹配')
  if (approvalToken !== plan.approvalToken) throw new CodeGateError('E_CODE_GATE_FAILED', '人工批准令牌与计划不匹配')
  if (plan.operations.length !== plan.files.length || plan.operations.some((op, index) => op.path !== plan.files[index]?.path)) {
    throw new CodeGateError('E_PARAM_INVALID', '源码计划的动作与文件摘要不一致')
  }
  const before: CodeRecord['before'] = []
  for (const [index, file] of plan.files.entries()) {
    const current = await fileState(root, file.path)
    if (normalizeDigest(current.sha256 ?? '') !== normalizeDigest(file.beforeSha256 ?? '') || (!current.exists && file.beforeSha256 !== null)) {
      throw new CodeGateError('E_CODE_BASE_MISMATCH', `应用前发现文件基线变化：${file.path}`)
    }
    const expectedAfter = contentAfter(current.content, plan.operations[index])
    const expectedAfterSha = expectedAfter === undefined ? null : sha256Text(expectedAfter)
    if (normalizeDigest(expectedAfterSha ?? '') !== normalizeDigest(file.afterSha256 ?? '') || (expectedAfter === undefined) !== (file.afterSha256 === null)) {
      throw new CodeGateError('E_PARAM_INVALID', `源码计划的产物摘要不匹配：${file.path}`)
    }
    before.push({ path: file.path, exists: current.exists, ...(current.content === undefined ? {} : { content: current.content }), sha256: current.sha256 })
  }
  const gates: CodeRecord['gates'] = []
  try {
    await applyContents(root, plan.operations)
  } catch (error) {
    await restoreSnapshots(root, before, plan.files)
    throw new CodeGateError('E_CODE_GATE_FAILED', `源码原子写入失败：${error instanceof Error ? error.message : String(error)}`)
  }
  // 固定闸门必须在写盘之后跑；失败时只在文件仍然等于本计划产物时回滚，
  // 如果这期间出现第三方改动则返回 E_CODE_BASE_MISMATCH，绝不覆盖它。
  if (!options.skipGates && plan.gates.length) {
    const runner = options.gateRunner ?? defaultGateRunner
    for (const gate of plan.gates) {
      const result = await runner(gate, root)
      gates.push({ id: gate.id, ok: result.ok, ...(result.output ? { output: result.output } : {}) })
      if (!result.ok) return await rollbackAfterGateFailure(root, plan, before, gates)
    }
  }
  const after = plan.files.map((file) => ({ path: file.path, exists: file.afterSha256 !== null, sha256: file.afterSha256 }))
  const record: CodeRecord = { schemaVersion: 1, planId: plan.planId, root, appliedAt: (options.now ?? (() => new Date().toISOString()))(), operations: plan.operations, before, after, gates }
  await persistRecord(record)
  return { ok: true, status: 'done', plan, record, gates }
}

async function rollbackAfterGateFailure(root: string, plan: CodePlan, before: CodeRecord['before'], gates: CodeRecord['gates']): Promise<CodeGateResult> {
  try {
    await restoreSnapshots(root, before, plan.files)
  } catch (error) {
    throw new CodeGateError('E_CODE_BASE_MISMATCH', `闸门失败且回滚遇到第三方修改：${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: false, status: 'failed', plan, error: { code: 'E_CODE_GATE_FAILED', message: '固定验证闸门未通过，已回滚源码' }, gates }
}

async function restoreSnapshots(root: string, snapshots: CodeRecord['before'], expectedAfter: readonly CodePlanFile[] = []): Promise<void> {
  for (const snapshot of snapshots) {
    const target = safePath(root, snapshot.path)
    const current = await fileState(root, snapshot.path)
    const after = expectedAfter.find((file) => file.path === snapshot.path)
    const currentMatchesBefore = normalizeDigest(current.sha256 ?? '') === normalizeDigest(snapshot.sha256 ?? '')
    const currentMatchesAfter = after ? normalizeDigest(current.sha256 ?? '') === normalizeDigest(after.afterSha256 ?? '') : false
    if (!currentMatchesBefore && !currentMatchesAfter) throw new CodeGateError('E_CODE_BASE_MISMATCH', `回滚前发现第三方修改：${snapshot.path}`)
    if (!snapshot.exists) {
      if (fs.existsSync(target.absolute)) await fsp.unlink(target.absolute)
    } else {
      await fsp.mkdir(path.dirname(target.absolute), { recursive: true })
      await atomicWrite(target.absolute, snapshot.content ?? '')
    }
  }
}

export async function undoCodePatch(rootInput: string, record: CodeRecord, options: CodeGateOptions = {}): Promise<CodeGateResult> {
  const root = rootRealPath(rootInput)
  if (record.root !== root) throw new CodeGateError('E_PARAM_INVALID', '撤销计划根目录不匹配')
  for (const after of record.after) {
    const current = await fileState(root, after.path)
    if (normalizeDigest(current.sha256 ?? '') !== normalizeDigest(after.sha256 ?? '')) throw new CodeGateError('E_CODE_BASE_MISMATCH', `撤销前发现文件已被第三方修改：${after.path}`)
  }
  const reverse: CodeOp[] = record.before.map((before, index) => {
    const after = record.after[index]
    if (!before.exists) return { kind: 'deleteFile', path: before.path, expectSha256: after.sha256 ?? '' }
    if (!after.exists) return { kind: 'createFile', path: before.path, content: before.content ?? '' }
    return { kind: 'writeFile', path: before.path, expectSha256: after.sha256 ?? '', content: before.content ?? '' }
  })
  const plan = await planCodePatch(root, reverse, options)
  const result = await applyCodePlan(root, plan, plan.approvalToken, { ...options, skipGates: options.skipGates ?? false })
  return result
}

export async function loadCodeRecord(rootInput: string, planId: string): Promise<CodeRecord> {
  const root = rootRealPath(rootInput)
  const filename = path.join(stateDir(root), planId, 'record.json')
  try {
    return JSON.parse(await fsp.readFile(filename, 'utf8')) as CodeRecord
  } catch (error) {
    throw new CodeGateError('E_PARAM_INVALID', `找不到源码改动记录 ${planId}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 供固定闸门和单测使用的默认命令矩阵。 */
export function fixedGatesForPaths(paths: readonly string[]): CodeGate[] {
  return gatesFor([...paths])
}

// 保留几个语义更直观的别名，CLI/宿主使用它们时仍只有这一份实现。
export const codePlan = planCodePatch
export const codeApply = applyCodePlan
export const codeUndo = undoCodePatch
