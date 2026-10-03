/**
 * 盲测回归（G4）：**只通过命令行**走完 agent 的一整圈。
 *
 * 判据来自 Agent 面设计 §10：agent 不读源码、不看界面、不提问，也要能
 * 读（catalog）→ 写（patch）→ 判（validate / explain）→ 跑（run / inspect）→ 报（report.md）。
 *
 * 三件事让这个脚本与 e2e / verify 各守一段：
 *
 * 1. **它不 import `src/`**。每一步都是真的起一个 `sciviz` 进程，拿 stdout 的 JSON 说话 ——
 *    一旦 import 了源码，这条用例就变成"读过源码的人当然能跑通"，而它要否定的正是这个。
 * 2. **它不猜接口**。要用哪个算子、参数叫什么、端口叫什么，全部从 `catalog --json` 里取；
 *    取不到就是缺陷（G1 的自描述性），而不是"脚本里写死一个也能跑"。
 * 3. **数字要独立算**。输入行数与首行读数由脚本自己知道，
 *    不是从引擎抄的 —— 抄来的数只能证明"它和上次跑得一样"。
 *
 * 用法：
 *   node scripts/agent-blind.mjs                 # 需要一个在跑的宿主（sciviz-local\run-host.ps1）
 *   node scripts/agent-blind.mjs --keep          # 保留工作目录（默认也保留，路径会打出来）
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '..')
const CLI = path.join(HERE, 'sciviz.mjs')

const rows = 512

const steps = []
let failed = 0

function ok(name, detail = '') {
  steps.push({ name, ok: true, detail })
  console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`)
}

function bad(name, detail) {
  failed += 1
  steps.push({ name, ok: false, detail })
  console.log(`  FAIL  ${name}  — ${detail}`)
}

function assert(name, cond, detail) {
  if (cond) ok(name, detail)
  else bad(name, detail)
  return !!cond
}

/** 起一个 sciviz 进程。cwd 固定在 sciviz-web（tsx 在那儿），文件一律用绝对路径 */
function sciviz(args, { expect = 0 } = {}) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: WEB,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  if (expect !== null && out.code !== expect) {
    throw new Error(
      `sciviz ${args.join(' ')} 退出码 ${out.code}（期望 ${expect}）\n${out.stderr || out.stdout}`,
    )
  }
  return out
}

function json(text, what) {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`${what} 的 stdout 不是纯 JSON：${err.message}\n${text.slice(0, 400)}`)
  }
}

/* ------------------------------------------------------------------ */

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const work = path.join(WEB, '.tmp', 'blind', stamp)
fs.mkdirSync(work, { recursive: true })
console.log(`=== 盲测（agent 面）===\n工作目录：${path.relative(WEB, work)}\n`)

const projectPath = path.join(work, 'project.sciviz')
const csvPath = path.join(work, 'data.csv')
const opsPath = path.join(work, 'ops.json')
/** http 或 ws 都行：同一条地址的两种写法（`probeHost` 与适配器各自归一） */
const host = process.env.SCIVIZ_HOST ?? 'http://127.0.0.1:8765'

