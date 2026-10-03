/** 对话栏/MCP 的轻量结构机检（C4）。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pureFiles = ['src/agent/context.ts', 'src/agent/prompt.ts', 'src/agent/session.ts', 'src/agent/tools.ts', 'src/agent/replay.ts', 'src/agent/sessionLog.ts']
const forbiddenImport = /from\s+['"](?:react|zustand|node:fs|node:fs\/promises|node:child_process|node:worker_threads|pyodide)|import\s+['"](?:react|zustand|node:fs|node:fs\/promises|node:child_process|node:worker_threads|pyodide)/
for (const relative of pureFiles) {
  const text = fs.readFileSync(path.join(root, relative), 'utf8')
  if (forbiddenImport.test(text)) throw new Error(`${relative} 引入了纯逻辑层禁止的依赖`)
}
const prompt = fs.readFileSync(path.join(root, 'src/agent/prompt.ts'), 'utf8')
if (/\bE_[A-Z0-9_]+\b|\b(?:train|data)\.[a-zA-Z0-9_]+/.test(prompt)) throw new Error('常驻提示词出现会漂移的错误码/算子事实')
const tools = fs.readFileSync(path.join(root, 'src/agent/tools.ts'), 'utf8')
const names = [...tools.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1])
if (new Set(names).size !== names.length) throw new Error('工具注册表有重复名称')
if (!names.includes('sciviz_code')) throw new Error('工具注册表缺少源码工具')
const mcp = fs.readFileSync(path.join(root, 'scripts/sciviz-mcp.mjs'), 'utf8')
for (const match of mcp.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
  const source = match[1]
  if (!(source.startsWith('node:') || source === './sciviz.mjs' || source === '../src/agent/tools.ts')) throw new Error(`MCP 壳引入了非白名单模块：${source}`)
}
process.stdout.write('agent static checks passed\n')
