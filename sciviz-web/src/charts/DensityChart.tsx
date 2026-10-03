import { ChartFrame } from './ChartFrame'
import { ChartEmpty } from './ChartEmpty'
import { makeLinearScale } from './scales'
import { getPalette } from './palettes'
import { axisFormatter, axisLabel, hoverValue, type ChartProps } from './chartProps'
import { formatNumber, kernelDensity } from '../utils/stats'

/**
 * 概率密度图。
 *
 * 只看一列数据，所以映射只用 X 槽位。曲线用高斯核密度估计，
 * 带宽走 Silverman 经验法则（可在节点上手动覆盖）。
 *
 * 和直方图的分工：直方图的形状会随分箱数变，密度图不受这个影响，
 * 更适合横向比较几组数据的分布形态。
 */
export function DensityChart({ rows, columns, mapping, style, onHover, mini }: ChartProps) {
  const xCol = columns.find((c) => c.name === mapping.x)

  if (!mapping.x) {
    return <ChartEmpty message="这一列数据还没接上" hint="把上游的特征端口连到这个节点的输入端口" />
  }

  const values = rows.map((r) => Number(r[mapping.x])).filter(Number.isFinite)
  if (values.length < 2) {
    return <ChartEmpty message="有效数据点不足" hint="概率密度估计至少需要 2 个有效数值" />
  }

  const d = kernelDensity(values, { bandwidth: style.bandwidth })
  if (!d) return <ChartEmpty message="无法估计概率密度" />

  const palette = getPalette(style.palette)
  const color = palette.categorical[0]

  /*
   * 点质量检测。
   *
   * 真实工业数据里常有大量重复值（典型是停机段的 0）。这会让 IQR 被压到接近 0，
   * Silverman 算出的带宽随之变小，曲线在那个值上形成一个极窄的尖峰，尾部被压平。
   * 这不是画错了，是数据本身长这样 —— 但必须在图上说明，
   * 否则看图的人会以为工具算坏了。
   */
  const pointMass = (() => {
    const freq = new Map<number, number>()
    for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1)
    let bestV = 0
    let bestC = 0
    for (const [v, c] of freq) {
      if (c > bestC) {
        bestC = c
        bestV = v
      }
    }
    const ratio = bestC / values.length
    return ratio >= 0.2 ? { value: bestV, ratio } : null
  })()

  const xMin = d.points[0].x
  const xMax = d.points[d.points.length - 1].x
  const yMax = d.peak * 1.1

  const showStats = style.showStats !== false

  return (
    <ChartFrame
      mini={mini}
      title={style.title}
      xLabel={style.xLabel || axisLabel(xCol, 'X')}
      yLabel={style.yLabel || '概率密度'}
      showGrid={style.showGrid}
      showLegend={false}
      build={({ width, height }) => {
        const xDom: [number, number] = [xMin, xMax]
        const yDom: [number, number] = [0, yMax]
        const xScale = makeLinearScale(xDom, [0, width], 6, axisFormatter(xCol, xDom))
        const yScale = makeLinearScale(yDom, [height, 0], 5, formatNumber)

        const toPath = (pts: typeof d.points) =>
          pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale.map(p.x)},${yScale.map(p.y)}`).join(' ')

        const line = toPath(d.points)
        const baseline = yScale.map(0)
        const area = `${line} L${xScale.map(xMax)},${baseline} L${xScale.map(xMin)},${baseline} Z`

        const marks = (
          <g>
            <path d={area} fill={color} opacity={0.18} />
            <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />

            {showStats && (
              <g pointerEvents="none">
                <line
                  x1={xScale.map(d.mean)}
                  x2={xScale.map(d.mean)}
                  y1={0}
                  y2={height}
                  stroke="#c0392b"
                  strokeWidth={1.3}
                  strokeDasharray="5 4"
                />
                <line
                  x1={xScale.map(d.median)}
                  x2={xScale.map(d.median)}
                  y1={0}
                  y2={height}
                  stroke="#2e7d32"
                  strokeWidth={1.3}
                  strokeDasharray="2 3"
                />
                <text x={xScale.map(d.mean) + 5} y={13} fontSize={10.5} fill="#c0392b">
                  均值 {formatNumber(d.mean)}
                </text>
                <text x={xScale.map(d.median) + 5} y={26} fontSize={10.5} fill="#2e7d32">
                  中位数 {formatNumber(d.median)}
                </text>
              </g>
            )}

            {/* 样本量与带宽如实标出来，避免看图的人不知道平滑程度 */}
            <text x={width - 4} y={height - 20} textAnchor="end" fontSize={10.5} fill="#9aa3ad">
              n = {d.n.toLocaleString('en-US')} · σ = {formatNumber(d.std)}
            </text>
            <text x={width - 4} y={height - 6} textAnchor="end" fontSize={10.5} fill="#9aa3ad">
              带宽 h = {formatNumber(d.bandwidth)}
              {d.autoBandwidth ? '（Silverman 自动）' : '（手动指定）'}
            </text>

            {pointMass && (
              <text x={6} y={height - 6} fontSize={10} fill="#c0392b">
                ⚠ {(pointMass.ratio * 100).toFixed(0)}% 的值都是 {formatNumber(pointMass.value)}
                ，曲线在那里是尖峰、尾部被压平
              </text>
            )}

            {/* 透明覆盖层：把鼠标位置换算成曲线上最近的点来做提示 */}
            <rect
              x={0}
              y={0}
              width={width}
              height={height}
              fill="transparent"
              style={{ cursor: 'crosshair' }}
              onMouseMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                const t = r.width > 0 ? (e.clientX - r.left) / r.width : 0
                const idx = Math.round(t * (d.points.length - 1))
                const p = d.points[Math.max(0, Math.min(d.points.length - 1, idx))]
                onHover(e, [
                  `${mapping.x} = ${hoverValue(xCol, p.x)}`,
                  `密度 = ${formatNumber(p.y)}`,
                ])
              }}
            />
          </g>
        )
        return { xScale, yScale, marks }
      }}
    />
  )
}
