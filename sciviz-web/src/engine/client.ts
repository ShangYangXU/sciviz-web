import { EngineDispatcher, type StatusListener } from './dispatch'
import { EngineError } from './errors'
import type {
  DatasetPayload,
  EngineStatus,
  EvalRequest,
  EvalResult,
  PreviewTable,
  WorkerIn,
  WorkerOut,
} from './protocol'

export { EngineError }

/**
 * 执行引擎的主线程客户端 —— **Pyodide 适配器**。
 *
 * 只暴露 promise 化的调用，不把 postMessage 泄漏给上层。上层应该 import
 * `backend.ts`：有两个适配器，这里是"零安装、纯 CPU"的那一个。
 *
 * 将来换成本地 Python 进程 + WebSocket 时，这里换实现、上面的调用方一行不用改
 * —— 那句话现在兑现了，见 `localClient.ts`。
 */

let worker: Worker | null = null
let initPromise: Promise<void> | null = null

const dispatcher = new EngineDispatcher()

const post = (msg: WorkerIn, transfer?: Transferable[]) =>
  worker?.postMessage(msg, transfer ?? [])

export function engineStatus(): { status: EngineStatus; detail: string } {
  return dispatcher.statusOf()
}

export function onEngineStatus(listener: StatusListener): () => void {
  return dispatcher.onStatus(listener)
}

function spawn(): Worker {
  const w = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<WorkerOut>) => dispatcher.handle(e.data)
  // Worker 崩掉后所有输出都不可信了，交给上层重建整个图
  w.onerror = (ev) => {
    dispatcher.setStatus('failed', ev.message || 'Worker 异常退出')
    dispatcher.failAll(ev.message || '执行引擎已退出')
    worker = null
    initPromise = null
  }
  return w
}

/** 启动引擎（幂等）。首次调用会加载 Pyodide，可能要几秒 */
export function ensureEngine(): Promise<void> {
  if (initPromise) return initPromise
  worker = spawn()
  dispatcher.setStatus('loading', '正在启动执行引擎')
  initPromise = new Promise<void>((resolve, reject) => {
    const off = dispatcher.onStatus((s, why) => {
      if (s === 'ready') {
        off()
        resolve()
      } else if (s === 'failed') {
        off()
        reject(new EngineError(why || '执行引擎启动失败'))
      }
    })
    post({ type: 'init' })
  })
  return initPromise
}

export function setDataset(payload: DatasetPayload): Promise<void> {
  const waiting = dispatcher.awaitDataset(payload.datasetId)
  post({ type: 'setDataset', payload })
  return waiting
}

export function loadFn(nodeId: string, code: string, fnName: string): Promise<void> {
  const waiting = dispatcher.awaitFn(nodeId)
  post({ type: 'loadFn', nodeId, code, fnName })
  return waiting
}

export function evalNode(args: EvalRequest): Promise<EvalResult> {
  const waiting = dispatcher.awaitEval(args.nodeId)
  post({ type: 'evalNode', ...args })
  return waiting
}

/** 按需拉一页行值。全表在 Python 侧，只有这里才会真的把行值搬过来 */
export function head(nodeId: string, portId: string, n: number, offset = 0): Promise<PreviewTable> {
  const { requestId, promise } = dispatcher.awaitHead()
  post({ type: 'head', requestId, nodeId, portId, n, offset })
  return promise
}

export function dropNode(nodeId: string): void {
  post({ type: 'dropNode', nodeId })
}
