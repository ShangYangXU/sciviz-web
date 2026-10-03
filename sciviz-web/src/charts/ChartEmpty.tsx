import { CHART_FULL_SIZE, useChartMini } from './ChartFrame'

interface Props {
  width?: number
  height?: number
  message: string
  hint?: string
}

/**
 * 字段未映射或数据为空时的占位图。
 *
 * 尺寸跟着 `mini` 那一档走（见 `ChartFrame` 的 MiniContext）：占位的话要说人话，
 * 而 800 宽的 viewBox 缩进节点框里，字号会掉到 6px —— 那时候它就不是占位说明，
 * 是一块带灰字的空白。
 */
export function ChartEmpty({ width, height, message, hint }: Props) {
  const mini = useChartMini()
  const W = width ?? (mini ? 360 : CHART_FULL_SIZE.width)
  const H = height ?? (mini ? 210 : 420)
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: '100%', height: 'auto' }}>
      <rect width={W} height={H} fill="#fbfcfd" stroke="#e3e7ec" strokeDasharray="6 5" />
      <text
        x={W / 2}
        y={H / 2 - 8}
        textAnchor="middle"
        fontSize={mini ? 11 : 14}
        fill="#7b8590"
      >
        {message}
      </text>
      {hint && (
        <text
          x={W / 2}
          y={H / 2 + 18}
          textAnchor="middle"
          fontSize={mini ? 9.5 : 12}
          fill="#a6aeb8"
        >
          {hint}
        </text>
      )}
    </svg>
  )
}
