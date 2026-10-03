import { getNodeTypeDef, WHOLE_TABLE_PORT } from './nodeRegistry'
import { parseSignature, parseTrainingSignature, type FnParamSpec } from './functionSignature'
import type { ParamSpec, PortSpec, Workflow, WorkflowEdge, WorkflowNode } from './types'
import { interfacePorts, parseModelInterface } from './modelInterface'

/**
 * 把解析出的形参转成控件描述。
 * 编辑器类型由默认值的字面量类型决定 —— 函数作者的写法就是最准确的类型声明。
 */
const COLUMN_SELECTOR_PARAMS = new Set(['feature', 'feature_name', 'column', 'column_name'])

function fnParamToSpec(
  p: FnParamSpec,
  upstreamColumns?: string[],
  currentValue?: unknown,
): ParamSpec {
  const base = { key: p.name, label: p.name, hint: p.annotation, required: !p.hasDefault }
  if (
    p.options?.length &&
    typeof p.defaultLiteral === 'string' &&
    p.options.includes(p.defaultLiteral)
  ) {
    return {
      ...base,
      type: 'select',
      default: p.defaultLiteral,
      options: p.options.map((value) => ({ value, label: value })),
    }
  }

  // 自定义绘图常见的列名参数从已经接入的表格取候选项，不要求用户再手打一次列名。
  // 只对明确命名的字符串参数生效；普通字符串仍是文本框，Literal 的静态选择优先。
  const stringAnnotation = (p.annotation ?? '').replace(/^typing\./, '').trim()
  const isStringParam =
    typeof p.defaultLiteral === 'string' ||
    (!p.hasDefault && (stringAnnotation === 'str' || stringAnnotation === 'String'))
  if (
    upstreamColumns?.length &&
    isStringParam &&
    !p.options?.length &&
    COLUMN_SELECTOR_PARAMS.has(p.name)
  ) {
    const selected = typeof currentValue === 'string' ? currentValue : ''
    const options = upstreamColumns.map((value) => ({ value, label: value }))
    if (selected && !upstreamColumns.includes(selected)) {
      options.unshift({ value: selected, label: `${selected}（当前值不在上游表）` })
    }
    return {
      ...base,
      type: 'select',
      default: p.defaultLiteral ?? '',
      options,
    }
  }

  switch (typeof p.defaultLiteral) {
    case 'number':
      return { ...base, type: 'number', default: p.defaultLiteral }
    case 'boolean':
      return { ...base, type: 'boolean', default: p.defaultLiteral }
    default:
      if (!p.hasDefault && /bool/.test((p.annotation ?? '').toLowerCase())) {
        return { ...base, type: 'boolean', default: false }
      }
      if (!p.hasDefault && /int|float|number|double/.test((p.annotation ?? '').toLowerCase())) {
        const integer = /int/.test((p.annotation ?? '').toLowerCase())
        return {
          ...base,
          type: 'number',
          default: 0,
          step: integer ? 1 : undefined,
        }
      }
      return { ...base, type: 'text', default: p.defaultLiteral ?? '' }
  }
}

const TRAINING_PARAM_LABELS: Readonly<Record<string, string>> = {
  past_n: '历史点数',
  future_n: '未来点数',
  stride: '滑动步长',
  batch_size: '批大小',
  epochs: '训练轮数',
  learning_rate: '学习率',
  lr: '学习率',
  patience: '早停耐心轮数',
  min_delta: '最小改善量',
  seed: '随机种子',
}

/**
 * 数据集在 YAML 里的对外身份。
 *
 * YAML 里存的是数据集 id，而 id 是本机导入时现生成的（`ds-1-xxxx`）——
 * 换次会话、刷个页面就必然对不上。名字 + 行数是这份数据"长什么样"的可读描述，
 * 拿它在导入时把失效的 id 认回来。
 */
export interface DatasetIdentity {
  name: string
  /** 导出时的行数。旧文件没这一项，undefined 表示"只有名字" */
  rowCount?: number
}

