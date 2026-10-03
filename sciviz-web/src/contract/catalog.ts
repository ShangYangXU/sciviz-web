/**
 * 算子与错误的**自描述清单** —— agent 面的 G1。
 *
 * 这是"agent 不读源码"这条承诺的全部依据：把它打印出来，agent 就知道
 * 有哪些算子、每个算子怎么接、每个参数是什么类型、什么算错、错了该怎么修。
 *
 * 两条设计约束：
 *
 * 1. **不许有第二处清单。** 端口与参数一律由 `resolvePorts` / `allNodeDefs` 现算，
 *    不在这里抄一遍。抄一遍就等于把 `nodeRegistry.ts` 复制成了两份。
 * 2. **不许依赖执行面。** 本模块不 import 任何适配器、Worker、Pyodide。
 *    "这个算子归谁算"现在直接读清单的 `runtimeClass` —— 2026-09-13 之前它由调用方注入，
 *    因为判据是 `plan.ts` 里的白名单，不能让契约层去 import 执行面。白名单并进清单
 *    之后，这个中间人就没有存在的理由了（待办 T2 已收）。
 */

import { allNodeDefs, defaultParams } from '../workflow/nodeRegistry'
import {
  isFunctionNode,
  isPortableParam,
  resolvePorts,
  type PortContext,
} from '../workflow/ports'
import { USER_MODULE_PREFIX } from '../workflow/userModules'
import type {
  Determinism,
  ExecClass,
  NodeTypeDef,
  NodeLifecycle,
  OperatorRequirement,
  ParamSpec,
  PortSpec,
  RuntimeClass,
  WorkflowNode,
} from '../workflow/types'
import { allErrorCodes, type ErrorCodeDef } from './errorCodes'
import { OPERATOR_IMPLEMENTATION_HASHES } from './operatorHashes.generated'

/** 算子在哪个执行面求值。判据就是清单自己的 `NodeTypeDef.runtimeClass`（R6.2） */
export type { RuntimeClass }

/** 参数在清单里比 `ParamSpec` 多一项：能不能被上游连线驱动 */
export interface CatalogParam extends ParamSpec {
  /**
   * true = 该参数在界面上长成了一个输入端口，可以被上游连线驱动。
   * agent 想接"超参搜索 → 学习率"这类线，判据就是它。
   */
  portable: boolean
}

export interface CatalogOperator {
  type: string
  /** `legacy` = 仅为旧工程兼容，不应用于新图 */
  lifecycle: NodeLifecycle
  label: string
  category: string
  description: string
  /** 'builtin' = 内置；'user' = 界面里自建的模块 */
  origin: 'builtin' | 'user'
  runtime: RuntimeClass
  /** 算子自己声明的语义化版本（R7）。R11 的工程迁移要靠它判断"换过口径没有" */
  version: string
  /** 确定性等级（R6）。`stochastic` 的算子会进运行清单的"不可复现贡献项" */
  determinism: Determinism
  /** 执行等级（R6.1）。`background` / `batch` 的长任务要能报进度、能被取消 */
  execClass: ExecClass
  /**
   * 共享边界之外的要求（R4）。`null` = 边界之内，浏览器与本地宿主都能跑。
   *
   * agent 要在**动手之前**判断"这张图能不能在这台机器上跑完"，判据就是它：
   * `runtime = 'host'` 而宿主没起时，那张图现在跑不了，改参数也救不回来。
   */
  requires: OperatorRequirement | null
  /**
   * true = 端口随数据或代码变化，静态清单里的端口只是"一种可能"。
   * 数据源看数据集列；列拼表看 slots 参数；函数类节点看 def 签名。
   */
  dynamicPorts: boolean
  /**
   * 算子实现的哈希。它进 `nodeFingerprint`，所以这一项变了 = 该算子及其全部下游
   * 都会重算。
   *
   * 放这里是为了让 agent / CLI 能回答"为什么重算了"：比对两次运行的清单，
   * 哈希变了就是实现变了，没变就去找参数或数据。没有这一栏时，
   * "结果为什么和上次不一样"只能靠猜。
   *
   * **这一栏永远在**（没有可哈希的实现时是 `null`），取值只有两种情况：
   * - 有真实现：一段 sha256（`scripts/gen-operator-hashes.mjs` 从算子源码生成，见 R7）；
   * - `null`：没有可哈希的实现 —— 要么是函数节点 / 自建模块（实现是用户写在
    *   `params.code` 里的代码，随工程走）。没有真实执行实现的节点不应进入当前清单。
   *
   * 为什么宁可给 `null` 也不省掉这一栏：省掉之后，"本来就没有实现"与"生成脚本漏了一个"
   * 长得一模一样，读清单的人分不出来 —— 只能去读源码，那正是这一栏要避免的事。
   */
  implementationHash: string | null
  /** 端口不确定时的原因，给 agent 一句人话 */
  portsNote?: string
  inputs: PortSpec[]
  outputs: PortSpec[]
  params: CatalogParam[]
}

