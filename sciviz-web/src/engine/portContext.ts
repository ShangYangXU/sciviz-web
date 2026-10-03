import { featuresOf, timeColumnOf } from '../store/useDataStore'
import { useNodeOutputStore } from '../store/nodeOutputStore'
import { useEditingWorkflow, useWorkflowStore } from '../store/useWorkflowStore'
import type { PortContext } from '../workflow/ports'
import { runtimeNodeIdForPath } from '../workflow/groups'
import type { Workflow } from '../workflow/types'

/**
 * `PortContext` 的构造点：把 store 里的实时状态注入进纯函数。
 *
 * 契约层（`workflow/ports.ts`）不许 import store（R2），但动态端口又必须知道
 * "上游那张表有哪些列"。**这个矛盾只能在一个地方解决：调用方在边界上注入。**
 * 这个文件就是那个边界 —— 执行面与界面共用同一份，免得两处各写一套"谁是我的上游"。
 *
 * 数据来源是**上一次求值的输出摘要**（`refs[...].columns`），不是重新拉数据：
 * 行列数由引擎算过，摘要是那一步的既成事实。所以列名只有在某一步真的算过之后
 * 才存在 —— 拆列节点的端口因此是"跑一次才长出来"的，这是刻意的，不是缺陷。
 */

/**
 * 某个输入端口上到达的表的列名。
 *
 * **算不出来时返回 null，不是空数组**：上游还没求过值是 null，而"这张表真的一列都没有"
 * 是另一件事。两者在 `portsTrustworthy` 里后果相反 —— 前者不能清连线，后者才该清。
 */
function columnsOf(
  nodeId: string,
  portId: string,
  workflow: Workflow,
  runtimeIdFor: (nodeId: string) => string,
): string[] | null {
  const edge = workflow.edges.find((e) => e.target === nodeId && e.targetPort === portId)
  if (!edge) return null
  const ref = useNodeOutputStore.getState().refs[runtimeIdFor(edge.source)]?.[edge.sourcePort]
  if (!ref || ref.kind !== 'table' || !ref.columns || ref.columns.length === 0) return null
  return ref.columns
}

/** 上游表中可按 1-based 序号选择的特征列；时间列不占特征序号。 */
function featureColumnsOf(
  nodeId: string,
  portId: string,
  workflow: Workflow,
  runtimeIdFor: (nodeId: string) => string,
): string[] | null {
  const edge = workflow.edges.find((e) => e.target === nodeId && e.targetPort === portId)
  if (!edge) return null
  const ref = useNodeOutputStore.getState().refs[runtimeIdFor(edge.source)]?.[edge.sourcePort]
  if (!ref || ref.kind !== 'table' || !ref.columns || ref.columns.length === 0) return null
  return ref.columns.filter((column) => column !== ref.timeColumn)
}

/** 非 React 场景（执行面、CLI 之外的纯逻辑调用）用这个 */
export function buildPortContext(
  workflow = useWorkflowStore.getState().workflow,
  groupPath: string[] = [],
): PortContext {
  return {
    featuresOf,
    timeColumnOf,
    columnsOf: (nodeId, portId) =>
      columnsOf(nodeId, portId, workflow, (id) => runtimeNodeIdForPath(groupPath, id)),
    featureColumnsOf: (nodeId, portId) =>
      featureColumnsOf(nodeId, portId, workflow, (id) => runtimeNodeIdForPath(groupPath, id)),
  }
}

/**
 * React 组件用这个。
 *
 * 订阅刻意粗：任何一个节点的输出摘要变了，都可能改到某些节点该画的端口。
 * 换成精确定位"我这个端口的上游"，每个调用点都要多写两层选择器，而节点是几十级 ——
 * 省下的那点重渲染不值得那份复杂度。真到几百个节点再收。
 */
export function usePortContext(): PortContext {
  useNodeOutputStore((s) => s.refs)
  const workflow = useEditingWorkflow()
  const groupPath = useWorkflowStore((s) => s.activeGroupPath)
  // 画布只校验/展示当前编辑子图，列摘要仍按根执行图的 namespaced ID 读取。
  return buildPortContext(workflow, groupPath)
}
