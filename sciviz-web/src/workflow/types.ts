import type { ChartSpec } from '../types'

/** 端口数据类型，用于连线合法性校验 */
export type PortType = 'any' | 'table' | 'tensor' | 'model' | 'metrics' | 'figure' | 'scaler'

export type NodeCategory = 'data' | 'feature' | 'model' | 'eval' | 'viz' | 'custom'

/** 确定性等级（契约规格 R6）。三级，且只有三级：多一档就等于多一处可以含糊的地方 */
export type Determinism = 'deterministic' | 'seeded' | 'stochastic'

/** 执行等级（契约规格 R6.1）。与 `runtimeClass` 无关：那个说谁来算，这个说按什么规格算 */
export type ExecClass = 'interactive' | 'background' | 'batch'

/** 执行面（契约规格 R6.2）：当前所有已注册算子都由真实引擎执行。 */
export type RuntimeClass = 'engine'

/** 节点生命周期：legacy 节点仅供旧工程兼容，不出现在新建节点库。 */
export type NodeLifecycle = 'current' | 'legacy'

/**
 * 这个算子在**共享边界之外**还要什么（AGENTS.md R4）。
 *
 * 边界的判据是客观的：`sciviz-web/node_modules/pyodide/pyodide-lock.json` 里有哪些包。
 * 边界以内（numpy / scipy / scikit-learn…）两个执行面都能跑，不需要声明；
 * 边界以外（torch）只能写成宿主专属算子，**必须在这里声明**。
 */
export interface OperatorRequirement {
  /**
   * 哪些执行面能跑它。
   * - `'both'`：浏览器（Pyodide）与本地宿主都行；
   * - `'host'`：只有本地宿主 —— 界面要在**跑之前**就说出来。
   */
  runtime: 'both' | 'host'
  /** 需要的宿主专属依赖（如 `['torch']`）。给人看，也是提示文案的来源 */
  packages: string[]
  /** 为什么需要它。界面在禁止它跑之前，先把这一句给出来 */
  reason: string
}

/**
 * 算子清单里与一次运行有关的那几项事实（R7 / R6.1 / R6.2 / R6）。
 *
 * 抽成独立形状，是为了让**无头核**能拿到它们而不必 import 注册表 ——
 * 注册表连着浏览器 store（数据视图、自建模块），核不该被拖进去。
 */
export interface OperatorFacts {
  /** 语义化版本（R7）。只有行为口径变了才升它 */
  version: string
  /**
   * 实现哈希（R7）。内置算子由脚本从源码生成；**用户代码没有**（它的实现在参数里，
   * 已随参数进指纹），所以是 null —— 缺就是缺，不编一个值出来
   */
  implementationHash: string | null
  runtimeClass: RuntimeClass
  determinism: Determinism
  execClass: ExecClass
  /** 共享边界之外的要求。`null` = 边界之内，两个执行面都能跑 */
  requires: OperatorRequirement | null
}

export interface PortSpec {
  id: string
  label: string
  type: PortType
  /** 可选输入端口：不连线也能执行 */
  optional?: boolean
  /**
   * 多入端口（契约规格 R13）：接受**任意多条**入边，算子按连线在图里的先后顺序拿到列表。
   *
   * 默认 false —— 一个端口一根线，第二根撞 `E_PORT_OCCUPIED`。开这一档的算子必须自己
   * 把"多条"消化掉（求值计划会把它们展开成引擎侧的有序 key），而**画布上仍然只有一个连接点**。
   * 用它的是 `data.collect`：拼表要接几路由手上有多少路决定，不该让人先去改一个「列数」。
   */
  multiple?: boolean
  /** 可选的接口元数据；不改变类型兼容规则，只让形状/轴语义可被显式保存与展示。 */
  shape?: (number | string)[]
  axes?: string[]
  dtype?: string
  unit?: string
  description?: string
  /** 端口来源：数据端口，还是"参数即端口" */
  kind?: 'data' | 'param'
  /** 参数端口对应的 node.params key */
  paramKey?: string
  /**
   * 参数端口的控件描述。
   * 函数节点的形参不在注册表里（由代码签名解析而来），
   * 所以把 ParamSpec 直接挂到端口上，渲染节点时不用再查一遍。
   */
  paramSpec?: ParamSpec
}