export interface Catalog {
  /** 清单格式版本。字段增删时 +1，agent 据此判断自己认不认得 */
  catalogVersion: number
  /** 生成时可见的算子总数。与 operators.length 相等，便于一眼核对 */
  operatorCount: number
  operators: CatalogOperator[]
  errorCodes: ErrorCodeDef[]
  /** 已知缺口，明写出来而不是让 agent 踩 */
  notes: string[]
}

export interface BuildCatalogOptions {
  /** 额外的算子定义（自建模块）。不传则用注册表里现有的 */
  extraDefs?: NodeTypeDef[]
}

export const CATALOG_VERSION = 2

/** 端口算不出来时的占位上下文：把"没有数据"和"数据没列"区分开 */
const EMPTY_CTX: PortContext = {
  featuresOf: () => [],
  timeColumnOf: () => null,
  hasDataset: () => false,
}

/** 给某个算子造一个临时实例，只为解析端口。position 是占位，不参与任何计算 */
function probeNode(def: NodeTypeDef): WorkflowNode {
  return {
    id: '·probe',
    type: def.type,
    label: def.label,
    params: defaultParams(def),
    position: { x: 0, y: 0 },
  }
}

function dynamicPortsOf(def: NodeTypeDef): { dynamic: boolean; note?: string } {
  if (def.type === 'train.function') {
    return {
      dynamic: true,
      note: '训练参数由 fit_model 签名解析；宿主上下文参数不会生成端口',
    }
  }
  if (def.type === 'custom.model') {
    return {
      dynamic: true,
      note: '输入/输出端口由代码里的 MODEL_INTERFACE 字面量解析；未声明时保留 model 输出',
    }
  }
  if (isFunctionNode(def.type)) {
    return { dynamic: true, note: '端口由代码里的 def 签名解析而来，不是注册表写死的' }
  }
  return { dynamic: false }
}

/**
 * 生成清单。
 *
 * 纯函数：同样的注册表 + 同样的注入，得到同样的输出。可被单测直接比对。
 */
export function buildCatalog(options: BuildCatalogOptions): Catalog {
  const defs = options.extraDefs ?? allNodeDefs()
  const operators: CatalogOperator[] = defs.map((def) => {
    const { inputs, outputs } = resolvePorts(probeNode(def), EMPTY_CTX)
    const { dynamic, note } = dynamicPortsOf(def)
    return {
      type: def.type,
      lifecycle: def.lifecycle ?? 'current',
      label: def.label,
      category: def.category,
      description: def.description,
      origin: def.type.startsWith(USER_MODULE_PREFIX) ? 'user' : 'builtin',
      runtime: def.runtimeClass,
      version: def.version,
      determinism: def.determinism,
      execClass: def.execClass,
      requires: def.requires,
      dynamicPorts: dynamic,
      implementationHash: OPERATOR_IMPLEMENTATION_HASHES[def.type] ?? null,
      ...(note ? { portsNote: note } : {}),
      inputs,
      outputs,
      params: def.params.map((p) => ({ ...p, portable: isPortableParam(p) })),
    }
  })

  operators.sort((a, b) => (a.category === b.category ? a.type.localeCompare(b.type) : a.category.localeCompare(b.category)))

  return {
    catalogVersion: CATALOG_VERSION,
    operatorCount: operators.length,
    operators,
    errorCodes: allErrorCodes(),
    notes: [
      'runtime 字段来自算子自己在清单里的声明（NodeTypeDef.runtimeClass），这是契约（契约规格 R6.2）。' +
        '字段必填：新增算子漏写会编译不过，不会静默退化成不可执行节点。',
      '函数类节点的端口是动态的，见各自的 portsNote。数据源始终只输出一个整表端口。' +
        '输入端口上 `multiple: true` 表示它是**多入端口**（契约规格 R13）：可以接任意多条线，' +
        '算子按连线在图里的先后拿到一个有序列表 —— 想接第二根线不需要先 disconnect，' +
        '也不会撞 E_PORT_OCCUPIED。' +
        '要拿到某个具体图的端口清单，用 `sciviz open <project>`。',
    ],
  }
}
