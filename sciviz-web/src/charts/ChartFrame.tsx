import { createContext, useContext, type ReactNode } from 'react'
import type { AnyScale } from './scales'

export interface LegendItem {
  label: string
  color: string
}

export interface GradientLegend {
  colors: string[]
  minLabel: string
  maxLabel: string
}

interface BuildResult {
  xScale: AnyScale
  yScale: AnyScale
  marks: ReactNode
}

interface Props {
  /**
   * 画布尺寸。不写就按 `mini` 取一档（见下面 FULL / MINI）——
   * 尺寸只在这里定义一次，六个图各自抄一份数字迟早对不上。
   */
  width?: number
  height?: number
  title: string
  xLabel: string
  yLabel: string
  showGrid: boolean
  showLegend: boolean
  /**
   * 缩略档：画在节点框里的那张预览图。
   *
   * 换的是**排版**而不是算法：边距收窄、标题与轴名让位给图形本身、刻度字号降一档、
   * 图例先不画。分箱、KDE、箱线图统计量走的还是同一份代码 —— 缩略图与大图必须是
   * 同一张图，否则"连接上就知道图长什么样"这句话就是假的。
   */
  mini?: boolean
  legend?: LegendItem[]
  gradientLegend?: GradientLegend
  /** 拿到内区尺寸后再构造比例尺与图形，避免与坐标轴互相依赖 */
  build: (inner: { width: number; height: number }) => BuildResult
}

const BASE_MARGIN = { top: 46, right: 28, bottom: 62, left: 74 }
/** 节点预览那一档：留得下刻度数字，留不下标题与轴名 */
const MINI_MARGIN = { top: 10, right: 12, bottom: 26, left: 40 }
const LEGEND_ITEM_H = 20
const LEGEND_FONT = 11
const MINI_LEGEND_FONT = 9

/** 两档画布尺寸。360 正好铺满宽节点（380 减去内边距） */
export const CHART_FULL_SIZE = { width: 800, height: 520 }
export const CHART_MINI_SIZE = { width: 360, height: 230 }

/**
 * 当前在画全尺寸还是缩略档。由 `ChartRenderer` 定一次，图里那些"自己带尺寸"的部件
 * （占位图）读它 —— 不然这件事要在 15 个调用点各传一遍参数，而漏掉一处就是
 * "缩略图里嵌着一张 800 宽的占位图"。
 */
const MiniContext = createContext(false)
export const ChartMiniProvider = MiniContext.Provider
export const useChartMini = (): boolean => useContext(MiniContext)

/** 估算图例条目像素宽度（CJK 按全角算），用于折行布局 */
function estimateItemWidth(label: string): number {
  let w = 0
  for (const ch of label) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 12 : 7
  return w + 30
}

function layoutLegend(items: LegendItem[], availWidth: number): LegendItem[][] {
  const rows: LegendItem[][] = []
  let row: LegendItem[] = []
  let used = 0
  for (const item of items) {
    const w = estimateItemWidth(item.label)
    if (used + w > availWidth && row.length) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(item)
    used += w
  }
  if (row.length) rows.push(row)
  return rows
}

