/**
 * sciviz —— agent 面的命令行入口（G0 骨架）。
 *
 * 存在的意义：把"读懂契约 → 校验图 → 拿到修复建议"这三件事从浏览器里拿出来。
 * 在此之前，agent 想验证任何东西都只能驱动 DOM（见 scripts/e2e.mjs）。
 *
 * 用法：
 *   npm run sciviz -- catalog [算子类型] [--json]
 *   npm run sciviz -- validate <文件.yaml> [--json] [--columns 名=列1,列2 ...] [--time 名=列]
 *   npm run sciviz -- plan <文件.yaml> [--data 名=文件.csv ...] [--json]
 *   npm run sciviz -- run <文件.yaml> --data 名=文件.csv [--out 目录] [--json]
   *   npm run sciviz -- doctor [--host 地址] [--json]
 *   npm run sciviz -- canvas --action status|new|inspect|patch|undo|run|screenshot [--host 地址] [--json]
 *   npm run sciviz -- explain <错误码> [--json]
 *   npm run sciviz -- explain --list
 *
 * 退出码（写成约定，agent 与 CI 都按它判断）：
 *   0  通过
 *   1  工程本身有问题（校验发现了 E_ 级错误）
 *   2  调用方用错了（子命令/参数不对、文件读不出来）
 *
 * 输出分工：给人读的报告走 stdout；`--json` 时 stdout 是**纯 JSON**，没有任何装饰，
 * 这样 `... --json | jq` 与 `JSON.parse(stdout)` 都能用。错误走 stderr。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')

/* Windows 上动态 import 必须给 file:// URL —— 直接传 "E:\..." 会被当成协议 e:
   （这个坑只在本机出现，Linux/macOS 上两种写法都"恰好"能跑，所以很容易漏） */
const mod = (...parts) => pathToFileURL(path.join(SRC, ...parts)).href

/* 动态 import 而不是顶层 import：这样即使某个模块在 Node 里初始化失败，
   也能给出一行说得清的报错，而不是一个 ERR_MODULE_NOT_FOUND 堆栈 */
const load = async () => {
  const [catalogMod, validateMod, errorMod, planMod, yamlMod, registryMod, yamlLib, runMod, projectMod, hostMod, patchMod, projectFileMod, fixtureMod, inspectionMod, codeMod, replayMod, defaultWorkflowMod, reportMod, canvasInspectionMod, contextMod, pagingMod, fingerprintMod] = await Promise.all([
    import(mod('contract', 'catalog.ts')),
    import(mod('contract', 'validate.ts')),
    import(mod('contract', 'errorCodes.ts')),
    import(mod('engine', 'plan.ts')),
    import(mod('workflow', 'yaml.ts')),
    import(mod('workflow', 'nodeRegistry.ts')),
    import('yaml'),
    import(mod('agent', 'run.ts')),
    import(mod('agent', 'project.ts')),
    import(mod('agent', 'hostAdapter.ts')),
    import(mod('kernel', 'patch.ts')),
    import(mod('workflow', 'project.ts')),
    import(mod('contract', 'truthFixtures.ts')),
    import(mod('agent', 'inspection.ts')),
    import(mod('agent', 'code.ts')),
    import(mod('agent', 'replay.ts')),
    import(mod('workflow', 'defaultWorkflow.ts')),
    import(mod('workflow', 'report.ts')),
    import(mod('agent', 'canvasInspection.ts')),
    import(mod('agent', 'context.ts')),
    import(mod('agent', 'inspectionPaging.ts')),
    import(mod('kernel', 'editFingerprint.ts')),
  ])
  return {
    catalogMod,
    validateMod,
    errorMod,
    planMod,
    yamlMod,
    registryMod,
    yamlLib,
    runMod,
    projectMod,
    hostMod,
    patchMod,
    projectFileMod,
    fixtureMod,
    inspectionMod,
    codeMod,
    replayMod,
    defaultWorkflowMod,
    reportMod,
    canvasInspectionMod,
    contextMod,
    pagingMod,
    fingerprintMod,
  }
}

const EXIT_OK = 0
const EXIT_ISSUES = 1
const EXIT_USAGE = 2

function die(message, code = EXIT_USAGE) {
  throw Object.assign(new Error(message), { cliCode: code, cliMessage: message })
}

/** 极简参数解析：支持 --flag、--key=value、--key value、可重复的 --key */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq >= 0) {
      const key = token.slice(2, eq)
      ;(flags[key] ??= []).push(token.slice(eq + 1))
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      ;(flags[key] ??= []).push(next)
      i += 1
    } else {
      ;(flags[key] ??= []).push('true')
    }
  }
  return { positional, flags }
}

const hasFlag = (flags, name) => flags[name] !== undefined && flags[name].at(-1) !== 'false'
const lastFlag = (flags, name) => flags[name]?.at(-1)

const printJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

/**
 * 长任务的进度打到 stderr。**过程量不进报告，也不进运行清单** ——
 * 那里只放"算完了什么"；一份清单里夹进几十行百分比就没人读了。
 *
 * 节流按"整 5%"走：宿主报得比这密得多（它按 batch 报、自己节流到 ~4/s），
 * 终端里每一格都打一遍，用户真正要找的那些行会被冲走。
 */
function nodeProgressReporter(json) {
  const shown = new Map()
  return (nodeId, ratio, message) => {
    if (json) return
    const pct = Math.round(ratio * 100)
    const last = shown.get(nodeId)
    if (!message && last !== undefined && pct - last < 5) return
    shown.set(nodeId, pct)
    process.stderr.write(`  ↻ ${nodeId} ${pct}%${message ? ` · ${message}` : ''}\n`)
  }
}

/* ------------------------------------------------------------------ */
/* catalog                                                             */
/* ------------------------------------------------------------------ */

function buildCatalog(mods) {
  // 不再注入"这个算子归谁算"：清单自己声明（NodeTypeDef.runtimeClass），
  // 由 buildCatalog 直接读。注入过一次的东西就是第二处真相的入口。
  return mods.catalogMod.buildCatalog({})
}

function printCatalogList(catalog) {
  const lines = [
    `SciViz 算子清单 v${catalog.catalogVersion} · ${catalog.operatorCount} 个算子 · ${catalog.errorCodes.length} 个错误码`,
    '',
  ]
  const byCategory = new Map()
  for (const op of catalog.operators) {
    if (!byCategory.has(op.category)) byCategory.set(op.category, [])
    byCategory.get(op.category).push(op)
  }
  for (const [category, ops] of byCategory) {
    lines.push(`【${category}】`)
    for (const op of ops) {
      const ports = op.dynamicPorts ? '端口动态' : `${op.inputs.length} 入 / ${op.outputs.length} 出`
      lines.push(`  ${op.type.padEnd(22)} ${op.label.padEnd(12)} [${op.runtime.padEnd(9)}] ${ports}`)
    }
    lines.push('')
  }
  lines.push('看某个算子的端口与参数：sciviz catalog <算子类型>')
  lines.push('拿到完整清单（含参数 spec 与错误码表）：sciviz catalog --json')
  process.stdout.write(`${lines.join('\n')}\n`)
}

function printCatalogOperator(op) {
  const lines = [`${op.type} · ${op.label}  [${op.category} · ${op.runtime}]`, '', op.description, '']
  if (op.dynamicPorts) lines.push(`端口：动态 —— ${op.portsNote}`, '')
  lines.push('输入：')
  lines.push(
    op.inputs.length === 0
      ? '  （无）'
      : op.inputs
          .map(
            (p) =>
              `  ${p.id.padEnd(16)} ${p.type.padEnd(9)}${p.optional ? ' 可选' : ' 必需'}` +
              `${p.kind === 'param' ? `  （参数端口：${p.paramKey}）` : ''}`,
          )
          .join('\n'),
  )
  lines.push('', '输出：')
  lines.push(
    op.outputs.length === 0
      ? '  （无）'
      : op.outputs.map((p) => `  ${p.id.padEnd(16)} ${p.type}`).join('\n'),
  )
  lines.push('', '参数：')
  lines.push(
    op.params.length === 0
      ? '  （无）'
      : op.params
          .map((p) => {
            const range =
              p.type === 'select'
                ? `选项 ${(p.options ?? []).map((o) => o.value).join('/')}`
                : p.type === 'number'
                  ? [p.min !== undefined ? `≥${p.min}` : '', p.max !== undefined ? `≤${p.max}` : '']
                      .filter(Boolean)
                      .join(' ') || '数值'
                  : p.type
            return (
              `  ${p.key.padEnd(14)} ${p.type.padEnd(8)} 默认 ${JSON.stringify(p.default).padEnd(10)} ` +
              `${range}${p.portable ? '  [可被上游驱动]' : ''}`
            )
          })
          .join('\n'),
  )
  process.stdout.write(`${lines.join('\n')}\n`)
}

