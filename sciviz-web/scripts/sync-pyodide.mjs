/**
 * 把 Pyodide 运行时同步到 public/pyodide/。
 *
 * 为什么需要这一步：
 * 1. npm 包里只有解释器核心；numpy / pandas 这类包是运行时按需下载的，默认去 CDN 取。
 *    本工具最终要离线交付，不能依赖网络。
 * 2. 核心 wasm 接近 10MB，不该进 git。
 *
 * 所以：核心从 node_modules 拷，包从同版本 CDN 拉（已存在就跳过，天然带缓存），
 * 产物落在 public/pyodide/ 并已 gitignore。
 *
 * 用法：node scripts/sync-pyodide.mjs
 */
import { createRequire } from 'node:module'
import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'node_modules', 'pyodide')
const outDir = join(root, 'public', 'pyodide')

/** 核心文件：解释器本体 + stdlib + 锁文件。锁文件必须一起拷，包名到文件名的映射在里面 */
const CORE_FILES = [
  'pyodide.asm.wasm',
  'pyodide.asm.mjs',
  'python_stdlib.zip',
  'pyodide.mjs',
  'pyodide-lock.json',
]

/**
 * 需要一并拉下来的包，依赖会自动展开。
 *
 * 清单不写在这里，而是读 pyodide-packages.json —— 因为浏览器那边的
 * engineWorker 也要按同一份清单 loadPackage，两处各写一份就是两处真相：
 * 一处加了包、另一处忘了加，表现是"本地能跑、浏览器报 ModuleNotFoundError"。
 */
const WANTED_PACKAGES = JSON.parse(
  await readFile(join(root, 'pyodide-packages.json'), 'utf8'),
)

const exists = async (p) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 展开包的传递依赖（DFS，去环） */
function resolvePackages(lock, roots) {
  const out = new Set()
  const visit = (name) => {
    if (out.has(name)) return
    const pkg = lock.packages[name]
    if (!pkg) throw new Error(`pyodide-lock.json 里没有包：${name}`)
    out.add(name)
    for (const dep of pkg.depends ?? []) visit(dep)
  }
  for (const r of roots) visit(r)
  return [...out]
}

async function main() {
  const version = require(join(srcDir, 'package.json')).version
  const baseUrl = `https://cdn.jsdelivr.net/pyodide/v${version}/full/`

  await mkdir(outDir, { recursive: true })

  for (const name of CORE_FILES) {
    const dst = join(outDir, name)
    if (await exists(dst)) {
      console.log(`  跳过 ${name}（已存在）`)
      continue
    }
    await copyFile(join(srcDir, name), dst)
    console.log(`  拷贝 ${name}`)
  }

  const lock = JSON.parse(await readFile(join(srcDir, 'pyodide-lock.json'), 'utf8'))
  const wanted = resolvePackages(lock, WANTED_PACKAGES)
  console.log(`Pyodide ${version}，需要 ${wanted.length} 个包：${wanted.join(', ')}`)

  for (const name of wanted) {
    const fileName = lock.packages[name].file_name
    const dst = join(outDir, fileName)
    if (await exists(dst)) {
      console.log(`  跳过 ${fileName}（已存在）`)
      continue
    }
    const url = baseUrl + fileName
    const res = await fetch(url)
    if (!res.ok) throw new Error(`下载失败 ${url}：${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await writeFile(dst, buf)
    console.log(`  下载 ${fileName}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`)
  }

  console.log(`\n完成：${outDir}`)
  console.log('注意：产物不进 git（见 .gitignore），换机器后重跑本脚本即可。')
}

main().catch((err) => {
  console.error('\n同步失败：', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
