import type { ChartMapping, ChartSpec, ChartType, Column, Dataset, Row } from '../types'
import type { PreviewTable, WorkflowNode } from './types'

/**
 * 把"上游表的抽稀样本"变成一个能直接画的图表配置。
 *
 * 这一段刻意做成纯函数：没有 React、没有 store、没有引擎 —— 抽稀已经在 Python 侧
 * 做完了，这里只决定"画哪两列、怎么标"。所以它能被 `node --test` 直接测，
 * 而不用起一个浏览器加 14MB 的 Pyodide 去验"X 轴到底选了哪一列"。
 */

/** 抽稀后的点上限。与 Python 侧 CHART_MAX_POINTS 对齐 */
export const CHART_MAX_POINTS = 6000

/** 这些图型要 X 轴有值；柱状/箱线图没有分类列时宁可空着，也不要拿几千个连续值当分类 */
const NEEDS_X: ChartType[] = ['scatter', 'line', 'histogram', 'density']

/**
 * 上游表的列语义。
 *
 * 引擎只把列名和时间列告诉我们，没有 dtype；对图表来说这就够了 ——
 * 时间列认出来是为了让 X 轴的刻度按时间格式化（epoch 秒按普通数字格式化会显示成 1.74e+9）。
 */
export function columnsOfTable(table: PreviewTable): Column[] {
  return columnsFromNames(table.columns, table.timeColumn)
}

/**
 * 只有列名时的列语义。
 *
 * 参数面板要提前把候选列摆出来（那时还没有行值，拿不到 PreviewTable），
 * 用的就是这一个 —— 免得"图上的列"和"下拉里的列"各有一套判断。
 */
export function columnsFromNames(names: string[], timeColumn: string | null): Column[] {
  return names.map((name) => ({
    name,
    type: 'number' as const,
    role: name === timeColumn ? ('time' as const) : ('continuous' as const),
  }))
}

/** 行优先的二维值 → 按列名索引的行对象（图表渲染器要的是后者） */
export function rowsOfTable(table: PreviewTable, columns: Column[]): Row[] {
  return table.rows.map((row) => {
    const out: Row = {}
    columns.forEach((col, i) => {
      const v = row[i]
      out[col.name] = v === undefined ? null : v
    })
    return out
  })
}

/**
 * 挑一组默认映射。
 *
 * 默认映射只根据这张实际输入表的列名与时间列决定；不从独立数据集读取候选列：
 * - 折线/散点：有时间列就横着铺时间，没有就退到第二个测量列；
 * - 直方图/密度图：只吃一列，放在 X；
 * - 柱状/箱线图：需要分类轴，上游是数值表时留空，由界面给出明确提示。
 */
export function autoMapColumns(columns: Column[], chartType: ChartType): ChartMapping {
  const measures = columns.filter((c) => c.role !== 'time')
  const time = columns.find((c) => c.role === 'time')
  const first = measures[0]?.name ?? columns[0]?.name ?? ''
  const second = measures[1]?.name ?? first

  if (chartType === 'bar' || chartType === 'box') {
    return { x: '', y: first, color: '' }
  }
  // 直方图/密度图只吃一列：X 放它，Y 留空（映射成"一列对自身"没有意义）
  if (chartType === 'histogram' || chartType === 'density') {
    return { x: first, y: '', color: '' }
  }
  // 折线/散点要两个不同的轴。上游只有一列又没有时间列时，硬拿它同时当 X 和 Y
  // 会画出一条对角线 —— 那看着像数据，其实是自己对自己。留空让界面说清"挑不出来"。
  const x = time?.name ?? (measures.length >= 2 ? second : '')
  return { x, y: first, color: '' }
}

/**
 * 节点上的映射优先，失效了（换过上游、列名对不上）再退回自动挑。
 * 不把失效的列名原样传下去：那样图上只会得到一片空白，而用户看不出是列没了。
 */
