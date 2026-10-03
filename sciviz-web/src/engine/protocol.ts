import type { ChartSpec, FigureImage } from '../types'
import type { PreviewTable } from '../workflow/types'

/** 前 N 行的形状沿用工作流里已有的那一个，界面与引擎说的是同一种表 */
export type { PreviewTable }

/**
 * 主线程 ↔ 执行引擎 Worker 的消息契约。
 *
 * 这是前后端之间唯一的接口。之所以单独成文件并且只放类型：将来把 Worker 换成
 * 本地 Python 进程时，改的是传输层（postMessage → WebSocket），这套消息原样保留。
 */

/* ---------------- 输出的"目录卡片" ---------------- */

export type OutputKind = 'table' | 'metrics' | 'figure' | 'model' | 'scaler'

/** 一个表输出的列级数值摘要；不包含原始行值。 */
export interface OutputColumnStats {
  count: number
  min: number | null
  max: number | null
  mean: number | null
  std: number | null
}

/**
 * 一个输出端口的摘要。
 *
 * **刻意不含具体行值**：全表（DataFrame）留在 Python 侧，这里只是"目录卡片"。
 * 要看行值时按需拉 head(nodeId, portId, n)，缓存键里的 version 保证改了上游会失效。
 */
export interface OutputRefBody {
  kind: OutputKind
  /** kind = table */
  columns?: string[]
  rowCount?: number
  timeColumn?: string | null
  /** kind = table。只统计数值列，NaN/Inf 不伪装成有限值。 */
  stats?: Record<string, OutputColumnStats>
  /** 这份摘要对应的求值指纹，便于 agent 判断是不是同一份结果。 */
  identity?: string
  /** 生成这份输出的上游端口身份链。 */
  lineage?: string[]
  /** kind = metrics。值为 null 表示这个指标算出来是 NaN/Inf，界面显示"—"而不是编一个数 */
  values?: Record<string, number | null>
  /** kind = figure */
  chart?: ChartSpec
  /** kind = figure；Matplotlib 图由 Python 导出成图片，前端只展示，不重新绘制 */
  image?: FigureImage
  /** kind = scaler。只放可序列化的摘要；真正的 scaler 对象仍留在 Python 会话内流转 */
  scaler?: Record<string, unknown>
}

/** 带上输出版本号的完整摘要。版本由主线程在收到结果时补 —— Python 侧不知道版本 */
export interface OutputRef extends OutputRefBody {
  version: number
}

/** 节点求值结果：输出端口 id → 摘要 */
export type NodeResultRefsBody = Record<string, OutputRefBody>

/**
 * 落盘的产物（目前只有训练节点的权重与 meta）。
 *
 * `path` 是**宿主机器上的绝对路径** —— 换台机器就不成立，所以清单里同时记
 * `fingerprint`：它才是"这是不是同一份输入算出来的"那个判据。
 */
export interface ArtifactRef {
  /** 产物类别（`model` / `meta` …）。界面写一句人话时用得上 */
  kind: string
  path: string
  bytes: number
  /** 不可变模型制品的身份；普通文件产物没有此字段 */
  artifactId?: string
  /** 此文件自身的 SHA-256（meta 项为 manifest 锚点） */
  sha256?: string
  /** 制品提交到磁盘时的 UTC 时间 */
  createdAt?: string
  /** 产出它的输入指纹 */
  fingerprint?: string
  /**
   * 这个节点的数据**实际**的采样率（Hz），由主线程从上游数据集的身份里查出来
   * （契约规格 R3.4：采样率是数据的属性，不是算子的参数）。
   *
   * null / 缺省 = 查不出来（上游不是数据源、来源不止一个数据集、或数据集没有时间列）。
   * 引擎**不猜**：查不出来时由算子决定是报错还是用用户显式填的值。
   */
  sampleRate?: number | null
}

