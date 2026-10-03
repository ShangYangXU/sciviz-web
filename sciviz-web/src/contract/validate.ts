/**
 * L1 静态校验器 —— 契约规格 §7 的第一级。
 *
 * 目标：**能在连线时 / 加载工程时判定的，不留到运行后**（契约规格 P2）。
 *
 * 本模块是纯函数：不进引擎、不碰 DOM、不读文件。界面、CLI、agent 三边共用它，
 * 所以"同一张图在三个地方得到同一份结论"是结构上保证的，不是靠纪律。
 *
 * 一条必须守住的判断规则，来自一次实测事故（见 `ports.ts` 的 portsTrustworthy 注释）：
 * **端口列表算不出来 ≠ 端口被删了。** 数据集没绑、代码还没写时，端口列表是空的，
 * 但这不是"连线错了"，而是"现在还不知道"。把这种情况报成 E_UNKNOWN_PORT 会让 agent
 * 去删一条本来就对的线。所以这里一律降级为 W_DATASET_UNRESOLVED 并跳过该节点的连线检查。
 */

import { getNodeTypeDef, hasNodeType } from '../workflow/nodeRegistry'
import {
  isFunctionNode,
  makeEdgeId,
  portsTrustworthy,
  resolvePorts,
  type PortContext,
} from '../workflow/ports'
import {
  LEGACY_TRAINING_PARAM_KEYS,
  parseSignature,
  parseTrainingSignature,
  usesRawTableTrainingProtocol,
} from '../workflow/functionSignature'
import { parseModelParams, validateModelListParamValue } from '../workflow/modelParams'
import { parseModelInterface } from '../workflow/modelInterface'
import { cyclePath, findCycle } from '../workflow/graph'
import { portsCompatible } from '../workflow/types'
import { expandWorkflowGroups } from '../workflow/groups'
import type { NodeTypeDef, ParamSpec, Workflow, WorkflowNode } from '../workflow/types'
import type { CheckLevel, Severity } from './errorCodes'

export interface Issue {
  code: string
  severity: Severity
  level: CheckLevel
  message: string
  nodeId?: string
  portId?: string
  edgeId?: string
  expected?: string
  actual?: string
}

/** 本级别**没查**的契约规则。明写出来，免得"校验通过"被误读成"契约全过" */
export interface SkippedCheck {
  code: string
  reason: string
}

export interface ValidationResult {
  ok: boolean
  errors: Issue[]
  warnings: Issue[]
  nodeCount: number
  edgeCount: number
  /** G0 还查不了的那些规则。字段存在本身就是诚实的一部分 */
  notChecked: SkippedCheck[]
}

export interface ValidateOptions {
  /** 关掉"端口算不出来"的告警。用于只关心结构合法性的场景 */
  quietUnresolved?: boolean
}

/** 没有数据集信息时的上下文：一切引用都算"定不下来"，而不是"不存在" */
export const NO_DATASET_CTX: PortContext = {
  featuresOf: () => [],
  timeColumnOf: () => null,
  hasDataset: () => false,
}

const L1 = 'L1' as const

function issue(
  code: string,
  severity: Severity,
  message: string,
  where: Omit<Issue, 'code' | 'severity' | 'level' | 'message'> = {},
): Issue {
  return { code, severity, level: L1, message, ...where }
}