/** 解析动态端口所需的外部信息 */
export interface PortContext {
  /** 数据集 id → 当前启用的特征列名 */
  featuresOf: (datasetId: string) => string[]
  /** 数据集 id → 时间列名；没有时间列时为 null */
  timeColumnOf: (datasetId: string) => string | null
  /** 这个 id 在本机有没有对应的数据集，用于导入时区分重新绑定与本地数据缺失。 */
  hasDataset?: (datasetId: string) => boolean
  /**
   * 数据集 id → **内容哈希**（`sha256:…`，见 `kernel/dataset.ts` 的 `datasetContentHash`）。
   *
   * 为什么指纹需要它：`data.source` 的指纹原本只有列名与时间列，于是**换了数据但列一样**
   * 时指纹不变 —— 界面会把上一次算出来的结果继续当成这次的结果显示，图、参数、时间列
   * 全都对，只有数是别人的（契约规格 R3.2）。算不出来时返回 null：指纹里就少这一项。
   */
  contentHashOf?: (datasetId: string) => string | null
  /** 数据集 id → 跨会话认回来的身份 */
  identityOf?: (datasetId: string) => DatasetIdentity | null
  /** 按身份反查本机数据集；exact 表示名字与行数都对上了 */
  findByIdentity?: (identity: DatasetIdentity) => { id: string; exact: boolean } | null
  /**
   * 某个**输入端口上到达的表**有哪些列。
   *
   * 与 `featuresOf` 的区别：那个只认"节点上选的数据集"，这个认图上任何一条线 ——
   * 函数筛完的表、分帧后的样本都算。拆列节点靠它把端口按上游实际的列长出来，
   * 用户因此不必手打列名。
   *
   * **返回 null 表示"还算不出来"，不是"没有列"**：上游没求过值时就是 null，
   * 与"这张表真的一列都没有"是两件事。区别对待由 `portsTrustworthy` 负责。
  */
  columnsOf?: (nodeId: string, portId: string) => string[] | null
  /**
   * 某个输入表中的可编号特征列。与 `columnsOf` 不同，它排除上游登记的时间列。
   * 不提供时，拆列的纯逻辑回退到 `columnsOf`；执行面有输出摘要时应提供这项，
   * 否则时间列会错误地占用特征序号。
   */
  featureColumnsOf?: (nodeId: string, portId: string) => string[] | null
}

/** 端口在边 id 里的分隔符。列名/参数名里几乎不可能出现竖线，比 -> 安全 */
const EDGE_SEP = '|'

export function makeEdgeId(source: string, sourcePort: string, target: string, targetPort: string): string {
  return [source, sourcePort, target, targetPort].join(EDGE_SEP)
}

/**
 * 数据源的「整表」输出端口。
 *
 * 数据源的唯一输出端口；单列选择由下游 `data.columns` 完成。
 */
export { WHOLE_TABLE_PORT }
const WHOLE_TABLE_LABEL = '整表'

/**
 * 旧工程时间轴端口的兼容标识。新数据源不再暴露它；导入迁移把旧直连改为拆列节点。
 */
export const TIME_PORT = '__time__'
const TIME_PORT_LABEL = '时间轴'

/** 合成端口（整表 / 时间轴）不是真实列名，反查列、按列序重映射都要特殊处理 */
export function isSyntheticPort(portId: string): boolean {
  return portId === WHOLE_TABLE_PORT || portId === TIME_PORT
}

/** 列拼表：把若干列端口拼回一张表 */
export const COLLECT_TYPE = 'data.collect'

/**
 * 拆列：把一张表拆成"一列一个输出端口"。
 *
 * 与 `data.collect` 正好互为逆操作 —— 拼表把若干列收成一张表，拆列把一张表摊成若干列。
 * 端口 id 就是列名；需要单列数据的下游节点通过这里明确选列。
 */
export const COLUMNS_TYPE = 'data.columns'

export interface FeatureIndexToken {
  raw: string
  index: number | null
}

/**
 * 解析拆列节点的显式特征索引。
 *
 * 索引从 1 开始；全角逗号、分号和换行都可作分隔符。JSON 数组是给工程/agent
 * 写入用的兼容形式，例如 `[1, 3]` 或 `["1", "3"]`。保留非法 token，
 * 让端口解析与执行面都能给出可定位的错误，而不是把它当成“留空”。
 */
