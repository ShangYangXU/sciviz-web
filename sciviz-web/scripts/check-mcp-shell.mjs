/** MCP M1/M2 机检：壳只转发 CLI，并从共享注册表取工具集合。 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const shell = fs.readFileSync(path.join(root, 'scripts', 'sciviz-mcp.mjs'), 'utf8')
for (const match of shell.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
  const source = match[1]
  if (!(source.startsWith('node:') || source === './sciviz.mjs' || source === '../src/agent/tools.ts')) throw new Error(`MCP 壳引入了第二执行面：${source}`)
}
if (!shell.includes("toolsForSurface('mcp')")) throw new Error('MCP 壳没有从共享 ToolSpec 取工具集合')
if (/EXPECTED_TOOLS|sciviz_code/.test(shell)) throw new Error('MCP 壳复制了工具清单或暴露了 chat-only 源码工具')
if (!shell.includes('runCli')) throw new Error('MCP 壳没有转发到 runCli')
process.stdout.write('mcp shell checks passed\n')
