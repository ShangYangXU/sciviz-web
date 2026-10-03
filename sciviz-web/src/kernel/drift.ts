/**
 * 跨运行对比（契约规格 §7 的 L3）。
 *
 * 为什么它重要：**同一张图跑两遍，数值应当一致。** 不一致就是不可复现 ——
 * 而不可复现是这类工具最不能出的问题。所以这里不是"锦上添花的统计"，
 * 它是"可复现"这个主张的机器判据。
 *
 * 对比的粒度分三层，从粗到细：
 * 1. **图变了没有**（图指纹）：变了的话，下面的数值差异都不必看 —— 那是两张图；
 * 2. **节点层面**：新增/消失/状态变化/耗时变化；
 * 3. **数值层面**：同一端口同一指标的值变了多少。
 */

import type { RunManifest } from './manifest'

export type DriftKind = 'added' | 'removed' | 'status' | 'output' | 'duration' | 'value'

export interface DriftChange {
  kind: DriftKind
  nodeId: string
  label: string
  /** 人话。直接进报告 */
  detail: string
  portId?: string
  metric?: string
  from?: number | string | null
  to?: number | string | null
  /** 相对变化，(to-from)/|from|。from 为 0 或非数值时为 undefined */
  relDelta?: number
}

export interface DriftReport {
  previousRunId: string
  /** 两张图的图指纹是否一致。不一致时数值差异没有意义 */
  sameGraph: boolean
  changes: DriftChange[]
  /** 结论用的人话。没有值得提的差异时只有一条"没有变化" */
  summary: string[]
}

/**
 * 耗时差异要同时越过这两道门槛才提。
 *
 * 只看比例会被毫秒级抖动刷屏（5ms → 11ms 是 +120%，但毫无信息量）；
 * 只看绝对值又会漏掉"3 秒变成 8 秒"这种。所以两个都要过。
 */
const DURATION_TOLERANCE = 0.25
const DURATION_MIN_ABS_MS = 50

function relDelta(from: number, to: number): number | undefined {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return undefined
  return (to - from) / Math.abs(from)
}

const fmt = (v: number | string | null | undefined): string => {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (!Number.isFinite(v)) return '—'
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)))
}

export function compareManifests(previous: RunManifest, current: RunManifest): DriftReport {
  const changes: DriftChange[] = []
  const sameGraph = previous.graphFingerprint === current.graphFingerprint

  const prevNodes = new Map(previous.nodes.map((n) => [n.nodeId, n]))
  const curNodes = new Map(current.nodes.map((n) => [n.nodeId, n]))

  for (const [id, node] of curNodes) {
    const before = prevNodes.get(id)
    if (!before) {
      changes.push({ kind: 'added', nodeId: id, label: node.label, detail: `新增节点「${node.label}」（${node.nodeType}）` })
      continue
    }
    if (before.status !== node.status) {
      changes.push({
        kind: 'status',
        nodeId: id,
        label: node.label,
        detail: `「${node.label}」的状态从 ${before.status} 变成 ${node.status}`,
        from: before.status,
        to: node.status,
      })
    }
    if (
      before.durationMs !== null &&
      node.durationMs !== null &&
      before.durationMs > 0 &&
      Math.abs(node.durationMs - before.durationMs) >= DURATION_MIN_ABS_MS &&
      Math.abs(node.durationMs - before.durationMs) / before.durationMs > DURATION_TOLERANCE
    ) {
      changes.push({
        kind: 'duration',
        nodeId: id,
        label: node.label,
        detail: `「${node.label}」耗时从 ${before.durationMs} ms 变成 ${node.durationMs} ms`,
        from: before.durationMs,
        to: node.durationMs,
      })
    }

    /* ---------------- 输出层 ---------------- */
    const ports = new Set([...Object.keys(before.outputs ?? {}), ...Object.keys(node.outputs ?? {})])
    for (const portId of ports) {
      const a = before.outputs?.[portId]
      const b = node.outputs?.[portId]
      if (!a && b) {
        changes.push({ kind: 'output', nodeId: id, label: node.label, portId, detail: `「${node.label}」多了输出端口 ${portId}` })
        continue
      }
      if (a && !b) {
        changes.push({ kind: 'output', nodeId: id, label: node.label, portId, detail: `「${node.label}」不再有输出端口 ${portId}` })
        continue
      }
      if (!a || !b) continue

      if (a.rowCount !== b.rowCount) {
        changes.push({
          kind: 'value',
          nodeId: id,
          label: node.label,
          portId,
          metric: '行数',
          from: a.rowCount ?? null,
          to: b.rowCount ?? null,
          detail: `「${node.label}」${portId} 的行数从 ${fmt(a.rowCount)} 变成 ${fmt(b.rowCount)}`,
        })
      }
      if ((a.columns?.length ?? 0) !== (b.columns?.length ?? 0)) {
        changes.push({
          kind: 'output',
          nodeId: id,
          label: node.label,
          portId,
          detail: `「${node.label}」${portId} 的列数从 ${a.columns?.length ?? 0} 变成 ${b.columns?.length ?? 0}`,
        })
      }

      const metrics = new Set([...Object.keys(a.values ?? {}), ...Object.keys(b.values ?? {})])
      for (const metric of metrics) {
        const av = a.values?.[metric] ?? null
        const bv = b.values?.[metric] ?? null
        if (av === bv) continue
        const change: DriftChange = {
          kind: 'value',
          nodeId: id,
          label: node.label,
          portId,
          metric,
          from: av,
          to: bv,
          detail: `「${node.label}」${portId} 的 ${metric} 从 ${fmt(av)} 变成 ${fmt(bv)}`,
        }
        // NaN 与 null 之间不算"漂移"，那是"这次没算出来"，如实说就好
        if (typeof av === 'number' && typeof bv === 'number') {
          const rel = relDelta(av, bv)
          if (rel !== undefined) change.relDelta = rel
        }
        changes.push(change)
      }
    }
  }

  for (const [id, node] of prevNodes) {
    if (!curNodes.has(id)) {
      changes.push({ kind: 'removed', nodeId: id, label: node.label, detail: `这次没有节点「${node.label}」（${node.nodeType}）` })
    }
  }

  return { previousRunId: previous.runId, sameGraph, changes, summary: summarize(changes, sameGraph, previous) }
}