/** 一次求值的请求。三个客户端（Pyodide / 宿主 / CLI 的宿主适配器）共用这一份形状 */
export interface EvalRequest {
  nodeId: string
  nodeType: string
  params: Record<string, string | number | boolean>
  inputs: Inputs
  outputPorts: OutputPortSpec[]
  /**
   * 主线程算好的输入指纹（`nodeFingerprint`）。
   *
   * 引擎自己算不出来：它只看得到这一次的参数与上游产物。产物按它归档，
   * 所以"同一份输入算两次"落在同一个目录 —— 那是跨运行复用的立足点（待办 T18）。
   */
  fingerprint?: string
  /**
   * 这一步的结果**能不能跨会话复用**。
   *
   * 判据不在引擎：由主线程按算子声明的 `determinism` 决定（契约规格 R6.4）——
   * `deterministic` 与 `seeded`（种子在 params 里、因此也在指纹里）可以，
   * `stochastic` / `volatile` 不可以。这样"能不能复用"只有一处判据。
   *
   * 两个训练算子声明 `stochastic`（GPU 上的非确定性归约，实测 CPU/GPU 不逐位相同）：
   * 复用它们的产物，等于把上一次算的冒充成这一次算的 —— 而运行清单会照着报，
   * 看起来完全正常。所以这一栏对它们是 false。
   */
  cacheable?: boolean
  /** 输出摘要携带的上游端口身份链；由无头核从输入绑定推导。 */
  lineage?: string[]
  /** 只由工程中已保存的、指纹精确匹配的引用设置；绝不代表训练请求 */
  restoreArtifactId?: string
  /** 工程文件保存的 manifest 摘要，用于验证引用目标未被替换 */
  restoreArtifactSha256?: string
}

/** 一次求值的结果：算出了什么 + 落了哪些盘 */
export interface EvalResult {
  refs: NodeResultRefsBody
  /** 空数组 = 这次没有产物（不是"没问"）。浏览器那侧永远是空的 */
  artifacts: ArtifactRef[]
  /** 空对象 = 这次没有元信息（不是"没问"） */
  meta: NodeMeta
  /**
   * true = 这个结果**不是这次算的**，是复用了上一次的同指纹结果（宿主侧缓存）。
   *
   * 必须如实报出来：日志、运行清单与报告都要能说"这一步没重算"。
   * 不报的话，用户会以为刚刚跑了一遍，而实际用的是几分钟前那份。
   */
  cached?: boolean
  /** 本次结果由已登记制品重建，未调用训练函数 */
  restored?: boolean
}

/**
 * 这次求值的**元信息**：指标里放不下的"数字之外的事实"（用了什么设备、哪一版库…）。
 *
 * 为什么要有这一栏：输出摘要的 `values` 只收数值，于是"用了 GPU / 哪块 GPU /
 * torch 什么版本"这类事实被**静默丢掉** —— 而它们正是判断"这次和上次是不是同一件事"
 * 要用的东西。字符串塞不进 `values`，编成数字更糟。
 */
export type NodeMeta = Record<string, string | number | boolean>

/**
 * 一个节点的运行时状态。
 *
 * `inputsFingerprint` 是"上次求值时，这个节点的输入长什么样"的完整记录
 * （自身参数 + 每个输入端口的来源与上游版本）。它不取哈希 —— 这个规模下直接比字符串
 * 没有成本，而哈希碰撞会静默地漏掉一次重算，那是最难查的一类错。
 */
export interface NodeRuntime {
  /**
   * `cancelled` = 用户按了取消，这次没有产出。
   *
   * 它与 `error` 分开是刻意的：取消不是失败，节点应当回到"可以重试"，
   * 而不是在运行清单里留下一条永远不会有人去查的"失败"。
   */
  status: 'idle' | 'computing' | 'ready' | 'error' | 'blocked' | 'manual' | 'cancelled'
  /** 每次重算 +1；下游据此失效 */
  outputVersion: number
  /** null = 从未求值 */
  inputsFingerprint: string | null
  /**
   * 这个节点落盘过哪些产物（训练节点才有）。
   *
   * 放在这里而不是单独一个消息：它是**节点状态的一部分** —— 界面在节点上标一句
   * "产物在哪儿"，运行清单也从这里取（于是"算了什么"与"落了什么"走同一条路）。
   */
  artifacts?: ArtifactRef[]
  /** true = 模型由磁盘制品恢复，当前模型对象仅在宿主会话内缓存 */
  loadedFromArtifact?: boolean
  /** 这次求值自报的元信息（见 `NodeMeta`）。没有就不写，不塞空对象 —— 空对象会让界面多出一行空的 */
  meta?: NodeMeta
  /**
   * true = 这次的输出**不是刚算的**，是复用了上一次同指纹的结果（宿主侧缓存）。
   *
   * 与 `meta` 分开是因为它讲的不是"用了什么"，而是"这份数有多新" ——
   * 用户判断"我要不要重跑一遍"时就靠它。
   */
  reused?: boolean
  error?: { message: string; traceback: string }
  /**
   * 长任务的进度（0~1）与一句人话。只有"还在算、且引擎会报进度"的节点才有。
   *
   * 引擎不报进度的节点这里一直是空的 —— 界面据此决定要不要画进度条，而不是
   * 拿一个假的比例糊弄人。
   */
  progress?: { ratio: number; message: string }
}

/* ---------------- 输入绑定 ---------------- */

