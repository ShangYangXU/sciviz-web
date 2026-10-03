/**
 * 生成 `src/contract/operatorHashes.generated.ts`：算子实现的哈希。
 *
 * 为什么必须有这个东西：`nodeFingerprint` 原先只由「节点类型 + 参数 + 上游版本号 +
 * 数据源列签名」组成，**不含算子实现**。于是改一次 `operators.py`，图里已算出的节点
 * 指纹不变，界面继续把旧结果显示为"最新" —— 同图、同参数、不同结果，而系统不报警。
 * 对一个以可复现为卖点的项目，这是最不能留的一类缺陷。
 *
 * 哈希怎么算：
 * - **每个算子一个哈希**：它的函数体源码（规范化行尾与行尾空白之后）。
 * - **再叠一层模块上下文哈希**：文件里函数体之外的部分（imports、模块级常量）。
 *   常量变了（比如 `TIME_STATS_ALL` 少了一项）会改变所有算子的结果，所以它必须
 *   让所有算子一起失效 —— 宁可多失效，也不能少失效。
 * - 刻意**排除** `OPERATORS = {...}` 那段：新增一个算子不该让其余算子全部重算。
 *
 * 生成物要进版本库，并由 `src/contract/operatorHashes.test.ts` 守着 ——
 * 改了算子源码却忘了重跑本脚本，`npm test` 会失败。
 *
 * 用法：node scripts/gen-operator-hashes.mjs [--check]
 *       --check 只校验是否最新，不写文件（CI / 测试用）
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(webRoot, '..')

/** 算子的唯一实现分布在这两个文件里；共享与宿主专属的都在 */
const SOURCES = [
  join(webRoot, 'src', 'engine', 'python', 'operators.py'),
  join(repoRoot, 'sciviz-local', 'sciviz_host', 'gpu_ops.py'),
]

export const OUTPUT_PATH = join(webRoot, 'src', 'contract', 'operatorHashes.generated.ts')

/**
 * 归一化：把"不影响结果的东西"从哈希里剔掉。
 *
 * 剔掉的是三类：**行尾（CRLF）**、**整行注释**、**连续空行**。
 *
 * 前两类在 Windows 检出与日常改注释时天天出现；第三类在"新增一个算子函数"时必然出现。
 * 不剔的话，改一句注释就会让整个文件的算子一起失效 —— 每次都要重新生成、diff 一大片，
 * 人就会开始忽略这个信号。**一个总在响的警报等于没有警报**，这比多算几遍贵得多。
 *
 * 已知的窄口子：三引号字符串里顶格写的 `#` 行也会被当成注释。那种写法在本仓库没有，
 * 且后果只是"那一行的改动不会让谁重算"。
 */
function normalize(text) {
  const kept = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/, '')
    if (/^\s*#/.test(line)) continue
    if (line === '' && kept[kept.length - 1] === '') continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 极简的 Python 顶层结构解析。
 *
 * 只做三件事，够用就行：找出每个顶层 `def` 的范围、找出 `OPERATORS = {...}` 的范围、
 * 剩下的就是模块上下文。刻意不引 Python 解析器 —— 这个脚本要在没有 Python 的
 * 环境里也能跑（CI 只装 Node 是最省事的）。
 *
 * 依赖该文件的书写风格：函数体一律缩进，顶层语句一律顶格。这个仓库的算子文件
 * 一直是这样，且由本脚本的测试守着（解析不出任何算子就报错，而不是静默生成空表）。
 */
function parseModule(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const ranges = []

  const defStarts = []
  lines.forEach((line, index) => {
    const match = /^def\s+(\w+)\s*\(/.exec(line)
    if (match) defStarts.push({ index, name: match[1] })
  })

  defStarts.forEach((def, order) => {
    let end = order + 1 < defStarts.length ? defStarts[order + 1].index : lines.length
    // 顶格的赋值（模块级常量）也算函数结束 —— 它在 `def` 之后出现时
    for (let i = def.index + 1; i < end; i++) {
      if (/^[A-Za-z_]\w*\s*=/.test(lines[i])) {
        end = i
        break
      }
    }
    ranges.push({ name: def.name, start: def.index, end })
  })

  const operatorsStart = lines.findIndex((line) => /^OPERATORS\s*=\s*\{/.test(line))
  let operatorsEnd = lines.length
  if (operatorsStart >= 0) {
    operatorsEnd = lines.findIndex((line, index) => index > operatorsStart && /^\}/.test(line))
    operatorsEnd = operatorsEnd < 0 ? lines.length : operatorsEnd + 1
    ranges.push({ name: null, start: operatorsStart, end: operatorsEnd })
  }

  const masked = [...lines]
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++) masked[i] = ''
  }

  const functions = new Map()
  for (const range of ranges) {
    if (!range.name) continue
    functions.set(range.name, normalize(lines.slice(range.start, range.end).join('\n')))
  }

  const mapping = new Map()
  if (operatorsStart >= 0) {
    for (let i = operatorsStart; i < operatorsEnd; i++) {
      // 表里长得像条目的行，必须先数出来 —— 解析不动它就要报错，不能跳过。
      // 曾经只认 `[\w.]+`：带连字符的节点类型（feature.scale-apply、feature.scale-fit）
      // 会被**静默丢掉**，于是那个算子的实现哈希根本不存在，改了实现指纹也不变 ——
      // 这一整套哈希存在的唯一理由就是防这件事，静默漏掉比没有更糟。
      const looksLikeEntry = /^\s*['"][^'"]+['"]\s*:/.test(lines[i])
      const match = /^\s*['"]([^'"]+)['"]\s*:\s*(\w+)\s*,/.exec(lines[i])
      if (looksLikeEntry && !match) {
        throw new Error(
          `OPERATORS 表里有一行认不出来，却被跳过了：${lines[i].trim()}\n` +
            '认不出来就等于这个算子没有实现哈希 —— 改了它的实现，指纹不会变，下游不会重算。',
        )
      }
      if (match) mapping.set(match[1], match[2])
    }
  }

  return { functions, mapping, moduleContext: normalize(masked.join('\n')) }
}