function summarize(changes: DriftChange[], sameGraph: boolean, previous: RunManifest): string[] {
  const lines: string[] = []
  if (changes.length === 0) {
    if (sameGraph) {
      lines.push(
        `没有变化：与上次（${previous.runId}）是同一张图，数值与状态一致 —— 这是"可复现"成立的证据`,
      )
    } else {
      // 图指纹变了而结果一样：图改过，只是改动没有影响这次的结果。
      // 这仍然要说出来 —— 否则读的人会以为"什么都没改过"。
      lines.push(
        `节点与数值都与上次（${previous.runId}）一致，但**图指纹不同**：图改过，只是这次改动没有影响结果`,
      )
    }
    return lines
  }
  lines.push(
    sameGraph
      ? `与上次（${previous.runId}）同一张图，但有 ${changes.length} 处差异`
      : `与上次（${previous.runId}）**不是同一张图** —— 下面的数值差异未必可比`,
  )
  const byKind = (k: DriftKind) => changes.filter((c) => c.kind === k)
  const valueChanges = byKind('value')
  const flaky = valueChanges.filter((c) => c.relDelta !== undefined && Math.abs(c.relDelta) > 1e-9)
  if (sameGraph && flaky.length > 0) {
    // 同一张图、值却变了 —— 这是最需要人看的一类
    lines.push(
      `⚠ 同一张图，但 ${flaky.length} 个数值对不上（例如 ${flaky[0].metric}：${fmt(flaky[0].from)} → ${fmt(flaky[0].to)}）。` +
        '要么这一步不可复现，要么有别的东西在变 —— 值得查。',
    )
  }
  for (const k of ['added', 'removed', 'status', 'output', 'value', 'duration'] as DriftKind[]) {
    const n = byKind(k).length
    if (n > 0) lines.push(`  · ${kindLabel(k)} ${n} 处`)
  }
  return lines
}

function kindLabel(k: DriftKind): string {
  switch (k) {
    case 'added':
      return '新增节点'
    case 'removed':
      return '消失的节点'
    case 'status':
      return '状态变化'
    case 'output':
      return '输出结构变化'
    case 'value':
      return '数值变化'
    case 'duration':
      return '耗时变化'
  }
}