type ParamType = 'number' | 'text' | 'select' | 'boolean' | 'code'

export interface ParamSpec {
  key: string
  label: string
  type: ParamType
  default: string | number | boolean
  /** 自定义模型构造函数没有默认值时，模型节点必须要求用户填写 */
  required?: boolean
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  unit?: string
  hint?: string
  /** 特殊控件：不走通用表单，由专用表单渲染 */
  widget?: 'default' | 'mapping' | 'palette' | 'dataset' | 'chartType' | 'datasetRef' | 'list'
  /** MODEL_PARAMS 列表控件的元素类型与边界。列表值自身仍以 JSON 字符串存入 node.params。 */
  listItemType?: 'int' | 'float' | 'text' | 'boolean'
  minItems?: number
  maxItems?: number
  itemMin?: number
  itemMax?: number
  /**
   * 是否允许把该参数接到上游。
   * 不设时按类型规则判定（数值型 = 可接）。
   * 显式设 false 用于"这个节点必须只有一个接口"这类硬约束 —— 比如概率密度图，
   * 密度带宽是调节旋钮而不是数据输入，给它长端口既没用又破坏"一列数据一个口"的语义。
   */
  portable?: boolean
}

export type AssetKind = 'dataset' | 'feature' | 'model' | 'metric' | 'figure' | 'scaler'

/** 节点执行后会产出的资产配方 */
export interface AssetRecipe {
  kind: AssetKind
  /** 名称里可用 {arch} {epochs} 这类占位符，从节点参数取值 */
  nameTemplate: string
  /** figure 类资产需要一份图表配置 */
  chart?: ChartSpec
  /** dataset 类资产的行列规模 */
  table?: { rows: number; cols: number }
  /** 其它需要展示的摘要字段 */
  summary?: Record<string, string | number>
}

export interface NodeTypeDef {
  type: string
  /** 未声明时按 `current` 处理；`legacy` 仍可加载与执行，但不提供给新图使用。 */
  lifecycle?: NodeLifecycle
  /**
   * 算子自己的**语义化版本**（契约规格 R7）。
   *
   * 与 `implementationHash` 分工不同：哈希回答"实现变了没有"（机器算的，人不必管），
   * 版本回答"这个算子有没有换过行为口径"（人写的，给 R11 的工程迁移用）。
   * 现在全部是 `0.1.0` —— 版本化从今天开始，此前没有任何算子有版本号可言。
   */
  version: string
  /**
   * 这个算子在**哪个执行面**求值（契约规格 R6.2）。
   *
   * - `'engine'`：走真引擎（浏览器里的 Pyodide 或本地宿主），结果是真实数值；
   *
   * 之前这件事写在 `src/engine/plan.ts` 的 `ENGINE_NODES` 白名单里，与这张注册表构成
   * **两处真相**：新增算子必须同时改两处，漏改则节点"看起来能跑、其实不走真引擎"，
   * 而且不报错。现在只有这一处（R1）。
   *
   * 字段刻意**必填**：忘了声明就该编译不过，而不是静静地退化成不可执行节点。
   */
  runtimeClass: 'engine'
  /**
   * 确定性等级（契约规格 R6）。**产物可复现到什么程度**，不是"准不准"。
   *
   * - `'deterministic'`：同样的输入必然同样的输出；
   * - `'seeded'`：有随机性，但给定 `seed` 参数后可复现（这类算子必须声明 `seed` 参数，
   *   否则校验报 `E_UNSEEDED_STOCHASTIC`）；
   * - `'stochastic'`：**不承诺**可复现 —— 包括"我们不知道"的情况（用户代码、GPU 上
   *   有非确定性归约时的训练）。这一档会进运行清单的"不可复现贡献项"。
   *
   * 宁可报得悲观，也不要报得乐观：说可复现而其实不可复现，是这份清单唯一无法原谅的错。
   */
  determinism: Determinism
  /**
   * 执行等级（契约规格 R6.1）：**这个算子该在什么时候被触发、要什么保障**。
   *
   * - `'interactive'`：< 100ms 量级，随编辑自动重算，可抢占、可丢弃；
   * - `'background'`：秒到分钟，自动排队，要有进度、可取消；
   * - `'batch'`：分钟到小时，显式触发，可取消、可恢复、产物落盘。
   *
   * 别与 `runtimeClass` 混了：那个说"谁来算"，这个说"该按什么规格算"。
   * 训练是 `background` 而不是 `interactive`，正是因为它必须能报进度、能被取消 ——
   * 长任务没有这两样，界面就是一块黑屏。
   */
  execClass: ExecClass
  /**
   * 共享边界之外的要求（见 `OperatorRequirement`）。
   *
   * **必填**，而且"什么都不用"要写成 `null` —— 那是一个明确的声明，不是"忘了写"。
   * 漏写一个宿主专属算子的要求，后果是界面告诉用户"这个浏览器也能跑"，
   * 而它只会在运行时才炸 —— 正是 T12 要消灭的那类静默失败。
   */
  requires: OperatorRequirement | null
  label: string
  category: NodeCategory
  description: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  params: ParamSpec[]
  assetRecipes: AssetRecipe[]
  /**
   * 画布上的形状。默认是卡片（标题 + 参数行 + 端口行）；`'dot'` 是**一个小圆点**：
   * 左边一个入口、右边一个出口、中间一个 ＋。
   *
   * 给"只做一件事、参数为零"的节点用。这类东西画成卡片的话，框上那一堆行全是噪声 ——
   * 用户要看的是"这里能接好几路"，不是又一张 216px 宽的表。
   */
  shape?: 'dot'
}

