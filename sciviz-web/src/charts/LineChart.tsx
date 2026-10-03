import { line as d3line } from 'd3'
import { ChartFrame, type LegendItem } from './ChartFrame'
import { ChartEmpty } from './ChartEmpty'
import { makeLinearScale, padDomain } from './scales'
import { getPalette } from './palettes'
import { axisFormatter, axisLabel, hoverValue, type ChartProps } from './chartProps'

export function LineChart({ rows, columns, mapping, style, onHover, mini }: ChartProps) {
  const xCol = columns.find((c) => c.name === mapping.x)
  const yCol = columns.find((c) => c.name === mapping.y)

  if (!mapping.x || !mapping.y) {
    return <ChartEmpty message="请先把字段拖到 X 轴和 Y 轴" hint="折线图用颜色槽位区分多条序列" />
  }

  const palette = getPalette(style.palette)

  // 按颜色列分组，未映射颜色时视为单条序列
  const groups = new Map<string, { x: number; y: number }[]>()
  for (const r of rows) {
    const x = Number(r[mapping.x])
    const y = Number(r[mapping.y])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const key = mapping.color ? String(r[mapping.color]) : '__single__'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ x, y })
  }

  const series = [...groups.entries()].map(([key, points], i) => ({
    key,
    points: [...points].sort((a, b) => a.x - b.x),
    color: key === '__single__' ? palette.categorical[0] : palette.categorical[i % palette.categorical.length],
  }))

  if (series.length === 0) {
    return <ChartEmpty message="当前映射下没有可用的数值点" hint="检查所选列是否为数值类型" />
  }

  const legend: LegendItem[] | undefined =
    mapping.color && series.length > 1
      ? series.map((s) => ({ label: s.key, color: s.color }))
      : undefined

  const allPts = series.flatMap((s) => s.points)
  const minX = Math.min(...allPts.map((p) => p.x))
  const maxX = Math.max(...allPts.map((p) => p.x))
  const minY = Math.min(...allPts.map((p) => p.y))
  const maxY = Math.max(...allPts.map((p) => p.y))

  return (
    <ChartFrame
      mini={mini}
      title={style.title}
      xLabel={style.xLabel || axisLabel(xCol, 'X')}
      yLabel={style.yLabel || axisLabel(yCol, 'Y')}
      showGrid={style.showGrid}
      showLegend={style.showLegend}
      legend={legend}
      build={({ width, height }) => {
        const xDom = padDomain(minX, maxX, 0.04)
        const yDom = padDomain(minY, maxY)
        const xScale = makeLinearScale(xDom, [0, width], 6, axisFormatter(xCol, xDom))
        const yScale = makeLinearScale(yDom, [height, 0], 6, axisFormatter(yCol, yDom))

        const path = d3line<{ x: number; y: number }>()
          .x((d) => xScale.map(d.x))
          .y((d) => yScale.map(d.y))

        const marks = (
          <g>
            {series.map((s) => (
              <g key={s.key}>
                <path
                  d={path(s.points) ?? ''}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  opacity={style.opacity}
                />
                {s.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={xScale.map(p.x)}
                    cy={yScale.map(p.y)}
                    r={Math.max(1.8, style.pointSize - 1.2)}
                    fill={s.color}
                    onMouseMove={(e) =>
                      onHover(e, [
                        `${mapping.x} = ${hoverValue(xCol, p.x)}`,
                        `${mapping.y} = ${hoverValue(yCol, p.y)}`,
                        ...(s.key === '__single__' ? [] : [`${mapping.color} = ${s.key}`]),
                      ])
                    }
                  />
                ))}
              </g>
            ))}
          </g>
        )
        return { xScale, yScale, marks }
      }}
    />
  )
}
