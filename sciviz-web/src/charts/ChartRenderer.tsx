import { ChartMiniProvider } from './ChartFrame'
import type { ChartSpec, ChartType, Dataset } from '../types'
import type { HoverHandler } from './chartProps'
import { ScatterChart } from './ScatterChart'
import { LineChart } from './LineChart'
import { BarChart } from './BarChart'
import { BoxChart } from './BoxChart'
import { HistogramChart } from './HistogramChart'
import { DensityChart } from './DensityChart'

interface Props {
  chart: ChartSpec
  dataset: Dataset
  onHover: HoverHandler
  /** 缩略档：节点上的预览。见 `ChartFrame` 的 mini 说明 */
  mini?: boolean
}

/** 按图型取组件。写成表而不是 switch：`ChartType` 加一档时这里编译不过，不会漏 */
const byType: Record<ChartType, typeof ScatterChart> = {
  scatter: ScatterChart,
  line: LineChart,
  bar: BarChart,
  box: BoxChart,
  histogram: HistogramChart,
  density: DensityChart,
}

export function ChartRenderer({ chart, dataset, onHover, mini }: Props) {
  const props = {
    rows: dataset.rows,
    columns: dataset.columns,
    mapping: chart.mapping,
    style: chart.style,
    onHover,
    mini,
  }

  // 一处声明"现在画的是缩略档"：六个图与它们各自画的占位图都从这里读，
  // 不用把 mini 一路传到每一个 return（漏一处就是缩略图里嵌一张 800 宽的占位图）
  const Chart = byType[chart.type]
  return (
    <ChartMiniProvider value={!!mini}>{Chart ? <Chart {...props} /> : null}</ChartMiniProvider>
  )
}