export interface WorkflowNode {
  id: string
  type: string
  label: string
  params: Record<string, string | number | boolean>
  /** 仅供界面阅读的参数短注释；key 与 params/端口的英文 key 一致，不参与计算。 */
  paramNotes?: Record<string, string>
  position: { x: number; y: number }
  /**
   * 复合组块的可序列化定义。普通节点不设置此字段；组块节点类型为 `workflow.group`。
   * 内部工作流仍使用相同 IR，执行前会展开成普通节点。
   */
  group?: WorkflowGroupDefinition
}

/** 组块的外部输入端口映射到内部节点的一个输入端口。 */
export interface WorkflowGroupInput {
  id: string
  label: string
  port: PortSpec
  targetNodeId: string
  targetPortId: string
}

/** 组块的外部输出端口映射到内部节点的一个输出端口。 */
export interface WorkflowGroupOutput {
  id: string
  label: string
  port: PortSpec
  sourceNodeId: string
  sourcePortId: string
}

/** 把一个内部节点参数提升为组块的外部参数。 */
export interface WorkflowGroupParameter {
  key: string
  label: string
  nodeId: string
  paramKey: string
  spec: ParamSpec
}

/** 组块内部子图及其公开的边界端口、参数。 */
export interface WorkflowGroupDefinition {
  workflow: Workflow
  inputs: WorkflowGroupInput[]
  outputs: WorkflowGroupOutput[]
  parameters: WorkflowGroupParameter[]
}