export function parseFeatureIndices(value: unknown): FeatureIndexToken[] {
  if (value === undefined || value === null) return []
  let rawTokens: unknown[]
  if (Array.isArray(value)) {
    rawTokens = value
  } else {
    const text = String(value).trim()
    if (!text) return []
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (Array.isArray(parsed)) rawTokens = parsed
        else rawTokens = [text]
      } catch {
        rawTokens = text.split(/[,，;；\n]/)
      }
    } else {
      rawTokens = text.split(/[,，;；\n]/)
    }
  }

  const seen = new Set<string>()
  const tokens: FeatureIndexToken[] = []
  for (const value of rawTokens) {
    const raw = String(value ?? '').trim()
    if (!raw || seen.has(raw)) continue
    seen.add(raw)
    const index = /^\d+$/.test(raw) ? Number(raw) : null
    tokens.push({ raw, index: index !== null && Number.isSafeInteger(index) && index > 0 ? index : null })
  }
  return tokens
}

function hasExplicitFeatureSelection(node: WorkflowNode): boolean {
  return parseFeatureIndices(node.params.columns).length > 0
}

function upstreamColumnsForSelection(node: WorkflowNode, ctx: PortContext): string[] | null {
  const featureColumns = ctx.featureColumnsOf?.(node.id, 'data')
  if (featureColumns !== undefined) return featureColumns
  return ctx.columnsOf?.(node.id, 'data') ?? null
}

function legacyNamedSelection(tokens: FeatureIndexToken[], available: string[] | null): string[] | null {
  if (tokens.length === 0 || tokens.some((token) => token.index !== null)) return null
  const names = tokens.map((token) => token.raw)
  // 旧工程可能只带着实际端口名，没有上游摘要。此时仍保留这些稳定的端口 id，
  // 等宿主执行时再由共享解析器验证列是否存在。
  if (!available) return names.every((name) => !/^\d+$/.test(name)) ? names : null
  return names.every((name) => available.includes(name)) ? names : null
}

/** 拆列节点上写死的特征索引（可留空）。留空 = 按上游实际列长端口。 */
export function explicitFeatureIndicesOf(node: WorkflowNode): number[] {
  return parseFeatureIndices(node.params.columns)
    .map((token) => token.index)
    .filter((index): index is number => index !== null)
}
/** 列拼表那个多入端口的 id：画布上就这一个连接点，能接任意多根线 */
export const COLLECT_IN_PORT = 'in'

/**
 * 这个节点的多入端口上已经接了的线，按连线在图里的先后列出（契约规格 R13）。
 *
 * 判据取**端口声明**（`multiple: true`）而不是节点类型 —— 以后再有吃多入的算子，
 * 这里不用加第二个 if。顺序就是 `edges` 里的先后：那是"这根线什么时候接上的"唯一的
 * 记录，也是拼表列序的来源。
 */
export function fanInEdges(workflow: Workflow, node: WorkflowNode): WorkflowEdge[] {
  const ports = new Set(
    getNodeTypeDef(node.type)
      .inputs.filter((p) => p.multiple)
      .map((p) => p.id),
  )
  if (ports.size === 0) return []
  return workflow.edges.filter((e) => e.target === node.id && ports.has(e.targetPort))
}

/** 函数类节点：端口从代码里的 def 签名解析，而不是写死在注册表 */
export function isFunctionNode(type: string): boolean {
  if (type === 'train.function') return true
  if (!type.startsWith('custom.')) return false
  // 自定义模型也是 Python 代码，但它的 build_model 是模型工厂，不是画布函数。
  // 保留注册表声明的 model 输出，不能把 build_model 的形参误长成数据端口。
  if (type === 'custom.model') return false
  // 未注册的 custom.* 不抛异常：导入到一份"带着别人自建模块"的 YAML 时，
  // 这里只是判断"能不能按签名解析端口"，是不是已注册另有别的检查负责
  try {
    return getNodeTypeDef(type).params.some((p) => p.key === 'code')
  } catch {
    return false
  }
}