/**
 * 一个输入端口的取值来源。
 * 接了线就从上游输出取；没接线且形参有字面量默认值就用那个默认值。
 */
export type InputBinding =
  | { kind: 'port'; nodeId: string; portId: string }
  | { kind: 'literal'; value: string | number | boolean }

/** 目标端口 id → 绑定 */
/**
 * 一个端口的输入绑定。
 *
 * **数组 = 多入端口**（契约规格 R13）：那个端口上接了几根线就有几个绑定，
 * 顺序就是连线在图里的先后 —— 拼表这类算子的输出列序直接由它决定，所以顺序是内容的一部分。
 * 求值计划负责把"一个端口、多根线"展开成这个数组；引擎侧不另建一套 `col_1…col_N` 的
 * 端口命名，否则"这个算子吃什么输入"就有两处说法了。
 */
export type Inputs = Record<string, InputBinding | InputBinding[]>

/**
 * 输出端口的形状提示。
 *
 * 由主线程（`graphRunner`，依据 `ports.ts`）给出，引擎不自己拼端口 id、
 * 也不自己猜端口语义 —— 否则两处各有一套判断，迟早错位。
 */
export interface OutputPortSpec {
  id: string
  shape: 'table' | 'column' | 'time' | 'auto'
  /** 输出端口的契约类型，用于区分普通表与可直接绘制的 figure */
  kind?: 'table' | 'tensor' | 'model' | 'metrics' | 'figure' | 'scaler' | 'any'
}

/* ---------------- 数据集 ---------------- */

export interface DatasetPayload {
  datasetId: string
  rowCount: number
  timeColumn: string | null
  /** 时间列（epoch 秒）。没有时间列时为 null */
  time: Float64Array | null
  /** 只运启用的数值列：没启用的列不进 Python，省内存也避免误用 */
  data: Record<string, Float32Array>
}

/* ---------------- 主线程 → Worker ---------------- */

export type WorkerIn =
  | { type: 'init' }
  | { type: 'setDataset'; payload: DatasetPayload }
  | { type: 'loadFn'; nodeId: string; code: string; fnName: string }
  | ({ type: 'evalNode' } & EvalRequest)
  | { type: 'head'; requestId: number; nodeId: string; portId: string; n: number; offset?: number }
  | { type: 'dropNode'; nodeId: string }
  /**
   * 请引擎在**可中断点**上停下。
   *
   * 同步 Python 里没有"从外面掐断"这回事，所以这是一句请求而不是命令：
   * 引擎在读到这个标志后自己决定在哪儿停（见 `runtime.Env.check_cancel`）。
   */
  | { type: 'cancel'; nodeId: string }

/* ---------------- Worker → 主线程 ---------------- */

export type WorkerOut =
  /**
   * 引擎就绪。`engineInfo` 是给人看的一行字：浏览器里是 Pyodide 与包版本，
   * 本地宿主里是 Python / torch / 设备。字段名刻意不提 Pyodide ——
   * 名字一旦写死成某一种实现，界面就会开始撒谎。
   */
  | { type: 'ready'; engineInfo: string }
  | { type: 'initError'; message: string }
  | { type: 'initProgress'; phase: string }
  | { type: 'datasetReady'; datasetId: string }
  | { type: 'datasetError'; datasetId: string; message: string }
  | { type: 'fnLoaded'; nodeId: string }
  | { type: 'fnError'; nodeId: string; message: string }
  | {
      type: 'nodeResult'
      nodeId: string
      refs: NodeResultRefsBody
      /** 这次求值落盘的产物。缺省 = 这个执行面不落盘 */
      artifacts?: ArtifactRef[]
      /** 这次求值自报的元信息。缺省 = 这个执行面不报 */
      meta?: NodeMeta
      /** true = 这个结果来自缓存（同一个输入指纹在上一次会话里算过）。见 `EvalResult.cached` */
      cached?: boolean
      /** true = 此结果由工程引用的磁盘制品恢复，没有调用训练函数 */
      restored?: boolean
    }
  /** 长任务的进度。节流在宿主侧做，所以这里可能一条都没有（算子不报进度） */
  | { type: 'nodeProgress'; nodeId: string; ratio: number; message: string }
  /** 这次求值被取消了。**不是错误**：没有产物，但节点可以重试 */
  | { type: 'nodeCancelled'; nodeId: string; message: string }
  | { type: 'nodeError'; nodeId: string; message: string; traceback: string }
  | { type: 'head'; requestId: number; table: PreviewTable }
  | { type: 'headError'; requestId: number; message: string }

/** 引擎状态。UI 只关心这几种，不关心里面是 Pyodide 还是别的 */
export type EngineStatus = 'cold' | 'loading' | 'ready' | 'failed'