try {
  /* ---------------- 0. 环境：宿主在不在 ---------------- */
  {
    const doc = json(sciviz(['doctor', '--json', '--host', host]).stdout, 'doctor')
    assert(
      '宿主可用（医生自检）',
      doc.ok === true && doc.host?.up === true,
      `${doc.host?.engine ?? ''} · 设备 ${doc.host?.device?.backend ?? '未知'}`,
    )
  }

  /* ---------------- 1. 读：catalog --json ---------------- */
  let catalog
  {
    catalog = json(sciviz(['catalog', '--json']).stdout, 'catalog')
    const ops = catalog.operators ?? []
    assert('catalog 列出了算子', ops.length >= 8, `${ops.length} 个算子`)

    // G1 自描述性：agent 要靠这些字段判断"能不能用、可不可复现、在哪儿跑"
    const need = ['version', 'implementationHash', 'runtime', 'determinism', 'execClass', 'requires']
    const missing = []
    for (const op of ops) for (const k of need) if (!(k in op)) missing.push(`${op.type}.${k}`)
    assert('每个算子都带全七项事实', missing.length === 0, missing.slice(0, 5).join('、') || '七项齐全')

    const byType = new Map(ops.map((o) => [o.type, o]))
    for (const t of ['data.source', 'data.preview', 'viz.chart', 'train.mlp']) {
      assert(`清单里有 ${t}`, byType.has(t), byType.get(t)?.label ?? '')
    }
    // 端口与参数必须能从清单里读出来 —— 盲测的"不猜接口"全靠它
    const preview = byType.get('data.preview')
    const keys = (preview?.params ?? []).map((p) => p.key)
    assert('预览参数能从清单里读到', keys.includes('rows'), keys.join(' / '))
    assert(
      '预览的输入输出端口能从清单里读到',
      (preview?.inputs ?? []).some((p) => p.id === 'data') && (preview?.outputs ?? []).some((p) => p.id === 'head'),
      `${(preview?.inputs ?? []).map((p) => p.id)} → ${(preview?.outputs ?? []).map((p) => p.id)}`,
    )
  }

  /* ---------------- 2. 造一份数据（独立于引擎） ---------------- */
  {
    const lines = ['时间,液位']
    const base = new Date(2024, 0, 1, 0, 0, 0).getTime()
    const pad = (v) => String(v).padStart(2, '0')
    for (let i = 0; i < rows; i += 1) {
      const d = new Date(base + i * 1000)
      const stampText =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      lines.push(`${stampText},${(50 + 10 * Math.sin(i / 20)).toFixed(3)}`)
    }
    fs.writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8')
    ok('造了一份确定的输入', `${rows} 行 · 1 Hz · 液位 = 50 + 10·sin(i/20)`)
  }

  /* ---------------- 3. 写：patch 把图搭起来 ---------------- */
  {
    // 空图不被接受（解析器要求至少一个节点），所以种子这一步只能手写 —— 这本身是
    // agent 面的一个真实摩擦：**"从零开始"这件事没有命令行入口**。记在返回值里
    fs.writeFileSync(
      projectPath,
      [
        'version: 1',
        'name: 盲测',
        'nodes:',
        '  - id: src',
        '    type: data.source',
        '    label: 数据',
        '    params: { datasetId: fixture }',
        '    position: { x: 0, y: 0 }',
        'edges: []',
        '',
      ].join('\n'),
      'utf8',
    )
    const before = fs.readFileSync(projectPath, 'utf8')

    const ops = {
      reason: '盲测：把 数据 → 预览 → 图表 搭起来',
      ops: [
        { op: 'addNode', id: 'preview', type: 'data.preview', position: { x: 220, y: 0 } },
        { op: 'addNode', id: 'chart', type: 'viz.chart', position: { x: 440, y: 0 } },
        { op: 'setParam', id: 'preview', key: 'rows', value: 10 },
        { op: 'connect', source: 'src', sourcePort: '__table__', target: 'preview', targetPort: 'data' },
        { op: 'connect', source: 'preview', sourcePort: 'head', target: 'chart', targetPort: 'data' },
      ],
    }
    fs.writeFileSync(opsPath, `${JSON.stringify(ops, null, 2)}\n`, 'utf8')

    const dry = json(
      sciviz(['patch', projectPath, '--ops', opsPath, '--dry-run', '--json']).stdout,
      'patch --dry-run',
    )
    assert(
      '--dry-run 只说不做',
      fs.readFileSync(projectPath, 'utf8') === before && (dry.changes ?? []).length >= 5,
      `${(dry.changes ?? []).length} 处改动，文件没动`,
    )

    const applied = json(
      sciviz(['patch', projectPath, '--ops', opsPath, '--json']).stdout,
      'patch',
    )
    assert('补丁真的写进去了', (applied.changes ?? []).length >= 5, `${applied.changes.length} 处改动`)
  }

  /* ---------------- 4. 判：validate ---------------- */
  {
    const v = json(sciviz(['validate', projectPath, '--json']).stdout, 'validate')
    assert('搭出来的图过 L1', v.ok === true, `${v.errors?.length ?? 0} 个错误 · ${v.warnings?.length ?? 0} 个告警`)
  }

  /* ---------------- 5. 跑：run ---------------- */
  const runOnce = () => {
    const out = json(
      sciviz(['run', projectPath, '--data', `fixture=${csvPath}`, '--out', path.join(work, 'runs'), '--host', host, '--json']).stdout,
      'run',
    )
    return out
  }
  let first
  {
    first = runOnce()
    assert('跑完了', first.status === 'done', `${first.nodes?.length ?? 0} 个节点`)
    const previewNode = (first.nodes ?? []).find((n) => n.nodeId === 'preview')
    const got = previewNode?.outputs?.head?.rowCount
    assert(
      '预览的行数与独立知道的输入一致',
      typeof got === 'number' && got === rows,
      `引擎 ${got}，输入 ${rows}`,
    )
    assert('运行清单落盘', fs.existsSync(path.join(first.manifestPath ?? '')), first.manifestPath ?? '')
    assert('报告落盘', fs.existsSync(path.join(first.reportPath ?? '')), first.reportPath ?? '')
  }

  /* ---------------- 6. 取数：inspect ---------------- */
  {
    const head = json(
      sciviz([
        'inspect',
        projectPath,
        '--node',
        'preview',
        '--rows',
        '1',
        '--data',
        `fixture=${csvPath}`,
        '--host',
        host,
        '--json',
      ]).stdout,
      'inspect',
    )
    const table = head.head?.table
    const value = table?.rows?.[0]?.[table.columns?.indexOf('液位') ?? 0]
    const expectedMean = 50
    assert(
      '省略 --port 时按真实输出自动选中唯一表端口',
      head.head?.portId === 'head',
      `选中 ${head.head?.portId ?? '（无）'}，预期 head`,
    )
    assert(
      '取到的是真数（与独立知道的首行一致）',
      typeof value === 'number' && Math.abs(value - expectedMean) < 1e-3,
      `引擎 ${value}，输入 ${expectedMean}`,
    )

    const latest = json(
      sciviz([
        'inspect',
        projectPath,
        '--from',
        'latest',
        '--out',
        path.join(work, 'runs'),
        '--node',
        '数据预览',
        '--json',
      ]).stdout,
      'inspect --from latest',
    )
    const latestNode = latest.nodes?.[0]
    assert(
      '最近运行可按唯一标签发现结果，不必猜 run.json 路径与节点 id',
      latest.source === 'manifest' &&
        latestNode?.nodeId === 'preview' &&
        latestNode?.inspectablePorts?.some((port) => port.portId === 'head' && port.rows === true) &&
        typeof latestNode?.fingerprint === 'string',
      `${latestNode?.label ?? '（无）'} · ${latestNode?.inspectablePorts?.map((port) => port.portId).join('/') ?? '无端口'}`,
    )
  }

  /* ---------------- 7. 故意做一次错改：拿到错误码 ---------------- */
  let badCode
  {
    const ops = {
      reason: '盲测：故意把图的输出接到表的输入上',
      ops: [
        { op: 'addNode', id: 'bad', type: 'data.collect', position: { x: 0, y: 200 } },
        { op: 'connect', source: 'chart', sourcePort: 'figure', target: 'bad', targetPort: 'in' },
      ],
    }
    fs.writeFileSync(opsPath, `${JSON.stringify(ops, null, 2)}\n`, 'utf8')
    const res = sciviz(['patch', projectPath, '--ops', opsPath, '--json'], { expect: null })
    const body = json(res.stdout, 'patch（错改）')
    badCode = body.rejections?.[0]?.code
    assert(
      '错改被拦住，而且给了错误码',
      res.code !== 0 && typeof badCode === 'string',
      `${badCode}：${body.rejections?.[0]?.message ?? ''}`,
    )
    // 原子性：一条被拒，整批不落盘
    const after = json(sciviz(['validate', projectPath, '--json']).stdout, 'validate（错改之后）')
    assert('被拒的补丁没有留下半截改动', after.ok === true, '图仍然合法')
  }

  /* ---------------- 8. 查码：explain ---------------- */
  {
    const def = json(sciviz(['explain', badCode, '--json']).stdout, 'explain')
    assert(
      '错误码自带"怎么修"',
      !!def.action && Array.isArray(def.fixes) && def.fixes.length > 0,
      `${def.action}（可用动作：${(def.fixes ?? []).join(' / ')}）`,
    )
  }

  /* ---------------- 9. 改对 + 复跑 + 撤销 ---------------- */
  {
    const ops = {
      reason: '盲测：把预览行数改成 20',
      ops: [{ op: 'setParam', id: 'preview', key: 'rows', value: 20 }],
    }
    fs.writeFileSync(opsPath, `${JSON.stringify(ops, null, 2)}\n`, 'utf8')
    sciviz(['patch', projectPath, '--ops', opsPath, '--json'])
    const again = runOnce()
    const got = (again.nodes ?? []).find((n) => n.nodeId === 'preview')?.outputs?.head?.rowCount
    assert(
      '改一处、重跑，输出仍保持原始行数',
      got === rows,
      `引擎 ${got}，输入 ${rows}`,
    )
    assert(
      '重跑后仍能得到图表输出',
      (again.nodes ?? []).some((n) => n.nodeId === 'chart' && n.outputs?.figure?.kind === 'figure'),
      '',
    )
    assert('报告里有这一次的结论', fs.readFileSync(again.reportPath, 'utf8').includes('预览'), again.reportPath)

    sciviz(['patch', projectPath, '--undo'])
    const undone = json(sciviz(['validate', projectPath, '--json']).stdout, 'validate（撤销之后）')
    const back = runOnce()
    const gotBack = (back.nodes ?? []).find((n) => n.nodeId === 'preview')?.outputs?.head?.rowCount
    assert(
      '撤销之后回到原来的图',
      undone.ok === true && gotBack === rows,
      `${gotBack} 行`,
    )
  }
} catch (err) {
  bad('盲测中断', String(err?.message ?? err))
}

console.log(
  `\n=== ${steps.filter((s) => s.ok).length}/${steps.length} 步通过 ===\n工作目录留在 ${path.relative(WEB, work)}`,
)
process.exit(failed === 0 ? 0 : 1)
