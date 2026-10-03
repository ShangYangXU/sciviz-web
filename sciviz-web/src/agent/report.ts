/**
 * 报告渲染：**事实段由机器生成，叙述段由写报告的人补。**
 *
 * 为什么必须分两段（Agent面设计 §7）：一份整体是散文的报告无法被第二个人复核。
 * 事实段逐字来自 `run.json`，任何一条都能拿回去重跑；叙述段只允许引用事实段里
 * 已经出现的数字。混在一起，两者都失去可核性。
 *
 * 这里**只生成事实段**。叙述段留给调用方（人或 agent）自己写 —— 机器不编结论。
 */

import type { OutputSummary, RunManifest } from '../kernel/manifest'

/**
 * 本地时间。
 *
 * 刻意不用 `toISOString()`：它按 UTC 输出，于是北京时区下 13:37 的一次运行
 * 会在报告里写成 05:37 —— 报告是给人核对"什么时候跑的"用的，差 8 小时就是错的。
 */
const dt = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}
const num = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : String(Math.round(v))

const shortNum = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))
}

/** 一个输出端口"产出了什么"的一句话。给人快速扫结果用 */
function describeOutput(o: OutputSummary): string {
  switch (o.kind) {
    case 'table': {
      const size = `${o.rowCount ?? '?'} 行 × ${o.columns?.length ?? '?'} 列`
      const names = (o.columns ?? []).slice(0, 4).join(' · ')
      const more = (o.columns?.length ?? 0) > 4 ? ` …共 ${o.columns?.length} 列` : ''
      return `${size}${names ? ` —— ${names}${more}` : ''}`
    }
    case 'metrics': {
      const entries = Object.entries(o.values ?? {})
      if (entries.length === 0) return '（没有指标值）'
      return entries.map(([k, v]) => `${k}=${shortNum(v)}`).join(' · ')
    }
    case 'figure':
      return '图（配置见界面）'
    case 'model':
      return '模型'
    default:
      return String(o.kind)
  }
}

/** 字节数 → 人话。产物从几 KB 的 meta 到几个 GB 的权重都有，固定成一种单位不好读 */
function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function statusMark(status: string): string {
  switch (status) {
    case 'ready':
      return '✔ 已算'
    case 'error':
      return '✘ 失败'
    case 'blocked':
      return '⊘ 跳过（上游不可用）'
    case 'manual':
      return '□ 未计算（引擎未执行）'
    case 'computing':
      return '… 计算中'
    default:
      return '· 未求值'
  }
}