export interface WorkflowEdge {
  id: string
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

export interface Workflow {
  id: string
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/* ---------------- 运行时 ---------------- */

export type NodeRunStatus = 'idle' | 'pending' | 'running' | 'done' | 'failed'

export interface RunAsset {
  id: string
  kind: AssetKind
  name: string
  /** 来源追溯：哪个节点产出的 */
  nodeId: string
  nodeLabel: string
  nodeType: string
  createdAt: number
  chart?: ChartSpec
  table?: { rows: number; cols: number }
  summary?: Record<string, string | number>
  /** 数据集类资产指向的数据集，供详情里做真实预览（总览 / 列统计 / 原值） */
  datasetId?: string
  /** 拟合标准化器产出的参数 */
  scaler?: ScalerSpec
}

/**
 * 画布上数据预览节点显示的头部行。
 * 只存在于节点视图，不进资产、不进列式存储 —— 它不是可被下游消费的数据集。
 */
export interface PreviewTable {
  /** 数据列名，按预览顺序 */
  columns: string[]
  /**
   * 与 columns 对齐的原始行值。
   *
   * **可以是字符串**：引擎的输出表里本来就有非数值列 —— 混淆矩阵的类别名、训练曲线的
   * 曲线名都是。以前这里写的是 `number[][]`，于是"按数字格式化"的渲染层把它们显示成
   * "—"（值是对的，只是没显示出来）。`null` 表示缺失。
   */
  rows: (number | string | null)[][]
  /** 上游数据的总行数，用于显示"前 N 行 / 共 M 行" */
  totalRows: number
  /** 哪一列是 epoch 秒；展示层据此把它格式化成日期时间 */
  timeColumn: string | null
}

export type ScalerMethod = 'z-score' | 'robust' | 'min-max'

/** 一列的标准化参数：(x - center) / scale */
export interface ScalerColumn {
  name: string
  /** 平移量：z-score 是均值，robust 是中位数，min-max 是最小值 */
  center: number
  /** 缩放除数：标准差 / IQR / 极差 */
  scale: number
  /**
   * 该列没有波动。常值列的 scale 真值是 0，除下去整列变 NaN，
   * 所以这里记 1 并打上标记，让"这列没被标准化"在图上可见而不是静默。
   */
  constant: boolean
}

/**
 * 拟合出来的标准化器。
 *
 * 刻意做成可 JSON 序列化的纯数据：它必须能随权重一起导出，
 * 评估和推理时要复用同一套 center/scale —— 各自重新 fit 就不是同一个变换了，
 * 指标也就不可比。
 */
export interface ScalerSpec {
  method: ScalerMethod
  columns: ScalerColumn[]
  /** 用多少行拟合出来的：参数来自多大一段数据，决定它能不能复用 */
  fittedRows: number
  /** 拟合来源的名字，便于核对"这份参数是在哪段数据上算的" */
  from: string
  /**
   * 「只标准化这几列」里写了、但上游表里**没有**的列名。
   *
   * 空或不存在 = 没有这种情况。这一项存在的意义是"写错列名不会静默"：
   * 少了它，用户把「蒸汽流量」打成「蒸气流量」，得到的是一份**少了那一列**的参数，
   * 图上没有任何地方说这件事，而下游拿到的是没被标准化的原始值。
   */
  missing?: string[]
}

export interface RunLogEntry {
  at: number
  nodeId: string | null
  level: 'info' | 'ok' | 'warn' | 'error'
  message: string
}

export interface Run {
  id: string
  workflowId: string
  workflowName: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'done' | 'failed' | 'cancelled'
  nodeStatus: Record<string, NodeRunStatus>
  durations: Record<string, number>
  assets: RunAsset[]
  logs: RunLogEntry[]
}

export const categoryMeta: Record<NodeCategory, { label: string; color: string }> = {
  data: { label: '数据', color: '#2f80ed' },
  feature: { label: '特征', color: '#27ae60' },
  model: { label: '模型', color: '#9b51e0' },
  eval: { label: '评估', color: '#e67e22' },
  viz: { label: '可视化', color: '#16a085' },
  custom: { label: '自定义', color: '#7f8c8d' },
}

export const portTypeMeta: Record<PortType, { label: string; color: string }> = {
  any: { label: '任意', color: '#7f8c8d' },
  table: { label: '表', color: '#2f80ed' },
  tensor: { label: '张量', color: '#8e44ad' },
  model: { label: '模型', color: '#9b51e0' },
  metrics: { label: '指标', color: '#e67e22' },
  figure: { label: '图', color: '#16a085' },
  scaler: { label: '标准化器', color: '#b03a56' },
}

/** 连线类型兼容规则：any 与任何类型互通 */
export function portsCompatible(from: PortType, to: PortType): boolean {
  return from === 'any' || to === 'any' || from === to
}

export const assetKindMeta: Record<AssetKind, { label: string; icon: string; color: string }> = {
  dataset: { label: '数据集', icon: '▦', color: '#2f80ed' },
  feature: { label: '特征', icon: '◈', color: '#27ae60' },
  model: { label: '模型', icon: '◉', color: '#9b51e0' },
  metric: { label: '指标', icon: '▲', color: '#e67e22' },
  figure: { label: '图', icon: '▣', color: '#16a085' },
  scaler: { label: '标准化器', icon: '⚖', color: '#b03a56' },
}