/**
 * 从一份 Python 源码算出它的算子哈希。抽出来是为了测试能喂合成源码 ——
 * "改了函数体哈希会变""只增删 OPERATORS 表哈希不变"这两条必须能被直接验证，
 * 而不是靠人去信这段解析逻辑。
 */
export function hashOperatorsFromSource(text) {
  const { functions, mapping, moduleContext } = parseModule(text)
  if (mapping.size === 0) {
    throw new Error('这份源码里没有解析出任何算子（OPERATORS 表为空或格式变了）')
  }
  // 模块上下文进每一个算子：常量变了，所有算子都要失效
  const contextHash = sha256(moduleContext)
  const hashes = {}
  for (const [type, fnName] of mapping) {
    const body = functions.get(fnName)
    if (!body) throw new Error(`找不到算子函数 ${fnName}（节点类型 ${type}）`)
    hashes[type] = sha256(`${contextHash}\n${body}`)
  }
  return { hashes, contextHash }
}

/** 算出全部算子的实现哈希：{ 节点类型: 哈希 }，外加每个源文件的模块上下文哈希 */
export async function computeOperatorHashes() {
  const hashes = {}
  const moduleHashes = {}

  for (const path of SOURCES) {
    const text = await readFile(path, 'utf8')
    const { hashes: fromFile, contextHash } = hashOperatorsFromSource(text)
    Object.assign(hashes, fromFile)
    moduleHashes[path.slice(repoRoot.length + 1).replace(/\\/g, '/')] = contextHash
  }

  return {
    hashes,
    moduleHashes,
    sources: SOURCES.map((p) => p.slice(repoRoot.length + 1).replace(/\\/g, '/')),
  }
}

/** 渲染成 TypeScript。抽出来是为了测试能比对"文件是不是最新" */
export function render(computed) {
  const sorted = Object.entries(computed.hashes).sort(([a], [b]) => (a < b ? -1 : 1))
  const rows = sorted.map(([type, hash]) => `  '${type}':\n    '${hash}',`).join('\n')
  const modules = Object.entries(computed.moduleHashes)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, hash]) => `  '${file}': '${hash}',`)
    .join('\n')
  const sources = computed.sources.map((s) => `  '${s}',`).join('\n')

  return `/**
 * 算子实现的哈希 —— **由 scripts/gen-operator-hashes.mjs 生成，不要手改**。
 *
 * 它进 \`nodeFingerprint\`。没有它，改一次算子实现，图里已算出的节点指纹不变，
 * 界面会继续把旧结果显示为"最新" —— 同图、同参数、不同结果，而系统不报警。
 *
 * 哈希的构成：函数的源码 + 该文件的模块上下文（imports 与模块级常量）。
 * 所以改常量会让同一文件里的算子**一起**失效 —— 宁可多失效，不能少失效。
 * 新增算子不改变已有算子的哈希（OPERATORS 表本身不进哈希）。
 *
 * 重新生成：\`node scripts/gen-operator-hashes.mjs\`
 * 忘了重新生成会让 \`npm test\` 失败（见 operatorHashes.test.ts），不会静默过期。
 */

/** 节点类型 → 实现哈希。查不到的（函数节点、自建模块）取空串 */
export const OPERATOR_IMPLEMENTATION_HASHES: Record<string, string> = {
${rows}
}

/**
 * 源文件 → 模块上下文哈希。
 * 算子哈希由它和函数体一起算出，所以这一项变了，那个文件里所有算子都会变。
 * 排障时先看它：能一眼分清"是函数改了"还是"是常量改了"。
 */
export const OPERATOR_MODULE_CONTEXT_HASHES: Record<string, string> = {
${modules}
}

/** 生成时读了哪些文件。换路径时这份清单跟着变，便于看出哈希为何整体变了 */
export const OPERATOR_HASH_SOURCES: string[] = [
${sources}
]
`
}

export async function generate() {
  return render(await computeOperatorHashes())
}

// 用 pathToFileURL 比手工拼字符串稳：Windows 上的盘符与中文路径都要靠它才对
// （AGENTS.md §6 记过同一个坑：绝对路径必须以 file:// URL 传给动态 import）
const invokedDirectly = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false

if (invokedDirectly) {
  const checkOnly = process.argv.includes('--check')
  const next = await generate()
  if (checkOnly) {
    const current = await readFile(OUTPUT_PATH, 'utf8').catch(() => '')
    if (current !== next) {
      console.error('算子哈希不是最新的。跑：node scripts/gen-operator-hashes.mjs')
      process.exit(1)
    }
    console.log('算子哈希是最新的')
  } else {
    await writeFile(OUTPUT_PATH, next, 'utf8')
    const { hashes } = await computeOperatorHashes()
    console.log(`写入 ${OUTPUT_PATH.slice(repoRoot.length + 1)}：${Object.keys(hashes).length} 个算子`)
  }
}