/** 一条**待连**的线：还没有 id 的那种。来源与去向都是端口的四元组 */
export interface ConnectionAttempt {
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

export interface ConnectionCheckOptions {
  /** 判"图上已有的那条边"时传它：它自己占着自己的输入端口，不算占用 */
  ignoreEdgeId?: string
  /**
   * 跳过"会不会成环"。
   *
   * 只给校验器用：它另有一条整图检查（第 4 步）报同一件事，而且报的是**完整路径**。
   * 逐边再报一遍只会让同一张图多出 N 条一模一样的错。
   */
  skipCycle?: boolean
}

/**
 * 判一条线能不能连 —— **连线规则的唯一实现**。
 *
 * 三个消费者都走这里：界面拖拽（`isValidConnection`）、补丁的 `connect` 动作、
 * L1 校验器判已有的边。此前这三处各写一套判断：界面只回 `true/false`（用户看不到
 * 原因），校验器与补丁各有一套措辞 —— 于是同一件"线连错了"，三处能给出三种说法，
 * 而"界面说不行、validate 说行"这种分歧谁也不会报错。
 *
 * 返回 `null` 表示可以连；否则返回一条 `Issue`（**错误码与人话都是最终稿**）。
 *
 * 两条与其他检查共享的口径：
 * - **端口算不出来（数据集没绑 / 代码还没写）不是"线连错了"** —— 返回 null 放行，
 *   理由见文件头与 `ports.ts` 的 `portsTrustworthy`；
 * - 已经成环的图，报出来的那句话与整图检查一字不差（同一个 `findCycle`，
 *   同一条路径渲染），所以界面说的和 `sciviz validate` 说的是同一句。
 */
export function checkConnection(
  workflow: Workflow,
  conn: ConnectionAttempt,
  ctx: PortContext = NO_DATASET_CTX,
  options: ConnectionCheckOptions = {},
): Issue | null {
  const src = workflow.nodes.find((n) => n.id === conn.source)
  const dst = workflow.nodes.find((n) => n.id === conn.target)
  const missing = !src ? conn.source : !dst ? conn.target : null
  if (missing !== null) {
    return issue('E_UNKNOWN_REF', 'error', `没有 id 为「${missing}」的节点`, { nodeId: missing })
  }
  if (src!.id === dst!.id) {
    // 自连必然是环，而且是最难看出来的一种：它不会自己报错，只会让调度器空转
    return issue('E_CYCLE', 'error', `图里有环：${src!.label} → ${src!.label}`, {
      nodeId: src!.id,
    })
  }
  // 算子没注册 / 端口列表算不出来：此刻判断不了，交给别的检查（E_UNKNOWN_OPERATOR、
  // W_DATASET_UNRESOLVED）去说。**不能借这里报"端口不存在"** —— 那会让 agent 去删一条对的线
  if (!hasNodeType(src!.type) || !hasNodeType(dst!.type)) return null
  if (!portsTrustworthy(src!, ctx) || !portsTrustworthy(dst!, ctx)) return null

  const srcPorts = resolvePorts(src!, ctx).outputs
  const dstPorts = resolvePorts(dst!, ctx).inputs
  const srcPort = srcPorts.find((p) => p.id === conn.sourcePort)
  const dstPort = dstPorts.find((p) => p.id === conn.targetPort)
  if (!srcPort || !dstPort) {
    return issue(
      'E_UNKNOWN_PORT',
      'error',
      !srcPort
        ? `节点「${src!.label}」上没有输出端口「${conn.sourcePort}」（现有：${srcPorts.map((p) => p.id).join(', ') || '无'}）`
        : `节点「${dst!.label}」上没有输入端口「${conn.targetPort}」（现有：${dstPorts.map((p) => p.id).join(', ') || '无'}）`,
      {
        nodeId: !srcPort ? src!.id : dst!.id,
        portId: !srcPort ? conn.sourcePort : conn.targetPort,
        expected: '现有端口之一',
        actual: !srcPort ? conn.sourcePort : conn.targetPort,
      },
    )
  }
  if (!portsCompatible(srcPort.type, dstPort.type)) {
    return issue(
      'E_TYPE_MISMATCH',
      'error',
      `端口类型不兼容：「${srcPort.label}」是 ${srcPort.type}，接到需要 ${dstPort.type} 的「${dstPort.label}」`,
      {
        nodeId: dst!.id,
        portId: conn.targetPort,
        expected: dstPort.type,
        actual: srcPort.type,
      },
    )
  }

  /*
   * 占用检查。多入端口（`multiple: true`，契约规格 R13）**跳过**：它的语义就是"一个入口
   * 吃任意多根线"，第二根线不是冲突。其余端口照旧报 E_PORT_OCCUPIED 且不自动替换 ——
   * 替换会静默丢掉别人接的那根线。
   */
  const occupied = dstPort.multiple
    ? undefined
    : workflow.edges.find(
        (e) =>
          e.target === conn.target &&
          e.targetPort === conn.targetPort &&
          e.id !== options.ignoreEdgeId,
      )
  if (occupied) {
    return issue(
      'E_PORT_OCCUPIED',
      'error',
      `输入端口「${dstPort.label}」已经被占用（连线 ${occupied.id}）；要换来源请先 disconnect`,
      { nodeId: conn.target, portId: conn.targetPort, edgeId: occupied.id },
    )
  }

  if (!options.skipCycle) {
    // 连上之后的图长这样 —— 就用校验器事后看它时的那个函数判，报的是同一句话
    const tentative: Workflow = {
      ...workflow,
      edges: [
        ...workflow.edges,
        {
          id: makeEdgeId(conn.source, conn.sourcePort, conn.target, conn.targetPort),
          source: conn.source,
          sourcePort: conn.sourcePort,
          target: conn.target,
          targetPort: conn.targetPort,
        },
      ],
    }
    const cycle = findCycle(tentative)
    if (cycle) {
      return issue('E_CYCLE', 'error', `图里有环：${cyclePath(workflow, cycle)}`, {
        nodeId: conn.target,
      })
    }
  }

  return null
}

/**
 * 一个参数的声明类型是否被这个值满足。不满足时返回一句人话。
 *
 * 导出是给补丁用的：`setParam` 必须在**写入之前**判一次，判据要和校验器完全一致
 * —— 否则会出现"补丁说改好了、validate 说不行"这种自相矛盾。
 */
export function checkParamValue(spec: ParamSpec, value: unknown): string | null {
  if (spec.widget === 'list') return validateModelListParamValue(spec, value)
  switch (spec.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `期望数字，实际是 ${JSON.stringify(value)}`
      }
      if (spec.min !== undefined && value < spec.min) return `小于下限 ${spec.min}`
      if (spec.max !== undefined && value > spec.max) return `大于上限 ${spec.max}`
      return null
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `期望布尔，实际是 ${JSON.stringify(value)}`
    case 'select': {
      if (typeof value !== 'string') return `期望字符串选项，实际是 ${JSON.stringify(value)}`
      const allowed = (spec.options ?? []).map((o) => o.value)
      if (allowed.length > 0 && !allowed.includes(value)) {
        return `不在选项里（可用：${allowed.join(' / ')}）`
      }
      return null
    }
    default:
      // text / code
      return typeof value === 'string' ? null : `期望文本，实际是 ${JSON.stringify(value)}`
  }
}

