/**
 * 无头侧的**执行适配器**：Node 直连本地宿主（`sciviz_host`）的 WebSocket。
 *
 * 为什么不去自己起一个 Python 进程跑算子：宿主已经是一份完整的实现
 * （会话隔离、设备探测、GPU 算子、二进制帧协议）。再写一遍就是第二份实现，
 * 而两份的差别只会在"同一张图在界面里与命令行里算出不同结果"时才被发现。
 *
 * 与 `engine/localClient.ts` 的关系：那个是给**浏览器**用的（要 localStorage、
 * 要 fetch、要 import.meta.env）。这里保留共用的部分 —— 消息分派用的是同一个
 * `EngineDispatcher`，所以"哪条消息唤醒哪个 promise"只有一处判断。
 */

import { EngineDispatcher } from '../engine/dispatch'
import { EngineError } from '../engine/errors'
import type { KernelAdapter } from '../kernel/types'
import type { RunEnvironment } from '../kernel/manifest'
import type {
  DatasetPayload,
  EvalRequest,
  EvalResult,
  PreviewTable,
  WorkerOut,
} from '../engine/protocol'

export const DEFAULT_HOST_URL = 'http://127.0.0.1:8765'

/**
 * 宿主自报的环境 → 运行清单里那一节（契约规格 R6.3 要求的"环境信息"）。
 *
 * 为什么要把这件事记下来：换台机器重跑结果对不上时，**只有这些字段能做差**。
 * torch 版本、CUDA 版本、显卡型号都是实测会改结果的变量；少了它们，
 * "为什么这次不一样"就只能靠回忆。宿主没答上来时返回 null —— 缺就是缺。
 */
export function environmentOf(health: HostHealth | null): RunEnvironment | null {
  if (!health) return null
  return {
    python: health.python,
    numpy: health.numpy,
    pandas: health.pandas,
    scipy: health.scipy ?? null,
    torch: health.device.torchVersion ?? null,
    cuda: health.device.cudaVersion ?? null,
    gpuNames: health.device.gpuNames ?? [],
    totalMemoryMb: health.device.totalMemoryMb ?? null,
    device: health.device.backend,
  }
}

export interface HostHealth {
  protocolVersion: number
  ok: boolean
  engine: string
  python: string
  numpy: string
  pandas: string
  /** 可能为 null：只被一部分共享算子用到，装不上时宿主照样提供服务 */
  scipy: string | null
  operators: string[]
  device: {
    backend: 'cuda' | 'cpu'
    summary: string
    gpuNames: string[]
    torchVersion: string | null
    cudaVersion: string | null
    totalMemoryMb: number | null
  }
}

/**
 * 同一个宿主有两种写法，取决于说什么：`/health` 走 http，引擎连接走 ws
 * （见 `socketUrl`）。两种写法都该能用 —— 否则"换个写法就说宿主人不在"，
 * 而报出来的是一句假话，排查的人会去重启一个本来就在跑的宿主。
 */
function httpUrlOf(url: string): string {
  return url.replace(/\/+$/, '').replace(/^ws/, 'http')
}