/**
 * 这个节点的端口列表现在可不可信。
 *
 * 「端口被删了」和「端口一时算不出来」在 `resolvePorts` 里长得一样：都是列表里少了几项。
 * 但后果完全不同 —— 前者该把连线清掉（用户在数据面板里关掉了一列，线留着就是死线），
 * 后者把线清掉就是数据丢失。典型情况是导入 YAML 后，函数签名或拆列节点的上游列名
 * 还没就绪；此时清线会让用户刚接好的图再也长不回来。
 *
 * 所以清理连线之前先问这一句：端口列表丢掉的那几项，是真的被删了，还是只是还算不出来。
 */
export function portsTrustworthy(node: WorkflowNode, ctx: PortContext): boolean {
  // 组节点缺少内联定义时，空端口不代表原有连线无效；保留连线，交给组定义校验报告问题。
  if (node.type === 'workflow.group') return Boolean(node.group)
  // 数据源端口固定。数据集没绑定是求值问题，不是端口结构不确定。
  if (node.type === 'train.function') {
    return !parseTrainingSignature(String(node.params.code ?? '')).error
  }

  if (node.type === 'custom.model') {
    const parsed = parseModelInterface(String(node.params.code ?? ''))
    return !parsed.error
  }
  // 函数节点：代码还没写、或签名解析不出来 → 同样算不出来
  if (isFunctionNode(node.type)) return !parseSignature(String(node.params.code ?? '')).error
  // 拆列：列名要么写在节点上，要么从上一次的运行结果里来。两者都没有时，
  // 端口列表只是"还算不出来" —— 这时候清连线会把用户刚接好的表丢掉
  if (node.type === COLUMNS_TYPE) {
    if (!hasExplicitFeatureSelection(node)) return (ctx.columnsOf?.(node.id, 'data')?.length ?? 0) > 0
    // 显式索引本身已经确定了端口数量；如果这是旧工程的列名选择，只有在列名已知时
    // 才能确认它仍然有效。
    const tokens = parseFeatureIndices(node.params.columns)
    if (tokens.every((token) => token.index !== null)) return true
    return legacyNamedSelection(tokens, upstreamColumnsForSelection(node, ctx)) !== null
  }
  return true
}

/**
 * 端口还算不出来时，给用户一句"下一步做什么"。
 *
 * 求值计划用它把节点拦在这一轮之外：拿一份空端口列表去算，引擎只会报
 * "还没有输出端口"，用户看到的是"节点闪了一下错误" —— 而真实情况只是"还没轮到"。
 */
export function portsPendingReason(node: WorkflowNode, ctx: PortContext): string | null {
  // 只认"会自己好"的那一种。
  //
  // 数据源没绑数据集、函数代码解析不出签名 —— 这两件事**不会自己好**，得由用户动手，
  // 所以它们继续走原来的报错路径。用一句"等一等"把该修的问题盖住，比报错更糟：
  // 用户会一直等一个永远不会来的结果。
  //
  // 拆列不同：它的端口来自上游，上游这一轮算完就有了。这一轮只是"还没轮到"。
  if (node.type !== COLUMNS_TYPE) return null
  if (portsTrustworthy(node, ctx)) return null
  return '等上游先算出来：这一步有哪些端口，由上游那张表有哪些列决定'
}

/** 该参数是否值得长成一个可接线的端口 */
export function isPortableParam(spec: ParamSpec): boolean {
  if (spec.portable !== undefined) return spec.portable
  // 只有数值型参数值得被上游驱动（超参搜索这类场景）。
  // 下拉选项、布尔、字段映射、代码给它们长端口没有真实用途，只会把节点撑大。
  return spec.type === 'number' && spec.widget === undefined
}

/** 组节点公开的端口与参数。边界端口保留定义中的契约，只把 id/label 换成组对外名称。 */
export function groupNodePorts(
  node: WorkflowNode,
): { inputs: PortSpec[]; outputs: PortSpec[] } {
  if (node.type !== 'workflow.group' || !node.group) return { inputs: [], outputs: [] }

  const inputs = node.group.inputs.map(({ id, label, port }) => ({ ...port, id, label }))
  const parameterPorts: PortSpec[] = node.group.parameters.map(({ key, label, spec }) => ({
    id: key,
    label,
    type: 'any' as const,
    kind: 'param' as const,
    paramKey: key,
    optional: !spec.required,
    paramSpec: { ...spec, key, label },
  }))
  const outputs = node.group.outputs.map(({ id, label, port }) => ({ ...port, id, label }))
  return { inputs: [...inputs, ...parameterPorts], outputs }
}

