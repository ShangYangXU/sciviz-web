/**
 * 共享算子的依赖边界检查。
 *
 * 规则（2026-09-13 定）：`src/engine/python/` 下的算子要**同时**在浏览器（Pyodide）
 * 和本地宿主（.venv）里跑，所以它们只能 import **Pyodide 里有的**库。
 *
 * 边界不是拍脑袋定的，是查出来的：判定依据就是 pyodide-lock.json 里那 356 个包。
 * 这样规则可以机器检查，而不是靠谁记得住。
 *
 * 不在表里的库（torch 是典型）不是"不许用"，而是"只能用在宿主专属算子里"——
 * 见 sciviz-local/sciviz_host/gpu_ops.py。
 *
 * 为什么要在 npm test 里跑：这个错误的症状是"本地跑得好好的、浏览器里炸"，
 * 而写代码的人九成时间在跑本地。等发现时，已经有一批图依赖了它。
 *
 * 用法：node scripts/check-shared-operator-deps.mjs
 *       node scripts/check-shared-operator-deps.mjs --self-test
 * 退出码：0 通过 / 1 越界 / 2 检查本身没跑起来
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const operatorDir = join(root, 'src', 'engine', 'python')
const lockPath = join(root, 'node_modules', 'pyodide', 'pyodide-lock.json')

/**
 * 标准库白名单。
 *
 * 刻意**不**把 `sys.stdlib_module_names` 整份抄进来：Pyodide 跑的是另一个 Python 版本
 * （cp314），抄一份 3.12 的名单反而会漏。这里只列本项目真会用到的，缺了就在报错里
 * 提示补一行 —— 失败信息里会直说"这是标准库的话把它加进 STDLIB"。
 */
const STDLIB = new Set([
  '__future__', 'abc', 'array', 'base64', 'bisect', 'collections', 'contextlib', 'copy', 'csv',
  'dataclasses', 'datetime', 'decimal', 'enum', 'functools', 'glob', 'hashlib', 'heapq',
  'io', 'itertools', 'json', 'logging', 'math', 'numbers', 'operator', 'os', 'pathlib',
  'pickle', 'platform', 'queue', 'random', 're', 'shutil', 'statistics', 'string',
  'struct', 'sys', 'tempfile', 'textwrap', 'threading', 'time', 'traceback', 'types',
  'typing', 'unicodedata', 'uuid', 'warnings', 'weakref',
])

/** 同目录里互相 import 的本地模块，不算外部依赖 */
const LOCAL = new Set(['runtime', 'operators'])

const IMPORT_RE = /^\s*(?:import\s+([A-Za-z_][\w.]*)|from\s+([A-Za-z_][\w.]*)\s+import)/gm

function rootModuleOf(name) {
  return name.split('.')[0]
}

/** 扫一份源码，返回越界的依赖。抽出来是为了能自测 —— 见 --self-test */
function scan(source, available) {
  const hits = []
  const used = new Set()
  for (const match of source.matchAll(IMPORT_RE)) {
    const name = rootModuleOf(match[1] ?? match[2])
    if (LOCAL.has(name) || STDLIB.has(name)) continue
    used.add(name)
    if (available.has(name)) continue
    hits.push({ line: source.slice(0, match.index).split('\n').length, name })
  }
  return { hits, used }
}

/**
 * 自测：确认这个检查**真的会失败**。
 *
 * 一个永远通过的检查比没有检查更糟 —— 它会让人以为边界已经被守住了。
 * 所以这里用几段写死的源码把"拦住 / 放行"两条路都走一遍。
 */
function selfTest() {
  const available = new Set(['scipy', 'sklearn', 'numpy'])
  const cases = [
    { source: 'import torch\n', shouldFlag: true },
    { source: 'def op():\n    import torch\n', shouldFlag: true },
    { source: 'import scipy.signal as sig\n', shouldFlag: false },
    { source: 'from sklearn.linear_model import Ridge\n', shouldFlag: false },
    { source: 'import base64, json, math\nimport runtime\n', shouldFlag: false },
  ]
  for (const [index, testCase] of cases.entries()) {
    const { hits } = scan(testCase.source, available)
    const flagged = hits.length > 0
    if (flagged !== testCase.shouldFlag) {
      console.error(`自测第 ${index + 1} 条不通过：期望 ${testCase.shouldFlag}，实际 ${flagged}`)
      process.exit(1)
    }
  }
  console.log(`检查器自测通过（${cases.length} 条：含 torch 该拦、scipy 该放行）`)
}

async function pyodideModules() {
  let lock
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (err) {
    console.error(`读不到 ${lockPath}：${err.message}`)
    console.error('先跑 npm install（判定边界要用 Pyodide 自己的包表，不能靠猜）。')
    process.exit(2)
  }
  const modules = new Set()
  for (const pkg of Object.values(lock.packages)) {
    for (const name of pkg.imports ?? []) modules.add(rootModuleOf(name))
  }
  return modules
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }

  const available = await pyodideModules()
  const files = (await readdir(operatorDir)).filter((f) => f.endsWith('.py'))

  const violations = []
  const used = new Set()

  for (const file of files) {
    const source = await readFile(join(operatorDir, file), 'utf8')
    const result = scan(source, available)
    for (const name of result.used) used.add(name)
    for (const hit of result.hits) violations.push({ file, ...hit })
  }

  if (violations.length > 0) {
    console.error('共享算子的依赖越界了。\n')
    console.error('共享算子要同时在浏览器（Pyodide）和本地宿主里跑，只能用 Pyodide 里有的库。\n')
    for (const v of violations) {
      console.error(`  src/engine/python/${v.file}:${v.line}  import ${v.name}`)
    }
    console.error('\n两条出路：')
    console.error('  1. 换一个 Pyodide 里有的库（catalog 与 pyodide-lock.json 可查）；')
    console.error('  2. 需要它就别放共享算子 —— 移到 sciviz-local/sciviz_host/gpu_ops.py，')
    console.error('     由本地适配器声明这项能力（torch 就是这么处理的）。')
    console.error('\n如果上面某个其实是标准库，把它加进本脚本的 STDLIB 列表。')
    process.exit(1)
  }

  const list = [...used].sort().join('、') || '（只有 numpy / pandas）'
  console.log(`共享算子依赖检查通过：${files.length} 个文件，用到 ${list}`)
}

await main()