export function renderReport(manifest: RunManifest): string {
  const lines: string[] = []

  lines.push(`# 运行报告 · ${manifest.workflow.name}`)
  lines.push('')
  lines.push(`> 本报告的事实段由 \`run.json\` 生成，逐字可核。叙述段请追加在末尾。`)
  lines.push('')

  lines.push('## 事实')
  lines.push('')
  lines.push(`- 运行 id：\`${manifest.runId}\``)
  lines.push(
    `- 开始 / 结束（本地时间）：${dt(manifest.startedAt)} → ${dt(manifest.finishedAt)}（${manifest.durationMs} ms）`,
  )
  lines.push(`- 结论：**${statusText(manifest.status)}**`)
  lines.push(`- 图指纹：\`${manifest.graphFingerprint}\``)
  lines.push(`- 引擎：${manifest.engine.info}`)
  lines.push(`- 规模：${manifest.workflow.nodeCount} 节点 · ${manifest.workflow.edgeCount} 连线`)
  lines.push('')

  /*
   * 环境（R6.3）。放在最前面，因为它是**读这份报告的前提**：
   * 换台机器重跑结果对不上时，先看的就是这几行。
   */
  lines.push('### 环境')
  lines.push('')
  if (manifest.environment) {
    const env = manifest.environment
    lines.push(
      `- Python ${env.python} · numpy ${env.numpy} · pandas ${env.pandas}` +
        (env.scipy ? ` · scipy ${env.scipy}` : ' · scipy 未安装'),
    )
    lines.push(
      `- ${env.device === 'cuda' ? 'GPU' : 'CPU'}` +
        (env.gpuNames.length > 0 ? ` ${env.gpuNames.join('、')}` : '') +
        (env.totalMemoryMb ? `（${env.totalMemoryMb} MB）` : ''),
    )
    lines.push(`- torch ${env.torch ?? '未安装'} · CUDA ${env.cuda ?? '无'}`)
  } else {
    lines.push('- 没问到宿主的环境（`/health` 没答）。**这不等于这台机器什么都没有。**')
  }
  lines.push('')

  lines.push('### 数据集')
  lines.push('')
  if (manifest.datasets.length === 0) {
    lines.push('（本次运行没有用到数据集）')
  } else {
    lines.push('| 名称 | 行数 | 时间列 | 采样率 | 内容哈希 |')
    lines.push('|---|---|---|---|---|')
    for (const d of manifest.datasets) {
      lines.push(
        `| ${d.name} | ${d.rowCount} | ${d.timeColumn ?? '—'} | ${
          d.sampleRate === null ? '—' : `${d.sampleRate} Hz`
        } | \`${d.contentHash.slice(0, 22)}…\` |`,
      )
    }
  }
  lines.push('')

  lines.push('### 节点')
  lines.push('')
  lines.push('| 节点 | 算子 | 状态 | 输出版本 | 算子版本 | 实现 | 执行等级 | 耗时 | 指纹 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const n of manifest.nodes) {
    const op = n.operator
    lines.push(
      `| ${n.label} \`${n.nodeId}\` | ${n.nodeType} | ${statusMark(n.status)} | ${n.outputVersion} | ${
        op?.version ?? '—'
      } | ${op?.implementationHash ? op.implementationHash.slice(0, 8) : '—'} | ${op?.execClass ?? '—'} | ${num(
        n.durationMs,
      )} ms | \`${n.fingerprintShort ?? '—'}\` |`,
    )
  }
  lines.push('')

  const withOutputs = manifest.nodes.filter((n) => Object.keys(n.outputs ?? {}).length > 0)
  if (withOutputs.length > 0) {
    lines.push('### 输出')
    lines.push('')
    lines.push(
      '这一步产出了什么。行值不在这里（全表留在引擎侧），要看前几行用 `sciviz inspect --rows N`。',
    )
    lines.push('')
    for (const n of withOutputs) {
      for (const [portId, o] of Object.entries(n.outputs)) {
        lines.push(`- **${n.label}** \`${n.nodeId}\` → \`${portId}\`：${describeOutput(o)}`)
      }
    }
    lines.push('')
  }

  /*
   * 落盘的产物（T8）。**路径只是这台机器上的位置**，所以每条都带上"产出它的输入指纹" ——
   * 换台机器时能对上的是指纹，不是路径。
   */
  const withArtifacts = manifest.nodes.filter((n) => (n.artifacts ?? []).length > 0)
  if (withArtifacts.length > 0) {
    lines.push('### 落盘的产物')
    lines.push('')
    lines.push('写在宿主机器上。换台机器路径就不成立，所以同时记下**产出它的输入指纹**。')
    lines.push('')
    for (const n of withArtifacts) {
      for (const a of n.artifacts ?? []) {
        lines.push(
          `- **${n.label}** \`${a.kind}\`：\`${a.path}\`（${bytesText(a.bytes)}）` +
            (a.fingerprint ? ` · 指纹 \`${a.fingerprint.slice(0, 12)}…\`` : ''),
        )
      }
    }
    lines.push('')
  }

  /*
   * 节点自报的元信息（T11）。指标只收数值，所以"用了什么设备、哪一版实现"这类事实
   * 单独列 —— 同一张图在 CPU 上跑还是在 3050 上跑，指标看起来都对，靠这一行才分得开。
   */
  const withMeta = manifest.nodes.filter((n) => n.meta && Object.keys(n.meta).length > 0)
  if (withMeta.length > 0) {
    lines.push('### 节点自报的元信息')
    lines.push('')
    for (const n of withMeta) {
      const pairs = Object.entries(n.meta ?? {}).map(([k, v]) => `${k} ${v}`)
      lines.push(`- **${n.label}** \`${n.nodeId}\`：${pairs.join(' · ')}`)
    }
    lines.push('')
  }

  const failed = manifest.nodes.filter((n) => n.status === 'error')
  if (failed.length > 0) {
    lines.push('### 失败')
    lines.push('')
    for (const n of failed) {
      lines.push(`- **${n.label}**（\`${n.nodeId}\`）：${n.error?.message ?? '未知错误'}`)
      if (n.error?.traceback) {
        lines.push('')
        lines.push('  ```')
        for (const line of n.error.traceback.split('\n')) lines.push(`  ${line}`)
        lines.push('  ```')
      }
    }
    lines.push('')
  }

  if (manifest.notComputed.length > 0) {
    lines.push('### 没有计算的节点')
    lines.push('')
    lines.push('这些节点没有产出任何数值。**本报告不包含它们的结论。**')
    lines.push('')
    for (const n of manifest.notComputed) {
      lines.push(`- \`${n.nodeId}\`（${n.nodeType}）：${n.reason}`)
    }
    lines.push('')
  }

  /*
   * 复用了上一次结果的节点（T18）。
   *
   * 单列一节而不是塞进表格：缓存改写了"这次运行到底算了什么"，读报告的人有权一眼看到。
   * 只有 deterministic / seeded 的算子会出现在这里（R6.4）—— 两个训练算子声明
   * stochastic，它们永远重算，所以永远不会出现在这一节里。
   */
  const reused = manifest.nodes.filter((n) => n.reused)
  if (reused.length > 0) {
    lines.push('### 复用了上一次结果的节点')
    lines.push('')
    lines.push(
      `这 ${reused.length} 个节点的输入指纹与上一次相同，直接用了引擎里那份输出，**这次没有重算**。` +
        '（只有声明为 deterministic / seeded 的算子会被这样复用；stochastic 的一律重算。）',
    )
    lines.push('')
    for (const n of reused) {
      lines.push(`- **${n.label}** \`${n.nodeId}\`（${n.nodeType}）`)
    }
    lines.push('')
  }

  if (manifest.contract) {
    lines.push('### 契约校验（L1）')
    lines.push('')
    lines.push(
      manifest.contract.ok
        ? `- 通过（${manifest.contract.warnings.length} 条告警）`
        : `- **未通过**：${manifest.contract.errors.length} 个错误`,
    )
    for (const e of manifest.contract.errors) {
      lines.push(`  - \`${e.code}\` ${e.message}`)
    }
    for (const w of manifest.contract.warnings) {
      lines.push(`  - \`${w.code}\` ${w.message}`)
    }
    if (manifest.contract.notChecked.length > 0) {
      lines.push('')
      lines.push('本次没查的规则（不是通过，是还没有判据）：')
      for (const s of manifest.contract.notChecked) lines.push(`  - \`${s.code}\` —— ${s.reason}`)
    }
    lines.push('')
  }

  if (manifest.drift) {
    const d = manifest.drift
    lines.push('### 与上一次相比')
    lines.push('')
    lines.push(`上次运行：\`${d.previousRunId}\`${d.sameGraph ? '（同一张图）' : '（**不是同一张图**，数值未必可比）'}`)
    lines.push('')
    for (const s of d.summary) lines.push(`- ${s}`)
    if (d.changes.length > 0) {
      lines.push('')
      for (const c of d.changes.slice(0, 20)) {
        const rel =
          c.relDelta === undefined
            ? ''
            : `（${c.relDelta >= 0 ? '+' : ''}${(c.relDelta * 100).toFixed(2)}%）`
        lines.push(`- ${c.detail}${rel}`)
      }
      if (d.changes.length > 20) lines.push(`- …还有 ${d.changes.length - 20} 处`)
    }
    lines.push('')
  }

  lines.push('### 可复现性')
  lines.push('')
  lines.push('**这次用到的算子是哪一版实现**（R7）。哈希变了就是实现变了；哈希没变就去找参数或数据。')
  lines.push('')
  lines.push('| 算子 | 版本 | 实现哈希 |')
  lines.push('|---|---|---|')
  for (const o of manifest.operatorVersions) {
    lines.push(`| ${o.type} | ${o.version} | ${o.implementationHash ? `\`${o.implementationHash}\`` : '—（用户代码，实现在参数里）'} |`)
  }
  lines.push('')
  if (manifest.unreproducible.length === 0) {
    lines.push('- 没有**已知的**不可复现来源。（这不等于"结果必然逐位相同"。）')
  } else {
    lines.push('不可复现贡献项（R6）：下面这些节点的产物**不承诺**同输入同输出。')
    lines.push('')
    for (const u of manifest.unreproducible) {
      lines.push(`- **${u.label}** \`${u.nodeId}\`（${u.nodeType}，${u.determinism}）：${u.reason}`)
    }
  }
  lines.push('')

  lines.push('### 本次没有承诺的东西')
  lines.push('')
  for (const g of manifest.gaps) lines.push(`- ${g}`)
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## 叙述')
  lines.push('')
  lines.push('（由写报告的人或 agent 补。只允许引用上面出现过的数字。）')
  lines.push('')

  return lines.join('\n')
}

function statusText(status: RunManifest['status']): string {
  switch (status) {
    case 'done':
      return '全部算完'
    case 'partial':
      return '部分算完（有节点没有实现，见下）'
    case 'failed':
      return '有节点失败'
    case 'cancelled':
      return '被中断'
  }
}