/**
 * 解析节点的实际端口。
 *
 * 四类情况：
 * 1. **数据源** —— 固定的单一整表输出端口
 * 2. **列拼表** —— 输入端口数由「列数」决定，拼成一个表输出
 * 3. **函数节点** —— 端口由代码里的 def 签名决定：形参是输入，return 的 key 是输出
 * 4. **预设节点** —— 语义化数据端口 + 数值型参数的端口（参数也能被上游连线驱动）
 */
export function resolvePorts(
  node: WorkflowNode,
  ctx: PortContext,
): { inputs: PortSpec[]; outputs: PortSpec[] } {
  const def = getNodeTypeDef(node.type)

  if (node.type === 'workflow.group') return groupNodePorts(node)

  if (node.type === COLUMNS_TYPE) {
    // 列名的来源有两个，优先级不能反：写死在节点上的那几个列是**用户的显式意图**，
    // 上游实际有什么只是事实。反过来的话，上游多一列就会在用户没同意的情况下多长一个
    // 端口 —— 而端口增减会牵动连线。
    const tokens = parseFeatureIndices(node.params.columns)
    const availableColumns = ctx.columnsOf?.(node.id, 'data') ?? null
    const featureColumns = upstreamColumnsForSelection(node, ctx)
    let columns = availableColumns ?? []
    if (tokens.length > 0) {
      const legacy = legacyNamedSelection(tokens, availableColumns)
      if (legacy) {
        columns = legacy
      } else if (featureColumns) {
        columns = tokens.map((token) =>
          token.raw === TIME_PORT
            ? TIME_PORT
            : token.index !== null && token.index <= featureColumns.length
              ? featureColumns[token.index - 1]
              : `__feature_index_${token.raw}`,
        )
      } else {
        // 上游还没出摘要时先给稳定的占位端口；真正的列名会在下一轮解析出来。
        columns = tokens.map((token) =>
          token.raw === TIME_PORT ? TIME_PORT : `__feature_index_${token.raw}`,
        )
      }
    }
    return {
      inputs: def.inputs,
      outputs: columns.map((name) => ({
        id: name,
        label: name.startsWith('__feature_index_')
          ? `特征索引 ${name.slice('__feature_index_'.length)}`
          : name === TIME_PORT
            ? TIME_PORT_LABEL
            : name,
        type: 'table' as const,
      })),
    }
  }

  if (node.type === 'train.function') {
    const sig = parseTrainingSignature(String(node.params.code ?? ''))
    const dynamicParams = sig.params.map<PortSpec>((p) => {
      const label = TRAINING_PARAM_LABELS[p.name] ?? p.name
      return {
        id: p.name,
        label,
        type: 'any',
        kind: 'param',
        paramKey: p.name,
        optional: p.hasDefault,
        paramSpec: { ...fnParamToSpec(p), label },
      }
    })
    return { inputs: [...def.inputs, ...dynamicParams], outputs: def.outputs }
  }

  if (node.type === 'custom.model') {
    const parsed = parseModelInterface(String(node.params.code ?? ''))
    if (parsed.error || !parsed.interface) return { inputs: [], outputs: def.outputs }
    const declared = interfacePorts(parsed.interface)
    return {
      inputs: declared.inputs,
      // `model` is the stable model-definition handle; declared outputs are the
      // model's named interface and remain after it so old edge ordering is stable.
      outputs: [...def.outputs, ...declared.outputs],
    }
  }

  if (isFunctionNode(node.type)) {
    const sig = parseSignature(String(node.params.code ?? ''))
    const upstreamColumns =
      node.type === 'custom.chart'
        ? ctx.columnsOf?.(node.id, 'data') ?? undefined
        : undefined
    return {
      inputs: sig.params.map<PortSpec>((p) => ({
        id: p.name,
        label: p.name,
        type: 'any',
        kind: 'param',
        paramKey: p.name,
        // 有默认值的形参不接线也能跑，直接用字面量
        optional: p.hasDefault,
        paramSpec: fnParamToSpec(p, upstreamColumns, node.params[p.name]),
      })),
      outputs: sig.outputs.map<PortSpec>((o) => ({
        id: o.name,
        label: o.name,
        // 自定义函数仍然保持动态端口，但这些约定俗成的输出名可以让下游知道
        // 它拿到的不是普通透传值：figure 交给统一绘图预览，scaler 可继续传给
        // 另一个自定义函数。这样用户只改函数代码，不需要再手工维护第二份端口声明。
        type: o.name === 'figure' ? 'figure' : o.name === 'scaler' ? 'scaler' : 'any',
      })),
    }
  }

  const paramPorts: PortSpec[] = def.params
    .filter(isPortableParam)
    .map<PortSpec>((p) => ({
      id: p.key,
      label: p.label,
      type: 'any',
      kind: 'param',
      paramKey: p.key,
      optional: true,
    }))

  return { inputs: [...def.inputs, ...paramPorts], outputs: def.outputs }
}

