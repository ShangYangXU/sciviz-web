import { EngineDispatcher, type ProgressListener, type StatusListener } from './dispatch'
import { EngineError } from './errors'
import type {
  DatasetPayload,
  EngineStatus,
  EvalRequest,
  EvalResult,
  PreviewTable,
  WorkerOut,
} from './protocol'

/**
 * 执行引擎的主线程客户端 —— **本地宿主适配器**。
 *
 * 与 `client.ts` 暴露完全相同的一组函数，所以调度器不需要知道自己在跟谁说话。
 * 存在的理由只有一个：**GPU**。Pyodide 是 CPU-only 的 CPython，接不了 CUDA。
 *
 * 传输是 WebSocket + 二进制帧。数据集里的数值不进 JSON：1M 行 × 10 列编码成
 * base64 既慢又白占三成带宽。只把"有哪些列、什么顺序、什么类型"发过去，
 * 数值按同一个顺序走二进制帧 —— 顺序由 WebSocket 自己保证，不需要包头。
 */

const DEFAULT_URL = 'http://127.0.0.1:8765'

export interface LocalHealth {
  protocolVersion: number
  ok: boolean
  engine: string
  python: string
  operators: string[]
  device: {
    backend: 'cuda' | 'cpu'
    summary: string
    gpuNames: string[]
    torchVersion: string | null
  }
}

type WireColumn = { name: string; dtype: 'float32' | 'float64'; kind: 'time' | 'column' }

/**
 * 宿主地址。桌面启动器会在 `host` 查询参数里给出实际端口；已打包的本地应用没有该参数时，
 * 使用当前 origin。Vite 开发模式则依次使用 `localStorage`、构建期 `VITE_SCIVIZ_HOST` 与默认端口。
 * 画布、固定数据集和 Agent 共用此函数，避免宿主改用备用端口后各自连到不同进程。
 */
export function localEngineUrl(): string {
  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search)
  const fromQuery = params?.get('host')?.trim()
  if (fromQuery) return fromQuery.replace(/\/+$/, '')

  if (params?.get('engine') === 'local' && !import.meta.env.DEV) {
    return window.location.origin.replace(/\/+$/, '')
  }

  const saved =
    typeof localStorage === 'undefined' ? null : localStorage.getItem('sciviz.localEngineUrl')
  const fromEnv = import.meta.env.VITE_SCIVIZ_HOST as string | undefined
  return (saved || fromEnv || DEFAULT_URL).replace(/\/+$/, '')
}

