/**
 * 无头核的对外契约。
 *
 * 这一层是"算出一张图"的全部对外形状。界面与 CLI 都只说这些类型，
 * 所以"同一张图在两边得到同一份结论"是结构上保证的，而不是靠两边各写一遍、再靠纪律对齐。
 */

import type { PortContext } from '../workflow/ports'
import type { OperatorFacts, RuntimeClass, Workflow } from '../workflow/types'
import type {
  DatasetPayload,
  Inputs,
  NodeRuntime,
  OutputPortSpec,
  PreviewTable,
} from '../engine/protocol'
import type { DatasetRef } from './dataset'

export type { OperatorFacts }

/**
 * 执行适配器。**与 `engine/backend.ts` 导出的那组函数同名同形** ——
 * 浏览器把 backend 传进来，CLI 把本地宿主的 WebSocket 客户端传进来，
 * 核不需要知道差别。
 */
export interface KernelAdapter {
  /** 启动/连接引擎，返回一行可读的引擎信息（浏览器是 Pyodide 版本，宿主是设备） */
  ensureReady(): Promise<string>
  setDataset(payload: DatasetPayload): Promise<void>
  loadFn(nodeId: string, code: string, fnName: string): Promise<void>
  evalNode(args: {
    nodeId: string
    nodeType: string
    params: Record<string, string | number | boolean>
    inputs: Inputs
    outputPorts: OutputPortSpec[]
    /** 主线程算好的输入指纹。引擎用它给产物归档 */
    fingerprint?: string
    /** 这个节点的数据实际的采样率（R3.4）。查不出来时 null */
    sampleRate?: number | null
    /**
     * 这个结果能不能跨会话复用（R6.4）。
     *
     * 只有实现了缓存的执行面才理会它（目前是本地宿主，见 `sciviz_host/cache.py`）。
     * 不理会它的执行面照常重算 —— 那是"没省下时间"，不是"算错了"。
     */
    cacheable?: boolean
    /** 输出摘要携带的上游端口身份链；由无头核从输入绑定推导。 */
    lineage?: string[]
  }): Promise<import('../engine/protocol').EvalResult>
  head(nodeId: string, portId: string, n: number, offset?: number): Promise<PreviewTable>
  dropNode(nodeId: string): void
  /**
   * 订阅节点进度（可选）。
   *
   * 不实现 = 这个执行面不报进度，界面就不画进度条。**不许**拿一个假的比例顶上：
   * 进度条的意义是"长任务还活着、走到哪儿了"，编一个出来它就成了装饰。
   */
  onNodeProgress?(listener: (nodeId: string, ratio: number, message: string) => void): () => void
  /**
   * 请引擎停下某个节点（可选）。返回 false = 这个执行面做不到。
   *
   * Pyodide 就是做不到：那里一次求值是一个**同步**的 Python 调用，中断插不进去。
   * 所以这个能力的差别必须能被上层看见（界面据此不显示取消按钮），
   * 而不是给一个按下去没有反应的按钮。
   */
  cancelNode?(nodeId: string): boolean
}

/** 数据集的查询入口。由 `DatasetCatalog` 提供，核只依赖这个形状 */
export interface DatasetLookup {
  has(id: string): boolean
  ref(id: string): DatasetRef | undefined
  featuresOf(id: string): string[]
  timeColumnOf(id: string): string | null
  payload(id: string): DatasetPayload | undefined
}

export interface KernelDeps {
  adapter: KernelAdapter
  datasets: DatasetLookup
  ctx: PortContext
  /** 查一个算子类型的事实；未知类型返回 null */
  operatorOf: (type: string) => OperatorFacts | null
  /**
   * 当前这个执行面能不能跑"只有宿主能跑"的算子（AGENTS.md R4）。
   *
   * 传函数而不是布尔值：执行面是**懒选址**的（先探一次宿主在不在，探到才定），
   * 而核可能在选址完成之前就拿着 deps 了。不传则按"能跑"处理 ——
   * CLI 永远连着宿主，界面必须显式回答这个问题。
   */
  canRunHostOperators?: () => boolean
  /**
   * 返回原因表示这次先不运行该节点，等待客户端显式启动。
   * CLI 不传；画布用它门控 GPU 训练等高成本后台任务。
   */
  deferNode?: (node: import('../workflow/types').WorkflowNode, fingerprint: string) => string | null
  /**
   * 返回当前工程中与当前训练指纹**同一个计算**的引用；不得查找其他工程的制品。
   *
   * 返回值带上引用里记的训练指纹：恢复请求要拿它去和制品自己的 `meta.json` 对齐
   * （宿主严格比对，见 `src/engine/protocol.ts` 的 `restoreArtifactId`）。
   */
  modelArtifactForNode?: (nodeId: string, fingerprint: string) =>
    | { artifactId: string; manifestSha256: string; trainingFingerprint: string }
    | undefined
  clock?: () => number
}

export interface KernelLogEntry {
  at: number
  nodeId: string | null
  level: 'info' | 'ok' | 'warn' | 'error'
  message: string
}

/**
 * 一次求值的记录。
 *
 * 记的是**事实上怎么算出来的**：`runtime` 是这一次实际走的执行面。
 * 清单里声明的 `execClass`（interactive / background / batch）不进这里 ——
 * 那是"该按什么规格算"，属于算子清单，运行清单从算子事实里读（见 manifest.ts）。
 */
export interface JobRecord {
  nodeId: string
  nodeType: string
  runtime: RuntimeClass
  fingerprint: string | null
  status: 'done' | 'failed' | 'skipped'
  startedAt: number
  finishedAt: number
  durationMs: number
  error?: { message: string; traceback: string }
}

export interface KernelOptions {
  /** 定点循环的轮数上限，与界面同一套调度语义（上游 +1 之后下游才过期） */
  maxRounds?: number
  /** 每个节点的运行时状态一变就回调。界面用它逐节点上色 */
  onRuntime?: (nodeId: string, runtime: NodeRuntime) => void
  /** 某个节点的产物变了就回调 */
  onRefs?: (nodeId: string, refs: Record<string, import('../engine/protocol').OutputRefBody>, version: number) => void
  onLog?: (entry: KernelLogEntry) => void
  isCancelled?: () => boolean
}

export interface KernelResult {
  workflow: Workflow
  engineInfo: string
  runtimes: Record<string, NodeRuntime>
  refs: Record<string, Record<string, import('../engine/protocol').OutputRefBody>>
  jobs: JobRecord[]
  logs: KernelLogEntry[]
  /** 引擎算不了的节点，如实列出而不是编产物 */
  notComputed: { nodeId: string; nodeType: string; reason: string }[]
  cancelled: boolean
  startedAt: number
  finishedAt: number
}