/** 该节点是否有动态端口（YAML 导入、端口校验等场景需要区别对待） */
/* ------------------------------------------------------------------ */
/* 上游数据列反查                                                      */
/* ------------------------------------------------------------------ */

interface UpstreamColumn {
  datasetId: string
  column: string
  sourceNodeId: string
  sourceLabel: string
}

/** 某个输入端口接的是哪个上游节点的哪个输出端口 */
export interface UpstreamTable {
  nodeId: string
  portId: string
  /** 上游节点的显示名，界面要拿它说明"数据来自哪一步" */
  label: string
}

/**
 * 反查一个输入端口接到的上游输出。
 *
 * 与 `resolveUpstreamColumn` 的区别：那个只认旧工程里"上游数据源直出的单列"，
 * 这个认任何上游 —— 函数筛完的表、分帧后的样本都算。图表节点要的是后者：
 * 它不关心上游是哪一列，只关心"那条线上有没有表"。
 */
export function resolveUpstreamTable(
  workflow: Workflow,
  nodeId: string,
  portId = 'data',
): UpstreamTable | null {
  const edge = workflow.edges.find((e) => e.target === nodeId && e.targetPort === portId)
  if (!edge) return null
  const src = workflow.nodes.find((n) => n.id === edge.source)
  if (!src) return null
  return { nodeId: src.id, portId: edge.sourcePort, label: src.label }
}

/**
 * 找到出图节点的上游表。
 *
 * 预设图表约定输入端口叫 `data`，但自定义函数的形参可以叫 `train`、`val` 或任意
 * 其他名字。只要节点有一条非 scaler 输入连线，就把它当作图表预览的原始表；函数
 * 真正返回的 `figure` 仍由引擎输出，前端只用这里的表补充行数和来源说明。
 */
export function resolveFigureUpstreamTable(workflow: Workflow, nodeId: string): UpstreamTable | null {
  const preferred = resolveUpstreamTable(workflow, nodeId, 'data')
  if (preferred) return preferred

  const edge = workflow.edges.find((candidate) =>
    candidate.target === nodeId && candidate.targetPort !== 'scaler',
  )
  if (!edge) return null
  const src = workflow.nodes.find((n) => n.id === edge.source)
  if (!src) return null
  return { nodeId: src.id, portId: edge.sourcePort, label: src.label }
}

/**
 * 这个节点的数据最终来自哪个数据集（沿输入端口的线一路往上游走，直到数据源节点）。
 *
 * 存在的理由只有一个：**采样率是数据的属性，不是算子的参数**（契约规格 R3.4）。
 * 频域特征要知道 fs，而 fs 得从"这份数据到底是谁"查出来 —— 它记在 `DatasetRef` 上。
 *
 * 三种情况返回 null，而且都是**老实说不知道**，不是"没有"：
 * - 上游接不到数据源（函数里造出来的表）；
 * - 上游来源不止一个数据集（列拼表把两份数据合在一起）—— 这时候"这份数据的采样率"
 *   本身就没有唯一答案；
 * - 数据源节点没选数据集。
 * 调用方拿到 null 之后要做的不是猜一个默认值，而是让用户在自定义函数中显式处理。
 */
