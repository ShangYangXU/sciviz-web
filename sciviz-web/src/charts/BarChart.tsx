import { ChartFrame, type LegendItem } from './ChartFrame'
import { ChartEmpty } from './ChartEmpty'
import { makeBandScale, makeLinearScale } from './scales'
import { getPalette } from './palettes'
import { formatNumber, mean, stdError } from '../utils/stats'
import { axisLabel, type ChartProps } from './chartProps'

export function BarChart({ rows, columns, mapping, style, onHover, mini }: ChartProps) {
  const xCol = columns.find((c) => c.name === mapping.x)
  const yCol = columns.find((c) => c.name === mapping.y)

  if (!mapping.x || !mapping.y) {
    return <ChartEmpty message="请把分类列拖到 X 轴、数值列拖到 Y 轴" hint="柱状图会按 X 轴分类聚合 Y 轴的均值，并画出标准误误差棒" />
  }

  const palette = getPalette(style.palette)

  const categories = [...new Set(rows.map((r) => String(r[mapping.x])))]
  const groups = mapping.color ? [...new Set(rows.map((r) => String(r[mapping.color])))] : ['__single__']

  interface Cell {
    category: string
    group: string
    mean: number
    sem: number
    n: number
  }
  const cells: Cell[] = []
  for (const cat of categories) {
    for (const g of groups) {
      const vals = rows
        .filter((r) => String(r[mapping.x]) === cat && (g === '__single__' || String(r[mapping.color]) === g))
        .map((r) => Number(r[mapping.y]))
        .filter(Number.isFinite)
      if (!vals.length) continue
      cells.push({ category: cat, group: g, mean: mean(vals), sem: stdError(vals), n: vals.length })
    }
  }

  if (cells.length === 0) {
    return <ChartEmpty message="聚合后没有可用数据" hint="确认 Y 轴所选列是数值类型" />
  }

  const groupColor = (g: string, i: number) =>
    g === '__single__' ? palette.categorical[0] : palette.categorical[i % palette.categorical.length]

  const legend: LegendItem[] | undefined =
    mapping.color && groups.length > 1 ? groups.map((g, i) => ({ label: g, color: groupColor(g, i) })) : undefined

  const maxTop = Math.max(...cells.map((c) => c.mean + c.sem))

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
        const xScale = makeBandScale(categories, [0, width], 0.25, (v) => v, 12)
        const yScale = makeLinearScale([0, maxTop], [height, 0], 6, formatNumber)
        const slot = xScale.bandwidth / groups.length

        const marks = (
          <g>
            {cells.map((c) => {
              const gi = groups.indexOf(c.group)
              const x = xScale.map(c.category) + gi * slot
              const y = yScale.map(c.mean)
              const barW = Math.max(2, slot * 0.82)
              const top = yScale.map(c.mean + c.sem)
              const bottom = yScale.map(c.mean - c.sem)
              const cx = x + barW / 2
              return (
                <g key={`${c.category}-${c.group}`}>
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={Math.max(0, height - y)}
                    fill={groupColor(c.group, gi)}
                    opacity={style.opacity}
                    onMouseMove={(e) =>
                      onHover(e, [
                        `${mapping.x} = ${c.category}`,
                        ...(c.group === '__single__' ? [] : [`${mapping.color} = ${c.group}`]),
                        `均值 = ${formatNumber(c.mean)}`,
                        `SEM = ±${formatNumber(c.sem)}`,
                        `n = ${c.n}`,
                      ])
                    }
                  />
                  {/* 误差棒 */}
                  <line x1={cx} x2={cx} y1={top} y2={bottom} stroke="#20262c" strokeWidth={1.2} />
                  <line x1={cx - barW * 0.22} x2={cx + barW * 0.22} y1={top} y2={top} stroke="#20262c" strokeWidth={1.2} />
                  <line x1={cx - barW * 0.22} x2={cx + barW * 0.22} y1={bottom} y2={bottom} stroke="#20262c" strokeWidth={1.2} />
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