/** 探一下宿主在不在。超时要短 —— 它决定的是"要不要等"，不是在等一个结果 */
export async function probeLocalEngine(timeoutMs = 900): Promise<LocalHealth | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${localEngineUrl()}/health`, { signal: controller.signal })
    if (!response.ok) return null
    const body = (await response.json()) as LocalHealth
    return body?.ok ? body : null
  } catch {
    // 探不到就是探不到，不是错误：没有宿主时本来就要回落 Pyodide
    return null
  } finally {
    clearTimeout(timer)
  }
}

let socket: WebSocket | null = null
let opening: Promise<WebSocket> | null = null
let initPromise: Promise<void> | null = null

const dispatcher = new EngineDispatcher()

export function engineStatus(): { status: EngineStatus; detail: string } {
  return dispatcher.statusOf()
}

export function onEngineStatus(listener: StatusListener): () => void {
  return dispatcher.onStatus(listener)
}

function socketUrl(): string {
  return `${localEngineUrl().replace(/^http/, 'ws')}/engine`
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (opening) return opening

  opening = new Promise<WebSocket>((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(socketUrl())
    const giveUp = (message: string) => {
      settled = true
      opening = null
      reject(new EngineError(message))
    }

    ws.onopen = () => {
      settled = true
      socket = ws
      opening = null
      resolve(ws)
    }
    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        dispatcher.handle(JSON.parse(event.data) as WorkerOut)
      } catch (err) {
        // 宿主发来的不是合法 JSON 说明协议对不上。宁可当场报错，也不要静默丢消息
        dispatcher.setStatus('failed', `宿主发来的消息无法解析：${String(err)}`)
        dispatcher.failAll('宿主消息协议不匹配')
      }
    }
    ws.onerror = () => {
      if (settled) return
      giveUp(
        `连不上本地执行宿主 ${localEngineUrl()}。先运行 py -3.12 -m sciviz_host，` +
          '或在地址后面加 ?engine=pyodide 用浏览器引擎',
      )
    }
    ws.onclose = () => {
      socket = null
      initPromise = null
      if (!settled) {
        giveUp(`本地执行宿主在连接过程中断开：${localEngineUrl()}`)
        return
      }
      // 已经连上过又断了：在飞的请求永远不会有回话
      const reason = '本地执行宿主已断开'
      dispatcher.setStatus('failed', reason)
      dispatcher.failAll(reason)
    }
  })
  return opening
}

function send(message: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new EngineError('本地执行宿主还没连上')
  }
  socket.send(JSON.stringify(message))
}

/** 连接宿主并等它报 ready（幂等）。连不上会失败，而不是悄悄回落 —— 回落由 backend 决定 */
export function ensureEngine(): Promise<void> {
  if (initPromise) return initPromise
  dispatcher.setStatus('loading', '正在连接本地执行宿主')
  initPromise = (async () => {
    const ws = await connect()
    const ready = new Promise<void>((resolve, reject) => {
      const off = dispatcher.onStatus((status, why) => {
        if (status === 'ready') {
          off()
          resolve()
        } else if (status === 'failed') {
          off()
          reject(new EngineError(why || '本地执行宿主启动失败'))
        }
      })
    })
    ws.send(JSON.stringify({ type: 'init' }))
    await ready
  })()
  // 失败之后要能重试：宿主要么被启动了，要么被重启了
  initPromise.catch(() => {
    initPromise = null
  })
  return initPromise
}

export async function setDataset(payload: DatasetPayload): Promise<void> {
  const columns: WireColumn[] = []
  if (payload.time) {
    columns.push({ name: payload.timeColumn ?? '__time', dtype: 'float64', kind: 'time' })
  }
  for (const name of Object.keys(payload.data)) {
    columns.push({ name, dtype: 'float32', kind: 'column' })
  }

  // 先取到要发的字节再登记等待：中途失败不能留下一个永远不落地的 promise
  const frames = columns.map((column): ArrayBufferView => {
    const values = column.kind === 'time' ? payload.time : payload.data[column.name]
    if (!values) throw new EngineError(`数据集缺少列「${column.name}」的数值`)
    return values
  })

  const waiting = dispatcher.awaitDataset(payload.datasetId)
  send({
    type: 'setDataset',
    payload: {
      datasetId: payload.datasetId,
      rowCount: payload.rowCount,
      timeColumn: payload.timeColumn,
      columns,
    },
  })
  // 二进制帧必须紧跟其后、顺序与 columns 完全一致：宿主不解析包头，
  // 它按同一个顺序认列。中间插一条别的消息就会整体错位。
  for (const frame of frames) socket?.send(frame)
  return waiting
}

export async function loadFn(nodeId: string, code: string, fnName: string): Promise<void> {
  const waiting = dispatcher.awaitFn(nodeId)
  send({ type: 'loadFn', nodeId, code, fnName })
  return waiting
}

export async function evalNode(args: EvalRequest): Promise<EvalResult> {
  const waiting = dispatcher.awaitEval(args.nodeId)
  send({ type: 'evalNode', ...args })
  return waiting
}

export async function head(nodeId: string, portId: string, n: number, offset = 0): Promise<PreviewTable> {
  const { requestId, promise } = dispatcher.awaitHead()
  send({ type: 'head', requestId, nodeId, portId, n, offset })
  return promise
}

export function dropNode(nodeId: string): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  send({ type: 'dropNode', nodeId })
}

/**
 * 请宿主停下这个节点。
 *
 * 返回 false = **这条请求送不出去**（没连上 / 宿主不在）—— 界面据此区分
 * "已经请它停了"与"连不上宿主"，而不是一律显示"正在取消"然后什么都不发生。
 */
export function cancelNode(nodeId: string): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  send({ type: 'cancel', nodeId })
  return true
}

/** 订阅节点进度。宿主不报进度的算子不会有任何回调 */
export function onNodeProgress(listener: ProgressListener): () => void {
  return dispatcher.onProgress(listener)
}
