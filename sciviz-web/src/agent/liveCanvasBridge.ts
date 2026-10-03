import { localEngineUrl } from '../engine/localClient'
import { projectEditFingerprint } from '../kernel/editFingerprint'
import { useCanvasHistory } from '../store/canvasHistory'
import { useNodeOutputStore } from '../store/nodeOutputStore'
import { applyProjectText, activeProjectId, buildProjectFromStores, rememberDraftProjectId, undoLastPatch } from '../store/projectFile'
import { useWorkflowStore } from '../store/useWorkflowStore'
import { emptyWorkflow } from '../workflow/defaultWorkflow'
import { emptyProject, projectToText, type Project } from '../workflow/project'
import { inspectCanvasGraph } from './canvasInspection'
import { runGraphPatch, runGraphUndo } from './graphTools'
import { readWriteMode } from './writeMode'
import { confirmDiscardReportDraft } from '../store/reportDraftGuard'

type LiveCanvasAction = 'new' | 'inspect' | 'patch' | 'undo' | 'run' | 'screenshot'

interface LiveCanvasRequest {
  type: 'request'
  requestId: string
  action: LiveCanvasAction
  payload?: Record<string, unknown>
}

interface LiveCanvasOptions {
  activateCanvas: () => void
}

const RETRY_MS = 1500
const MAX_RETRY_MS = 10000
const MAX_SCREENSHOT_SIDE = 1600
const MAX_SCREENSHOT_PIXELS = 2_560_000