/**
 * R5 的判据本身。抽成纯函数只为一件事：**能被单独测**。
 *
 * 注册表里的算子必须全部合规（否则校验一跑就红），所以"不合规"那条路只能
 * 靠一个假定义来钉住 —— 借这一个小函数把判据露出来。
 */
export function seededWithoutSeedParam(
  def: Pick<NodeTypeDef, 'determinism' | 'params'>,
): boolean {
  return def.determinism === 'seeded' && !def.params.some((p) => p.key === 'seed')
}

/**
 * 校验一张图。
 *
 * 检查项与顺序（顺序是刻意的：前面的错误会让后面的检查失去意义）：
 * 1. 节点 id 唯一
 * 2. 算子已注册
 * 3. 连线两端存在（悬空边）
 * 4. 无环
 * 5. 参数合法
 * 6. 端口存在 + 类型兼容
 * 7. 必需输入已接
 */
export function validateWorkflow(
  workflow: Workflow,
  ctx: PortContext = NO_DATASET_CTX,
  options: ValidateOptions = {},
): ValidationResult {
  // 普通工作流沿用原校验路径；组块展开前先保留根图的基础结构错误，
  // 否则展开器会把重复 id / 悬空边统一包装成 E_GROUP_INVALID。
  if (!workflow.nodes.some((node) => node.type === 'workflow.group')) {
    return validateFlatWorkflow(workflow, ctx, options)
  }
  const ids = new Set<string>()
  const hasDuplicateId = workflow.nodes.some((node) => {
    if (ids.has(node.id)) return true
    ids.add(node.id)
    return false
  })
  const nodeIds = new Set(workflow.nodes.map((node) => node.id))
  const hasDanglingEdge = workflow.edges.some(
    (edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target),
  )
  if (hasDuplicateId || hasDanglingEdge) {
    return validateFlatWorkflow(workflow, ctx, options)
  }
  try {
    // 校验器与运行器共用展开规则；组定义坏了时，在进入普通节点校验前给稳定错误码。
    return validateFlatWorkflow(expandWorkflowGroups(workflow, ctx), ctx, options)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      errors: [issue('E_GROUP_INVALID', 'error', `复合组块定义无效：${detail}`, { expected: '有效的子图与端口/参数映射' })],
      warnings: [],
      nodeCount: workflow.nodes.length,
      edgeCount: workflow.edges.length,
      notChecked: NOT_CHECKED,
    }
  }
}