export function ChartFrame({
  width,
  height,
  title,
  xLabel,
  yLabel,
  showGrid,
  showLegend,
  mini,
  legend,
  gradientLegend,
  build,
}: Props) {
  const size = mini ? CHART_MINI_SIZE : CHART_FULL_SIZE
  const W = width ?? size.width
  const H = height ?? size.height
  const margin = mini ? MINI_MARGIN : { ...BASE_MARGIN }
  const tickFont = mini ? 8.5 : 11
  const legendFont = mini ? MINI_LEGEND_FONT : LEGEND_FONT

  // 缩略档不画图例：200 多像素高的框里，图例占掉的那一条比它能传达的信息贵
  const legendRows =
    showLegend && !mini && legend?.length
      ? layoutLegend(legend, W - margin.left - margin.right)
      : []
  const legendHeight = legendRows.length * LEGEND_ITEM_H + (legendRows.length ? 12 : 0)
  const gradientHeight = showLegend && !mini && gradientLegend ? 34 : 0
  margin.bottom += legendHeight + gradientHeight

  const innerW = Math.max(10, W - margin.left - margin.right)
  const innerH = Math.max(10, H - margin.top - margin.bottom)

  const { xScale, yScale, marks } = build({ width: innerW, height: innerH })
  const isBandX = xScale.kind === 'band'

  return (
    <svg
      className="chart-svg"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ maxWidth: '100%', height: 'auto' }}
    >
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />

      {title && !mini && (
        <text x={W / 2} y={26} textAnchor="middle" fontSize={15} fontWeight={600} fill="#1c2024">
          {title}
        </text>
      )}

      <g transform={`translate(${margin.left},${margin.top})`}>
        {showGrid &&
          yScale.ticks.map((t, i) => (
            <line key={`gy-${i}`} x1={0} x2={innerW} y1={t.pos} y2={t.pos} stroke="#e8ebef" strokeWidth={1} />
          ))}
        {showGrid &&
          !isBandX &&
          xScale.ticks.map((t, i) => (
            <line key={`gx-${i}`} y1={0} y2={innerH} x1={t.pos} x2={t.pos} stroke="#f1f3f6" strokeWidth={1} />
          ))}

        {marks}

        <line x1={0} x2={0} y1={0} y2={innerH} stroke="#5b6570" strokeWidth={1.4} />
        <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="#5b6570" strokeWidth={1.4} />

        {xScale.ticks.map((t, i) => (
          <text
            key={`tx-${i}`}
            x={t.pos}
            y={innerH + (mini ? 12 : 18)}
            textAnchor="middle"
            fontSize={tickFont}
            fill="#5b6570"
          >
            {t.label}
          </text>
        ))}
        {yScale.ticks.map((t, i) => (
          <text
            key={`ty-${i}`}
            x={mini ? -6 : -10}
            y={t.pos}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={tickFont}
            fill="#5b6570"
          >
            {t.label}
          </text>
        ))}

        {xLabel && !mini && (
          <text x={innerW / 2} y={innerH + 42} textAnchor="middle" fontSize={12.5} fill="#1c2024">
            {xLabel}
          </text>
        )}
        {yLabel && !mini && (
          <text
            transform={`translate(${-54},${innerH / 2}) rotate(-90)`}
            textAnchor="middle"
            fontSize={12.5}
            fill="#1c2024"
          >
            {yLabel}
          </text>
        )}
      </g>

      {legendRows.length > 0 && (
        <g transform={`translate(${margin.left},${H - legendHeight - gradientHeight + 4})`}>
          {legendRows.map((row, ri) => {
            let x = 0
            return (
              <g key={ri} transform={`translate(0,${ri * LEGEND_ITEM_H})`}>
                {row.map((item) => {
                  const w = estimateItemWidth(item.label)
                  const node = (
                    <g key={item.label} transform={`translate(${x},0)`}>
                      <rect y={-7} width={11} height={11} rx={2} fill={item.color} />
                      <text x={16} y={3} fontSize={legendFont} fill="#3d4752">
                        {item.label}
                      </text>
                    </g>
                  )
                  x += w
                  return node
                })}
              </g>
            )
          })}
        </g>
      )}

      {showLegend && !mini && gradientLegend && (
        <g transform={`translate(${margin.left},${H - gradientHeight + 6})`}>
          <defs>
            <linearGradient id="sciviz-seq-legend" x1="0" x2="1" y1="0" y2="0">
              {gradientLegend.colors.map((c, i) => (
                <stop
                  key={`${c}-${i}`}
                  offset={`${(i / Math.max(1, gradientLegend.colors.length - 1)) * 100}%`}
                  stopColor={c}
                />
              ))}
            </linearGradient>
          </defs>
          <rect width={140} height={12} fill="url(#sciviz-seq-legend)" stroke="#d5dae0" />
          <text x={0} y={26} fontSize={10} fill="#5b6570">
            {gradientLegend.minLabel}
          </text>
          <text x={140} y={26} fontSize={10} fill="#5b6570" textAnchor="end">
            {gradientLegend.maxLabel}
          </text>
        </g>
      )}
    </svg>
  )
}