export function mergeMapping(
  params: Record<string, string | number | boolean>,
  columns: Column[],
  chartType: ChartType,
): ChartMapping {
  const auto = autoMapColumns(columns, chartType)
  const has = (name: string) => name !== '' && columns.some((c) => c.name === name)
  const x = String(params.x ?? '')
  const y = String(params.y ?? '')
  const color = String(params.color ?? '')

  let nextX = has(x) ? x : auto.x
  const nextY = has(y) ? y : auto.y
  // 直方图/密度图只吃一列：X 与 Y 撞成同一列时以 X 为准，别画成"一列对自身"
  const folded = chartType === 'histogram' || chartType === 'density'
  if (folded && !has(x) && has(y) && !auto.x) nextX = y
  return {
    x: nextX,
    y: folded ? '' : nextY,
    color: has(color) ? color : '',
  }
}

/**
 * 这个可视化节点该画成什么图型。
 *
 * 判据只写这一处：图表节点的图型是参数（人可以换），概率密度图只会画密度、没有那个参数。
 * 两边各挑一次的话，"框上画的"与"资产库里那张"迟早不是同一张图。
 */
export function chartTypeOfNode(node: WorkflowNode): ChartType {
  if (node.type === 'viz.density') return 'density'
  return String(node.params.chartType ?? 'scatter') as ChartType
}

export interface ChartFromTableOptions {
  /** 抽稀前的行数，用来在图上注明"这是个抽样" */
  totalRows: number
  chartId: string
}

/**
 * 组装图表配置。样式取自节点参数，口径与"选数据集"那条路一致 ——
 * 同一个节点换个数据来源，画出来不该是两种风格。
 */
export function chartFromTable(
  node: WorkflowNode,
  table: PreviewTable,
  opts: ChartFromTableOptions,
): ChartSpec {
  const columns = columnsOfTable(table)
  const chartType = chartTypeOfNode(node)
  // 自定义函数通过返回表表达要绘制的数据；不再要求用户在节点面板重复指定 X/Y/颜色列。
  // 保留这个分支的纯函数约束，也让旧工程里存下来的映射值不会覆盖自动识别结果。
  const mapping =
    node.type === 'custom.chart'
      ? autoMapColumns(columns, chartType)
      : mergeMapping(node.params, columns, chartType)
  const title = String(node.params.title ?? '')
  // 密度图没接标题时用列名当图名：`概率密度图 · 上游表` 那种名字看不出画的是哪一列，
  // 而资产库堆了三五张密度图之后就完全分不开了
  const name =
    title ||
    (chartType === 'density' && mapping.x ? `${mapping.x} 的概率密度` : `${node.label} · 上游表`)

  const dataset: Dataset = {
    id: `engine:${node.id}`,
    name: `${node.label} · 上游表`,
    description: `上游表抽稀到 ${table.rows.length} 点（原表 ${opts.totalRows} 行）`,
    columns,
    rows: rowsOfTable(table, columns),
    primaryMeasure: mapping.x && mapping.x !== table.timeColumn ? mapping.x : mapping.y || undefined,
  }

  return {
    id: opts.chartId,
    name,
    type: chartType,
    // 不指向任何数据集：数据就在 inline 里。详情面板据此不要去找数据集
    datasetId: dataset.id,
    mapping,
    style: {
      title,
      xLabel: '',
      yLabel: '',
      palette: String(node.params.palette ?? 'okabe-ito'),
      pointSize: Number(node.params.pointSize ?? 3.5),
      opacity: 0.85,
      showGrid: node.params.showGrid !== false,
      showLegend: node.params.showLegend !== false,
      // 密度图自己的两个旋钮。它们只在节点上有，图表节点没这两个参数 —— 不传就是 undefined，
      // DensityChart 那边按默认处理（0 = Silverman 自动带宽）
      ...(node.params.bandwidth !== undefined ? { bandwidth: Number(node.params.bandwidth ?? 0) } : {}),
      ...(node.params.showStats !== undefined ? { showStats: node.params.showStats !== false } : {}),
    },
    inline: dataset,
  }
}

/** 该图型是否需要 X 轴有值 —— 界面用它在映射缺失时给出可读的提示 */
export function needsX(chartType: ChartType): boolean {
  return NEEDS_X.includes(chartType)
}
