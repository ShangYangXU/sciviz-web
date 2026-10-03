import { ChartFrame, type LegendItem } from './ChartFrame'
import { ChartEmpty } from './ChartEmpty'
import { makeBandScale, makeLinearScale } from './scales'
import { getPalette } from './palettes'
import { formatNumber, histogramBins } from '../utils/stats'
import { axisLabel, type ChartProps } from './chartProps'

export function HistogramChart({ rows, columns, mapping, style, onHover, mini }: ChartProps) {
  const xCol = columns.find((c) => c.name === mapping.x)

  if (!mapping.x) {
    return <ChartEmpty message="请把数值列拖到 X 轴" hint="直方图统计单个连续变量的分布" />
  }

  const palette = getPalette(style.palette)
  const values = rows.map((r) => Number(r[mapping.x])).filter(Number.isFinite)

  if (values.length === 0) {
    return <ChartEmpty message="所选列没有可用的数值" hint="检查列类型是否为数值型" />
  }

  const bins = histogramBins(values)
  const groups = mapping.color ? [...new Set(rows.map((r) => String(r[mapping.color])))] : ['__single__']

  const binWidth = bins[0].x1 - bins[0].x0
  const series = groups.map((g, i) => {
    const subset = rows.filter((r) => g === '__single__' || String(r[mapping.color]) === g)
    const counts = bins.map(() => 0)
    for (const r of subset) {
      const v = Number(r[mapping.x])
      if (!Number.isFinite(v)) continue
      let idx = Math.floor((v - bins[0].x0) / binWidth)
      if (idx >= bins.length) idx = bins.length - 1
      if (idx < 0) continue
      counts[idx]++
    }
    return {
      key: g,
      counts,
      color: g === '__single__' ? palette.categorical[0] : palette.categorical[i % palette.categorical.length],
    }
  })

  const maxCount = Math.max(...series.flatMap((s) => s.counts), 1)
  const legend: LegendItem[] | undefined =
    mapping.color && groups.length > 1 ? series.map((s) => ({ label: s.key, color: s.color })) : undefined
  const binCenters = bins.map((b) => (b.x0 + b.x1) / 2)

  return (
    <ChartFrame
      mini={mini}
      title={style.title}
      xLabel={style.xLabel || axisLabel(xCol, 'X')}
      yLabel={style.yLabel || '频数'}
      showGrid={style.showGrid}
      showLegend={style.showLegend}
      legend={legend}
      build={({ width, height }) => {
        const xScale = makeBandScale(
          binCenters.map((c) => String(c)),
          [0, width],
          0.06,
          (v) => formatNumber(Number(v)),
          9,
        )
        const yScale = makeLinearScale([0, maxCount], [height, 0], 6, (v) => String(Math.round(v)))

        const marks = (
          <g>
            {series.map((s) => (
              <g key={s.key}>
                {bins.map((b, i) => {
                  const x = xScale.map(String(binCenters[i]))
                  const barW = Math.max(1, xScale.bandwidth)
                  const y = yScale.map(s.counts[i])
                  return (
                    <rect
                      key={i}
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(0, height - y)}
                      fill={s.color}
                      opacity={series.length > 1 ? 0.55 : style.opacity}
                      stroke={s.color}
                      strokeWidth={series.length > 1 ? 0.8 : 0}
                      onMouseMove={(e) =>
                        onHover(e, [
                          `${mapping.x} ∈ [${formatNumber(b.x0)}, ${formatNumber(b.x1)}]`,
                          ...(s.key === '__single__' ? [] : [`${mapping.color} = ${s.key}`]),
                          `频数 = ${s.counts[i]}`,
                        ])
                      }
                    />
                  )
                })}
              </g>
            ))}
            <text x={width - 6} y={16} textAnchor="end" fontSize={10.5} fill="#9aa3ad">
              n = {values.length} · {bins.length} 个分组
            </text>
            {series.length > 1 && (
              <text x={width - 6} y={30} textAnchor="end" fontSize={10.5} fill="#9aa3ad">
                多组重叠显示（半透明）
              </text>
            )}
            <text x={6} y={height - 6} fontSize={10} fill="#9aa3ad">
              组距 = {formatNumber(binWidth)}
            </text>
          </g>
        )
        return { xScale, yScale, marks }
      }}
    />
  )
}
