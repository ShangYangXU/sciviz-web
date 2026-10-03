import { ChartFrame, type LegendItem } from './ChartFrame'
import { ChartEmpty } from './ChartEmpty'
import { makeBandScale, makeLinearScale } from './scales'
import { getPalette } from './palettes'
import { boxStats, formatNumber } from '../utils/stats'
import { axisLabel, type ChartProps } from './chartProps'

export function BoxChart({ rows, columns, mapping, style, onHover, mini }: ChartProps) {
  const xCol = columns.find((c) => c.name === mapping.x)
  const yCol = columns.find((c) => c.name === mapping.y)

  if (!mapping.x || !mapping.y) {
    return <ChartEmpty message="请把分类列拖到 X 轴、数值列拖到 Y 轴" hint="箱线图展示每个分类下数值的四分位数与离群点" />
  }

  const palette = getPalette(style.palette)
  const categories = [...new Set(rows.map((r) => String(r[mapping.x])))]
  const groups = mapping.color ? [...new Set(rows.map((r) => String(r[mapping.color])))] : ['__single__']

  const cells = categories.flatMap((cat) =>
    groups.flatMap((g) => {
      const vals = rows
        .filter((r) => String(r[mapping.x]) === cat && (g === '__single__' || String(r[mapping.color]) === g))
        .map((r) => Number(r[mapping.y]))
        .filter(Number.isFinite)
      if (vals.length < 2) return []
      return [{ category: cat, group: g, stats: boxStats(vals) }]
    }),
  )

  if (cells.length === 0) {
    return <ChartEmpty message="分组后没有足够的数值样本" hint="每组至少需要 2 个有效数值" />
  }

  const groupColor = (g: string, i: number) =>
    g === '__single__' ? palette.categorical[0] : palette.categorical[i % palette.categorical.length]

  const legend: LegendItem[] | undefined =
    mapping.color && groups.length > 1 ? groups.map((g, i) => ({ label: g, color: groupColor(g, i) })) : undefined

  const lo = Math.min(...cells.map((c) => Math.min(c.stats.min, ...c.stats.outliers)))
  const hi = Math.max(...cells.map((c) => Math.max(c.stats.max, ...c.stats.outliers)))

  return (
    <ChartFrame
      mini={mini}
      title={style.title}
      xLabel={style.xLabel || (xCol ? xCol.name : 'X')}
      yLabel={style.yLabel || axisLabel(yCol, 'Y')}
      showGrid={style.showGrid}
      showLegend={style.showLegend}
      legend={legend}
      build={({ width, height }) => {
        const xScale = makeBandScale(categories, [0, width], 0.3, (v) => v, 12)
        const yScale = makeLinearScale([lo, hi], [height, 0], 6, formatNumber)
        const slot = xScale.bandwidth / groups.length

        const marks = (
          <g>
            {cells.map((c) => {
              const gi = groups.indexOf(c.group)
              const boxW = Math.max(6, slot * 0.6)
              const cx = xScale.map(c.category) + gi * slot + slot / 2
              const s = c.stats
              const hover = (e: React.MouseEvent) =>
                onHover(e, [
                  `${mapping.x} = ${c.category}`,
                  ...(c.group === '__single__' ? [] : [`${mapping.color} = ${c.group}`]),
                  `中位数 = ${formatNumber(s.median)}`,
                  `Q1 / Q3 = ${formatNumber(s.q1)} / ${formatNumber(s.q3)}`,
                  `范围 = ${formatNumber(s.min)} ~ ${formatNumber(s.max)}`,
                  `n = ${s.n}${s.outliers.length ? ` · 离群 ${s.outliers.length}` : ''}`,
                ])

              return (
                <g key={`${c.category}-${c.group}`}>
                  {/* 须 */}
                  <line x1={cx} x2={cx} y1={yScale.map(s.max)} y2={yScale.map(s.q3)} stroke="#3d4752" strokeWidth={1.2} />
                  <line x1={cx} x2={cx} y1={yScale.map(s.q1)} y2={yScale.map(s.min)} stroke="#3d4752" strokeWidth={1.2} />
                  <line x1={cx - boxW * 0.3} x2={cx + boxW * 0.3} y1={yScale.map(s.max)} y2={yScale.map(s.max)} stroke="#3d4752" strokeWidth={1.2} />
                  <line x1={cx - boxW * 0.3} x2={cx + boxW * 0.3} y1={yScale.map(s.min)} y2={yScale.map(s.min)} stroke="#3d4752" strokeWidth={1.2} />
                  {/* 箱体 */}
                  <rect
                    x={cx - boxW / 2}
                    y={yScale.map(s.q3)}
                    width={boxW}
                    height={Math.max(1, yScale.map(s.q1) - yScale.map(s.q3))}
                    fill={groupColor(c.group, gi)}
                    opacity={style.opacity}
                    stroke="#20262c"
                    strokeWidth={1}
                    onMouseMove={hover}
                  />
                  {/* 中位数 */}
                  <line x1={cx - boxW / 2} x2={cx + boxW / 2} y1={yScale.map(s.median)} y2={yScale.map(s.median)} stroke="#20262c" strokeWidth={2.2} />
                  {/* 离群点 */}
                  {s.outliers.map((o, oi) => (
                    <circle
                      key={oi}
                      cx={cx}
                      cy={yScale.map(o)}
                      r={Math.max(1.6, style.pointSize - 1.6)}
                      fill="none"
                      stroke="#20262c"
                      strokeWidth={1}
                      onMouseMove={hover}
                    />
                  ))}
                </g>
              )
            })}
          </g>
        )
        return { xScale, yScale, marks }
      }}
    />
  )
}
