import { locateNodes, nodeAmbiguity, sha256Hex, stableStringify } from './context'
import { renderChartVisual, type FigureVisual } from './figureVisual'
import { planEvaluation } from '../engine/plan'
import { editableProjectView } from '../kernel/editFingerprint'
import { figurePortId, resolveNodeChartAtPath } from '../store/nodeChart'
import { useNodeOutputStore } from '../store/nodeOutputStore'
import { runtimeNodeIdForPath } from '../workflow/groups'
import { projectPortContext, type Project } from '../workflow/project'

/** A bounded, portable PNG and its exact place in the workflow. */
export interface ReportFigureCapture extends FigureVisual {
  nodeId: string
  groupPath: string[]
  label: string
  runtimeId: string
  portId: string
  /** Digest only: the raw runtime fingerprint may contain user code. */
  sourceFingerprintSha256: string
}

export class FigureCaptureError extends Error {
  constructor(public readonly code: 'E_PARAM_INVALID' | 'E_UNKNOWN_REF' | 'E_EXECUTION_FAILED', message: string) {
    super(message)
    this.name = 'FigureCaptureError'
  }
}

type OutputState = ReturnType<typeof useNodeOutputStore.getState>

/** The visual inspection and report attachment paths share this one freshness rule. */
function figureReadiness(project: Project, runtimeId: string, outputState: OutputState): { ready: boolean; failure?: string } {
  if (outputState.graphError) return { ready: false, failure: outputState.graphError.message }
  const runtime = outputState.runtimes[runtimeId]
  if (runtime?.status === 'error' || runtime?.status === 'blocked' || runtime?.status === 'manual' || runtime?.status === 'cancelled') {
    return { ready: false, failure: runtime.error?.message ?? `图表节点当前状态为 ${runtime.status}` }
  }
  if (runtime?.status !== 'ready') return { ready: false }

  try {
    const versions = Object.fromEntries(Object.entries(outputState.runtimes).map(([id, item]) => [id, item.outputVersion]))
    const plan = planEvaluation(project.graph, outputState.runtimes, projectPortContext(project), versions)
    const blocked = plan.blocked.find((item) => item.node.id === runtimeId)
    const missing = plan.missing.find((item) => item.node.id === runtimeId)
    const deferred = plan.deferred.find((item) => item.node.id === runtimeId)
    if (blocked) return { ready: false, failure: blocked.reason }
    if (missing) return { ready: false, failure: `图表缺少必需输入：${missing.ports.join('、')}` }
    if (deferred) return { ready: false, failure: deferred.reason }
    return { ready: plan.unchanged.includes(runtimeId) }
  } catch (error: unknown) {
    return { ready: false, failure: error instanceof Error ? error.message : String(error) }
  }
}

async function waitForCurrentFigure(project: Project, runtimeId: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError')
    const state = figureReadiness(project, runtimeId, useNodeOutputStore.getState())
    if (state.failure) throw new FigureCaptureError('E_EXECUTION_FAILED', state.failure)
    if (state.ready) return
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200))
  }
  throw new FigureCaptureError('E_EXECUTION_FAILED', '等待当前参数下的图表重算超时；未读取旧图')
}

/**
 * Capture the same figure displayed on the canvas. The PNG is local until the caller
 * explicitly attaches it to an inspection request or saves it in a project report.
 */
export async function captureCurrentFigure(
  project: Project,
  nodeId: string,
  groupPath?: readonly string[],
  signal?: AbortSignal,
  getCurrentProject?: () => Promise<Project>,
): Promise<ReportFigureCapture> {
  if (!nodeId) throw new FigureCaptureError('E_PARAM_INVALID', '读取图像需要 nodeId')
  if (groupPath && (!Array.isArray(groupPath) || groupPath.some((part) => typeof part !== 'string'))) {
    throw new FigureCaptureError('E_PARAM_INVALID', 'groupPath 必须是字符串数组')
  }

  const locations = locateNodes(project, nodeId)
  if (!groupPath && locations.length > 1) {
    const ambiguity = nodeAmbiguity(project, nodeId, locations)
    throw new FigureCaptureError('E_PARAM_INVALID', `节点 id「${nodeId}」在多层重复。请给出目标 groupPath：${JSON.stringify(ambiguity?.matches ?? [])}`)
  }
  const place = locations.find((location) => !groupPath || (
    location.groupPath.length === groupPath.length && location.groupPath.every((part, index) => part === groupPath[index])
  ))
  if (!place) throw new FigureCaptureError('E_UNKNOWN_REF', `当前工程里没有节点「${nodeId}」；先用 inspect 查看图块及 groupPath`)
  const portId = figurePortId(place.node)
  if (!portId) throw new FigureCaptureError('E_PARAM_INVALID', `「${place.node.label}」没有可读的图表输出`)

  const runtimeId = runtimeNodeIdForPath(place.groupPath, place.node.id)
  await waitForCurrentFigure(project, runtimeId, signal)
  const before = useNodeOutputStore.getState()
  const runtime = before.runtimes[runtimeId]
  const outputVersion = runtime?.outputVersion
  const inputFingerprint = runtime?.inputsFingerprint
  const refVersion = before.refs[runtimeId]?.[portId]?.version
  if (!runtime || outputVersion === undefined || !inputFingerprint || refVersion !== outputVersion) {
    throw new FigureCaptureError('E_EXECUTION_FAILED', `「${place.node.label}」当前没有可读取的图像结果；没有保存旧图`)
  }

  const chart = await resolveNodeChartAtPath(place.node, place.workflow, place.groupPath, `agent:${runtimeId}`)
  if (!chart) throw new FigureCaptureError('E_EXECUTION_FAILED', `「${place.node.label}」当前没有可读取的图像结果；没有保存旧图`)
  const visual = await renderChartVisual(chart)
  const sourceFingerprintSha256 = await sha256Hex(inputFingerprint)
  if (signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError')

  // Table head retrieval and PNG rendering are asynchronous. Reject the capture if
  // any new result arrived while those operations ran; the caller can retry.
  const projectChanged = getCurrentProject
    ? stableStringify(editableProjectView(await getCurrentProject())) !== stableStringify(editableProjectView(project))
    : false
  const after = useNodeOutputStore.getState()
  const current = figureReadiness(project, runtimeId, after)
  const latest = after.runtimes[runtimeId]
  if (projectChanged || !current.ready || latest?.inputsFingerprint !== inputFingerprint || latest.outputVersion !== outputVersion || after.refs[runtimeId]?.[portId]?.version !== refVersion) {
    throw new FigureCaptureError('E_EXECUTION_FAILED', '图表在读取期间发生变化；请重试以取得当前图像')
  }

  return {
    ...visual,
    nodeId: place.node.id,
    groupPath: [...place.groupPath],
    label: [...place.groupLabels, place.node.label].join(' > '),
    runtimeId,
    portId,
    sourceFingerprintSha256,
  }
}
