import { head } from '../engine/backend'
import { CHART_MAX_POINTS, chartFromTable } from '../workflow/chartFromTable'
import { isFunctionNode, resolveFigureUpstreamTable, resolvePorts } from '../workflow/ports'
import { decimateModeFor, featuresOf, resolveDatasetView, timeColumnOf } from './useDataStore'
import { headKey, useNodeOutputStore } from './nodeOutputStore'
import type { ChartSpec, Dataset } from '../types'
import type { Workflow, WorkflowNode } from '../workflow/types'
import { runtimeNodeIdForPath } from '../workflow/groups'

/**
 * 图表节点**此刻**该画成什么样。
 *
 * 这个文件存在的理由是"一件事只有一处声明"：资产库那张图与节点框上那张缩略图
 * 必须来自同一份引擎 figure/table 输出。上游没接或没算出结果时返回 null，不从节点外
 * 另找一份数据补图。
 *
 * 取数走 `nodeOutputStore` 的 head 缓存（键含输出 version）：上游重算一次自动失效，
 * 而同一版本里资产库与缩略图共用同一次取数，不各取一遍 6000 行。
 */

export interface NodeChart {
  chart: ChartSpec
  /** 这张图要画的那份数据（抽稀后的点，不是原表） */
  dataset: Dataset | undefined
  /** 图上的点数 */
  points: number
  /** 原始行数。图注"来自 N 行的抽稀"用它 —— 拿点数当行数会把抽样这件事说反 */
  totalRows: number | null
}

/**
 * 图表要画的那份数据。
 *
 * `chartFromTable` 生成的工作流图都带 inline 数据；保留数据集读取是为了兼容资产库里
 * 已经保存的旧图表资产，不再作为绘图节点的数据回退路径。
 */
export function chartDataset(chart: ChartSpec): Dataset | undefined {
  if (chart.image) return undefined
  if (chart.inline) return chart.inline
  return resolveDatasetView(chart.datasetId, undefined, decimateModeFor(chart.type)) ?? undefined
}

/** 找到节点声明的第一个 figure 输出；训练曲线、自定义图表不一定叫 `figure`。 */
export function figurePortId(node: WorkflowNode): string | null {
  const ports = resolvePorts(node, { featuresOf, timeColumnOf }).outputs
  return ports.find((port) => port.type === 'figure')?.id ?? null
}

/**
 * 解析这张图。**不等**：上游或 figure 还没算出来就返回 null。
 *
 * 不等是有意的 —— 调用它的是画布上的缩略图，它每 300ms 就会被重画一次，
 * 而"运行"那条路自己会等（见 `useWorkflowStore` 的 `waitForTableRef`）。
 */
export async function resolveNodeChart(
  node: WorkflowNode,
  workflow: Workflow,
  chartId: string,
): Promise<NodeChart | null> {
  const state = useNodeOutputStore.getState()
  const upstream = resolveFigureUpstreamTable(workflow, node.id)
  const portId = figurePortId(node)
  const ref = portId ? state.refs[node.id]?.[portId] : undefined
  if (!upstream) return null

  if (ref?.kind === 'figure' && ref.image) {
    const chart: ChartSpec = {
      id: chartId,
      name: node.label,
      type: 'scatter',
      datasetId: `engine:${node.id}`,
      mapping: { x: '', y: '', color: '' },
      style: {
        title: '',
        xLabel: '',
        yLabel: '',
        palette: 'okabe-ito',
        pointSize: 3.5,
        opacity: 0.85,
        showGrid: false,
        showLegend: false,
      },
      image: ref.image,
    }
    return {
      chart,
      dataset: undefined,
      points: 0,
      totalRows: state.refs[upstream.nodeId]?.[upstream.portId]?.rowCount ?? null,
    }
  }

  if (ref && (ref.kind === 'table' || ref.kind === 'figure') && portId) {
    // 密度图的取点数量由节点参数决定，输出摘要里的 rowCount 就是实际参与估计的点数；
    // 这里必须把这些点全部取回来，否则 sampleRatio=1 仍会被前端固定的 6000 截断。
    const maxPoints =
      node.type === 'viz.density' && typeof ref.rowCount === 'number'
        ? Math.max(0, ref.rowCount)
        : CHART_MAX_POINTS
    const key = headKey(node.id, portId, ref.version, maxPoints)
    try {
      const table = state.heads[key] ?? (await head(node.id, portId, maxPoints))
      useNodeOutputStore.getState().putHead(key, table)
      const totalRows = isFunctionNode(node.type)
        ? ref.rowCount ?? table.totalRows
        : state.refs[upstream.nodeId]?.[upstream.portId]?.rowCount ?? ref.rowCount ?? table.totalRows
      const chart = chartFromTable(node, table, { totalRows, chartId })
      return {
        chart,
        dataset: chartDataset(chart),
        points: table.rows.length,
        totalRows,
      }
    } catch {
      // 取不到引擎的实际产物就不画：改用别的数据会让图和连线表达的来源不一致。
    }
  }

  return null
}

/** Resolve a chart from a nested workflow using the same runtime ids as its canvas preview. */
export function resolveNodeChartAtPath(
  node: WorkflowNode,
  workflow: Workflow,
  groupPath: readonly string[],
  chartId: string,
): Promise<NodeChart | null> {
  const mapId = (id: string) => runtimeNodeIdForPath(groupPath, id)
  const runtimeWorkflow: Workflow = {
    ...workflow,
    nodes: workflow.nodes.map((item) => ({ ...item, id: mapId(item.id) })),
    edges: workflow.edges.map((edge) => ({
      ...edge,
      source: mapId(edge.source),
      target: mapId(edge.target),
    })),
  }
  return resolveNodeChart({ ...node, id: mapId(node.id) }, runtimeWorkflow, chartId)
}
