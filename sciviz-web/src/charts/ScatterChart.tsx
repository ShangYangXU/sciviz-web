import { ChartFrame, type LegendItem } from './ChartFrame'
import { ChartEmpty } from './ChartEmpty'
import { makeLinearScale, padDomain } from './scales'
import { buildColorScale, getPalette } from './palettes'
import { formatNumber } from '../utils/stats'
import { axisFormatter, axisLabel, extractPoints, hoverValue, type ChartProps } from './chartProps'

export function ScatterChart({ rows, columns, mapping, style, onHover, mini }: ChartProps) {
  const xCol = columns.find((c) => c.name === mapping.x)
  const yCol = columns.find((c) => c.name === mapping.y)
  const colorCol = columns.find((c) => c.name === mapping.color)
  const colorIsContinuous = colorCol?.role === 'continuous'

  const palette = getPalette(style.palette)
  const rawColorValues = mapping.color ? rows.map((r) => String(r[mapping.color])) : []
  const colorScale = buildColorScale(rawColorValues, palette, !!colorIsContinuous)
  const colorOf = (v: string | null) => (v === null ? palette.categorical[0] : (colorScale.map.get(v) ?? palette.categorical[0]))

  const pts = extractPoints(rows, mapping, colorOf)
  const missing = rows.length - pts.length

  if (!mapping.x || !mapping.y) {
    return <ChartEmpty message="请先把字段拖到 X 轴和 Y 轴" hint="从左侧列列表中拖拽列名到右侧的映射槽位" />
  }
  if (pts.length === 0) {
    return <ChartEmpty message="当前映射下没有可用的数值点" hint="检查所选列是否为数值类型" />
  }

  const legend: LegendItem[] | undefined =
    mapping.color && !colorIsContinuous
      ? colorScale.domain.map((v) => ({ label: v, color: colorScale.map.get(v)! }))
      : undefined

  const gradientLegend =
    mapping.color && colorIsContinuous
      ? (() => {
          const nums = colorScale.domain.map(Number).filter(Number.isFinite)
          return {
            colors: palette.sequential,
            minLabel: formatNumber(Math.min(...nums)),
            maxLabel: formatNumber(Math.max(...nums)),
          }
        })()
      : undefined

  // 节点里的缩略图面积很小；点数很多时降低点径和不透明度，避免重叠成一团黑。
  const denseMini = mini && pts.length > 1200
  const pointSize = denseMini ? Math.min(style.pointSize, 1.4) : style.pointSize
  const pointOpacity = denseMini ? Math.min(style.opacity, 0.32) : style.opacity

  return (
    <ChartFrame
      mini={mini}
      title={style.title}
      xLabel={style.xLabel || axisLabel(xCol, 'X')}
      yLabel={style.yLabel || axisLabel(yCol, 'Y')}
      showGrid={style.showGrid}
      showLegend={style.showLegend}
      legend={legend}
      gradientLegend={gradientLegend}
      build={({ width, height }) => {
        const xDom = padDomain(Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.x)))
        const yDom = padDomain(Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.y)))
        const xScale = makeLinearScale(xDom, [0, width], 6, axisFormatter(xCol, xDom))
        const yScale = makeLinearScale(yDom, [height, 0], 6, axisFormatter(yCol, yDom))

        const marks = (
          <g>
            {pts.map((p, i) => (
              <circle
                key={i}
                cx={xScale.map(p.x)}
                cy={yScale.map(p.y)}
                r={pointSize}
                fill={p.color!}
                opacity={pointOpacity}
                onMouseMove={(e) =>
                  onHover(e, [
                    `${mapping.x} = ${hoverValue(xCol, p.x)}`,
                    `${mapping.y} = ${hoverValue(yCol, p.y)}`,
                    ...(p.colorValue !== null ? [`${mapping.color} = ${p.colorValue}`] : []),
                  ])
                }
              />
            ))}
            {missing > 0 && (
              <text x={6} y={height - 6} fontSize={10} fill="#9aa3ad">
                已忽略 {missing} 行缺失值
              </text>
            )}
          </g>
        )
        return { xScale, yScale, marks }
      }}
    />
  )
}
