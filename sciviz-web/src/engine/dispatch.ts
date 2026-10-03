import { CancelledError, EngineError } from './errors'
import { toPreviewTable } from './table'
import type {
  EvalResult,
  EngineStatus,
  PreviewTable,
  WorkerOut,
} from './protocol'

export type StatusListener = (status: EngineStatus, detail: string) => void

/** 某个节点的进度变了一下。`message` 可以为空串（只有比例） */
export type ProgressListener = (nodeId: string, ratio: number, message: string) => void

interface Pending<T> {
  resolve: (value: T) => void
  reject: (error: EngineError) => void
}

/**
 * 引擎回话的分派：状态 + "哪条消息唤醒哪个 promise"。
 *
 * 两个适配器（Pyodide Worker 的 postMessage、本地宿主的 WebSocket）收到的消息是
 * 同构的（`protocol.ts`），所以这套判断只应该有一份 —— 两份的下场是其中一个
 * 适配器漏处理某种错误，而那个错误恰好只在 GPU 路径上出现。
 *
 * 传输方式留在各自的客户端里：Worker 要 spawn，WebSocket 要连接与重连，
 * 那才是它们真正不同的部分。
 */
export class EngineDispatcher {
  private status: EngineStatus = 'cold'
  private detail = ''
  private headSeq = 0

  private readonly listeners = new Set<StatusListener>()
  private readonly progressListeners = new Set<ProgressListener>()
  private readonly datasets = new Map<string, Pending<void>>()
  private readonly fns = new Map<string, Pending<void>>()
  private readonly evals = new Map<string, Pending<EvalResult>>()
  private readonly heads = new Map<number, Pending<PreviewTable>>()

  statusOf(): { status: EngineStatus; detail: string } {
    return { status: this.status, detail: this.detail }
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener)
    listener(this.status, this.detail)
    return () => this.listeners.delete(listener)
  }

  /**
   * 订阅节点进度。
   *
   * 进度**不进 promise**：它不是"这一次求值的结果"，而是一条持续的过程量。
   * 把它塞进 await 会逼着调用方在拿到结果之前什么都做不了 —— 而进度的全部意义
   * 就是"在结果还没来的时候有东西可看"。
   */
  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  setStatus(next: EngineStatus, why = ''): void {
    this.status = next
    this.detail = why
    for (const listener of this.listeners) listener(next, why)
  }

  awaitDataset(datasetId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.datasets.set(datasetId, { resolve, reject })
    })
  }

  awaitFn(nodeId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.fns.set(nodeId, { resolve, reject })
    })
  }

  awaitEval(nodeId: string): Promise<EvalResult> {
    return new Promise<EvalResult>((resolve, reject) => {
      this.evals.set(nodeId, { resolve, reject })
    })
  }

  awaitHead(): { requestId: number; promise: Promise<PreviewTable> } {
    const requestId = ++this.headSeq
    const promise = new Promise<PreviewTable>((resolve, reject) => {
      this.heads.set(requestId, { resolve, reject })
    })
    return { requestId, promise }
  }

  /** 传输断了：在飞的请求永远不会有回话，必须当场拒绝，不能挂着 */
  failAll(message: string): void {
    const error = new EngineError(message)
    for (const pending of this.datasets.values()) pending.reject(error)
    for (const pending of this.fns.values()) pending.reject(error)
    for (const pending of this.evals.values()) pending.reject(error)
    for (const pending of this.heads.values()) pending.reject(error)
    this.datasets.clear()
    this.fns.clear()
    this.evals.clear()
    this.heads.clear()
  }

  handle(message: WorkerOut): void {
    switch (message.type) {
      case 'initProgress':
        this.setStatus('loading', message.phase)
        return
      case 'ready':
        this.setStatus('ready', message.engineInfo)
        return
      case 'initError':
        this.setStatus('failed', message.message)
        this.failAll(message.message)
        return
      case 'datasetReady':
        this.datasets.get(message.datasetId)?.resolve()
        this.datasets.delete(message.datasetId)
        return
      case 'datasetError':
        this.datasets.get(message.datasetId)?.reject(new EngineError(message.message))
        this.datasets.delete(message.datasetId)
        return
      case 'fnLoaded':
        this.fns.get(message.nodeId)?.resolve()
        this.fns.delete(message.nodeId)
        return
      case 'fnError':
        this.fns.get(message.nodeId)?.reject(new EngineError(message.message))
        this.fns.delete(message.nodeId)
        return
      case 'nodeResult':
        // 产物随结果一起回来：这次算出了什么、落了哪些盘，是同一条消息里的两件事
        this.evals
          .get(message.nodeId)
          ?.resolve({
            refs: message.refs,
            artifacts: message.artifacts ?? [],
            meta: message.meta ?? {},
            // 「这次没算，用的是上次那份」必须一路带到界面与清单（见 protocol.ts）
            ...(message.cached ? { cached: true } : {}),
            ...(message.restored ? { restored: true } : {}),
          })
        this.evals.delete(message.nodeId)
        return
      case 'nodeProgress':
        for (const listener of this.progressListeners) {
          listener(message.nodeId, message.ratio, message.message)
        }
        return
      case 'nodeCancelled':
        // 取消**是**这次求值的终点，所以它唤醒 promise（而不是当成一条过程量）——
        // 但唤醒方式是一个能被识别的类型，上层据此走"可重试"而不是"失败"
        this.evals.get(message.nodeId)?.reject(new CancelledError(message.message))
        this.evals.delete(message.nodeId)
        return
      case 'nodeError':
        this.evals
          .get(message.nodeId)
          ?.reject(new EngineError(message.message, message.traceback))
        this.evals.delete(message.nodeId)
        return
      case 'head':
        this.heads.get(message.requestId)?.resolve(toPreviewTable(message.table))
        this.heads.delete(message.requestId)
        return
      case 'headError':
        this.heads.get(message.requestId)?.reject(new EngineError(message.message))
        this.heads.delete(message.requestId)
        return
    }
  }
}
