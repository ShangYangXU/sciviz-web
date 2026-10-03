import type { OutputRefBody } from '../engine/protocol'
import { featuresOf, getStoredDataset } from './useDataStore'
import type {
  RunAsset,
  WorkflowNode,
} from '../workflow/types'

let assetSeq = 0
/** 资产 id 自增。数据变换产出的资产也要用它，所以导出 */
export const nextAssetId = () => `asset-${++assetSeq}`

export function makeRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `run_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
}
/*
 * 「概率密度图」以前在这儿有一份 buildDensityChart：拿连线反查一个**数据集 id**，
 * 再把那张数据集整体交给画图组件。它有两个问题，第二个才要命：
 *
 * 1. 反查只认"上游直接是数据源节点"（`resolveUpstreamColumn` 里那一句），
 *    隔着函数或拆列节点就返回 null —— 于是"点了运行也什么都没有"；
 * 2. 反查成功时画的是**那份数据集**的分布。用户先筛掉非工作状态、再接密度图，
 *    看到的仍然是全量 104.8 万行的曲线 —— 一张看着完全正常、其实在说谎的图。
 *
 * 现在密度图是引擎节点（`op_density`），画的是连进来那一份的实际值，
 * 出图与抽样都只有 `chartFromTable` 一条路。这里不再留第二条画图逻辑。
 */

/**
 * 列拼表节点 → 一张表的资产。
 *
 * 行列数与列名来自引擎的实际输出；不能沿图猜上游一定是数据源。
 */
export function buildCollectAsset(node: WorkflowNode, table: Pick<OutputRefBody, 'kind' | 'rowCount' | 'columns'> | undefined): RunAsset | null {
  if (!table || table.kind !== 'table') return null
  const columns = table.columns ?? []

  return {
    id: nextAssetId(),
    kind: 'dataset',
    name: `${node.label} · ${columns.length} 列`,
    nodeId: node.id,
    nodeLabel: node.label,
    nodeType: node.type,
    createdAt: Date.now(),
    table: { rows: table.rowCount ?? 0, cols: columns.length },
    summary: { 列: columns.join('、') },
  }
}

/** 数据源节点的资产：行数、特征数、时间跨度都取自真实数据集 */
export function buildSourceAsset(
  node: WorkflowNode,
  ctx: Record<string, string | number | boolean>,
): RunAsset | null {
  const datasetId = String(node.params.datasetId ?? '')
  if (!datasetId) return null

  const stored = getStoredDataset(datasetId)
  const feats = featuresOf(datasetId)
  const name = stored?.name ?? datasetId

  const summary: Record<string, string | number> = { 启用特征: feats.length }
  if (stored) {
    summary['采样步长'] = stored.stepSeconds ? `${stored.stepSeconds} s` : '不规则'
    if (stored.time && stored.rowCount > 0) {
      const fmt = (s: number) => new Date(s * 1000).toLocaleString('zh-CN', { hour12: false })
      summary['时间范围'] = `${fmt(stored.time[0])} → ${fmt(stored.time[stored.rowCount - 1])}`
    }
  }
  void ctx

  return {
    id: nextAssetId(),
    kind: 'dataset',
    name,
    nodeId: node.id,
    nodeLabel: node.label,
    nodeType: node.type,
    createdAt: Date.now(),
    table: { rows: stored?.rowCount ?? 0, cols: feats.length },
    datasetId,
    summary,
  }
}