export function upstreamDatasetId(workflow: Workflow, nodeId: string): string | null {
  const found = new Set<string>()
  const seen = new Set<string>()

  const walkInto = (target: string, targetPort: string): void => {
    const edge = workflow.edges.find((e) => e.target === target && e.targetPort === targetPort)
    if (!edge) return
    const key = `${edge.source}:${edge.sourcePort}`
    if (seen.has(key)) return
    seen.add(key)
    const node = workflow.nodes.find((n) => n.id === edge.source)
    if (!node) return
    if (node.type === 'data.source') {
      const id = String(node.params.datasetId ?? '')
      if (id) found.add(id)
      return
    }
    // 继续往上游走：这个节点的每个输入端口都可能是数据的来路
    for (const e of workflow.edges.filter((x) => x.target === node.id)) {
      walkInto(node.id, e.targetPort)
    }
  }

  for (const e of workflow.edges.filter((x) => x.target === nodeId)) {
    walkInto(nodeId, e.targetPort)
  }
  return found.size === 1 ? [...found][0] : null
}

/** 端口 id → 给人看的名字。合成端口不能把内部 id 漏到界面上 */
function portDisplayLabel(portId: string): string {
  if (portId === WHOLE_TABLE_PORT) return WHOLE_TABLE_LABEL
  if (portId === TIME_PORT) return TIME_PORT_LABEL
  return portId
}

/**
 * 兼容旧工程：从仍然直连数据源的输入端口反查历史单列连线。
 *
 * 新工程的数据源只输出整表，单列选择由 `data.columns` 显式完成；旧连线会在导入时
 * 自动迁移，因此当前界面和执行路径不应依赖这个反查函数。
 */
export function resolveUpstreamColumn(
  workflow: Workflow,
  nodeId: string,
  portId = 'data',
): UpstreamColumn | null {
  const edge = workflow.edges.find((e) => e.target === nodeId && e.targetPort === portId)
  if (!edge) return null
  // 整表和时间轴都不是一列数值，不能当列名反查给只吃单列的节点
  if (isSyntheticPort(edge.sourcePort)) return null
  const src = workflow.nodes.find((n) => n.id === edge.source)
  if (!src || src.type !== 'data.source') return null
  const datasetId = String(src.params.datasetId ?? '')
  if (!datasetId) return null
  return {
    datasetId,
    column: edge.sourcePort,
    sourceNodeId: src.id,
    sourceLabel: src.label,
  }
}

/** 输入端口 → 上游列名。只对"上游是数据源"的情况有值，供节点框上直接显示列名 */
export function buildUpstreamLabels(workflow: Workflow): Map<string, Record<string, string>> {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]))
  const out = new Map<string, Record<string, string>>()
  for (const e of workflow.edges) {
    const src = byId.get(e.source)
    if (src?.type !== 'data.source') continue
    const m = out.get(e.target) ?? {}
    m[e.targetPort] = portDisplayLabel(e.sourcePort)
    out.set(e.target, m)
  }
  return out
}

/** 列拼表多入端口上接进来的每一路 */
export interface CollectFilling {
  /** 上游列名；整表 / 时间轴端口接入时是对应的中文标签 */
  column: string
  sourceNodeId: string
  sourcePort: string
}

/**
 * 列出列拼表已接线的上游，顺序 = 连线先后（= 拼出来的列序）。
 *
 * 这里以前是"按槽位 1..N 各找一根线"，所以槽位数（一个用户要填的参数）决定了
 * 能接几路。现在多入端口没有上限，也没有那个参数。
 */
export function collectWiring(workflow: Workflow, node: WorkflowNode): CollectFilling[] {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]))
  const filled: CollectFilling[] = []
  for (const edge of fanInEdges(workflow, node)) {
    if (!byId.has(edge.source)) continue
    filled.push({
      column: portDisplayLabel(edge.sourcePort),
      sourceNodeId: edge.source,
      sourcePort: edge.sourcePort,
    })
  }
  return filled
}