/** 探一下宿主在不在。/health 是它自报能力的地方，也是唯一的探活方式 */
export async function probeHost(url = DEFAULT_HOST_URL, timeoutMs = 1500): Promise<HostHealth | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${httpUrlOf(url)}/health`, { signal: controller.signal })
    if (!response.ok) return null
    const body = (await response.json()) as HostHealth
    return body?.ok ? body : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

type WireColumn = { name: string; dtype: 'float32' | 'float64'; kind: 'time' | 'column' }

export class HostAdapter implements KernelAdapter {
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private ready: Promise<string> | null = null
  private readonly dispatcher = new EngineDispatcher()

  constructor(private readonly url: string = DEFAULT_HOST_URL) {}

  private socketUrl(): string {
    return `${this.url.replace(/\/+$/, '').replace(/^http/, 'ws')}/engine`
  }

  private connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.opening) return this.opening

    this.opening = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.socketUrl())
      let settled = false
      ws.onopen = () => {
        settled = true
        this.socket = ws
        this.opening = null
        resolve()
      }
      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          this.dispatcher.handle(JSON.parse(String(event.data)) as WorkerOut)
        } catch (err) {
          this.dispatcher.setStatus('failed', `宿主发来的消息无法解析：${String(err)}`)
          this.dispatcher.failAll('宿主消息协议不匹配')
        }
      }
      ws.onerror = () => {
        if (settled) return
        settled = true
        this.opening = null
        reject(
          new EngineError(
            `连不上本地执行宿主 ${this.url}。先在另一个终端里起它：\n` +
              '  cd sciviz-local; .\\run-host.ps1\n' +
              '（`sciviz doctor` 会告诉你它现在在不在、能算什么）',
          ),
        )
      }
      ws.onclose = () => {
        this.socket = null
        this.ready = null
        this.dispatcher.failAll('本地执行宿主已断开')
      }
    })
    return this.opening
  }

  private send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new EngineError('本地执行宿主还没连上')
    }
    this.socket.send(JSON.stringify(message))
  }

  /** 订阅节点进度。CLI 用它把百分比打到 stderr —— 过程量进不了报告与运行清单 */
  onNodeProgress(listener: (nodeId: string, ratio: number, message: string) => void): () => void {
    return this.dispatcher.onProgress(listener)
  }

  /** 请宿主停下某个节点。返回 false = 现在连不上，请求没送出去 */
  cancelNode(nodeId: string): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.send({ type: 'cancel', nodeId })
    return true
  }

  /** 连接 + 等宿主报 ready（幂等）。返回它自报的一行引擎信息 */
  ensureReady(): Promise<string> {
    if (this.ready) return this.ready
    this.dispatcher.setStatus('loading', '正在连接本地执行宿主')
    this.ready = (async () => {
      await this.connect()
      const engineInfo = new Promise<string>((resolve, reject) => {
        const off = this.dispatcher.onStatus((status, why) => {
          if (status === 'ready') {
            off()
            resolve(why)
          } else if (status === 'failed') {
            off()
            reject(new EngineError(why || '本地执行宿主启动失败'))
          }
        })
      })
      this.socket!.send(JSON.stringify({ type: 'init' }))
      return engineInfo
    })()
    // 失败之后要能重试：宿主要么刚被启动，要么刚被重启
    this.ready.catch(() => {
      this.ready = null
    })
    return this.ready
  }

  async setDataset(payload: DatasetPayload): Promise<void> {
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

    const waiting = this.dispatcher.awaitDataset(payload.datasetId)
    this.send({
      type: 'setDataset',
      payload: {
        datasetId: payload.datasetId,
        rowCount: payload.rowCount,
        timeColumn: payload.timeColumn,
        columns,
      },
    })
    // 二进制帧必须紧跟其后、顺序与 columns 完全一致：宿主不解析包头，按同一顺序认列。
    // 中间插一条别的消息就会整体错位。
    for (const frame of frames) this.socket?.send(frame)
    return waiting
  }

  async loadFn(nodeId: string, code: string, fnName: string): Promise<void> {
    const waiting = this.dispatcher.awaitFn(nodeId)
    this.send({ type: 'loadFn', nodeId, code, fnName })
    return waiting
  }

  async evalNode(args: EvalRequest): Promise<EvalResult> {
    const waiting = this.dispatcher.awaitEval(args.nodeId)
    this.send({ type: 'evalNode', ...args })
    return waiting
  }

  async head(nodeId: string, portId: string, n: number, offset = 0): Promise<PreviewTable> {
    const { requestId, promise } = this.dispatcher.awaitHead()
    this.send({ type: 'head', requestId, nodeId, portId, n, offset })
    return promise
  }

  dropNode(nodeId: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.send({ type: 'dropNode', nodeId })
  }

  close(): void {
    this.socket?.close()
    this.socket = null
    this.ready = null
  }
}
