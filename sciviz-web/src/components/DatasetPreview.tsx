import { useMemo } from 'react'
import { getStoredDataset } from '../store/useDataStore'
import { resolveDatasetView } from '../store/useDataStore'
import {
  ROW_VIEW_COLUMN,
  TIME_VIEW_COLUMN,
  countTimeGaps,
  countTimeMisalignment,
} from '../data/columnStore'
import { getPalette } from '../charts/palettes'

interface Props {
  datasetId: string
}

const LANE_H = 46
const PLOT_W = 820
const AXIS_W = 118
const HEAD_ROWS = 40

function fmtTime(s: number): string {
  const d = new Date(s * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtNum(v: number): string {
  const abs = Math.abs(v)
  if (!Number.isFinite(v)) return '—'
  if (abs >= 1e6 || (abs > 0 && abs < 1e-3)) return v.toExponential(1)
  if (abs >= 1000) return v.toFixed(0)
  if (abs >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

/**
 * 数据集的真实面貌：多泳道时序总览 + 列统计 + 开头若干行原值。
 *
 * 存在的理由：数据集资产此前只呈现成"104.8 万行 × 10 列"一个数字，
 * 而停机段在哪、哪列全是 0、时间轴断了几次，恰恰是调筛选函数时真正要看的东西。
 */
export function DatasetPreview({ datasetId }: Props) {
  const ds = getStoredDataset(datasetId)

  const model = useMemo(() => {
    if (!ds) return null
    const cols = ds.columns.filter((c) => c.enabled && c.name in ds.data)
    // 总览用抽稀视图（≤900 点），原值表格直接读列式数组，两者用途不同
    const view = resolveDatasetView(ds.id, 900, 'envelope')
    if (!view) return null
    const pts = view.rows

    const hasTime = !!ds.time && pts.length > 0
    const t0 = hasTime ? (pts[0][TIME_VIEW_COLUMN] as number) : 0
    const t1 = hasTime ? (pts[pts.length - 1][TIME_VIEW_COLUMN] as number) : 1

    const lanes = cols.map((c) => {
      let min = Infinity
      let max = -Infinity
      for (const r of pts) {
        const v = r[c.name] as number
        if (!Number.isFinite(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
      if (!Number.isFinite(min)) {
        min = 0
        max = 1
      }
      if (max - min < 1e-9) max = min + 1
      const path = pts
        .map((r, i) => {
          const v = r[c.name] as number
          const x = hasTime ? ((r[TIME_VIEW_COLUMN] as number) - t0) / (t1 - t0 || 1) : i / (pts.length || 1)
          const y = 1 - (v - min) / (max - min)
          return `${(x * PLOT_W).toFixed(1)},${(y * (LANE_H - 8) + 4).toFixed(1)}`
        })
        .join(' ')
      return { name: c.name, min, max, path, stats: c.stats }
    })

    // 全零区间 = 停机段的特征。用抽稀点判定足够定位，且不会漏掉整段停机
    const deadSpans: { x0: number; x1: number }[] = []
    if (cols.length > 0) {
      let runStart = -1
      pts.forEach((r, i) => {
        const dead = cols.every((c) => Number(r[c.name]) === 0)
        const at = () => (i / Math.max(1, pts.length - 1)) * PLOT_W
        if (dead && runStart < 0) runStart = at()
        if (!dead && runStart >= 0) {
          deadSpans.push({ x0: runStart, x1: at() })
          runStart = -1
        }
      })
      if (runStart >= 0) deadSpans.push({ x0: runStart, x1: PLOT_W })
    }

    const head: Record<string, number>[] = []
    const n = Math.min(HEAD_ROWS, ds.rowCount)
    for (let i = 0; i < n; i++) {
      const row: Record<string, number> = { _row: i }
      if (ds.time) row[TIME_VIEW_COLUMN] = ds.time[i]
      for (const c of cols) row[c.name] = ds.data[c.name][i]
      head.push(row)
    }

    return {
      cols,
      lanes,
      deadSpans,
      head,
      hasTime,
      t0,
      t1,
      viewRows: pts.length,
      gaps: countTimeGaps(ds),
      misalign: countTimeMisalignment(ds, view),
    }
  }, [ds])

  if (!ds) {
    return (
      <div className="hint-box">
        还没有可预览的数据。请先导入 CSV，并将数据源节点连接到这里。
      </div>
    )
  }
  if (!model) return null

  const palette = getPalette('okabe-ito')
  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="ds-preview">
      {/* ---------- 时序总览 ---------- */}
      <div className="dp-section">
        <div className="dp-title">
          时序总览
          <span className="dp-sub">
            {model.viewRows.toLocaleString('en-US')} 点（min/max 包络抽稀自 {ds.rowCount.toLocaleString('en-US')} 行）
          </span>
        </div>
        <svg
          className="dp-svg"
          width={AXIS_W + PLOT_W + 8}
          height={model.lanes.length * LANE_H + 22}
          role="img"
          aria-label="多列时序总览"
        >
          {model.lanes.map((lane, li) => (
            <g key={lane.name} transform={`translate(${AXIS_W}, ${li * LANE_H})`}>
              <rect className="dp-lane-bg" width={PLOT_W} height={LANE_H - 4} />
              {model.deadSpans.map((s, si) => (
                <rect
                  key={si}
                  className="dp-dead"
                  x={s.x0}
                  width={Math.max(1.5, s.x1 - s.x0)}
                  height={LANE_H - 4}
                />
              ))}
              <polyline
                points={lane.path}
                fill="none"
                stroke={palette.categorical[li % palette.categorical.length]}
                strokeWidth={1.1}
              />
              <text className="dp-lane-name" x={-AXIS_W + 4} y={LANE_H / 2 - 4}>
                {lane.name}
              </text>
              <text className="dp-lane-range" x={-AXIS_W + 4} y={LANE_H / 2 + 8}>
                {fmtNum(lane.min)} ~ {fmtNum(lane.max)}
              </text>
            </g>
          ))}
          <g transform={`translate(${AXIS_W}, ${model.lanes.length * LANE_H})`}>
            {ticks.map((f) => (
              <text key={f} className="dp-tick" x={f * PLOT_W} y={10}>
                {model.hasTime ? fmtTime(model.t0 + f * (model.t1 - model.t0)) : String(Math.round(f * ds.rowCount))}
              </text>
            ))}
          </g>
        </svg>
        <div className="dp-legend">
          <span className="dp-dead-chip" />
          全零区间（停机/吹扫）· 共 {model.deadSpans.length} 处
        </div>
      </div>

      {/* ---------- 列统计 ---------- */}
      <div className="dp-section">
        <div className="dp-title">
          列统计
          <span className="dp-sub">导入时在 Worker 里全量算好，非抽样</span>
        </div>
        <table className="dp-stats">
          <thead>
            <tr>
              <th>列</th>
              <th className="num">最小</th>
              <th className="num">最大</th>
              <th className="num">均值</th>
              <th>零值占比</th>
            </tr>
          </thead>
          <tbody>
            {model.cols.map((c) => {
              const pct = ds.rowCount > 0 ? (c.stats.zeros / ds.rowCount) * 100 : 0
              return (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td className="num">{fmtNum(c.stats.min)}</td>
                  <td className="num">{fmtNum(c.stats.max)}</td>
                  <td className="num">{fmtNum(c.stats.mean)}</td>
                  <td>
                    <span className="dp-bar-wrap">
                      <span className={`dp-bar ${pct > 50 ? 'high' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                      <em>{pct.toFixed(1)}%</em>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* ---------- 原值前若干行 ---------- */}
      <div className="dp-section">
        <div className="dp-title">
          前 {model.head.length} 行原值
          <span className="dp-sub">直接读列式存储，未经抽稀</span>
        </div>
        <div className="dp-table-scroll">
          <table className="dp-table">
            <thead>
              <tr>
                <th className="num">原始行号</th>
                {model.hasTime && <th>时间</th>}
                {model.cols.map((c) => (
                  <th key={c.name} className="num">
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.head.map((r) => (
                <tr key={r[ROW_VIEW_COLUMN]}>
                  <td className="num">{r[ROW_VIEW_COLUMN]}</td>
                  {model.hasTime && <td>{new Date(r[TIME_VIEW_COLUMN] * 1000).toLocaleString('zh-CN', { hour12: false })}</td>}
                  {model.cols.map((c) => (
                    <td key={c.name} className={`num ${r[c.name] === 0 ? 'is-zero' : ''}`}>
                      {fmtNum(r[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------- 时间轴完整性 ---------- */}
      <div className={`dp-integrity ${model.misalign < 0 ? 'warn' : model.misalign > 0 ? 'bad' : ''}`}>
        {model.misalign < 0 ? (
          <>视图行缺少 <code>{ROW_VIEW_COLUMN}</code> 主键，无法校验时间对齐</>
        ) : model.misalign > 0 ? (
          <>时间轴对齐校验失败：{model.misalign} 行的时间戳与 ds.time[{ROW_VIEW_COLUMN}] 不一致</>
        ) : (
          <>
            时间轴对齐校验通过（每行时间戳 == ds.time[{ROW_VIEW_COLUMN}]）· 按 {ds.stepSeconds ?? '?'}s 步长，
            时间轴断裂 {model.gaps.toLocaleString('en-US')} 处
          </>
        )}
      </div>
    </div>
  )
}