function validateFlatWorkflow(
  workflow: Workflow,
  ctx: PortContext = NO_DATASET_CTX,
  options: ValidateOptions = {},
): ValidationResult {
  const issues: Issue[] = []
  const nodes = workflow.nodes
  const edges = workflow.edges
  const byId = new Map<string, WorkflowNode>()

  /* ---------------- 1. id 唯一 ---------------- */
  for (const n of nodes) {
    if (byId.has(n.id)) {
      issues.push(
        issue('E_DUPLICATE_NODE_ID', 'error', `节点 id「${n.id}」重复`, { nodeId: n.id }),
      )
      continue
    }
    byId.set(n.id, n)
  }

  /* ---------------- 2. 算子已注册 ---------------- */
  const registered = new Set<string>()
  for (const n of nodes) {
    if (registered.has(n.id)) continue
    if (!hasNodeType(n.type)) {
      issues.push(
        issue('E_UNKNOWN_OPERATOR', 'error', `算子「${n.type}」不在清单里`, {
          nodeId: n.id,
          expected: 'catalog 里列出的算子之一',
          actual: n.type,
        }),
      )
      continue
    }
    registered.add(n.id)
  }

  /* ---------------- 3. 悬空边 ---------------- */
  for (const e of edges) {
    const missingSrc = !byId.has(e.source)
    const missingDst = !byId.has(e.target)
    if (missingSrc || missingDst) {
      const which = [missingSrc ? e.source : '', missingDst ? e.target : ''].filter(Boolean).join(' / ')
      issues.push(
        issue('E_DANGLING_EDGE', 'error', `连线 ${e.source} → ${e.target} 引用了不存在的节点（${which}）`, {
          edgeId: e.id,
        }),
      )
    }
  }

  /* ---------------- 4. 成环 ---------------- */
  const cycle = findCycle(workflow)
  if (cycle) {
    const path = cyclePath(workflow, cycle)
    issues.push(
      issue('E_CYCLE', 'error', `图里有环：${path}`, {
        nodeId: cycle[0],
        expected: '有向无环图',
        actual: path,
      }),
    )
  }

  /* ---------------- 5–7. 逐个节点 ---------------- */
  for (const node of nodes) {
    if (!registered.has(node.id)) continue
    const def = getNodeTypeDef(node.type)

    if (node.type === 'train.function') {
      const signature = parseTrainingSignature(String(node.params.code ?? ''))
      if (signature.error) {
        issues.push(
          issue('E_PARAM_INVALID', 'error', `训练函数代码解析失败：${signature.error}`, {
            nodeId: node.id,
            portId: 'code',
            expected: 'def fit_model(...)',
            actual: signature.error,
          }),
        )
      }
    }

    /* 参数：先定"这个键是不是合法的" */
    const signatureParams = isFunctionNode(node.type)
      ? new Set(parseSignature(String(node.params.code ?? '')).params.map((p) => p.name))
      : new Set<string>()
    const modelSchema =
      node.type === 'custom.model'
        ? parseModelParams(String(node.params.code ?? ''))
        : { specs: [] }
    const modelInterfaceSchema =
      node.type === 'custom.model'
        ? parseModelInterface(String(node.params.code ?? ''))
        : { declared: false }
    if (node.type === 'custom.model' && modelInterfaceSchema.error) {
      issues.push(
        issue('E_PARAM_INVALID', 'error', `MODEL_INTERFACE 解析失败：${modelInterfaceSchema.error}`, {
          nodeId: node.id,
          portId: 'code',
          expected: 'MODEL_INTERFACE = {inputs: [...], outputs: [...]}',
          actual: modelInterfaceSchema.error,
        }),
      )
    }
    const modelParamSpecs = modelSchema.specs
    const specByKey = new Map([...def.params, ...modelParamSpecs].map((p) => [p.key, p]))
    // 被上游驱动的参数：此刻的值只当占位，不参与校验
    const driven = new Set(
      edges.filter((e) => e.target === node.id).map((e) => e.targetPort),
    )

    for (const [key, value] of Object.entries(node.params)) {
      const spec = specByKey.get(key)
      if (!spec) {
        if (signatureParams.has(key)) continue
        if (
          node.type === 'train.function' &&
          !usesRawTableTrainingProtocol(String(node.params.code ?? '')) &&
          LEGACY_TRAINING_PARAM_KEYS.has(key)
        ) continue
        // 用户编辑 MODEL_PARAMS 时，字典可能暂时处于半截状态。此时保留已有的
        // 动态值，不把每一次敲键都报成非法参数；代码真正运行前仍会由 Python 编译器校验。
        if (node.type === 'custom.model' && modelSchema.error) continue
        issues.push(
          issue('E_PARAM_INVALID', 'error', `参数「${key}」不是 ${node.type} 声明过的键`, {
            nodeId: node.id,
            portId: key,
            expected: [...specByKey.keys()].join(' / ') || '（该算子无参数）',
            actual: key,
          }),
        )
        continue
      }
      if (driven.has(key)) continue
      const fault = checkParamValue(spec, value)
      if (fault) {
        issues.push(
          issue('E_PARAM_INVALID', 'error', `参数「${spec.label}」${fault}`, {
            nodeId: node.id,
            portId: key,
            expected: `${spec.type}${spec.min !== undefined ? ` ≥ ${spec.min}` : ''}${spec.max !== undefined ? ` ≤ ${spec.max}` : ''}`,
            actual: JSON.stringify(value),
          }),
        )
      }
    }

    /*
     * R5：声明了 `seeded` 就必须真的有一个 `seed` 参数。
     *
     * 这不是"检查用户填没填"——`seed` 有默认值，永远填得上。检查的是**算子自己**：
     * 声明可复现却不给固定种子的入口，那个声明就是空头支票，而用户会以为
     * "我固定了种子，所以能复现"。宁可现在拦住。
     */
    if (seededWithoutSeedParam(def)) {
      issues.push(
        issue('E_UNSEEDED_STOCHASTIC', 'error', `算子「${def.label}」声明为 seeded，却没有声明 seed 参数`, {
          nodeId: node.id,
          expected: '一个名为 seed 的参数（"固定种子可复现"要有入口才成立）',
          actual: [...specByKey.keys()].join(' / ') || '（该算子无参数）',
        }),
      )
    }

    /* 端口：算不出来就只告警，不判连线 —— 见文件头那条规则 */
    const trustworthy = portsTrustworthy(node, ctx)
    if (!trustworthy) {
      if (!options.quietUnresolved) {
        issues.push(
          issue(
            'W_DATASET_UNRESOLVED',
            'warning',
            `节点「${node.label}」的端口现在定不下来（${
              node.type === 'data.columns'
                ? '拆列列名未填写且上游表尚未算出'
                : '代码还没写或签名解析不出来'
            }），与该节点相连的连线本次不判`,
            { nodeId: node.id },
          ),
        )
      }
      continue
    }

    const { inputs } = resolvePorts(node, ctx)

    /* 必需输入 */
    for (const port of inputs) {
      if (port.optional) continue
      if (edges.some((e) => e.target === node.id && e.targetPort === port.id)) continue
      if (node.params[port.id] !== undefined) continue
      issues.push(
        issue('E_MISSING_INPUT', 'error', `节点「${node.label}」的必需输入「${port.label}」没接线`, {
          nodeId: node.id,
          portId: port.id,
          expected: '接一条线或填一个字面量',
          actual: '空',
        }),
      )
    }

    /* 出边：端口存在 + 类型兼容 */
    for (const edge of edges.filter((e) => e.source === node.id)) {
      const dst = byId.get(edge.target)
      if (!dst || !registered.has(dst.id)) continue
      // 逐条边走**同一个**判据：界面拖拽、补丁 connect 与这里，三处报出的错误码
      // 与那句话因此是同一份。成环不在这里报 —— 上面第 4 步已经报了，而且带完整路径
      const hit = checkConnection(workflow, edge, ctx, {
        ignoreEdgeId: edge.id,
        skipCycle: true,
      })
      if (hit) issues.push({ ...hit, edgeId: edge.id })
    }
  }

  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    notChecked: NOT_CHECKED,
  }
}

