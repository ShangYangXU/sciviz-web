import { getNodeTypeDef } from '../workflow/nodeRegistry'
import { resolvePorts } from '../workflow/ports'
import { projectPortContext, type Project } from '../workflow/project'
import type { Workflow, WorkflowNode } from '../workflow/types'
import type { PatchFile, PatchOp, OpPath } from '../contract/ops'

/**
 * 把补丁结果给模型时使用的显示摘要。
 *
 * 工具内部必须保留稳定 id，方便机器寻址；用户看到的改动却应该沿用画布上的名称。
 * 这层只负责显示，不改变 PatchOp、工程文件或撤销记录。
 */

function workflowAt(project: Project, path: OpPath | undefined): Workflow | undefined {
  let current: Workflow = project.graph
  for (const id of path ?? []) {
    const node = current.nodes.find((item) => item.id === id)
    if (!node?.group) return undefined
    current = node.group.workflow
  }
  return current
}

function pathText(project: Project, fallback: Project, path: OpPath | undefined): string {
  if (!path || path.length === 0) return ''
  let current: Workflow = project.graph
  let fallbackCurrent: Workflow = fallback.graph
  const labels: string[] = []
  for (const id of path) {
    const node = current.nodes.find((item) => item.id === id)
    const fallbackNode = fallbackCurrent.nodes.find((item) => item.id === id)
    labels.push(node?.label ?? fallbackNode?.label ?? id)
    if (node?.group) current = node.group.workflow
    else if (fallbackNode?.group) current = fallbackNode.group.workflow
    else break
    if (fallbackNode?.group) fallbackCurrent = fallbackNode.group.workflow
  }
  return labels.length > 0 ? `在「${labels.join(' > ')}」中，` : ''
}

function nodeAt(project: Project, path: OpPath | undefined, id: string): WorkflowNode | undefined {
  return workflowAt(project, path)?.nodes.find((node) => node.id === id)
}

function nodeName(node: WorkflowNode | undefined, id: string): string {
  return node?.label ?? `节点 ${id}`
}

function decodePortId(portId: string): string {
  try {
    return decodeURIComponent(portId)
  } catch {
    return portId
  }
}

function portName(project: Project, node: WorkflowNode | undefined, portId: string, direction: 'inputs' | 'outputs'): string {
  if (!node) return decodePortId(portId)
  try {
    const port = resolvePorts(node, projectPortContext(project))[direction].find((item) => item.id === portId)
    return port?.label ?? decodePortId(portId)
  } catch {
    return decodePortId(portId)
  }
}

function paramName(node: WorkflowNode | undefined, key: string): string {
  if (!node) return key
  const groupParam = node.group?.parameters.find((parameter) => parameter.key === key)
  if (groupParam) return groupParam.spec.label
  try {
    return getNodeTypeDef(node.type).params.find((parameter) => parameter.key === key)?.label ?? key
  } catch {
    return key
  }
}

function nodeTypeLabel(type: string): string {
  try {
    return getNodeTypeDef(type).label
  } catch {
    return type
  }
}

function valueText(value: unknown): string {
  if (value === undefined) return '未设置'
  if (typeof value === 'string') return `「${value}」`
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  return JSON.stringify(value)
}

function formatOp(project: Project, afterProject: Project, op: PatchOp): string {
  const opPath = 'path' in op && Array.isArray(op.path) ? op.path : undefined
  const prefix = pathText(project, afterProject, opPath)
  const workflow = workflowAt(project, opPath)
  const afterWorkflow = workflowAt(afterProject, opPath)
  const findNode = (id: string): WorkflowNode | undefined => nodeAt(project, opPath, id) ?? nodeAt(afterProject, opPath, id)

  switch (op.op) {
    case 'addNode': {
      const label = op.label ?? nodeTypeLabel(op.type)
      return `${prefix}新增图块「${label}」`
    }
    case 'removeNode': {
      const node = nodeAt(project, opPath, op.id)
      const edgeCount = workflow?.edges.filter((edge) => edge.source === op.id || edge.target === op.id).length ?? 0
      return `${prefix}删除图块「${nodeName(node, op.id)}」${edgeCount > 0 ? `，同时断开 ${edgeCount} 条连线` : ''}`
    }
    case 'renameNode': {
      const node = nodeAt(project, opPath, op.id)
      return `${prefix}将「${nodeName(node, op.id)}」改名为「${op.label}」`
    }
    case 'moveNode': {
      const node = nodeAt(project, opPath, op.id)
      return `${prefix}移动图块「${nodeName(node, op.id)}」`
    }
    case 'connect': {
      const source = findNode(op.source)
      const target = findNode(op.target)
      return `${prefix}连接「${nodeName(source, op.source)}」的「${portName(project, source, op.sourcePort, 'outputs')}」到「${nodeName(target, op.target)}」的「${portName(project, target, op.targetPort, 'inputs')}」`
    }
    case 'disconnect': {
      const edge = workflow?.edges.find((item) => item.id === op.edgeId) ?? afterWorkflow?.edges.find((item) => item.id === op.edgeId)
      if (!edge) return `${prefix}断开一条连线`
      const source = findNode(edge.source)
      const target = findNode(edge.target)
      return `${prefix}断开「${nodeName(source, edge.source)}」的「${portName(project, source, edge.sourcePort, 'outputs')}」到「${nodeName(target, edge.target)}」的连线`
    }
    case 'setParam': {
      const node = nodeAt(project, opPath, op.id)
      return `${prefix}将「${nodeName(node, op.id)}」的参数「${paramName(node, op.key)}」设为 ${valueText(op.value)}`
    }
    case 'resetParams': {
      const node = nodeAt(project, opPath, op.id)
      return `${prefix}恢复「${nodeName(node, op.id)}」的默认参数`
    }
    case 'createGroup':
      return `${prefix}将 ${op.nodeIds.length} 个图块封装成子空间「${op.label ?? '新子空间'}」`
    case 'ungroup': {
      const node = nodeAt(project, opPath, op.id)
      const count = node?.group?.workflow.nodes.length ?? 0
      return `${prefix}解散子空间「${nodeName(node, op.id)}」${count > 0 ? `，释放 ${count} 个图块` : ''}`
    }
    case 'setMeta': {
      const parts: string[] = []
      if (op.name !== undefined) parts.push(`工程名改为「${op.name}」`)
      if (op.description !== undefined) parts.push('更新工程描述')
      return parts.join('；') || '更新工程信息'
    }
    case 'addDataset':
      return `登记数据集「${op.name}」`
    case 'removeDataset': {
      const dataset = project.datasets.find((item) => item.id === op.id)
      return `移除数据集「${dataset?.name ?? op.id}」`
    }
    case 'setDatasetView': {
      const dataset = project.datasets.find((item) => item.id === op.datasetId)
      const parts: string[] = []
      if (op.enabled) parts.push(`启用 ${op.enabled.length} 列`)
      if (op.timeColumn !== undefined) parts.push(op.timeColumn ? `时间列设为「${op.timeColumn}」` : '移除时间列')
      return `更新数据集「${dataset?.name ?? op.datasetId}」视图${parts.length > 0 ? `：${parts.join('，')}` : ''}`
    }
  }
}

export function humanizePatch(project: Project, patch: PatchFile, afterProject: Project = project): string[] {
  return patch.ops.map((op) => formatOp(project, afterProject, op))
}
