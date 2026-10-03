export type ColumnType = 'number' | 'string' | 'date'

/** 列语义：决定它能被拖到哪些槽位 */
export type ColumnRole = 'continuous' | 'categorical' | 'time' | 'identifier'

export interface Column {
  name: string
  type: ColumnType
  role: ColumnRole
  unit?: string
  /** 分类列的去重取值，用于图例与配色 */
  levels?: string[]
}

export type Row = Record<string, number | string | null>

export interface Dataset {
  id: string
  name: string
  description: string
  columns: Column[]
  rows: Row[]
  /** 主测量列：自动映射时优先作为 Y 轴 / 频数统计对象 */
  primaryMeasure?: string
}

export type ChartType = 'scatter' | 'line' | 'bar' | 'box' | 'histogram' | 'density'

/** 字段映射槽位。空字符串代表未映射 */
export interface ChartMapping {
  x: string
  y: string
  color: string
}

export interface ChartStyle {
  title: string
  xLabel: string
  yLabel: string
  palette: string
  pointSize: number
  opacity: number
  showGrid: boolean
  showLegend: boolean
  /** 概率密度图专用：带宽。0 或未设 = 按 Silverman 经验法则自动选 */
  bandwidth?: number
  /** 概率密度图专用：是否标注均值/中位数 */
  showStats?: boolean
}

/** Python figure rendered once by Matplotlib and transported as a static image. */
export interface FigureImage {
  mimeType: 'image/png'
  /** Base64-encoded PNG bytes. */
  data: string
  width: number
  height: number
}

export interface ChartSpec {
  id: string
  name: string
  type: ChartType
  datasetId: string
  mapping: ChartMapping
  style: ChartStyle
  /** Present for a Python-created image; when set, the frontend must not redraw the chart. */
  image?: FigureImage
  /**
   * 上游表直接抽稀出来的点。
   *
   * 有它时图表不查数据集：数据只在 Python 侧存在（函数筛完的中间结果不是一份导入的
   * CSV），前端拿到的是抽稀后的一小段。`datasetId` 这时只是一个记号（`engine:<节点>`），
   * 详情里的"找不到该图表引用的数据源"分支要认得这种情况。
   */
  inline?: Dataset
}

export type SlotKey = keyof ChartMapping

export interface ChartTypeMeta {
  type: ChartType
  label: string
  hint: string
  /** 该图型需要哪些槽位 */
  slots: SlotKey[]
  /** 各槽位接受的列语义 */
  accepts: Partial<Record<SlotKey, ColumnRole[]>>
}