/** Keep the local app registered with the host so an MCP call can target its live stores. */
export function startLiveCanvasBridge(options: LiveCanvasOptions): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let retryTimer: number | null = null
  let stateTimer: number | null = null
  let requestQueue: Promise<void> = Promise.resolve()
  let retryDelay = RETRY_MS
  let pageId = globalThis.crypto?.randomUUID?.() ?? `page-${Date.now().toString(36)}`

  const state = () => {
    const workflow = useWorkflowStore.getState().workflow
    return {
      pageId,
      title: document.title,
      projectId: activeProjectId(),
      projectName: workflow.name,
      nodeCount: workflow.nodes.length,
      edgeCount: workflow.edges.length,
      visible: document.visibilityState === 'visible',
      focused: document.hasFocus(),
    }
  }

  const sendState = () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'state', state: state() }))
    }
  }

  const reconnect = () => {
    if (stopped || retryTimer !== null) return
    retryTimer = window.setTimeout(() => {
      retryTimer = null
      void connect()
    }, retryDelay)
    retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 1.7)
  }

  const connect = async () => {
    if (stopped || socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return
    try {
      const host = localEngineUrl()
      const response = await fetch(`${host}/agent/config`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`宿主配置请求失败：${response.status}`)
      const config = await response.json() as { token?: unknown }
      if (typeof config.token !== 'string' || !config.token) throw new Error('宿主没有返回画布通道令牌')
      if (stopped) return

      const wsUrl = `${host.replace(/^http/, 'ws')}/agent/canvas`
      const next = new WebSocket(wsUrl)
      socket = next
      next.onopen = () => {
        retryDelay = RETRY_MS
        next.send(JSON.stringify({ type: 'hello', token: config.token, state: state() }))
        if (stateTimer !== null) window.clearInterval(stateTimer)
        stateTimer = window.setInterval(sendState, 1000)
      }
      next.onmessage = (event) => {
        let message: unknown
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (!message || typeof message !== 'object') return
        const request = message as Partial<LiveCanvasRequest>
        if (request.type !== 'request' || typeof request.requestId !== 'string' || !request.action) return
        requestQueue = requestQueue.then(async () => {
          const result = await handleRequest(request as LiveCanvasRequest)
          if (next.readyState === WebSocket.OPEN) {
            next.send(JSON.stringify({ type: 'result', requestId: request.requestId, result }))
          }
          sendState()
        }).catch(() => undefined)
      }
      next.onclose = () => {
        if (socket === next) socket = null
        if (stateTimer !== null) {
          window.clearInterval(stateTimer)
          stateTimer = null
        }
        reconnect()
      }
      next.onerror = () => next.close()
    } catch {
      reconnect()
    }
  }

  const handleRequest = async (request: LiveCanvasRequest): Promise<Record<string, unknown>> => {
    try {
      options.activateCanvas()
      await nextPaint()
      const payload = request.payload ?? {}
      let result: Record<string, unknown>
      switch (request.action) {
        case 'new': result = await createDraft(payload); break
        case 'inspect': result = await inspectLiveCanvas(); break
        case 'patch': result = await patchLiveCanvas(payload, request.requestId); break
        case 'undo': result = await undoLiveCanvas(payload, request.requestId); break
        case 'run': result = await runLiveCanvas(); break
        case 'screenshot': result = { ok: true }; break
        default: throw new Error(`不支持的实时画布动作：${String(request.action)}`)
      }

      const wantsImage = request.action === 'screenshot' ||
        (['new', 'patch', 'undo', 'run'].includes(request.action) && payload.includeScreenshot !== false)
      if (wantsImage && result.ok !== false) {
        try {
          result = { ...result, image: await captureCanvasImage() }
        } catch (error) {
          result = {
            ...result,
            screenshotWarning: error instanceof Error ? error.message : String(error),
          }
        }
      }
      return result
    } catch (error) {
      return {
        ok: false,
        error: { code: 'E_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) },
      }
    }
  }

  const onFocusChange = () => sendState()
  document.addEventListener('visibilitychange', onFocusChange)
  window.addEventListener('focus', onFocusChange)
  window.addEventListener('blur', onFocusChange)
  void connect()

  return () => {
    stopped = true
    document.removeEventListener('visibilitychange', onFocusChange)
    window.removeEventListener('focus', onFocusChange)
    window.removeEventListener('blur', onFocusChange)
    if (retryTimer !== null) window.clearTimeout(retryTimer)
    if (stateTimer !== null) window.clearInterval(stateTimer)
    socket?.close()
    socket = null
  }
}

async function inspectLiveCanvas(): Promise<Record<string, unknown>> {
  const project = await buildProjectFromStores()
  const fingerprint = await projectEditFingerprint(project)
  const graph = inspectCanvasGraph(project, { runtimes: useNodeOutputStore.getState().runtimes })
  return {
    ok: true,
    projectId: activeProjectId(),
    baseFingerprint: fingerprint,
    canvas: graph,
  }
}

async function createDraft(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : '未命名工作流'
  if (!confirmDiscardReportDraft()) {
    return { ok: false, status: 'rejected', error: { code: 'E_PARAM_INVALID', message: '用户取消切换画布' } }
  }
  const approved = window.confirm(`在当前 SciViz 页面创建空白画布「${name}」？\n\n当前打开的工程会与新画布分离；如有未保存内容，请先取消并保存。`)
  if (!approved) {
    return { ok: false, status: 'rejected', error: { code: 'E_PARAM_INVALID', message: '用户取消创建新画布' } }
  }

  window.dispatchEvent(new Event('sciviz-live-new-draft'))
  useCanvasHistory.getState().clear()
  const workflow = emptyWorkflow(`wf-live-${Date.now().toString(36)}`, name)
  const project = emptyProject(workflow)
  const applied = applyProjectText(projectToText(project), `wf-live-${Date.now().toString(36)}`)
  if (!applied.ok) throw new Error(applied.error ?? '无法初始化空白画布')
  const projectId = activeProjectId()
  rememberDraftProjectId(localStorage, projectId)
  return { ok: true, projectId, name, created: true, nodeCount: 0, edgeCount: 0 }
}

async function patchLiveCanvas(payload: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>> {
  const project = await buildProjectFromStores()
  const mode = readWriteMode(localStorage, activeProjectId())
  const call = await runGraphPatch(project, payload, `mcp-canvas-${requestId}`, {
    confirm: (question) => window.confirm(question),
    mode,
    write: (applied, patch, result) => {
      const withRecord: Project = {
        ...applied,
        patches: [
          ...applied.patches,
          {
            at: Date.now(),
            reason: patch.reason ?? 'MCP 实时画布补丁',
            ops: patch.ops as unknown as Record<string, unknown>[],
            reverse: result.reverse as unknown as Record<string, unknown>[],
          },
        ],
      }
      const written = applyProjectText(projectToText(withRecord), activeProjectId())
      return written.ok ? { ok: true } : { ok: false, error: written.error ?? '补丁写回画布失败' }
    },
  })
  const data = call.data && typeof call.data === 'object' ? call.data as Record<string, unknown> : {}
  const fingerprint = call.ok ? await projectEditFingerprint(await buildProjectFromStores()) : undefined
  return {
    ok: call.ok,
    status: call.status,
    ...(call.error ? { error: call.error } : {}),
    ...(fingerprint ? { baseFingerprint: fingerprint } : {}),
    data: { ...data, ...(fingerprint ? { baseFingerprint: fingerprint } : {}) },
  }
}

async function undoLiveCanvas(payload: Record<string, unknown>, requestId: string): Promise<Record<string, unknown>> {
  const project = await buildProjectFromStores()
  const mode = readWriteMode(localStorage, activeProjectId())
  const call = await runGraphUndo(project, payload, `mcp-canvas-undo-${requestId}`, {
    confirm: (question) => window.confirm(question),
    mode,
    undo: undoLastPatch,
  })
  const data = call.data && typeof call.data === 'object' ? call.data as Record<string, unknown> : {}
  const fingerprint = call.ok ? await projectEditFingerprint(await buildProjectFromStores()) : undefined
  return {
    ok: call.ok,
    status: call.status,
    ...(call.error ? { error: call.error } : {}),
    ...(fingerprint ? { baseFingerprint: fingerprint } : {}),
    ...(call.data ? { data: { ...data, ...(fingerprint ? { baseFingerprint: fingerprint } : {}) } } : {}),
  }
}

async function runLiveCanvas(): Promise<Record<string, unknown>> {
  await useWorkflowStore.getState().runWorkflow()
  const runtimes = useNodeOutputStore.getState().runtimes
  const nodes = Object.fromEntries(Object.entries(runtimes).map(([id, runtime]) => [id, {
    status: runtime.status,
    outputVersion: runtime.outputVersion,
    error: runtime.error?.message,
    progress: runtime.progress,
  }]))
  return { ok: true, nodes, pending: Object.values(runtimes).some((runtime) => runtime.status === 'computing') }
}

async function captureCanvasImage(): Promise<Record<string, unknown>> {
  const source = document.querySelector<HTMLElement>('.canvas-host')
  if (!source) throw new Error('当前页面找不到画布区域')
  const rect = source.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) throw new Error('画布当前不可见，无法截图')

  const clone = source.cloneNode(true) as HTMLElement
  inlineComputedStyles(source, clone)
  clone.style.width = `${rect.width}px`
  clone.style.height = `${rect.height}px`
  const wrapper = document.createElement('div')
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  wrapper.style.cssText = `width:${rect.width}px;height:${rect.height}px;overflow:hidden;background:#fff`
  wrapper.append(clone)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}" viewBox="0 0 ${rect.width} ${rect.height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrapper)}</foreignObject></svg>`
  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const objectUrl = URL.createObjectURL(svgBlob)
  try {
    const image = new Image()
    image.src = objectUrl
    await image.decode()
    const scale = Math.min(1, MAX_SCREENSHOT_SIDE / rect.width, MAX_SCREENSHOT_SIDE / rect.height,
      Math.sqrt(MAX_SCREENSHOT_PIXELS / (rect.width * rect.height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(rect.width * scale))
    canvas.height = Math.max(1, Math.round(rect.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布截图上下文')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法编码画布 PNG')), 'image/png')
    })
    if (blob.size > 8 * 1024 * 1024) throw new Error('画布 PNG 超过 MCP 的 8 MiB 图像上限')
    const data = await blobToBase64(blob)
    return { mimeType: 'image/png', data, width: canvas.width, height: canvas.height, byteLength: blob.size }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function inlineComputedStyles(source: Element, clone: Element): void {
  const computed = getComputedStyle(source)
  const style = (clone as HTMLElement | SVGElement).style
  for (let index = 0; index < computed.length; index += 1) {
    const property = computed.item(index)
    style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property))
  }
  const sourceChildren = source.children
  const cloneChildren = clone.children
  for (let index = 0; index < Math.min(sourceChildren.length, cloneChildren.length); index += 1) {
    inlineComputedStyles(sourceChildren[index], cloneChildren[index])
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取画布 PNG 失败'))
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      if (comma < 0) reject(new Error('画布 PNG 编码格式无效'))
      else resolve(value.slice(comma + 1))
    }
    reader.readAsDataURL(blob)
  })
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}