/**
 * G0 查不了的规则。
 *
 * 这些规则都要求 IR 先长出 `PortDescriptor`（轴序、单位、split），
 * 而当前端口只有粗枚举 `PortType`（契约规格 §9 第 5 项）。在 P0 补齐之前，
 * 这里是**空的**，而不是"通过"。
 *
 * `E_UNSEEDED_STOCHASTIC` 已从这里移走：算子的 `determinism` 落地之后，
 * 它有了真判据（见上面那段检查）。`E_OPERATOR_VERSION_CHANGED` 还留在这里 ——
 * 算子有了版本与哈希，但**工程文件还没有记下自己用的是哪一版**，
 * 没有"旧版本"可比，就判不出"变了没有"（R11 的迁移流程未做）。
 */
const NOT_CHECKED: SkippedCheck[] = [
  { code: 'E_AXIS_ROLE_MISMATCH', reason: '端口还没有轴语义（PortDescriptor.axes）' },
  { code: 'E_RANK_MISMATCH', reason: '端口还没有轴数声明' },
  { code: 'E_DTYPE_DOWNCAST', reason: '端口还没有 dtype 声明' },
  { code: 'E_UNIT_MISMATCH', reason: '端口还没有单位声明' },
  { code: 'E_SPLIT_LEAK', reason: '端口还没有 split 标记，fits 也无处声明' },
  { code: 'E_OPERATOR_VERSION_CHANGED', reason: '工程文件还没记录算子版本，没有"旧版本"可比（R11 未做）' },
]
