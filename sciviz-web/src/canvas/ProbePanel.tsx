import { useEffect, useState } from 'react'
import { head as fetchHead } from '../engine/backend'
import {
  headKey,
  useEngineInfo,
  useHead,
  useNodeOutputStore,
  useNodeRefs,
  useNodeRuntime,
} from '../store/nodeOutputStore'
import { formatNumber } from '../utils/stats'

/**
 * 数据探针的显示部分。
 *
 * 三条规矩：
 * 1. **显示的是上游的输出，不是探针自己的**。探针的输出只是原样透传，显示它等于绕一圈看自己。
 * 2. 全表在 Python 侧，这里只按需拉前 N 行，并按 version 缓存 —— 所以改行数不会让上游重算。
 * 3. 拿不到值就如实说拿不到（出错给 traceback），绝不用别的数据顶替。
 */

interface Props {
  /** 上游节点与端口。null 表示还没接线 */
  upstreamNodeId: string | null
  upstreamPortId: string | null
  upstreamLabel: string
  rows: number
}

export function ProbePanel({ upstreamNodeId, upstreamPortId, upstreamLabel, rows }: Props) {
  if (!upstreamNodeId || !upstreamPortId) {
    return <div className="wf-preview-note">先接一个数据端口</div>
  }
  return (
    <Connected
      nodeId={upstreamNodeId}
      portId={upstreamPortId}
      label={upstreamLabel}
      rows={rows}
    />
  )
}

function Connected({
  nodeId,
  portId,
  label,
  rows,
}: {
  nodeId: string
  portId: string
  label: string
  rows: number
}) {
  const runtime = useNodeRuntime(nodeId)
  const refs = useNodeRefs(nodeId)
  const engine = useEngineInfo()
  const ref = refs?.[portId]
  // 上游节点自报的元信息（设备、版本…）：输出摘要的数值里放不下它
  const metaText = runtime.meta ? Object.entries(runtime.meta).map(([k, v]) => `${k} ${v}`).join(' · ') : ''

  const cacheKey = ref && ref.kind === 'table' ? headKey(nodeId, portId, ref.version, rows) : null
  const table = useHead(cacheKey)
  const [headError, setHeadError] = useState<string | null>(null)

  useEffect(() => {
    if (!cacheKey || table || runtime.status !== 'ready') return
    let cancelled = false
    setHeadError(null)
    fetchHead(nodeId, portId, rows)
      .then((t) => {
        if (!cancelled) useNodeOutputStore.getState().putHead(cacheKey, t)
      })
      .catch((err: unknown) => {
        if (!cancelled) setHeadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, table, runtime.status, nodeId, portId, rows])

  // 判定顺序：**先看有没有输出，再看状态**。
  // 先看有没有输出，状态只在没有输出时用来解释原因。
  if (!ref) {
    if (runtime.status === 'error') {
      return (
        <div className="wf-preview-err">
          <div className="wf-preview-err-msg">{runtime.error?.message ?? '上游出错'}</div>
          {runtime.error?.traceback ? (
            <details className="wf-preview-tb">
              <summary>traceback</summary>
              <pre>{runtime.error.traceback}</pre>
            </details>
          ) : null}
        </div>
      )
    }
    if (runtime.status === 'blocked') {
      return <div className="wf-preview-note">{runtime.error?.message ?? '上游未产出，本步未计算'}</div>
    }
    // 引擎起不来时明说引擎的问题，而不是含糊地"等待上游求值"
    if (engine.status === 'failed') {
      return <div className="wf-preview-note">执行引擎未就绪：{engine.detail || '未知原因'}</div>
    }
    if (runtime.status === 'ready') return <div className="wf-preview-note">该输出端口本次没有值</div>
    return (
      <div className="wf-preview-note">
        {runtime.status === 'computing' ? '读取上游…' : '等待上游求值…'}
      </div>
    )
  }

  if (ref.kind === 'metrics') {
    const entries = Object.entries(ref.values ?? {})
    return (
      <div className="wf-preview">
        <div className="wf-preview-head">
        <span className="wf-preview-from">来自 {label}</span>
        {metaText ? (
          <span className="wf-preview-meta" title={metaText}>
            {metaText}
          </span>
        ) : null}
        </div>
        {entries.length === 0 ? (
          <div className="wf-preview-note">没有可显示的指标</div>
        ) : (
          <div className="wf-metrics">
            {entries.map(([k, v]) => (
              <div key={k} className="wf-metric">
                <span className="wf-metric-k">{k}</span>
                <span className="wf-metric-v">{v === null ? '—' : formatNumber(v)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (ref.kind !== 'table') {
    return (
      <div className="wf-preview">
        <div className="wf-preview-head">
          <span className="wf-preview-from">来自 {label}</span>
        </div>
        <div className="wf-preview-note">这个输出是「{ref.kind}」，当前还不能在这里预览</div>
      </div>
    )
  }

  return (
    <div className="wf-preview">
      <div className="wf-preview-head">
        <span className="wf-preview-from">来自 {label}</span>
        <span className="wf-preview-total">
          {(ref.rowCount ?? 0).toLocaleString('en-US')} 行
          {ref.columns ? ` · ${ref.columns.length} 列` : ''}
        </span>
        {runtime.status === 'computing' ? <span className="wf-preview-busy">重算中</span> : null}
      </div>

      {headError ? (
        <div className="wf-preview-err-msg">{headError}</div>
      ) : !table ? (
        <div className="wf-preview-note">读取前 {rows} 行…</div>
      ) : (
        <div className="wf-preview-scroll">
          <table className="wf-preview-table">
            <thead>
              <tr>
                <th className="i">#</th>
                {table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, ri) => (
                <tr key={ri}>
                  <td className="i">{ri}</td>
                  {row.map((v, ci) =>
                    table.columns[ci] === table.timeColumn ? (
                      <td key={ci} className="t">
                        {fmtCellTime(v)}
                      </td>
                    ) : (
                      <td key={ci} className={v === 0 ? 'z' : ''}>
                        {fmtCell(v)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * 一个格子的显示值。
 *
 * **字符串原样显示**：引擎的输出表里有非数值列（混淆矩阵的类别名、训练曲线的曲线名），
 * 一律按数字格式化会把它们全变成"—" —— 数值是对的，只是没显示出来。
 */
function fmtCell(v: number | string | null): string {
  if (typeof v === 'string') return v
  if (v === null) return '—'
  return formatNumber(v)
}

/** 节点框宽度有限，时间用短格式；完整时间留给详情面板里的表格 */
function fmtCellTime(value: number | string | null): string {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
