/**
 * Pure projections shared by the in-canvas agent and the CLI/MCP probe.
 * Runtime values are injected by the caller so this module never reads a store,
 * DOM, worker, or filesystem.
 */

import type { OutputRefBody } from '../engine/protocol'
import { projectPortContext, type Project } from '../workflow/project'
import { runtimeNodeIdForPath } from '../workflow/groups'
import { resolvePorts } from '../workflow/ports'
import { getNodeTypeDef, hasNodeType } from '../workflow/nodeRegistry'
import type { Workflow, WorkflowNode } from '../workflow/types'
import { inspectablePorts } from './inspectionCore'
import { locateNodes, nodeAmbiguity, type NodeLocation } from './context'

export interface CanvasRuntimeSnapshot {
  status: string
  outputVersion?: number
  progress?: number | { ratio: number; message: string }
  error?: { message?: string } | string
}

export interface CanvasInspectionState {
  refs?: Record<string, Record<string, OutputRefBody>>
  runtimes?: Record<string, CanvasRuntimeSnapshot | undefined>
  editFingerprint?: string
}

const SECRET_PARAM = /(token|key|secret|password|credential)/i

export function inspectableParamsOf(params: Record<string, unknown>): Record<string, string | number | boolean> {
  const visible: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === 'code' || SECRET_PARAM.test(key)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') visible[key] = value
  }
  return visible
}

export function editableParamsOf(
  node: WorkflowNode,
  workflow: Workflow,
  project: Project,
): Record<string, unknown>[] {
  if (!hasNodeType(node.type)) return []
  const context = projectPortContext({ ...project, graph: workflow })
  const specs = new Map<string, { spec: ReturnType<typeof getNodeTypeDef>['params'][number]; portId: string }>()
  for (const spec of getNodeTypeDef(node.type).params) specs.set(spec.key, { spec, portId: spec.key })
  for (const port of resolvePorts(node, context).inputs) {
    if (port.kind === 'param' && port.paramSpec) specs.set(port.paramKey ?? port.paramSpec.key, { spec: port.paramSpec, portId: port.id })
  }
  return [...specs].flatMap(([key, { spec, portId }]) => {
    if (spec.type === 'code' || spec.widget === 'datasetRef' || SECRET_PARAM.test(key)) return []
    const incoming = workflow.edges.find((edge) => edge.target === node.id && edge.targetPort === portId)
    return [{
      key,
      portId,
      label: spec.label,
      type: spec.type,
      default: spec.default,
      currentValue: node.params[key] ?? spec.default,
      required: spec.required ?? false,
      ...(spec.options ? { options: spec.options } : {}),
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      ...(spec.step !== undefined ? { step: spec.step } : {}),
      ...(spec.unit ? { unit: spec.unit } : {}),
      ...(spec.hint ? { hint: spec.hint } : {}),
      ...(incoming ? { connectedFrom: { nodeId: incoming.source, portId: incoming.sourcePort }, editable: false } : { editable: true }),
    }]
  })
}

export function locateCanvasNode(project: Project, nodeId: string, groupPath?: string[]): {
  locations: NodeLocation[]
  location?: NodeLocation
  ambiguity?: ReturnType<typeof nodeAmbiguity>
} {
  const allLocations = locateNodes(project, nodeId)
  const locations = groupPath
    ? allLocations.filter((location) => location.groupPath.length === groupPath.length && location.groupPath.every((part, index) => part === groupPath[index]))
    : allLocations
  return {
    locations,
    ...(locations[0] ? { location: locations[0] } : {}),
    ...(!groupPath ? { ambiguity: nodeAmbiguity(project, nodeId, allLocations) } : {}),
  }
}

export function inspectCanvasNode(
  project: Project,
  nodeId: string,
  location: NodeLocation,
  state: CanvasInspectionState = {},
): Record<string, unknown> {
  const runtimeId = runtimeNodeIdForPath(location.groupPath, location.node.id)
  const refs = state.refs?.[runtimeId] ?? state.refs?.[nodeId]
  const runtime = state.runtimes?.[runtimeId] ?? state.runtimes?.[nodeId]
  const runtimeError = typeof runtime?.error === 'string' ? runtime.error : runtime?.error?.message
  return {
    nodeId,
    runtimeId,
    label: location.node.label,
    type: location.node.type,
    groupPath: location.groupPath,
    groupLabels: location.groupLabels,
    ...(state.editFingerprint ? { editFingerprint: state.editFingerprint } : {}),
    params: inspectableParamsOf(location.node.params),
    editableParams: editableParamsOf(location.node, location.workflow, project),
    outputs: inspectablePorts(refs, { includeIdentity: false }),
    ...(runtime ? { runtime: {
      status: runtime.status,
      outputVersion: runtime.outputVersion,
      progress: runtime.progress,
      error: runtimeError,
    } } : {}),
  }
}

export function inspectCanvasGraph(project: Project, state: CanvasInspectionState = {}): {
  nodes: Array<Record<string, unknown> & { runtimeId: string }>
  edges: Array<Record<string, unknown> & { sourceRuntimeId: string }>
} {
  const nodes: Array<Record<string, unknown> & { runtimeId: string }> = []
  const edges: Array<Record<string, unknown> & { sourceRuntimeId: string }> = []
  const visit = (workflow: Workflow, groupPath: string[] = [], groupLabels: string[] = []) => {
    for (const node of workflow.nodes) {
      const location: NodeLocation = { node, workflow, groupPath, groupLabels }
      const details = inspectCanvasNode(project, node.id, location, state)
      nodes.push({ ...details, runtimeId: runtimeNodeIdForPath(groupPath, node.id) })
      if (node.group) visit(node.group.workflow, [...groupPath, node.id], [...groupLabels, node.label])
    }
    for (const edge of workflow.edges) {
      edges.push({ ...edge, groupPath, sourceRuntimeId: runtimeNodeIdForPath(groupPath, edge.source), targetRuntimeId: runtimeNodeIdForPath(groupPath, edge.target) })
    }
  }
  visit(project.graph)
  return { nodes, edges }
}