function cmdCatalog(mods, args) {
  const catalog = buildCatalog(mods)
  const want = args.positional[0]
  const hit = want ? catalog.operators.find((o) => o.type === want) : null
  if (want && !hit) die(`清单里没有算子「${want}」。用 \`sciviz catalog\` 看全部。`)
  if (hasFlag(args.flags, 'json')) {
    printJson(hit ? { ...catalog, operatorCount: 1, operators: [hit] } : catalog)
    return EXIT_OK
  }
  if (!want) {
    printCatalogList(catalog)
    return EXIT_OK
  }
  printCatalogOperator(hit)
  return EXIT_OK
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 `--columns 名=列1,列2` / `--time 名=列` 构造端口上下文。
 *
 * 为什么不做成"自动读 CSV"：无头读取数据是 G1 的范围（还要连带内容哈希与
 * DatasetRef）。G0 让调用方**显式声明**列，好处是把"这份数据长什么样"这件事
 * 变成一次明确的输入，而不是一次猜测。
 */
function buildContext(args) {
  const cols = new Map()
  const times = new Map()
  for (const raw of args.flags.columns ?? []) {
    const eq = raw.indexOf('=')
    if (eq < 0) die(`--columns 的格式是 名=列1,列2，收到的是「${raw}」`)
    const name = raw.slice(0, eq)
    cols.set(
      name,
      raw
        .slice(eq + 1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  for (const raw of args.flags.time ?? []) {
    const eq = raw.indexOf('=')
    if (eq < 0) die(`--time 的格式是 名=列，收到的是「${raw}」`)
    times.set(raw.slice(0, eq), raw.slice(eq + 1))
  }
  return {
    featuresOf: (id) => cols.get(id) ?? [],
    timeColumnOf: (id) => times.get(id) ?? null,
    hasDataset: (id) => cols.has(id),
    /* 让导出时记下的数据集**名字**在无头场景里直接充当 id：
       YAML 里的 id 是本机导入时现生成的，换一次会话就必然对不上（见 yaml.ts 的说明）。
       名字是这份数据在文件里唯一稳定的身份，所以这里按名字绑定。 */
    findByIdentity: (identity) => (cols.has(identity.name) ? { id: identity.name, exact: true } : null),
  }
}

/**
 * 列出这张图引用了哪些数据集。
 *
 * 存在的意义：`--columns` 要按**数据集 id** 声明列，而这个 id 是导入时现生成的
 * （`ds-1-xxxx`），agent 不可能猜出来。所以校验完直接把"你引用了哪些 id"报出来，
 * 闭环才是`validate → 看到 id → 带 --columns 再 validate 一次`，而不是让 agent 去读文件猜。
 *
 * 这里额外解析一次原始 YAML 只为拿 `dataset.name`（可读的名字），
 * **判定语义仍全部来自 yamlToWorkflow**，不在这里重做一遍。
 */
function collectDatasetRefs(text, workflow, yamlLib) {
  const declared = new Map()
  try {
    const doc = yamlLib.parse(text)
    for (const raw of doc?.nodes ?? []) {
      const id = raw?.params?.datasetId
      if (typeof id === 'string' && raw?.dataset?.name) {
        declared.set(id, { name: raw.dataset.name, rowCount: raw.dataset.rowCount })
      }
    }
  } catch {
    /* 解析不出来就算了：这一项只是提示，不该让校验失败 */
  }
  const refs = []
  for (const node of workflow?.nodes ?? []) {
    const id = node.params?.datasetId
    if (typeof id !== 'string' || !id) continue
    const d = declared.get(id)
    refs.push({
      nodeId: node.id,
      nodeLabel: node.label,
      datasetId: id,
      ...(d?.name ? { name: d.name } : {}),
      ...(d?.rowCount !== undefined ? { rowCount: d.rowCount } : {}),
    })
  }
  return refs
}

/**
 * 结构扫描：**只在解析失败时**跑，一次把文件的结构性问题列全。
 *
 * 为什么需要它：`yamlToWorkflow` 在第一个结构问题处就返回（界面只需要一条能显示的错误），
 * 于是 agent 会陷入"改一个、跑一次、再冒一个"的循环。这个扫描读的是原始 YAML，
 * 只用 `hasNodeType`（唯一事实来源），**不做任何端口/类型兼容判定** ——
 * 那些仍然只由 `validate.ts` 负责。
 *
 * 它只在解析失败时运行，所以永远不会和 validate 的结论出现两份。
 */
function scanRawStructure(text, mods) {
  const issues = []
  try {
    const doc = mods.yamlLib.parse(text)
    const rawNodes = Array.isArray(doc?.nodes) ? doc.nodes : []
    const seen = new Set()
    for (const raw of rawNodes) {
      const id = typeof raw?.id === 'string' ? raw.id : ''
      const type = raw?.type
      if (id) {
        if (seen.has(id)) {
          issues.push({ code: 'E_DUPLICATE_NODE_ID', nodeId: id, message: `节点 id「${id}」重复` })
          continue
        }
        seen.add(id)
      }
      if (typeof type !== 'string' || !type) continue
      if (!mods.registryMod.hasNodeType(type)) {
        issues.push({
          code: 'E_UNKNOWN_OPERATOR',
          nodeId: id,
          expected: 'catalog 里列出的算子之一',
          actual: type,
          message: `算子「${type}」不在清单里`,
        })
      }
    }
    for (const raw of Array.isArray(doc?.edges) ? doc.edges : []) {
      if (Array.isArray(raw)) continue
      const source = typeof raw?.source === 'string' ? raw.source : ''
      const target = typeof raw?.target === 'string' ? raw.target : ''
      if (!source || !target) continue
      const missing = [source, target].filter((id) => !seen.has(id))
      if (missing.length) {
        issues.push({
          code: 'E_DANGLING_EDGE',
          message: `连线 ${source} → ${target} 引用了不存在的节点（${missing.join(' / ')}）`,
        })
      }
    }
  } catch {
    /* YAML 本身就读不动时返回空：那时 E_YAML_INVALID 才是对的结论 */
  }
  return issues
}

function printValidation(file, result, importWarnings, datasetRefs = []) {
  const lines = [`校验 ${file}`, `  节点 ${result.nodeCount} · 连线 ${result.edgeCount}`, '']
  if (result.ok) {
    lines.push(
      result.warnings.length === 0
        ? '  ✔ 通过'
        : `  ✔ 无阻断错误 · ${result.warnings.length} 个告警`,
    )
  } else {
    lines.push(`  ✘ ${result.errors.length} 个错误 · ${result.warnings.length} 个告警`)
  }
  lines.push('')

  const render = (list, mark) => {
    for (const it of list) {
      lines.push(`${mark} [${it.code}] ${it.message}`)
      const where = [
        it.nodeId ? `节点 ${it.nodeId}` : '',
        it.portId ? `端口 ${it.portId}` : '',
        it.edgeId ? `连线 ${it.edgeId}` : '',
      ].filter(Boolean)
      if (where.length) lines.push(`    ${where.join(' · ')}`)
      if (it.expected !== undefined || it.actual !== undefined) {
        lines.push(`    期望 ${it.expected ?? '—'} / 实际 ${it.actual ?? '—'}`)
      }
    }
  }
  render(result.errors, '  ✘')
  if (result.errors.length) lines.push('')
  render(result.warnings, '  !')
  if (result.warnings.length) lines.push('')

  for (const w of importWarnings) lines.push(`  ! [W_IMPORT] ${w}`)
  if (importWarnings.length) lines.push('')

  if (result.notChecked?.length) {
    lines.push('本次没查的规则（不是通过，是还没有判据）：')
    for (const s of result.notChecked) lines.push(`  · ${s.code} —— ${s.reason}`)
    lines.push('')
  }
  if (datasetRefs.length) {
    lines.push('这张图引用的数据集：')
    for (const r of datasetRefs) {
      const extra = [r.name ? `名字「${r.name}」` : '', r.rowCount !== undefined ? `${r.rowCount} 行` : '']
        .filter(Boolean)
        .join(' · ')
      lines.push(`  · ${r.datasetId}${extra ? `（${extra}）` : ''} ← 节点 ${r.nodeId}「${r.nodeLabel}」`)
    }
    lines.push('')
  }
  if (result.warnings.some((w) => w.code === 'W_DATASET_UNRESOLVED')) {
    lines.push(
      '提示：动态端口尚未就绪时，补全函数签名或为「拆列」填写列名；必要时先运行上游。' +
        '`--columns` 只声明数据集列视图，数据源仍只有一个整表端口。',
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function cmdValidate(mods, args) {
  const file = args.positional[0]
  if (!file) die('用法：sciviz validate <文件.yaml> [--json] [--columns 名=列1,列2]')
  if (!fs.existsSync(file)) die(`文件不存在：${file}`)

  const text = fs.readFileSync(file, 'utf8')
  const flagCtx = buildContext(args)

  /*
   * **同一份文件，三种命令都要读得动。**
   *
   * 工程文件（`.sciviz`：`graph:` 段 + `datasets:` 视图）与旧的工作流 YAML（顶层 `nodes:`）
   * 都要认。此前 `validate` 只走 `yamlToWorkflow`，于是 `patch` 刚改好的工程、
   * `run` 刚跑通的工程，到了 `validate` 就是一句"YAML 缺少 nodes 列表" ——
   * agent 的闭环（改 → 验 → 跑）在这一步断掉，而它看起来像"文件坏了"。
   *
   * 判据只有一处：**工程文件用工程文件自己的解析器**（`textToProject`，与 patch/run 同一个），
   * 端口上下文用工程里记的数据集视图（那也是人做过的那套视图）。
   */
  const asProject = mods.projectFileMod.textToProject(text, undefined, 'wf-cli')
  if (asProject.project) {
    const project = asProject.project
    const view = mods.projectFileMod.projectPortContext(project)
    const ctx = {
      // 命令行显式给了就以命令行为准（它比文件更晚、更具体），否则用工程里记的视图
      featuresOf: (id) => (flagCtx.hasDataset(id) ? flagCtx.featuresOf(id) : view.featuresOf(id)),
      timeColumnOf: (id) => flagCtx.timeColumnOf(id) ?? view.timeColumnOf(id),
      hasDataset: (id) => flagCtx.hasDataset(id) || view.hasDataset(id),
      findByIdentity: flagCtx.findByIdentity,
    }
    const result = mods.validateMod.validateWorkflow(project.graph, ctx)
    const datasetRefs = project.graph.nodes
      .filter((n) => typeof n.params?.datasetId === 'string' && n.params.datasetId)
      .map((n) => {
        const ref = project.datasets.find((d) => d.id === n.params.datasetId)
        return {
          nodeId: n.id,
          nodeLabel: n.label,
          datasetId: n.params.datasetId,
          ...(ref?.name ? { name: ref.name } : {}),
          ...(ref?.rowCount !== undefined ? { rowCount: ref.rowCount } : {}),
        }
      })
    if (hasFlag(args.flags, 'json')) {
      printJson({ file, ...result, importWarnings: asProject.warnings ?? [], datasetRefs })
    } else {
      printValidation(file, result, asProject.warnings ?? [], datasetRefs)
    }
    return result.ok ? EXIT_OK : EXIT_ISSUES
  }

  const ctx = flagCtx
  const parsed = mods.yamlMod.yamlToWorkflow(text, 'wf-cli', ctx)
  const datasetRefs = collectDatasetRefs(text, parsed.workflow, mods.yamlLib)

  if (!parsed.workflow) {
    /* 解析在第一个结构问题处就停下，所以这里补一次结构扫描，把可修的项一次列全 */
    const errors = scanRawStructure(text, mods).map((it) => ({
      severity: 'error',
      level: 'L1',
      ...it,
    }))
    if (errors.length === 0) {
      errors.push({
        code: 'E_YAML_INVALID',
        severity: 'error',
        level: 'L1',
        message: parsed.error ?? '解析失败',
      })
    }
    const warnings = (parsed.warnings ?? []).map((message) => ({
      code: 'W_IMPORT',
      severity: 'warning',
      level: 'L1',
      message,
    }))
    warnings.push({
      code: 'W_IMPORT',
      severity: 'warning',
      level: 'L1',
      message: `解析在第一个结构问题处停下：${parsed.error ?? '未知'}（改完再跑一次会继续往下走）`,
    })
    const result = {
      file,
      ok: false,
      errors,
      warnings,
      nodeCount: 0,
      edgeCount: 0,
      notChecked: [],
      datasetRefs,
    }
    if (hasFlag(args.flags, 'json')) printJson(result)
    else printValidation(file, result, [], datasetRefs)
    return EXIT_ISSUES
  }

  const result = mods.validateMod.validateWorkflow(parsed.workflow, ctx)
  if (hasFlag(args.flags, 'json')) {
    printJson({ file, ...result, importWarnings: parsed.warnings ?? [], datasetRefs })
  } else {
    printValidation(file, result, parsed.warnings ?? [], datasetRefs)
  }
  return result.ok ? EXIT_OK : EXIT_ISSUES
}

/* ------------------------------------------------------------------ */
/* explain                                                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* plan / run / doctor                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* patch                                                               */
/* ------------------------------------------------------------------ */

/**
 * 改一份工程。
 *
 * 默认**就地写回** —— 它的用途就是"改这一份"，两边共用同一个文件。
 * 唯一的例外是旧格式：把一份没有 version 的工作流 YAML 就地升成工程文件是一次
 * 格式迁移，必须显式同意（`--upgrade` 或 `--out`），不允许顺手改掉（R11 的精神）。
 */
async function cmdPatch(mods, args) {
  const file = args.positional[0]
  if (!file) die('用法：sciviz patch <文件> --ops ops.json [--dry-run] [--out 文件] [--json]')
  if (!fs.existsSync(file)) die(`工程文件不存在：${file}`)

  const text = fs.readFileSync(file, 'utf8')
  const parsed = mods.projectFileMod.textToProject(
    text,
    undefined,
    path.basename(file, path.extname(file)),
    { preserveDatasetIds: true },
  )
  if (!parsed.project) die(`读不了这份工程：${parsed.error ?? '未知原因'}`, EXIT_ISSUES)
  const project = parsed.project

  const dryRun = hasFlag(args.flags, 'dry-run')
  const undo = hasFlag(args.flags, 'undo')

  /* ---------------- 撤销：用上一条改动记录里的反向动作 ---------------- */
  if (undo) {
    const last = project.patches[project.patches.length - 1]
    if (!last) die('这份工程里没有可撤销的改动记录（改动记录由 sciviz patch 写入）', EXIT_ISSUES)
    const result = mods.patchMod.applyPatch(project, {
      reason: `撤销：${last.reason ?? '（没有写原因）'}`,
      ops: last.reverse,
    })
    if (!result.ok) {
      const why = result.rejections.map((r) => `[${r.code}] ${r.message}`).join('；')
      die(`撤不回去：${why || '反向动作与当前图对不上'}。可能这份工程在被改过之后又变了`, EXIT_ISSUES)
    }
    if (!dryRun) {
      const undone = { ...result.project, patches: project.patches.slice(0, -1) }
      const outPath = lastFlag(args.flags, 'out') ?? file
      fs.writeFileSync(outPath, mods.projectFileMod.projectToText(undone), 'utf8')
    }
    const lines = [`撤销最近一次改动${dryRun ? '（--dry-run，没有写回）' : ''}`, '']
    for (const c of result.changes) lines.push(`  × ${c}`)
    process.stdout.write(`${lines.join('\n')}\n`)
    return EXIT_OK
  }

  const opsPath = lastFlag(args.flags, 'ops')
  if (!opsPath) {
    die('要给出 --ops <ops.json>（格式 {"reason": "一句话", "ops": [...]}），或者用 --undo 撤销上一次改动')
  }
  if (!fs.existsSync(opsPath)) die(`ops 文件不存在：${opsPath}`)

  let patchFile
  try {
    const raw = JSON.parse(fs.readFileSync(opsPath, 'utf8'))
    patchFile = Array.isArray(raw) ? { ops: raw } : raw
  } catch (err) {
    die(`ops 文件不是合法 JSON：${err.message}`)
  }
  if (!Array.isArray(patchFile?.ops)) die('ops 文件里没有 ops 数组')

  const hasMachineBaseline = Object.prototype.hasOwnProperty.call(patchFile, 'baseFingerprint')
  const result = hasMachineBaseline
    ? await mods.patchMod.applyPatchGuarded(project, patchFile)
    : mods.patchMod.applyPatch(project, patchFile)

  // 就地写回前先确认"这不是在偷偷改格式"
  const outPath = lastFlag(args.flags, 'out') ?? file
  const inPlace = outPath === file
  const isLegacy = project.version === 0
  const upgrade = hasFlag(args.flags, 'upgrade')
  const willWrite = result.ok && !dryRun
  if (willWrite && inPlace && isLegacy && !upgrade) {
    die(
      '这是一份旧格式的工作流 YAML（没有 version）。就地写回会把它变成工程文件，' +
        '这是一次格式迁移，不能顺手做：用 --out <新文件.sciviz> 另存，或确认要升级时加 --upgrade。',
      EXIT_USAGE,
    )
  }

  if (willWrite) {
    /*
     * 把这次改动（连同它的反向动作）记进工程文件。
     *
     * 记在文件里而不是旁边：**界面只拿到这一个文件**。浏览器选完文件拿不到
     * "旁边那个补丁记录"，所以要让"撤销 agent 刚才的改动"在界面上能点，
     * 记录就必须跟着工程走。
     */
    const record = {
      at: Date.now(),
      ...(patchFile.reason ? { reason: patchFile.reason } : {}),
      ops: patchFile.ops,
      reverse: result.reverse,
    }
    const withHistory = {
      ...result.project,
      patches: [...project.patches, record].slice(-mods.projectFileMod.PATCH_HISTORY_LIMIT),
    }
    fs.writeFileSync(outPath, mods.projectFileMod.projectToText(withHistory), 'utf8')
  }

  if (hasFlag(args.flags, 'json')) {
    printJson({
      file,
      out: willWrite ? outPath : null,
      dryRun,
      ok: result.ok,
      reason: patchFile.reason ?? null,
      changes: result.changes,
      incomplete: result.incomplete,
      rejections: result.rejections.map((r) => ({
        ...r,
        explain: mods.errorMod.getErrorCode(r.code)?.action ?? null,
      })),
      diff: result.diff,
      validation: result.validation,
    })
  } else {
    const lines = [`改工程 ${file}${patchFile.reason ? ` —— ${patchFile.reason}` : ''}`, '']
    if (result.ok) {
      lines.push(`  ✔ 落了 ${result.changes.length} 处改动${dryRun ? '（--dry-run，没有写回）' : ''}`)
      for (const c of result.changes) lines.push(`    · ${c}`)
      if (result.incomplete.length) {
        lines.push('', '  还差这些（不算错误，图没接完是正常的中间状态）：')
        for (const i of result.incomplete) lines.push(`    ! ${i}`)
      }
      /*
       * 整图静态校验的问题**不阻断**这次写入（见 kernel/patch.ts 的四条设计决定）：
       * 人会把半截实验与子空间留在画布上。但"落下了"与"没问题"是两件事，
       * 所以这里如实列出来，让人（或 agent）自己决定要不要接着改。
       */
      const l1 = (result.validation?.errors ?? []).filter((e) => e.code !== 'E_MISSING_INPUT')
      if (l1.length) {
        lines.push('', `  这次改动落了，但整图还有 ${l1.length} 处静态校验问题（不阻断写入）：`)
        for (const e of l1.slice(0, 12)) lines.push(`    ! [${e.code}] ${e.message}`)
        if (l1.length > 12) lines.push(`    …还有 ${l1.length - 12} 处，用 validate 看全部`)
      }
      if (result.diff) lines.push('', '  改动：', indentDiff(result.diff))
      if (willWrite) lines.push('', `  已写回：${outPath}`)
    } else {
      lines.push(`  ✘ 一条都没落（补丁是原子的：要么全过，要么全不动）`, '')
      for (const r of result.rejections) {
        lines.push(`  ✘ [${r.code}] 第 ${r.index + 1} 条 ${r.op}：${r.message}`)
        const def = mods.errorMod.getErrorCode(r.code)
        if (def) lines.push(`      怎么办：${def.action}`)
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  return result.ok ? EXIT_OK : EXIT_ISSUES
}

const indentDiff = (diff) =>
  diff
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')

/** `--data 数据集id或名字=路径.csv`，可重复 */
function parseDataBindings(args) {
  const out = []
  for (const raw of args.flags.data ?? []) {
    const eq = raw.indexOf('=')
    if (eq < 0) die(`--data 的格式是 数据集id或名字=路径.csv，收到的是「${raw}」`)
    out.push({ key: raw.slice(0, eq), path: raw.slice(eq + 1) })
  }
  return out
}

function projectIssues(project) {
  const lines = []
  for (const u of project.usageErrors) lines.push(`  ✘ ${u}`)
  if (project.unbound.length) {
    lines.push('  没有绑定 CSV 的数据集：')
    for (const u of project.unbound) {
      lines.push(`    · ${u.name ?? u.datasetId}（id ${u.datasetId}）← 节点 ${u.nodeIds.join(', ')}`)
    }
  }
  for (const b of project.bound.filter((x) => x.rowCountMismatch)) {
    lines.push(`  ! ${b.name}：导出时记 ${b.declaredRowCount} 行，实际 ${b.rowCount} 行 —— 确认是不是同一份数据`)
  }
  return lines
}

async function cmdPlan(mods, args) {
  const file = args.positional[0]
  if (!file) die('用法：sciviz plan <文件.yaml> [--data 名=文件.csv ...] [--json]')
  const { project, plan } = await mods.runMod.planProject(file, parseDataBindings(args))

  if (!project.workflow) {
    const body = { file, ok: false, error: project.parseError ?? '解析失败', ...projectIssuesObj(project) }
    if (hasFlag(args.flags, 'json')) printJson(body)
    else {
      process.stdout.write(`计划 ${file}\n\n  ✘ 读不了这份工程：${body.error}\n`)
      for (const l of projectIssues(project)) process.stdout.write(`${l}\n`)
    }
    return EXIT_ISSUES
  }

  const shape = {
    file,
    ok: project.usageErrors.length === 0,
    workflow: {
      name: project.workflow.name,
      nodes: project.workflow.nodes.length,
      edges: project.workflow.edges.length,
    },
    datasets: project.datasets.map((d) => ({
      id: d.id,
      name: d.name,
      rowCount: d.rowCount,
      timeColumn: d.timeColumn,
      sampleRate: d.sampleRate,
      contentHash: d.contentHash,
    })),
    unbound: project.unbound,
    evaluate: plan.evaluate.map((i) => ({ nodeId: i.node.id, type: i.node.type, label: i.node.label })),
    blocked: plan.blocked.map((i) => ({
      nodeId: i.node.id,
      type: i.node.type,
      label: i.node.label,
      reason: i.reason,
    })),
    missing: plan.missing.map((i) => ({ nodeId: i.node.id, label: i.node.label, ports: i.ports })),
    unchanged: plan.unchanged,
    manual: plan.manual.map((id) => {
      const n = project.workflow.nodes.find((x) => x.id === id)
      return { nodeId: id, type: n?.type ?? '', label: n?.label ?? id }
    }),
    validation: project.validation,
    importWarnings: project.importWarnings,
    usageErrors: project.usageErrors,
  }

  if (hasFlag(args.flags, 'json')) {
    printJson(shape)
  } else {
    const lines = [
      `计划 ${file}`,
      `  ${project.workflow.name} · ${shape.workflow.nodes} 节点 · ${shape.workflow.edges} 连线`,
      '',
    ]
    for (const l of projectIssues(project)) lines.push(l)
    if (project.datasets.length) {
      lines.push('  数据集：')
      for (const d of shape.datasets) {
        lines.push(`    ✔ ${d.name} · ${d.rowCount} 行 · ${d.contentHash.slice(0, 18)}…`)
      }
    }
    lines.push('', `  会算 ${shape.evaluate.length} 个节点：`)
    for (const e of shape.evaluate) lines.push(`    · ${e.nodeId.padEnd(12)} ${e.label}`)
    if (shape.manual.length) {
      lines.push('', `  引擎算不了、不会产出数值的 ${shape.manual.length} 个节点：`)
      for (const m of shape.manual) lines.push(`    □ ${m.nodeId.padEnd(12)} ${m.label}（${m.type}）`)
    }
    if (shape.blocked.length) {
      lines.push('', `  上游不可用而跳过的 ${shape.blocked.length} 个节点：`)
      for (const b of shape.blocked) lines.push(`    ⊘ ${b.nodeId.padEnd(12)} ${b.reason}`)
    }
    if (shape.missing.length) {
      lines.push('', '  缺必需输入：')
      for (const m of shape.missing) lines.push(`    ! ${m.nodeId.padEnd(12)} 缺 ${m.ports.join('、')}`)
    }
    if (project.validation && !project.validation.ok) {
      lines.push('', `  契约校验未通过：${project.validation.errors.length} 个错误（用 validate 看细节）`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return shape.usageErrors.length === 0 ? EXIT_OK : EXIT_USAGE
}

function projectIssuesObj(project) {
  return {
    usageErrors: project.usageErrors,
    unbound: project.unbound,
    importWarnings: project.importWarnings,
  }
}

async function cmdRun(mods, args) {
  const file = args.positional[0]
  if (!file) die('用法：sciviz run <文件.yaml> --data 名=文件.csv [--out 目录] [--host 地址]')
  const bindings = parseDataBindings(args)
  const outDir = lastFlag(args.flags, 'out') ?? path.join(process.cwd(), 'runs')
  const url = lastFlag(args.flags, 'host') ?? mods.hostMod.DEFAULT_HOST_URL
  const json = hasFlag(args.flags, 'json')
  const captureFigures = hasFlag(args.flags, 'capture-figures')
  const say = (line) => process.stderr.write(`${line}\n`)

  if (!json) say(`运行 ${file}`)
  let outcome
  try {
    outcome = await mods.runMod.runProject({
      yamlPath: file,
      bindings,
      hostUrl: url,
      outDir,
      captureFigures,
      onProgress: (dataset, phase, ratio) => {
        if (!json) say(`  [${dataset}] ${phase} ${Math.round(ratio * 100)}%`)
      },
      onLog: (entry) => {
        if (!json) say(`  ${entry.message}`)
      },
      onNodeProgress: nodeProgressReporter(json),
    })
  } catch (err) {
    // 引擎连不上、CSV 读不动这类问题：环境/用法问题，不是"图有问题"
    if (json) printJson({ file, ok: false, error: String(err?.message ?? err) })
    else say(`  ✘ ${err?.message ?? err}`)
    return EXIT_USAGE
  }

  const m = outcome.manifest
  if (json) {
    printJson({
      file,
      ok: m.status === 'done',
      status: m.status,
      runId: m.runId,
      manifestPath: outcome.manifestPath,
      reportPath: outcome.reportPath,
      ...(outcome.figures ? { figures: outcome.figures } : {}),
      ...(outcome.figureCapture ? { figureCapture: outcome.figureCapture } : {}),
      graphFingerprint: m.graphFingerprint,
      engine: m.engine,
      datasets: m.datasets,
      nodes: m.nodes.map((n) => ({
        nodeId: n.nodeId,
        label: n.label,
        type: n.nodeType,
        status: n.status,
        durationMs: n.durationMs,
        fingerprint: n.fingerprint,
        // 端口摘要跟着走：agent 跑完之后要能**当场**读出算出了什么（行数、列、指标），
        // 而不是再去翻 run.json —— 少一次"文件在哪儿"的绕路
        outputs: n.outputs ?? {},
        error: n.error ?? null,
      })),
      notComputed: m.notComputed,
      contract: m.contract,
      gaps: m.gaps,
    })
  } else {
    const lines = [
      '',
      `  引擎：${m.engine.info}`,
      `  数据集：${m.datasets.map((d) => `${d.name}（${d.rowCount} 行）`).join('、') || '（无）'}`,
      '',
    ]
    const mark = { ready: '✔', error: '✘', blocked: '⊘', manual: '□', computing: '…', idle: '·' }
    for (const n of m.nodes) {
      lines.push(
        `  ${mark[n.status] ?? '·'} ${n.label.padEnd(14)} ${n.status.padEnd(9)} ${
          n.durationMs === null ? '' : `${n.durationMs} ms`
        }`,
      )
    }
    lines.push('')
    for (const n of m.nodes.filter((x) => x.status === 'error')) {
      lines.push(`  ✘ ${n.label}：${n.error?.message ?? ''}`)
    }
    if (m.notComputed.length) {
      lines.push(`  □ ${m.notComputed.length} 个节点没有产出数值（见报告）`)
    }
    lines.push('', `  运行清单：${outcome.manifestPath}`, `  报告：${outcome.reportPath}`)
    if (m.drift) {
      lines.push('', '  与上一次相比：')
      for (const s of m.drift.summary) lines.push(`    ${s}`)
      for (const c of m.drift.changes.slice(0, 6)) lines.push(`    · ${c.detail}`)
      if (m.drift.changes.length > 6) lines.push(`    · …还有 ${m.drift.changes.length - 6} 处`)
    }
    lines.push(
      `  结论：${m.status === 'done' ? '全部算完' : m.status === 'partial' ? '部分算完' : m.status}`,
    )
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  return m.status === 'done' ? EXIT_OK : EXIT_ISSUES
}

/**
 * 问一次宿主的跨机器体检（T17）。
 *
 * **问到什么记什么**：问不到就返回 null —— 老宿主没有这个端点，或者它刚刚关了。
 * 那是"没得体检"，不是"体检没过"，两件事必须分开说（否则升级前的老宿主会被判成跑不了）。
 */
async function probePreflight(url) {
  const base = url.replace(/\/+$/, '').replace(/^ws/, 'http')
  try {
    const res = await fetch(`${base}/preflight`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function probeAgent(url) {
  const base = url.replace(/\/+$/, '')
  try {
    const configResponse = await fetch(`${base}/agent/config`, { signal: AbortSignal.timeout(3000) })
    if (!configResponse.ok) return null
    const config = await configResponse.json()
    const token = config.token
    delete config.token
    let hostDoctor = null
    if (token) {
      const doctorResponse = await fetch(`${base}/agent/exec`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sciviz-Agent-Token': token }, body: JSON.stringify({ tool: 'doctor', args: {} }), signal: AbortSignal.timeout(3000) })
      if (doctorResponse.ok) hostDoctor = await doctorResponse.json()
    }
    return { config, doctor: hostDoctor }
  } catch {
    return null
  }
}

async function cmdDoctor(mods, args) {
  const url = lastFlag(args.flags, 'host') ?? mods.hostMod.DEFAULT_HOST_URL
  const health = await mods.hostMod.probeHost(url)
  // 宿主在的时候顺带问一次体检：它与 /health 分工不同 —— 那个是探活（界面每隔几秒问），
  // 这个要读注册表、试端口、看磁盘，只在 doctor 这种排查场景按需问一次
  const preflight = health ? await probePreflight(url) : null
  const agent = health ? await probeAgent(url) : null
  const models = buildCatalog(mods)
  const engineOps = new Set(health?.operators ?? [])
  const declaredEngine = models.operators.filter((o) => o.runtime === 'engine').map((o) => o.type)
  /*
   * 清单说"归引擎算"、但宿主报不出来 → 这些节点在这个后端上跑不了。
   *
   * 例外是 `custom.*`：它不走 Python 算子表，而是"先把源码编译进来、再按名字调用"
   * 那条路径（见 operators.is_user_fn）。所以它不在 /health 的 operators 里，
   * 却是能算的 —— 拿两个不同的集合硬比会得到一个假警报。
   */
  const isUserFn = (t) => t.startsWith('custom.')
  const missing = declaredEngine.filter((t) => !engineOps.has(t) && !isUserFn(t))

  if (hasFlag(args.flags, 'json')) {
    printJson({
      // 与 validate / run / verify 一个口径：顶层的 ok 说"这次命令成没成"，
      // 退出码与它一致。下面那几节才是细节
      ok: !!health,
      host: {
        url,
        up: !!health,
        ...(health
          ? { engine: health.engine, python: health.python, device: health.device, operators: health.operators.length }
          : {}),
      },
      catalog: {
        operators: models.operatorCount,
        engine: declaredEngine.length,
      },
      declaredButUnavailable: missing,
      ...(preflight ? { preflight } : {}),
      ...(agent ? { agent } : {}),
      note: '/health 的 operators 只列 Python 算子表；custom.* 走用户函数路径，不在其中但可执行',
    })
    return health ? EXIT_OK : EXIT_ISSUES
  }

  const lines = ['环境自检', '']
  if (health) {
    lines.push(`  执行宿主：${url} ✔ 在`)
    lines.push(`    引擎：${health.engine}`)
    lines.push(`    Python ${health.python} · 算子 ${health.operators.length} 个`)
    if (preflight) {
      lines.push('', `  跨机器体检：${preflight.summary}`)
      for (const c of preflight.checks) {
        const mark = { ok: '✔', warn: '!', blocked: '✘' }[c.level] ?? '·'
        lines.push(`    ${mark} ${c.title}：${c.detail}`)
        if (c.fix) lines.push(`        → ${c.fix}`)
      }
    }
  } else {
    lines.push(`  执行宿主：${url} ✘ 不在`)
    lines.push('    无头运行需要一个本地宿主。在另一个终端里起它：')
    lines.push('      cd sciviz-local && py -3.12 -m sciviz_host')
  }
  lines.push(
    '',
    `  算子清单：${models.operatorCount} 个（全部由真实引擎执行）`,
  )
  if (agent) {
    lines.push('', `  AI 网关：${agent.config.configured ? '✔ 已配置' : '✘ 未配置'} · ${agent.config.provider ?? '无 provider'}${agent.config.model ? ` / ${agent.config.model}` : ' / 自动发现模型'}`)
    if (agent.doctor?.data) lines.push(`    状态目录：${agent.doctor.data.stateDir} · ${agent.doctor.data.stateWritable ? '可写' : '不可写'}`)
  } else if (health) {
    lines.push('', '  AI 网关：✘ 无法探测（宿主版本可能不支持 /agent 面）')
  }
  // 宿主不在线时，"清单说归引擎算、但宿主报不出来"这一栏是纯噪声（全部都会缺），
  // 所以只在线时才判它
  if (health && missing.length) {
    lines.push('', '  清单说归引擎算、但宿主报不出来的算子（这些节点在这个后端上跑不了）：')
    for (const t of missing) lines.push(`    ! ${t}`)
  }
  lines.push('', '  已知缺口：')
  // 这一节必须跟着现实走：它曾经写着"算子版本与实现哈希未落地"，
  // 而那条早就收了 —— 一份会撒谎的缺口清单比没有清单更坏
  lines.push('    · 跨运行缓存不落盘：宿主一重启就没了（T18 的余项）')
  lines.push('    · 自定义用户代码的行为取决于代码本身，报告不会替用户代码承诺额外结论')
  process.stdout.write(`${lines.join('\n')}\n`)
  return health ? EXIT_OK : EXIT_ISSUES
}

/* ------------------------------------------------------------------ */
/* inspect                                                             */
/* ------------------------------------------------------------------ */

/** 一个端口的输出摘要 → 几行文字 */
function describeOutputLines(portId, o) {
  const head = `  ${portId.padEnd(14)} ${String(o.kind).padEnd(8)}`
  if (o.kind === 'table') {
    const cols = (o.columns ?? []).join(' · ')
    return [
      `${head} ${o.rowCount ?? '?'} 行 × ${o.columns?.length ?? '?'} 列`,
      ...(cols ? [`      列：${cols}`] : []),
    ]
  }
  if (o.kind === 'metrics') {
    const entries = Object.entries(o.values ?? {})
    return [
      `${head} 指标`,
      ...entries.map(([k, v]) => `      ${k} = ${v === null ? '—' : Number(v).toPrecision(8)}`),
    ]
  }
  return [head]
}

async function cmdInspectCanvas(mods, args, file, fail, json) {
  if (!fs.existsSync(file)) return fail('找不到工程文件：' + file, {}, EXIT_USAGE)
  let parsed
  try {
    parsed = mods.projectFileMod.textToProject(
      fs.readFileSync(file, 'utf8'),
      undefined,
      path.basename(file, path.extname(file)),
      { preserveDatasetIds: true },
    )
  } catch (error) {
    return fail('工程文件读不出来：' + (error instanceof Error ? error.message : String(error)), {}, EXIT_USAGE)
  }
  if (!parsed.project) return fail(parsed.error ?? '工程文件读不出来', { warnings: parsed.warnings ?? [] }, EXIT_USAGE)
  const project = parsed.project
  const requestedFrom = lastFlag(args.flags, 'from')
  let manifestPath
  let manifest
  let runLookupMessage
  if (requestedFrom && requestedFrom !== 'latest') {
    manifestPath = path.resolve(requestedFrom)
    if (!fs.existsSync(manifestPath)) return fail('找不到运行清单：' + manifestPath, {}, EXIT_USAGE)
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      return fail('运行清单不是合法 JSON：' + (error instanceof Error ? error.message : String(error)), {}, EXIT_USAGE)
    }
  } else {
    const latest = mods.inspectionMod.findLatestManifest({
      projectPath: file,
      workflowName: project.name,
      runs: project.runs,
      ...(lastFlag(args.flags, 'out') ? { outDir: lastFlag(args.flags, 'out') } : {}),
      defaultOutDir: path.join(process.cwd(), 'runs'),
    })
    if (latest.ok) {
      manifestPath = latest.manifestPath
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      } catch (error) {
        runLookupMessage = '最近一次运行清单无法读取：' + (error instanceof Error ? error.message : String(error))
      }
    } else {
      runLookupMessage = latest.message
    }
  }
  if (manifest && !Array.isArray(manifest.nodes)) return fail('运行清单缺少 nodes 列表', {}, EXIT_USAGE)

  const asInspectionState = (sourceManifest) => {
    const nodes = Array.isArray(sourceManifest?.nodes) ? sourceManifest.nodes : []
    return {
      refs: Object.fromEntries(nodes.map((node) => [String(node.nodeId), node.outputs ?? {}])),
      runtimes: Object.fromEntries(nodes.map((node) => [String(node.nodeId), {
        status: String(node.status ?? 'unknown'),
        outputVersion: Number(node.outputVersion ?? 0),
        error: node.error?.message,
      }])),
    }
  }
  let state = asInspectionState(manifest)
  const editFingerprint = await mods.fingerprintMod.projectEditFingerprint(project)
  const withFingerprint = { ...state, editFingerprint }
  let nodeId = lastFlag(args.flags, 'node-id') ?? lastFlag(args.flags, 'node')
  const rawGroupPath = lastFlag(args.flags, 'group-path')
  let groupPath
  if (rawGroupPath !== undefined) {
    try {
      groupPath = JSON.parse(rawGroupPath)
    } catch {
      return fail('--group-path 必须是 JSON 字符串数组', {}, EXIT_USAGE)
    }
    if (!Array.isArray(groupPath) || groupPath.some((part) => typeof part !== 'string')) {
      return fail('--group-path 必须是 JSON 字符串数组', {}, EXIT_USAGE)
    }
  }
  if (nodeId && !hasFlag(args.flags, 'node-id')) {
    const idMatch = mods.canvasInspectionMod.locateCanvasNode(project, nodeId, groupPath).location
    if (!idMatch) {
      const labels = mods.contextMod.outlineOf(project.graph).filter((node) =>
        node.label === nodeId && (!groupPath || (node.groupPath.length === groupPath.length && node.groupPath.every((part, index) => part === groupPath[index]))))
      if (labels.length === 1) nodeId = labels[0].id
      else if (labels.length > 1) return fail('节点标签「' + nodeId + '」不唯一，请用 nodeId 指定其中一个', { availableNodes: labels.map(({ id, label, groupPath: group }) => ({ nodeId: id, label, groupPath: group })) }, EXIT_USAGE)
    }
  }
  const hasRows = args.flags.rows !== undefined
  const rowsValue = Number(lastFlag(args.flags, 'rows'))
  const rowOffsetValue = Number(lastFlag(args.flags, 'row-offset') ?? 0)
  const codeRequested = hasFlag(args.flags, 'code')
  const codeOffset = lastFlag(args.flags, 'code-offset')
  const offset = lastFlag(args.flags, 'offset')
  const limit = lastFlag(args.flags, 'limit')
  const portId = lastFlag(args.flags, 'port')
  const source = {
    kind: 'project',
    file: path.resolve(file),
    projectId: project.projectId ?? null,
    name: project.name,
    editFingerprint,
    ...(manifest ? {
      run: {
        runId: manifest.runId ?? null,
        manifestPath: path.resolve(manifestPath),
        graphFingerprint: manifest.graphFingerprint ?? null,
      },
    } : { latestRun: null, ...(runLookupMessage ? { runLookupMessage } : {}) }),
  }
  const datasets = project.datasets.map((dataset) => ({
    id: dataset.id,
    name: dataset.name,
    ...(dataset.rowCount === undefined ? {} : { rowCount: dataset.rowCount }),
    columns: (dataset.columns ?? []).map(({ name, type, role, enabled }) => ({ name, type, role, enabled })),
    ...(dataset.timeColumn === undefined ? {} : { timeColumn: dataset.timeColumn }),
  }))

  if (!nodeId) {
    if (codeRequested) {
      const codeBlocks = await mods.contextMod.codeBlocksOf(project)
      const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0))
      const pageLimit = Math.max(25, Math.min(50, Math.floor(Number(limit) || 25)))
      const page = codeBlocks.slice(requestedOffset, requestedOffset + pageLimit)
      const nextOffset = requestedOffset + page.length
      const result = {
        ok: true,
        ...source,
        codeBlocks: page,
        codeBlockCount: codeBlocks.length,
        offset: requestedOffset,
        nextOffset: nextOffset < codeBlocks.length ? nextOffset : null,
        codeIndexComplete: nextOffset >= codeBlocks.length,
      }
      if (json) printJson(result)
      else process.stdout.write('代码块 ' + codeBlocks.length + ' 个 · 本页 ' + page.length + ' 个 · ' + (result.codeIndexComplete ? '已完成' : '下页 offset=' + nextOffset) + '\n')
      return EXIT_OK
    }
    if (hasRows) return fail('--rows 需要同时给 --node-id', {}, EXIT_USAGE)
    const graph = mods.canvasInspectionMod.inspectCanvasGraph(project, state)
    const page = mods.pagingMod.pageGraph(graph.nodes, graph.edges, offset, limit)
    const result = { ok: true, ...source, datasets, ...page }
    if (json) printJson(result)
    else process.stdout.write(project.name + ' · ' + page.nodeCount + ' 节点 · ' + page.edgeCount + ' 连线 · 本页 ' + page.nodes.length + ' 节点\n')
    return EXIT_OK
  }

  const located = mods.canvasInspectionMod.locateCanvasNode(project, nodeId, groupPath)
  const place = located.location
  if (!place) {
    const all = mods.canvasInspectionMod.inspectCanvasGraph(project)
    const matches = all.nodes.filter((node) => node.nodeId === nodeId || node.label === nodeId)
    return fail('当前工程里没有节点「' + nodeId + '」；先不带 --node-id 查看画布节点', {
      availableNodes: matches.length ? matches.map(({ nodeId: id, label, groupPath: group }) => ({ nodeId: id, label, groupPath: group })) : undefined,
    })
  }
  if (codeRequested && groupPath === undefined && located.locations.length > 1) {
    return fail('节点 id「' + nodeId + '」在多层重复。请从代码块目录复制目标 groupPath 后重试', { matches: located.ambiguity?.matches ?? [] }, EXIT_USAGE)
  }
  const base = {
    ...mods.canvasInspectionMod.inspectCanvasNode(project, nodeId, place, withFingerprint),
    ...(located.ambiguity ? {
      ambiguous: located.ambiguity.ambiguous,
      matches: located.ambiguity.matches,
      note: located.ambiguity.note,
    } : {}),
  }
  if (codeRequested) {
    const code = typeof place.node.params.code === 'string' ? place.node.params.code : undefined
    if (code === undefined) {
      const result = { ok: true, ...source, ...base, message: '这个块没有代码正文；它的行为由注册算子实现决定。' }
      if (json) printJson(result)
      else process.stdout.write(place.node.label + ' 没有内联代码正文\n')
      return EXIT_OK
    }
    const page = mods.pagingMod.pageCode(code, codeOffset, lastFlag(args.flags, 'code-limit'))
    const digest = 'sha256:' + await mods.contextMod.sha256Hex(code)
    const result = {
      ok: true,
      ...source,
      ...base,
      code: page.code,
      codeDigest: digest,
      codeLines: code.split(/\r?\n/).length,
      codeLength: code.length,
      codeOffset: page.codeOffset,
      nextCodeOffset: page.nextCodeOffset,
      codeComplete: page.codeComplete,
    }
    if (json) printJson(result)
    else process.stdout.write(place.node.label + ' · ' + result.codeLines + ' 行代码 · ' + (page.codeComplete ? '已完成' : '下页 codeOffset=' + page.nextCodeOffset) + '\n')
    return EXIT_OK
  }
  if (!hasRows) {
    const result = { ok: true, ...source, ...base }
    if (json) printJson(result)
    else process.stdout.write(place.node.label + '（' + nodeId + ' · ' + place.node.type + '）\n')
    return EXIT_OK
  }
  if (!Number.isInteger(rowsValue) || rowsValue < 0) return fail('--rows 必须是大于等于 0 的整数', {}, EXIT_USAGE)
  if (!Number.isInteger(rowOffsetValue) || rowOffsetValue < 0) return fail('--row-offset 必须是大于等于 0 的整数', {}, EXIT_USAGE)
  if (requestedFrom && requestedFrom !== 'latest') {
    return fail('--from 指定的是历史清单，里面没有行值；去掉 --from 后 inspect 会按当前工程重新运行并分页取值')
  }
  const rows = Math.max(1, Math.min(100, Math.floor(rowsValue)))
  const runtimeId = String(base.runtimeId)
  try {
    const outcome = await mods.runMod.runProject({
      yamlPath: file,
      bindings: parseDataBindings(args),
      hostUrl: lastFlag(args.flags, 'host') ?? mods.hostMod.DEFAULT_HOST_URL,
      outDir: lastFlag(args.flags, 'out') ?? path.join(process.cwd(), 'runs'),
      heads: [{ nodeId: runtimeId, ...(portId ? { portId } : {}), rows, rowOffset: rowOffsetValue }],
      onProgress: (dataset, phase, ratio) => {
        if (!json) process.stderr.write('  ' + dataset + ' ' + phase + ' ' + Math.round(ratio * 100) + '%\n')
      },
    })
    manifest = outcome.manifest
    manifestPath = outcome.manifestPath
    state = asInspectionState(manifest)
    const updatedBase = {
      ...mods.canvasInspectionMod.inspectCanvasNode(project, nodeId, place, { ...state, editFingerprint }),
      ...(located.ambiguity ? {
        ambiguous: located.ambiguity.ambiguous,
        matches: located.ambiguity.matches,
        note: located.ambiguity.note,
      } : {}),
    }
    const head = outcome.heads[0]
    const nextRowOffset = rowOffsetValue + head.table.rows.length
    const result = {
      ok: true,
      ...source,
      run: { runId: manifest.runId, manifestPath, graphFingerprint: manifest.graphFingerprint },
      ...updatedBase,
      portId: head.portId,
      rows,
      rowOffset: rowOffsetValue,
      table: head.table,
      nextRowOffset: nextRowOffset < head.table.totalRows ? nextRowOffset : null,
      rowsComplete: nextRowOffset >= head.table.totalRows,
    }
    if (json) printJson(result)
    else process.stdout.write(place.node.label + ':' + head.portId + ' · ' + head.table.rows.length + ' 行' + (result.rowsComplete ? '' : ' · 下页 rowOffset=' + nextRowOffset) + '\n')
    return EXIT_OK
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

async function cmdInspect(mods, args) {
  const file = args.positional[0]
  if (!file) die('用法：sciviz inspect <工程> [--canvas] [--node <id或唯一标签>] [--node-id <id>] [--group-path JSON] [--port <id>] [--rows N] [--row-offset N] [--code] [--code-offset N] [--offset N] [--limit N] [--from run.json|latest] [--image]')
  const nodeId = lastFlag(args.flags, 'node')
  const portId = lastFlag(args.flags, 'port')
  const imageRequested = hasFlag(args.flags, 'image')
  const rows = Number(lastFlag(args.flags, 'rows') ?? 0)
  let from = lastFlag(args.flags, 'from')
  const json = hasFlag(args.flags, 'json')

  const fail = (message, details = {}, code = EXIT_ISSUES) => {
    if (json) printJson({ file, ok: false, error: message, ...details })
    else process.stderr.write(`${message}\n`)
    return code
  }
  if (hasFlag(args.flags, 'canvas')) return await cmdInspectCanvas(mods, args, file, fail, json)
  const nodeJson = (n) => ({
    nodeId: n.nodeId,
    label: n.label,
    type: n.nodeType,
    status: n.status,
    durationMs: n.durationMs ?? null,
    fingerprint: n.fingerprint ?? null,
    fingerprintShort: n.fingerprintShort ?? null,
    reused: n.reused === true,
    cache: n.status === 'ready' ? (n.reused === true ? 'hit' : 'miss') : null,
    simulated: n.operator?.runtimeClass === 'simulated',
    operator: n.operator ?? null,
    meta: n.meta ?? {},
    artifacts: n.artifacts ?? [],
    error: n.error ?? null,
    outputs: portId ? { [portId]: n.outputs?.[portId] ?? null } : (n.outputs ?? {}),
    inspectablePorts: mods.inspectionMod.inspectablePorts(n.outputs ?? {}),
  })

  if (!Number.isInteger(rows) || rows < 0) {
    return fail('--rows 必须是大于等于 0 的整数', {}, EXIT_USAGE)
  }
  if (rows > 0 && !nodeId) {
    return fail('--rows 需要同时给 --node；先不带 --rows 运行 inspect 可列出全部节点与端口', {}, EXIT_USAGE)
  }
  if (imageRequested && (!nodeId || rows > 0 || !from)) {
    return fail('--image 需要 --node 和 --from run.json|latest，且不能与 --rows 同用', {}, EXIT_USAGE)
  }

  if (from === 'latest') {
    if (!fs.existsSync(file)) return fail(`找不到工程文件：${file}`, {}, EXIT_USAGE)
    const parsed = mods.projectFileMod.textToProject(
      fs.readFileSync(file, 'utf8'),
      undefined,
      path.basename(file, path.extname(file)),
      { preserveDatasetIds: true },
    )
    if (!parsed.project) return fail(parsed.error ?? '工程文件读不出来', {}, EXIT_USAGE)
    const outFlag = lastFlag(args.flags, 'out')
    const latest = mods.inspectionMod.findLatestManifest({
      projectPath: file,
      workflowName: parsed.project.name,
      runs: parsed.project.runs,
      ...(outFlag ? { outDir: outFlag } : {}),
      defaultOutDir: path.join(process.cwd(), 'runs'),
    })
    if (!latest.ok) {
      return fail(latest.message, { searched: latest.searched })
    }
    from = latest.manifestPath
  }

  /* ---------------- 读历史清单：快，不需要宿主，但没有行值 ---------------- */
  if (from) {
    if (!fs.existsSync(from)) return fail(`找不到运行清单：${from}`, {}, EXIT_USAGE)
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(from, 'utf8'))
    } catch (err) {
      return fail(`运行清单不是合法 JSON：${err?.message ?? err}`, {}, EXIT_USAGE)
    }
    if (rows > 0) {
      return fail(
        '--from 读的是运行清单，里面**没有行值**（全表留在引擎侧）。' +
          '要看前几行去掉 --from，改用 --rows —— 那会把图跑一遍再取。',
        {},
        EXIT_USAGE,
      )
    }
    if (!Array.isArray(manifest.nodes)) return fail('运行清单缺少 nodes 列表', {}, EXIT_USAGE)
    const selection = mods.inspectionMod.selectResultNodes(manifest.nodes, nodeId)
    if (!selection.ok) {
      return fail(selection.message, { availableNodes: selection.availableNodes })
    }
    const nodes = selection.nodes
    if (imageRequested) {
      if (nodes.length !== 1) return fail('--image 必须唯一指定一个图表节点')
      const candidates = (Array.isArray(manifest.figures) ? manifest.figures : [])
        .filter((figure) => (figure?.runtimeId ?? figure?.nodeId) === nodes[0].nodeId && (!portId || figure.portId === portId))
      if (candidates.length === 0) return fail('这次运行没有捕获所选图表的图像；运行时请启用 --capture-figures')
      if (candidates.length > 1) return fail('该节点有多个图像端口，请用 --port 指定一个')
      const figure = candidates[0]
      const runDir = path.dirname(path.resolve(from))
      const imagePath = path.resolve(runDir, figure.path)
      const relativeImagePath = path.relative(runDir, imagePath)
      if (!relativeImagePath || relativeImagePath === '..' || relativeImagePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeImagePath)) {
        return fail('运行清单里的图像路径越出了本次运行目录')
      }
      if (!fs.existsSync(imagePath)) return fail(`运行图像文件不存在：${imagePath}`)
      const runDirReal = fs.realpathSync(runDir)
      const imagePathReal = fs.realpathSync(imagePath)
      const realRelative = path.relative(runDirReal, imagePathReal)
      if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        return fail('运行图像的实际路径越出了本次运行目录')
      }
      const imageBytes = fs.readFileSync(imagePathReal)
      if (imageBytes.length === 0 || imageBytes.length > 8 * 1024 * 1024) return fail('运行图像为空或超过 8 MiB 上限')
      const digest = crypto.createHash('sha256').update(imageBytes).digest('hex')
      if (digest !== figure.sha256) return fail('运行图像 SHA-256 与运行清单不匹配')
      if (json) {
        printJson({
          ok: true,
          source: 'figure',
          from,
          runId: manifest.runId,
          figure: {
          nodeId: figure.nodeId,
          groupPath: figure.groupPath ?? [],
          runtimeId: figure.runtimeId ?? figure.nodeId,
          portId: figure.portId,
            label: figure.label,
            mimeType: figure.mimeType,
            width: figure.width,
            height: figure.height,
            sha256: figure.sha256,
            fingerprintSha256: figure.fingerprintSha256 ?? null,
            data: imageBytes.toString('base64'),
          },
        })
        return EXIT_OK
      }
      process.stdout.write(`图像 ${figure.label} · ${figure.nodeId}:${figure.portId} · ${figure.width}×${figure.height} · SHA-256 ${figure.sha256}\n`)
      return EXIT_OK
    }
    if (json) {
      printJson({
        ok: true,
        source: 'manifest',
        from,
        runId: manifest.runId,
        graphFingerprint: manifest.graphFingerprint,
        nodes: nodes.map(nodeJson),
        gaps: manifest.gaps ?? [],
      })
      return EXIT_OK
    }
    const lines = [`${manifest.workflow?.name ?? ''} · 运行 ${manifest.runId}`, '']
    for (const n of nodes) {
      lines.push(`${n.label}（${n.nodeId} · ${n.nodeType}）  ${n.status}${n.durationMs === null ? '' : ` · ${n.durationMs} ms`}`)
      const outs = portId ? { [portId]: n.outputs?.[portId] } : (n.outputs ?? {})
      if (!outs || Object.keys(outs).length === 0 || !outs[Object.keys(outs)[0]]) {
        lines.push('  （这个节点没有记下输出摘要）')
      } else {
        for (const [p, o] of Object.entries(outs)) if (o) lines.push(...describeOutputLines(p, o))
      }
      lines.push('')
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return EXIT_OK
  }

  /* ---------------- 现跑一遍再看：能看到行值，但需要宿主 ---------------- */
  const outDir = lastFlag(args.flags, 'out') ?? path.join(process.cwd(), 'runs')
  const url = lastFlag(args.flags, 'host') ?? mods.hostMod.DEFAULT_HOST_URL
  const say = (l) => process.stderr.write(`${l}\n`)
  if (!json) say(`跑一遍再看 ${file}`)

  let outcome
  try {
    outcome = await mods.runMod.runProject({
      yamlPath: file,
      bindings: parseDataBindings(args),
      hostUrl: url,
      outDir,
      heads: rows > 0 && nodeId ? [{ nodeId, ...(portId ? { portId } : {}), rows }] : [],
      onLog: (e) => {
        if (!json) say(`  ${e.message}`)
      },
      onNodeProgress: nodeProgressReporter(json),
    })
  } catch (err) {
    if (err?.name === 'InspectionSelectionError') {
      return fail(String(err.message), {
        ...(err.availableNodes ? { availableNodes: err.availableNodes } : {}),
        ...(err.availablePorts ? { availablePorts: err.availablePorts } : {}),
      })
    }
    if (json) printJson({ file, ok: false, error: String(err?.message ?? err) })
    else say(`  ✘ ${err?.message ?? err}`)
    return EXIT_USAGE
  }

  const selection = mods.inspectionMod.selectResultNodes(outcome.manifest.nodes, nodeId)
  if (!selection.ok) {
    return fail(selection.message, { availableNodes: selection.availableNodes })
  }
  const nodes = selection.nodes
  const head = outcome.heads[0]

  if (json) {
    printJson({
      file,
      ok: outcome.manifest.status === 'done',
      source: 'run',
      runId: outcome.manifest.runId,
      manifestPath: outcome.manifestPath,
      graphFingerprint: outcome.manifest.graphFingerprint,
      nodes: nodes.map(nodeJson),
      head: head
        ? { nodeId: head.nodeId, portId: head.portId, rows: head.rows, table: head.table }
        : null,
      gaps: outcome.manifest.gaps ?? [],
    })
    return outcome.manifest.status === 'done' ? EXIT_OK : EXIT_ISSUES
  }

  const lines = ['', `  运行：${outcome.manifestPath}`, '']
  for (const n of nodes) {
    lines.push(`${n.label}（${n.nodeId} · ${n.nodeType}）  ${n.status}`)
    const outs = portId ? { [portId]: n.outputs?.[portId] } : (n.outputs ?? {})
    for (const [p, o] of Object.entries(outs)) if (o) lines.push(...describeOutputLines(p, o))
    lines.push('')
  }
  if (head) {
    lines.push(`前 ${head.rows} 行（${head.nodeId} · ${head.portId}）：`)
    lines.push(`  ${head.table.columns.join(' | ')}`)
    for (const row of head.table.rows) {
      lines.push(
        `  ${row
          .map((v) => {
            if (v === null || v === undefined) return '—'
            // 通道名这类列是字符串。硬转数字会显示成 NaN，看着像坏数据
            if (typeof v === 'string') return v
            return Number.isFinite(v) ? Number(v).toPrecision(6) : '—'
          })
          .join(' | ')}`,
      )
    }
    if (head.table.totalRows > head.table.rows.length) {
      lines.push(`  …共 ${head.table.totalRows} 行`)
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return outcome.manifest.status === 'done' ? EXIT_OK : EXIT_ISSUES
}

/** 夹具数据 → CSV 文本。与 `csvParse` 读的那种 CSV 完全一样，不搞第二种约定 */
function csvTextOf(fixture) {
  const lines = [fixture.data.header.join(',')]
  for (const row of fixture.data.rows) lines.push(row.join(','))
  return `${lines.join('\n')}\n`
}

/** 从输出摘要里读一个数。读不到就返回 undefined —— 那本身就是要报出来的事实 */
function readSummary(summary, key) {
  if (!summary) return undefined
  const v = summary.values?.[key]
  return typeof v === 'number' ? v : undefined
}

/**
 * `sciviz verify` —— 注册式真值夹具（G4）。
 *
 * 它回答的问题与 `run` 不同：`run` 说"跑完了、算出了什么"，`verify` 说"算出来的
 * 那个数对不对"。判据来自 `src/contract/truthFixtures.ts`：每条夹具自带一份独立真值
 * （解析解或朴素实现）与一句出处。
 *
 * **要连引擎**：验的是执行面算得对不对，没有引擎就没有可验的东西。所以宿主没起时
 * 它报的是环境问题（退出码 2），而不是"夹具失败"。
 */
async function cmdVerify(mods, args) {
  const only = args.positional[0]
  const all = mods.fixtureMod.TRUTH_FIXTURES
  const picked = only ? all.filter((f) => f.id === only) : all
  if (picked.length === 0) {
    die(`没有 id 为「${only}」的夹具。现有：\n  ${all.map((f) => f.id).join('\n  ')}`)
  }

  const json = hasFlag(args.flags, 'json')
  const url = lastFlag(args.flags, 'host') ?? mods.hostMod.DEFAULT_HOST_URL
  const say = (line) => {
    if (!json) process.stderr.write(`${line}\n`)
  }

  /*
   * 宿主有什么，决定了哪些夹具能跑。
   *
   * 最要紧的一条是 torch：`train.mlp` 这类宿主专属算子没有它就一步都跑不了。
   * **没装 torch 的宿主上要跳过、并在结论里写明原因**，而不是让夹具红着 ——
   * CI 里那个 agent-face job 就是故意不装 torch 的（4GB 的 CUDA 构建只在开发机上有意义），
   * 红着只会让人去查一个根本不存在的回归。
   */
  const health = await mods.hostMod.probeHost(url)
  if (!health) {
    die(`宿主连不上（${url}）。sciviz verify 验的就是执行面，先把它起起来：sciviz-local\\run-host.ps1`)
  }
  const hasTorch = !!health.device?.torchVersion

  // 夹具产物写在 `.tmp/verify/<id>/`：它是**可复现的输入**，留着方便人手跑一遍看看
  const root = path.join(process.cwd(), '.tmp', 'verify')
  fs.mkdirSync(root, { recursive: true })

  const results = []
  for (const f of picked) {
    if (f.requires === 'torch' && !hasTorch) {
      say(`跳过 ${f.id}：${f.what}`)
      results.push({
        fixture: f.id,
        what: f.what,
        skipped: true,
        reason: '这个宿主未安装 torch，训练夹具未执行',
        cells: [],
      })
      continue
    }

    const dir = path.join(root, f.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'data.csv'), csvTextOf(f), 'utf8')

    const project = mods.projectFileMod.emptyProject(f.graph)
    project.name = f.graph.name
    project.datasets = [
      {
        id: f.data.key,
        name: f.data.name,
        path: 'data.csv',
        rowCount: f.data.rows.length,
        timeColumn: f.data.timeColumn,
        columns: f.data.features.map((name) => ({
          name,
          type: 'number',
          role: 'continuous',
          enabled: true,
        })),
      },
    ]
    const yamlPath = path.join(dir, 'project.sciviz')
    fs.writeFileSync(yamlPath, mods.projectFileMod.projectToText(project), 'utf8')

    say(`夹具 ${f.id} —— ${f.what}`)
    let outcome
    try {
      outcome = await mods.runMod.runProject({
        yamlPath,
        bindings: [],
        hostUrl: url,
        outDir: path.join(dir, 'runs'),
        onLog: (entry) => say(`  ${entry.message}`),
        // 表类端口（时域/频域特征）的数在**行里**，摘要里没有 —— 要核它们就得真去取行
        // 每个端口取到"最靠后的那一行就够"，同一端口的多行只取一次
        heads: f.cells
          .filter((c) => (c.where ?? 'metric') === 'row')
          .reduce((acc, c) => {
            const portId = c.portId ?? 'data'
            const rows = (c.rowIndex ?? 0) + 1
            const hit = acc.find((h) => h.nodeId === c.nodeId && h.portId === portId)
            if (hit) hit.rows = Math.max(hit.rows, rows)
            else acc.push({ nodeId: c.nodeId, portId, rows })
            return acc
          }, []),
      })
    } catch (err) {
      results.push({
        fixture: f.id,
        what: f.what,
        dir,
        ok: false,
        error: String(err?.message ?? err),
        cells: [],
      })
      continue
    }

    const cells = f.cells.map((cell) => {
      const portId = cell.portId ?? 'data'
      const node = outcome.manifest.nodes.find((n) => n.nodeId === cell.nodeId)
      const summary = node?.outputs?.[portId]
      const where = cell.where ?? 'metric'
      let actual
      if (where === 'rowCount') actual = summary?.rowCount
      else if (where === 'columns') actual = summary?.columns?.length
      else if (where === 'metric') actual = readSummary(summary, cell.key)
      else {
        const head = outcome.heads.find((h) => h.nodeId === cell.nodeId && h.portId === portId)
        const at = head ? head.table.columns.indexOf(cell.key) : -1
        const v = at >= 0 ? head.table.rows?.[cell.rowIndex ?? 0]?.[at] : undefined
        actual = typeof v === 'number' ? v : undefined
      }
      const ok = typeof actual === 'number' && Math.abs(actual - cell.value) <= cell.tol
      return {
        nodeId: cell.nodeId,
        portId,
        key: cell.key,
        expected: cell.value,
        actual: actual ?? null,
        tol: cell.tol,
        from: cell.from,
        ok,
        // 读不到数时，"节点是什么状态、报了什么错"是唯一有用的线索
        note: node ? undefined : `清单里没有节点 ${cell.nodeId}`,
        nodeStatus: node?.status,
        nodeError: node?.error?.message,
      }
    })
    results.push({ fixture: f.id, what: f.what, dir, ok: cells.every((c) => c.ok), cells })
  }

  const failed = results.filter((r) => !r.skipped && !r.ok)
  if (json) {
    printJson({ ok: failed.length === 0, host: url, fixtures: results })
  } else {
    const lines = []
    for (const r of results) {
      if (r.skipped) {
        lines.push('', `⊘ ${r.fixture}  ${r.what}`, `    跳过：${r.reason}`)
        continue
      }
      lines.push('', `${r.ok ? '✔' : '✘'} ${r.fixture}  ${r.what}`)
      if (r.error) lines.push(`    ✘ ${r.error}`)
      for (const c of r.cells) {
        const got = c.actual === null ? '（读不到）' : c.actual
        lines.push(
          `    ${c.ok ? '✔' : '✘'} ${c.nodeId}.${c.portId} ${c.key} = ${got}` +
            (c.ok ? '' : `，期望 ${c.expected}（±${c.tol}）`),
        )
        if (!c.ok) {
          lines.push(`        出处：${c.from}`)
          if (c.nodeStatus && c.nodeStatus !== 'done') {
            lines.push(`        节点状态：${c.nodeStatus}${c.nodeError ? ` —— ${c.nodeError}` : ''}`)
          }
        }
      }
      lines.push(`    输入留在 ${path.relative(process.cwd(), r.dir)}`)
    }
    const cells = results.reduce((s, r) => s + r.cells.length, 0)
    const bad = results.reduce((s, r) => s + r.cells.filter((c) => !c.ok).length, 0)
    const skipped = results.filter((r) => r.skipped).length
    const ran = results.length - skipped
    lines.push(
      '',
      `${ran - failed.length}/${ran} 条夹具通过；核了 ${cells} 个数，${bad} 个对不上` +
        (skipped > 0 ? `；跳过 ${skipped} 条（原因见上）` : ''),
    )
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return failed.length === 0 ? EXIT_OK : EXIT_ISSUES
}

function cmdExplain(mods, args) {
  const { allErrorCodes, getErrorCode, explainCode } = mods.errorMod
  if (hasFlag(args.flags, 'list')) {
    const codes = allErrorCodes()
    if (hasFlag(args.flags, 'json')) {
      printJson(codes)
      return EXIT_OK
    }
    const lines = [`错误码 ${codes.length} 个`, '']
    for (const d of codes) {
      lines.push(
        `${d.code.padEnd(28)} ${d.level} ${d.severity === 'error' ? '阻断' : '告警'}  ${d.action}`,
      )
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return EXIT_OK
  }

  const code = args.positional[0]
  if (!code) die('用法：sciviz explain <错误码>，或 sciviz explain --list')
  const def = getErrorCode(code)
  if (!def) die(`未知错误码「${code}」。用 \`sciviz explain --list\` 看全部可用码。`, EXIT_ISSUES)
  if (hasFlag(args.flags, 'json')) {
    printJson(def)
    return EXIT_OK
  }

  const context = {}
  const nodeId = lastFlag(args.flags, 'node')
  const portId = lastFlag(args.flags, 'port')
  if (nodeId) context.nodeId = nodeId
  if (portId) context.portId = portId
  process.stdout.write(`${explainCode(code, context)}\n`)
  return EXIT_OK
}

/* ------------------------------------------------------------------ */
/* code / chat replay                                                  */
/* ------------------------------------------------------------------ */

function readJsonFile(filename, label) {
  if (!filename) die(`${label} 需要一个 JSON 文件`)
  const absolute = path.resolve(filename)
  if (!fs.existsSync(absolute)) die(`找不到 ${label}：${filename}`)
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'))
  } catch (error) {
    die(`${label} 不是合法 JSON：${error?.message ?? error}`)
  }
}

function codeError(error) {
  if (error?.code) return { code: error.code, message: error.message ?? String(error) }
  return { code: 'E_PARAM_INVALID', message: error?.message ?? String(error) }
}

function printCodeResult(result, json) {
  if (json) {
    printJson(result)
    return
  }
  if (result?.plan) {
    const plan = result.plan
    process.stdout.write(`源码计划 ${plan.planId}\n  根目录：${plan.root}\n  文件：${plan.files.length}\n  固定闸门：${plan.gates.map((gate) => gate.id).join('、') || '无'}\n  批准令牌：${plan.approvalToken}\n`)
    if (plan.diff) process.stdout.write(`\n${plan.diff}\n`)
  }
  if (result?.status) process.stdout.write(`\n${result.status === 'done' ? '✔' : '✘'} ${result.status}${result.error ? ` · [${result.error.code}] ${result.error.message}` : ''}\n`)
  if (result?.gates?.length) {
    process.stdout.write('闸门：\n')
    for (const gate of result.gates) process.stdout.write(`  ${gate.ok ? '✔' : '✘'} ${gate.id}${gate.output ? ` · ${gate.output.slice(-500)}` : ''}\n`)
  }
}

async function cmdCode(mods, args) {
  const root = args.positional[0]
  const action = lastFlag(args.flags, 'action')
  const json = hasFlag(args.flags, 'json')
  if (!root || !action) die('用法：sciviz code <根> --action list|search|read|check|plan|apply|undo [--json]')
  try {
    if (action === 'list') {
      const rows = await mods.codeMod.listCodeFiles(root, lastFlag(args.flags, 'glob') ?? '**/*')
      if (json) printJson({ ok: true, action, root: path.resolve(root), files: rows })
      else process.stdout.write(rows.map((row) => `${row.path}\t${row.bytes}\t${row.sha256}`).join('\n') + (rows.length ? '\n' : ''))
      return EXIT_OK
    }
    if (action === 'search') {
      const result = await mods.codeMod.searchCodeFiles(root, lastFlag(args.flags, 'query') ?? '', lastFlag(args.flags, 'glob') ?? '**/*', Number(lastFlag(args.flags, 'limit') ?? 50), hasFlag(args.flags, 'case-sensitive'))
      if (json) printJson({ ok: true, action, root: path.resolve(root), result })
      else process.stdout.write(result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n') + (result.matches.length ? '\n' : '') + `${result.totalMatches} match(es) in ${result.filesSearched} file(s)${result.truncated ? ' (results truncated)' : ''}\n`)
      return EXIT_OK
    }
    if (action === 'check') {
      const raw = lastFlag(args.flags, 'checks')
      const selected = raw ? raw.split(',').map((id) => id.trim()).filter(Boolean) : undefined
      const checks = await mods.codeMod.runCodeChecks(root, selected)
      const ok = checks.every((check) => check.ok)
      if (json) printJson({ ok, action, root: path.resolve(root), checks })
      else for (const check of checks) process.stdout.write(`${check.ok ? '✔' : '✘'} ${check.id}${check.output ? `\n${check.output}` : ''}\n`)
      return ok ? EXIT_OK : EXIT_ISSUES
    }
    if (action === 'read') {
      const filename = lastFlag(args.flags, 'path') ?? args.positional[1]
      const result = await mods.codeMod.readCodeFile(root, filename, Number(lastFlag(args.flags, 'start') ?? 1), lastFlag(args.flags, 'end') === undefined ? undefined : Number(lastFlag(args.flags, 'end')))
      if (json) printJson({ ok: true, action, result })
      else process.stdout.write(`${result.path} · ${result.sha256} · ${result.startLine}-${result.endLine}/${result.lineCount}${result.nextStartLine ? ` · 下页从第 ${result.nextStartLine} 行开始` : ''}\n${result.text}\n`)
      return EXIT_OK
    }
    if (action === 'plan') {
      const raw = readJsonFile(lastFlag(args.flags, 'ops'), '--ops')
      const operations = Array.isArray(raw) ? raw : raw.operations
      if (!Array.isArray(operations)) die('--ops JSON 必须是动作数组或 {"operations": [...]}')
      const plan = await mods.codeMod.planCodePatch(root, operations)
      const result = { ok: true, status: 'planned', plan }
      const out = lastFlag(args.flags, 'out')
      if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
      printCodeResult(result, json)
      return EXIT_OK
    }
    if (action === 'apply') {
      const plan = readJsonFile(lastFlag(args.flags, 'plan'), '--plan')
      const approval = lastFlag(args.flags, 'approved') ?? lastFlag(args.flags, 'approval-token')
      if (!approval) die('apply 必须带 --approved <计划批准令牌>')
      const result = await mods.codeMod.applyCodePlan(root, plan, approval)
      printCodeResult(result, json)
      return result.ok ? EXIT_OK : EXIT_ISSUES
    }
    if (action === 'undo') {
      const planId = lastFlag(args.flags, 'plan-id')
      if (!planId) die('undo 必须带 --plan-id <已应用计划 id>')
      const record = await mods.codeMod.loadCodeRecord(root, planId)
      const result = await mods.codeMod.undoCodePatch(root, record)
      printCodeResult(result, json)
      return result.ok ? EXIT_OK : EXIT_ISSUES
    }
    die(`不认识的源码动作「${action}」`)
  } catch (error) {
    const failure = codeError(error)
    if (json) printJson({ ok: false, action, error: failure })
    else process.stderr.write(`[${failure.code}] ${failure.message}\n`)
    return EXIT_ISSUES
  }
}

async function cmdChat(mods, args) {
  const action = args.positional[0]
  if (action !== 'replay') die('用法：sciviz chat replay <session.jsonl> [--until seq] [--dry-run] [--json]')
  const filename = args.positional[1]
  if (!filename) die('用法：sciviz chat replay <session.jsonl> [--until seq] [--dry-run] [--json]')
  const lines = fs.readFileSync(path.resolve(filename), 'utf8').split(/\r?\n/)
  const until = lastFlag(args.flags, 'until') === undefined ? undefined : Number(lastFlag(args.flags, 'until'))
  const replay = mods.replayMod.replaySession(lines, until)
  const result = {
    ok: true,
    file: path.resolve(filename),
    dryRun: hasFlag(args.flags, 'dry-run'),
    readOnly: mods.replayMod.replayIsReadOnly(replay),
    ...replay,
  }
  if (hasFlag(args.flags, 'json')) printJson(result)
  else process.stdout.write(`回放 ${filename}\n  事件 ${result.events.length} · 用户消息 ${result.userMessages.length} · 工具调用 ${result.toolCalls} · 写动作 ${result.writes}\n  ${result.readOnly ? '只读' : '含写动作（默认不执行）'}${result.dryRun ? ' · dry-run 仅比较纯读证据' : ''}\n`)
  return EXIT_OK
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从零创建一份可被界面、CLI 与 MCP 共用的工程文件。
 *
 * 这里故意只调用工程 IR 的现有构造与序列化：不能为 CLI 另造一份“最小 YAML”，
 * 否则新工程一旦被 UI 打开就会出现身份、版本或默认字段的第二套口径。
 */
function cmdNew(mods, args) {
  const requested = args.positional[0]
  if (!requested) die('用法：sciviz new <文件.sciviz> [--name 名称] [--description 描述] [--force] [--json]')
  const file = path.resolve(requested)
  if (path.extname(file).toLowerCase() !== '.sciviz') {
    die(`新工程文件必须使用 .sciviz 扩展名：${requested}`)
  }
  if (fs.existsSync(file) && !hasFlag(args.flags, 'force')) {
    die(`工程文件已存在：${file}（如需覆盖请显式加 --force）`)
  }
  const fallbackName = path.basename(file, path.extname(file)) || '未命名工作区'
  const name = lastFlag(args.flags, 'name') ?? fallbackName
  const description = lastFlag(args.flags, 'description') ?? ''
  if (!name.trim()) die('--name 不能为空')

  const projectId = crypto.randomUUID()
  const graph = mods.defaultWorkflowMod.emptyWorkflow(`wf-${projectId.slice(0, 8)}`, name.trim())
  graph.description = description
  const project = mods.projectFileMod.emptyProject(graph)
  project.projectId = projectId
  project.description = description
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, mods.projectFileMod.projectToText(project), 'utf8')

  const result = { ok: true, file, projectId, name: project.name, created: true, overwritten: hasFlag(args.flags, 'force') }
  if (hasFlag(args.flags, 'json')) printJson(result)
  else process.stdout.write(`已创建工作区\n  文件：${file}\n  名称：${project.name}\n  工程身份：${projectId}\n`)
  return EXIT_OK
}

async function cmdCanvas(mods, args) {
  const action = lastFlag(args.flags, 'action')
  const actions = new Set(['status', 'new', 'inspect', 'patch', 'undo', 'run', 'screenshot'])
  if (!action || !actions.has(action)) {
    die('用法：sciviz canvas --action status|new|inspect|patch|undo|run|screenshot [--payload 请求.json] [--host 地址] [--json]')
  }
  const host = String(lastFlag(args.flags, 'host') ?? process.env.SCIVIZ_HOST ?? mods.hostMod.DEFAULT_HOST_URL).replace(/\/+$/, '')
  let payload = {}
  const payloadPath = lastFlag(args.flags, 'payload')
  if (payloadPath) {
    try {
      payload = JSON.parse(fs.readFileSync(path.resolve(payloadPath), 'utf8'))
    } catch (error) {
      die(`无法读取实时画布请求：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) die('--payload 必须是 JSON 对象')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 70000)
  try {
    const configResponse = await fetch(`${host}/agent/config`, { signal: controller.signal })
    if (!configResponse.ok) die(`本地宿主不可用：GET /agent/config 返回 HTTP ${configResponse.status}`)
    const config = await configResponse.json()
    if (typeof config?.token !== 'string' || !config.token) die('本地宿主没有返回 Agent 进程令牌')
    const response = await fetch(`${host}/agent/canvas/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sciviz-Agent-Token': config.token },
      body: JSON.stringify({ action, payload }),
      signal: controller.signal,
    })
    const text = await response.text()
    let result
    try { result = JSON.parse(text) } catch { result = { ok: false, error: { message: text || `HTTP ${response.status}` } } }
    if (!response.ok) die(`实时画布请求失败：${result?.detail ?? result?.error?.message ?? `HTTP ${response.status}`}`)
    if (hasFlag(args.flags, 'json')) printJson(result)
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result?.ok === false ? EXIT_ISSUES : EXIT_OK
  } catch (error) {
    if (error?.cliCode !== undefined) throw error
    const message = error?.name === 'AbortError' ? '实时画布请求超时' : error instanceof Error ? error.message : String(error)
    die(`无法连接实时画布宿主：${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function hashText(text) {
  return hashBytes(Buffer.from(text, 'utf8'))
}

function readScivizProject(mods, filename) {
  const file = path.resolve(filename)
  if (path.extname(file).toLowerCase() !== '.sciviz') die(`项目报告只支持 .sciviz 工程：${filename}`)
  if (!fs.existsSync(file)) die(`找不到工程文件：${file}`)
  const bytes = fs.readFileSync(file)
  const text = bytes.toString('utf8')
  const parsed = mods.projectFileMod.textToProject(text, undefined, path.basename(file, '.sciviz'), { preserveDatasetIds: true })
  if (!parsed.project) die(parsed.error ?? '工程文件读不出来')
  if (parsed.warnings.some((warning) => warning.startsWith('reports'))) {
    die(`工程报告结构有问题，为避免保存时丢失报告而停止：${parsed.warnings.filter((warning) => warning.startsWith('reports')).join('；')}`)
  }
  return { file, text, sha256: hashBytes(bytes), project: parsed.project }
}

function atomicWriteProject(filename, text, expectedSha256) {
  const currentBytes = fs.readFileSync(filename)
  if (hashBytes(currentBytes) !== expectedSha256) die('工程文件在操作期间发生变化，请重新读取报告清单后再试', EXIT_ISSUES)
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
    const latestBytes = fs.readFileSync(filename)
    if (hashBytes(latestBytes) !== expectedSha256) die('工程文件在写入前发生变化，请重新读取报告清单后再试', EXIT_ISSUES)
    fs.renameSync(temp, filename)
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}

function normalizeReportImages(entries) {
  if (!Array.isArray(entries)) die('报告 figures 必须是数组')
  return entries.map((entry, index) => {
    const figure = entry?.figure
    if (!figure || typeof figure !== 'object') die(`报告 figures[${index}] 缺少 figure`)
    if (typeof figure.dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(figure.dataUrl)) {
      die(`报告 figures[${index}] 不是有效的内嵌图像`)
    }
    const data = Buffer.from(figure.dataUrl.slice(figure.dataUrl.indexOf(',') + 1), 'base64')
    const digest = crypto.createHash('sha256').update(data).digest('hex')
    if (digest !== String(figure.sha256 ?? '').toLowerCase()) die(`报告 figures[${index}] 的 SHA-256 与图片内容不匹配`)
    if (!Number.isFinite(figure.width) || !Number.isFinite(figure.height) || figure.width <= 0 || figure.height <= 0) {
      die(`报告 figures[${index}] 缺少有效尺寸`)
    }
    const normalized = {
      dataUrl: figure.dataUrl,
      sha256: digest,
      ...(typeof figure.sourceFingerprintSha256 === 'string' ? { sourceFingerprintSha256: figure.sourceFingerprintSha256 } : {}),
      width: figure.width,
      height: figure.height,
      nodeId: String(figure.nodeId ?? ''),
      groupPath: Array.isArray(figure.groupPath) ? figure.groupPath.map(String) : [],
      label: String(figure.label ?? figure.nodeId ?? '图表'),
      runtimeId: String(figure.runtimeId ?? figure.nodeId ?? ''),
      portId: String(figure.portId ?? 'figure'),
    }
    return { figure: normalized, caption: String(entry.caption ?? normalized.label) }
  })
}

async function cmdReport(mods, args) {
  const filename = args.positional[0]
  const action = lastFlag(args.flags, 'action')
  if (!filename || !['list', 'read', 'save', 'delete'].includes(action)) {
    die('用法：sciviz report <工程.sciviz> --action list|read|save|delete [--report-id id] [--expected-sha256 sha] [--report input.json] [--json]')
  }
  const json = hasFlag(args.flags, 'json')
  let loaded
  try {
    loaded = readScivizProject(mods, filename)
    const { file, project } = loaded
    if (action === 'list') {
      const reports = project.reports.map((report) => ({
        id: report.id,
        title: report.title,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        markdownBytes: Buffer.byteLength(report.markdown, 'utf8'),
        figureCount: report.figures.length,
      }))
      const result = { ok: true, action, file, projectSha256: loaded.sha256, reports }
      if (json) printJson(result)
      else process.stdout.write(reports.length ? reports.map((report) => `${report.id}\t${report.title}\t${report.updatedAt}\t${report.figureCount} 张图`).join('\n') + '\n' : '工程内还没有项目报告\n')
      return EXIT_OK
    }

    const reportId = lastFlag(args.flags, 'report-id')
    if (action === 'read') {
      if (!reportId) die('report read 需要 --report-id')
      const report = project.reports.find((item) => item.id === reportId)
      if (!report) die(`找不到报告：${reportId}`, EXIT_ISSUES)
      const offset = Number(lastFlag(args.flags, 'offset') ?? 0)
      const limit = Number(lastFlag(args.flags, 'limit') ?? 12000)
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) die('--offset 与 --limit 必须是有效的非负/正整数')
      const pageSize = Math.min(limit, 24000)
      const nextOffset = Math.min(report.markdown.length, offset + pageSize)
      const result = { ok: true, action, file, projectSha256: loaded.sha256, report: { id: report.id, title: report.title, createdAt: report.createdAt, updatedAt: report.updatedAt, markdown: report.markdown.slice(offset, nextOffset), offset, nextOffset: nextOffset < report.markdown.length ? nextOffset : null, complete: nextOffset >= report.markdown.length, figures: report.figures } }
      if (json) printJson(result)
      else process.stdout.write(`${result.report.markdown}\n`)
      return EXIT_OK
    }

    const expected = lastFlag(args.flags, 'expected-sha256')
    if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) die(`${action} 必须带有效的 --expected-sha256（先调用 list 或 read）`)
    if (loaded.sha256 !== expected.toLowerCase()) die('工程文件已变化，请重新读取报告清单后再试', EXIT_ISSUES)

    if (action === 'delete') {
      if (!reportId) die('report delete 需要 --report-id')
      const index = project.reports.findIndex((item) => item.id === reportId)
      if (index < 0) die(`找不到报告：${reportId}`, EXIT_ISSUES)
      project.reports.splice(index, 1)
    } else {
      const input = readJsonFile(lastFlag(args.flags, 'report'), '--report')
      if (!input || typeof input !== 'object' || typeof input.title !== 'string' || typeof input.markdown !== 'string') {
        die('--report JSON 必须包含 title 与 markdown 字符串')
      }
      const id = String(input.id ?? reportId ?? crypto.randomUUID())
      const prior = project.reports.find((item) => item.id === id)
      if (reportId && reportId !== id) die('--report-id 与 JSON 中的 id 不一致')
      const now = new Date().toISOString()
      const materialized = mods.reportMod.materializeReportFigures(input.markdown, normalizeReportImages(input.figures ?? []))
      const next = {
        id,
        title: input.title.trim(),
        markdown: materialized.markdown,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
        ...(prior?.source ? { source: prior.source } : {}),
        figures: materialized.figures,
      }
      project.reports = prior
        ? project.reports.map((item) => item.id === id ? next : item)
        : [...project.reports, next]
    }

    mods.reportMod.validateProjectReports(project.reports)
    const output = mods.projectFileMod.projectToText(project)
    atomicWriteProject(file, output, expected.toLowerCase())
    const result = { ok: true, action, file, projectSha256: hashText(output), reports: project.reports.map(({ id, title, updatedAt, figures }) => ({ id, title, updatedAt, figureCount: figures.length })) }
    if (json) printJson(result)
    else process.stdout.write(action === 'delete' ? `已删除报告 ${reportId}\n` : `已保存报告 ${reportId ?? project.reports.at(-1)?.id}\n`)
    return EXIT_OK
  } catch (error) {
    if (error?.cliCode !== undefined) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (json) printJson({ ok: false, action, error: message })
    else process.stderr.write(`${message}\n`)
    return EXIT_ISSUES
  }
}

const USAGE = `sciviz —— SciViz 的机器操作入口

用法：
  sciviz new <文件.sciviz> [--name 名称] [--description 描述] [--force] [--json]
                                                从零创建一个工作区工程文件
  sciviz catalog [算子类型] [--json]        列出算子、端口、参数
  sciviz validate <文件.yaml> [--json]      静态校验一张图（L1）
         [--columns 名=列1,列2] [--time 名=列]
  sciviz plan <文件.yaml> [--data 名=文件.csv ...]   只看要算什么（不连引擎）
  sciviz run <文件.yaml> --data 名=文件.csv [...]    无头跑一遍，写运行清单与报告
         [--out 目录] [--host 地址] [--capture-figures] [--json]
  sciviz doctor [--host 地址] [--json]      环境自检：宿主在不在、能算什么
  sciviz patch <文件> --ops ops.json        改工程：一批动作，要么全过要么全不动
         [--dry-run] [--out 文件] [--upgrade] [--json]
  sciviz patch <文件> --undo                撤销上一次改动（用文件里记的反向动作）
  sciviz inspect <工程> [--node <id或唯一标签>] [--port <id>] [--rows N] [--image]
         [--from runs/<id>/run.json|latest] [--out 运行目录] [--json]
                                                发现并查看节点计算结果
  sciviz report <工程.sciviz> --action list|read|save|delete [--json]
         [--report-id id] [--expected-sha256 sha] [--report input.json]
                                                管理工程内的项目报告与图像
  sciviz canvas --action status|new|inspect|patch|undo|run|screenshot [--json]
         [--payload 请求.json] [--host 地址]
                                                直接操作当前前台 SciViz 页面
  sciviz code <根> --action list|search|read|check|plan|apply|undo [--json]
         --path 文件 [--start 行] [--end 行]
         --ops actions.json --out plan.json
         --plan plan.json --approved <批准令牌>
         --plan-id <已应用计划 id>
                                                受限源码读取与补丁闸门
  sciviz chat replay <session.jsonl> [--until seq] [--dry-run] [--json]
                                                确定性会话回放（默认不写盘）
  sciviz verify [夹具 id] [--host 地址] [--json]   注册式真值：把"算得对不对"真的核一遍
  sciviz explain <错误码> [--json]          一个错误码的触发条件与修复动作
  sciviz explain --list                     全部错误码

退出码：0 通过 ｜ 1 有问题（契约违约 / 节点失败 / 有节点没算） ｜ 2 用法或环境错误`

async function executeCli(argv = process.argv.slice(2)) {
  const sub = argv[0]
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return EXIT_OK
  }
  const args = parseArgs(argv.slice(1))
  const mods = await load()

  switch (sub) {
    case 'new':
      return cmdNew(mods, args)
    case 'canvas':
      return await cmdCanvas(mods, args)
    case 'report':
      return await cmdReport(mods, args)
    case 'catalog':
      return cmdCatalog(mods, args)
    case 'validate':
      return await cmdValidate(mods, args)
    case 'plan':
      return await cmdPlan(mods, args)
    case 'run':
      return await cmdRun(mods, args)
    case 'doctor':
      return await cmdDoctor(mods, args)
    case 'patch':
      return await cmdPatch(mods, args)
    case 'inspect':
      return await cmdInspect(mods, args)
    case 'verify':
      return await cmdVerify(mods, args)
    case 'explain':
      return cmdExplain(mods, args)
    case 'code':
      return await cmdCode(mods, args)
    case 'chat':
      return await cmdChat(mods, args)
    default:
      die(`不认识的子命令「${sub}」\n\n${USAGE}`)
  }
}

/** MCP 壳调用的进程内入口：返回 CLI 原样 stdout/stderr 与退出码。 */
export async function runCli(argv = process.argv.slice(2)) {
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  let out = ''
  let err = ''
  process.stdout.write = ((chunk) => { out += String(chunk); return true })
  process.stderr.write = ((chunk) => { err += String(chunk); return true })
  try {
    const code = await executeCli(argv)
    return { code: code ?? EXIT_OK, stdout: out, stderr: err }
  } catch (error) {
    err += `${error?.cliMessage ?? `sciviz 异常：${error?.stack ?? error}`}\n`
    return { code: error?.cliCode ?? EXIT_USAGE, stdout: out, stderr: err }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

const invokedDirectly = !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) {
  executeCli()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      process.stderr.write(`${err?.cliMessage ?? `sciviz 异常：${err?.stack ?? err}`}\n`)
      process.exitCode = err?.cliCode ?? EXIT_USAGE
    })
}
