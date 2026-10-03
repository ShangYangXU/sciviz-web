import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { defaultParams, getNodeTypeDef, hasNodeType } from './nodeRegistry'
import { pruneGroupParameterBindings, WORKFLOW_GROUP_TYPE } from './groups'
import { parseTrainingSignature } from './functionSignature'
import { parseModelParams } from './modelParams'
import {
  makeEdgeId,
  portsTrustworthy,
  resolvePorts,
  COLUMNS_TYPE,
  COLLECT_IN_PORT,
  COLLECT_TYPE,
  TIME_PORT,
  WHOLE_TABLE_PORT,
  type DatasetIdentity,
  type PortContext,
} from './ports'
import type {
  ParamSpec,
  PortSpec,
  Workflow,
  WorkflowEdge,
  WorkflowGroupDefinition,
  WorkflowNode,
} from './types'

const MAX_GROUP_DEPTH = 32

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function serializePort(port: PortSpec): PortSpec {
  // Spread keeps future optional port metadata intact when an older client opens and saves a file.
  return { ...port }
}

function serializeGroup(group: WorkflowGroupDefinition, ctx: PortContext | undefined, depth: number): Record<string, unknown> {
  const value = group as WorkflowGroupDefinition & Record<string, unknown>
  return {
    ...value,
    workflow: workflowToYamlObjectAtDepth(group.workflow, ctx, { includeId: true, includeMetadata: true }, depth + 1),
    inputs: group.inputs.map((input) => ({ ...input, port: serializePort(input.port) })),
    outputs: group.outputs.map((output) => ({ ...output, port: serializePort(output.port) })),
    parameters: group.parameters.map((parameter) => ({ ...parameter, spec: { ...parameter.spec } })),
  }
}

/**
 * Build the graph document used by workflow YAML and `.sciviz` files.
 * `includeId` and `includeMetadata` let `.sciviz` keep its current top-level graph shape while
 * nested workflows retain their full identity and name.
 */
export function workflowToYamlObject(
  wf: Workflow,
  ctx?: PortContext,
  options: { includeId?: boolean; includeMetadata?: boolean } = { includeMetadata: true },
): Record<string, unknown> {
  return workflowToYamlObjectAtDepth(wf, ctx, options, 0)
}

function workflowToYamlObjectAtDepth(
  wf: Workflow,
  ctx: PortContext | undefined,
  options: { includeId?: boolean; includeMetadata?: boolean },
  depth: number,
): Record<string, unknown> {
  if (depth > MAX_GROUP_DEPTH) throw new Error(`组块嵌套超过 ${MAX_GROUP_DEPTH} 层，不能序列化`)
  return {
    ...(options.includeId ? { id: wf.id } : {}),
    ...(options.includeMetadata ? { name: wf.name, description: wf.description } : {}),
    nodes: wf.nodes.map((node) => {
      const identity = ctx?.identityOf?.(String(node.params.datasetId ?? '')) ?? null
      return {
        id: node.id,
        type: node.type,
        label: node.label,
        params: node.params,
        ...(node.paramNotes && Object.keys(node.paramNotes).length > 0 ? { paramNotes: node.paramNotes } : {}),
        ...(identity ? { dataset: identity } : {}),
        ...(node.group ? { group: serializeGroup(node.group, ctx, depth) } : {}),
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      }
    }),
    edges: wf.edges.map((edge) => ({
      source: edge.source,
      sourcePort: edge.sourcePort,
      target: edge.target,
      targetPort: edge.targetPort,
    })),
  }
}

/**
 * 导出成 YAML。
 * 这是工作流的"唯一真相"载体：可 diff、可 git、可程序化批量生成。
 *
 * 带 `ctx` 时额外写出数据源节点引用的**数据集身份**（名字 + 行数）。
 * `datasetId` 是本机导入时现生成的，换会话必然失效；只留 id 的话，
 * 一份导出到别处的 YAML 回来时会指向一个不存在的数据集，整条链直接断。
 */
export function workflowToYaml(wf: Workflow, ctx?: PortContext): string {
  const doc = workflowToYamlObject(wf, ctx)
  const body = stringifyYaml(doc, { lineWidth: 0, indent: 2 })
  return `# workflow: ${wf.name}\n# 由 SciViz v0.0 导出 —— 可手工编辑后重新导入画布\n${body}`
}

interface ParseResult {
  workflow?: Workflow
  error?: string
  warnings: string[]
}

/** 读节点上的 `dataset:` 段（旧文件没有这一项） */
function readIdentity(raw: unknown): DatasetIdentity | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name) return null
  return {
    name: o.name,
    rowCount: typeof o.rowCount === 'number' ? o.rowCount : undefined,
  }
}

/**
 * 把 YAML 里那份数据集绑回本机的一份。
 *
 * 判据顺序：`datasetId` 在本机还能用 → 什么都不做；否则按名字（+ 行数）认回来；
 * 再认不回来就只提示、不改参数 —— 这时连线会指向一个算不出来的端口，
 * 由 `portsTrustworthy` 保证它不被当成"死线"清掉，用户导入 CSV 后选一次就能复活。
 */
function rebindDataset(
  node: WorkflowNode,
  rawDataset: unknown,
  ctx: PortContext | undefined,
  warnings: string[],
): void {
  const identity = readIdentity(rawDataset)
  if (!ctx) return
  const declared =
    getNodeTypeDef(node.type).params.some((p) => p.key === 'datasetId') ||
    (node.type === 'viz.chart' && 'datasetId' in node.params)
  if (!declared) return

  const current = String(node.params.datasetId ?? '')
  if (current && (ctx.hasDataset ? ctx.hasDataset(current) : true)) return

  // 旧版 YAML 没有 dataset 段，只剩一个 id。id 认不回来时至少要说清是哪份数据，
  // 否则用户只会看到数据源节点报错，不知道要重新导入什么
  if (!identity) {
    if (current) {
      warnings.push(
        `节点「${node.label}」引用的数据集不在本会话里（YAML 里只记了 id「${current}」）：` +
          (node.type === 'viz.chart'
            ? '先在顶栏「导入数据」导入这份 CSV，再在自动生成的兼容数据源节点上选择；图表连线已迁移'
            : '先在顶栏「导入数据」导入这份 CSV，再在该节点上选一次；连线已原样保留'),
      )
    }
    return
  }

  const hit = ctx.findByIdentity?.(identity) ?? null
  if (hit) {
    node.params.datasetId = hit.id
    warnings.push(
      hit.exact
        ? `节点「${node.label}」的数据集已按导出时的名字「${identity.name}」重新绑定到本机同一份数据`
        : `节点「${node.label}」的数据集按名字「${identity.name}」绑定到了本机的一份数据，` +
            '但行数与导出时不一致 —— 请确认这是不是你要的那份',
    )
    return
  }
  warnings.push(
    `节点「${node.label}」引用的数据集「${identity.name}」不在本会话里：` +
      (node.type === 'viz.chart'
        ? '先在顶栏「导入数据」导入这份 CSV，再在自动生成的兼容数据源节点上选择；图表连线已迁移'
        : '先在顶栏「导入数据」导入这份 CSV，再在该节点上选一次；连线已原样保留'),
  )
}

function normalizeParamSpec(raw: unknown, path: string): ParamSpec | string {
  if (!isRecord(raw)) return `${path} 必须是对象`
  const type = String(raw.type)
  const defaultMatchesType =
    (type === 'number' && typeof raw.default === 'number' && Number.isFinite(raw.default)) ||
    (type === 'boolean' && typeof raw.default === 'boolean') ||
    (['text', 'select', 'code'].includes(type) && typeof raw.default === 'string')
  if (
    typeof raw.key !== 'string' || !raw.key ||
    typeof raw.label !== 'string' || !raw.label ||
    !['number', 'text', 'select', 'boolean', 'code'].includes(type) ||
    !defaultMatchesType
  ) {
    return `${path} 缺少有效的 key、label、type，或 default 与 type 不匹配`
  }
  for (const key of ['required', 'portable'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') return `${path}.${key} 必须是布尔值`
  }
  for (const key of ['min', 'max', 'step', 'minItems', 'maxItems', 'itemMin', 'itemMax'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) {
      return `${path}.${key} 必须是有限数字`
    }
  }
  for (const key of ['unit', 'hint'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') return `${path}.${key} 必须是文本`
  }
  if (
    raw.widget !== undefined &&
    !['default', 'mapping', 'palette', 'dataset', 'chartType', 'datasetRef', 'list'].includes(String(raw.widget))
  ) {
    return `${path}.widget 不是已知控件类型`
  }
  if (raw.listItemType !== undefined && !['int', 'float', 'text', 'boolean'].includes(String(raw.listItemType))) {
    return `${path}.listItemType 不是已知列表元素类型`
  }
  if (raw.options !== undefined) {
    if (
      !Array.isArray(raw.options) ||
      raw.options.some((option) => !isRecord(option) || typeof option.value !== 'string' || typeof option.label !== 'string')
    ) {
      return `${path}.options 必须是包含文本 value/label 的列表`
    }
  }
  // Keep extra fields too, so an older app can round-trip a spec from a newer file.
  return { ...raw } as unknown as ParamSpec
}

function normalizePortSpec(raw: unknown, path: string): PortSpec | string {
  if (!isRecord(raw)) return `${path} 必须是对象`
  if (
    typeof raw.id !== 'string' || !raw.id ||
    typeof raw.label !== 'string' || !raw.label ||
    !['any', 'table', 'tensor', 'model', 'metrics', 'figure', 'scaler'].includes(String(raw.type))
  ) {
    return `${path} 缺少有效的 id、label 或端口 type`
  }
  if (raw.optional !== undefined && typeof raw.optional !== 'boolean') return `${path}.optional 必须是布尔值`
  if (raw.multiple !== undefined && typeof raw.multiple !== 'boolean') return `${path}.multiple 必须是布尔值`
  if (raw.kind !== undefined && raw.kind !== 'data' && raw.kind !== 'param') {
    return `${path}.kind 必须是 data 或 param`
  }
  if (raw.paramKey !== undefined && typeof raw.paramKey !== 'string') return `${path}.paramKey 必须是文本`
  if (raw.paramSpec !== undefined) {
    const spec = normalizeParamSpec(raw.paramSpec, `${path}.paramSpec`)
    if (typeof spec === 'string') return spec
  }
  return { ...raw } as unknown as PortSpec
}

function resolvedPortExists(
  workflow: Workflow,
  nodeId: string,
  portId: string,
  direction: 'inputs' | 'outputs',
  ctx?: PortContext,
): boolean {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return false
  const portContext: PortContext = ctx ?? {
    featuresOf: () => [],
    timeColumnOf: () => null,
  }
  if (!portsTrustworthy(node, portContext)) return true
  return resolvePorts(node, portContext)[direction].some((port) => port.id === portId)
}

function normalizeGroup(
  raw: unknown,
  nodeId: string,
  nodeLabel: string,
  ctx: PortContext | undefined,
  warnings: string[],
  options: YamlParseOptions,
  depth: number,
): WorkflowGroupDefinition | string {
  const path = `组块「${nodeLabel}」`
  if (!isRecord(raw)) return `${path} 的 group 定义必须是对象`
  if (depth >= MAX_GROUP_DEPTH) return `${path} 的嵌套超过 ${MAX_GROUP_DEPTH} 层，已拒绝导入`
  if (!isRecord(raw.workflow)) return `${path} 缺少有效的内部 workflow 对象`

  const childId = typeof raw.workflow.id === 'string' && raw.workflow.id ? raw.workflow.id : `${nodeId}__inner`
  if (childId !== raw.workflow.id) warnings.push(`${path} 的内部 workflow 缺少 id，已生成「${childId}」`)
  const childResult = normalizeWorkflowDocument(raw.workflow, childId, ctx, options, depth + 1)
  if (!childResult.workflow) {
    return `${path} 的内部 workflow 无效：${childResult.error ?? '无法读取'}`
  }
  warnings.push(...childResult.warnings.map((warning) => `${path} 内部：${warning}`))
  const inner = childResult.workflow
  const innerNodeIds = new Set(inner.nodes.map((node) => node.id))

  const normalizeInputs = (items: unknown): WorkflowGroupDefinition['inputs'] | string => {
    if (!Array.isArray(items)) return `${path}.inputs 必须是列表`
    const seen = new Set<string>()
    const result: WorkflowGroupDefinition['inputs'] = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const at = `${path}.inputs[${index + 1}]`
      if (!isRecord(item)) return `${at} 必须是对象`
      if (
        typeof item.id !== 'string' || !item.id || seen.has(item.id) ||
        typeof item.label !== 'string' || !item.label ||
        typeof item.targetNodeId !== 'string' || !item.targetNodeId ||
        typeof item.targetPortId !== 'string' || !item.targetPortId
      ) return `${at} 缺少有效字段，或 id 重复`
      if (!innerNodeIds.has(item.targetNodeId)) return `${at} 指向不存在的内部节点「${item.targetNodeId}」`
      const port = normalizePortSpec(item.port, `${at}.port`)
      if (typeof port === 'string') return port
      if (!resolvedPortExists(inner, item.targetNodeId, item.targetPortId, 'inputs', ctx)) {
        return `${at} 指向不存在的输入端口「${item.targetPortId}」`
      }
      seen.add(item.id)
      result.push({ ...item, port } as unknown as WorkflowGroupDefinition['inputs'][number])
    }
    return result
  }

  const normalizeOutputs = (items: unknown): WorkflowGroupDefinition['outputs'] | string => {
    if (!Array.isArray(items)) return `${path}.outputs 必须是列表`
    const seen = new Set<string>()
    const result: WorkflowGroupDefinition['outputs'] = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const at = `${path}.outputs[${index + 1}]`
      if (!isRecord(item)) return `${at} 必须是对象`
      if (
        typeof item.id !== 'string' || !item.id || seen.has(item.id) ||
        typeof item.label !== 'string' || !item.label ||
        typeof item.sourceNodeId !== 'string' || !item.sourceNodeId ||
        typeof item.sourcePortId !== 'string' || !item.sourcePortId
      ) return `${at} 缺少有效字段，或 id 重复`
      if (!innerNodeIds.has(item.sourceNodeId)) return `${at} 指向不存在的内部节点「${item.sourceNodeId}」`
      const port = normalizePortSpec(item.port, `${at}.port`)
      if (typeof port === 'string') return port
      if (!resolvedPortExists(inner, item.sourceNodeId, item.sourcePortId, 'outputs', ctx)) {
        return `${at} 指向不存在的输出端口「${item.sourcePortId}」`
      }
      seen.add(item.id)
      result.push({ ...item, port } as unknown as WorkflowGroupDefinition['outputs'][number])
    }
    return result
  }

  const normalizeParameters = (items: unknown): WorkflowGroupDefinition['parameters'] | string => {
    if (!Array.isArray(items)) return `${path}.parameters 必须是列表`
    const seen = new Set<string>()
    const result: WorkflowGroupDefinition['parameters'] = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const at = `${path}.parameters[${index + 1}]`
      if (!isRecord(item)) return `${at} 必须是对象`
      if (
        typeof item.key !== 'string' || !item.key || seen.has(item.key) ||
        typeof item.label !== 'string' || !item.label ||
        typeof item.nodeId !== 'string' || !item.nodeId ||
        typeof item.paramKey !== 'string' || !item.paramKey
      ) return `${at} 缺少有效字段，或 key 重复`
      if (!innerNodeIds.has(item.nodeId)) return `${at} 指向不存在的内部节点「${item.nodeId}」`
      const spec = normalizeParamSpec(item.spec, `${at}.spec`)
      if (typeof spec === 'string') return spec
      seen.add(item.key)
      result.push({ ...item, spec } as unknown as WorkflowGroupDefinition['parameters'][number])
    }
    return result
  }

  const inputs = normalizeInputs(raw.inputs)
  if (typeof inputs === 'string') return inputs
  const outputs = normalizeOutputs(raw.outputs)
  if (typeof outputs === 'string') return outputs
  const parameters = normalizeParameters(raw.parameters)
  if (typeof parameters === 'string') return parameters
  return { ...raw, workflow: inner, inputs, outputs, parameters } as unknown as WorkflowGroupDefinition
}

/** 补齐缺失字段，让老 YAML / 手写 YAML 也能导进来 */
function normalizeNode(
  raw: unknown,
  index: number,
  warnings: string[],
  ctx: PortContext | undefined,
  options: YamlParseOptions,
  groupDepth: number,
): WorkflowNode | string {
  if (!raw || typeof raw !== 'object') return `第 ${index + 1} 个节点不是对象`
  const o = raw as Record<string, unknown>

  const type = typeof o.type === 'string' ? o.type : ''
  if (!type) return `第 ${index + 1} 个节点缺少 type 字段`
  // 认"内置 + 自建"：自建模块在本机的清单里，导入自己的 YAML 不该被判未注册
  if (!hasNodeType(type)) return `第 ${index + 1} 个节点的类型「${type}」未注册`

  const def = getNodeTypeDef(type)
  const id = typeof o.id === 'string' && o.id ? o.id : `n${index + 1}`
  if (typeof o.id !== 'string') warnings.push(`节点 ${id} 缺少 id，已自动生成`)

  // 先铺默认参数再用 YAML 覆盖 —— 这样以后新增参数不会让老文件失效。
  // 动态参数例外：custom.model / train.function 的控件来自节点自己的 code，
  // 不能把注册表默认 code 里的旧参数（例如 hidden_dim）带进新代码（例如
  // hidden_channels），否则打开工程后会出现“参数不合法”，并且污染模型指纹。
  const params = { ...defaultParams(def) }
  const rawParams = o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : null
  const rawCode = typeof rawParams?.code === 'string' ? rawParams.code : undefined
  if (rawCode !== undefined && (def.type === 'custom.model' || def.type === 'train.function')) {
    const staticCode = String(def.params.find((param) => param.key === 'code')?.default ?? '')
    const parseDynamicKeys = (code: string) =>
      def.type === 'custom.model'
        ? parseModelParams(code).specs.map((param) => param.key)
        : parseTrainingSignature(code).params
            .filter((param) => param.hasDefault && param.defaultLiteral !== null)
            .map((param) => param.name)
    const dynamicKeys = new Set([...parseDynamicKeys(staticCode), ...parseDynamicKeys(rawCode)])
    for (const key of dynamicKeys) delete params[key]
    for (const key of parseDynamicKeys(rawCode)) {
      const spec =
        def.type === 'custom.model'
          ? parseModelParams(rawCode).specs.find((param) => param.key === key)
          : undefined
      if (spec && !spec.required) params[key] = spec.default
    }
  }
  if (rawParams) {
    for (const [k, v] of Object.entries(rawParams)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        params[k] = v
      } else if (v !== null && v !== undefined) {
        warnings.push(`节点 ${id} 的参数「${k}」不是基本类型，已忽略`)
      }
    }
  } else {
    warnings.push(`节点 ${id} 没有 params，已使用默认值`)
  }

  const pos = (o.position ?? {}) as Record<string, unknown>
  const position = {
    x: typeof pos.x === 'number' ? pos.x : 80 + index * 60,
    y: typeof pos.y === 'number' ? pos.y : 80 + (index % 4) * 110,
  }

  const node: WorkflowNode = {
    id,
    type,
    label: typeof o.label === 'string' && o.label ? o.label : def.label,
    params,
    ...(o.paramNotes && typeof o.paramNotes === 'object' && !Array.isArray(o.paramNotes)
      ? { paramNotes: Object.fromEntries(
          Object.entries(o.paramNotes).filter(([key, value]) => key && typeof value === 'string' && value.trim()),
        ) as Record<string, string> }
      : {}),
    position,
  }
  if (o.group !== undefined) {
    if (type !== WORKFLOW_GROUP_TYPE) return `节点 ${id} 含 group 定义，但类型不是 ${WORKFLOW_GROUP_TYPE}`
    const group = normalizeGroup(o.group, id, node.label, ctx, warnings, options, groupDepth)
    if (typeof group === 'string') return group
    node.group = group
  } else if (type === WORKFLOW_GROUP_TYPE) {
    return `组块节点「${node.label}」缺少 group 定义`
  }
  if (!options.preserveDatasetIds) rebindDataset(node, o.dataset, ctx, warnings)
  return node
}

function normalizeEdge(
  raw: unknown,
  nodeById: Map<string, WorkflowNode>,
  ctx: PortContext | undefined,
  index: number,
  warnings: string[],
): WorkflowEdge | string {
  /** 取某节点的端口列表；给了 ctx 就走动态解析，否则退回静态注册表 */
  const portsOf = (node: WorkflowNode) => {
    if (ctx) return resolvePorts(node, ctx)
    const def = getNodeTypeDef(node.type)
    return { inputs: def.inputs, outputs: def.outputs }
  }

  // 兼容两种写法：[源, 目标] 或 { source, target, sourcePort, targetPort }
  if (Array.isArray(raw)) {
    const [source, target] = raw as unknown[]
    if (typeof source !== 'string' || typeof target !== 'string') {
      return `第 ${index + 1} 条连线的格式不对`
    }
    const srcNode = nodeById.get(source)
    const dstNode = nodeById.get(target)
    if (!srcNode || !dstNode) {
      return `第 ${index + 1} 条连线引用了不存在的节点（${source} → ${target}）`
    }
    const sourcePort = portsOf(srcNode).outputs[0]?.id ?? 'out'
    const targetPort = portsOf(dstNode).inputs[0]?.id ?? 'in'
    warnings.push(`连线 ${source} → ${target} 未指定端口，已按首端口连接`)
    return { id: makeEdgeId(source, sourcePort, target, targetPort), source, sourcePort, target, targetPort }
  }

  if (!raw || typeof raw !== 'object') return `第 ${index + 1} 条连线不是对象`
  const o = raw as Record<string, unknown>
  const source = typeof o.source === 'string' ? o.source : ''
  const target = typeof o.target === 'string' ? o.target : ''
  if (!source || !target) return `第 ${index + 1} 条连线缺少 source 或 target`

  const srcNode = nodeById.get(source)
  const dstNode = nodeById.get(target)
  if (!srcNode || !dstNode) {
    return `第 ${index + 1} 条连线引用了不存在的节点（${source} → ${target}）`
  }

  const sourcePort =
    typeof o.sourcePort === 'string' && o.sourcePort
      ? o.sourcePort
      : (portsOf(srcNode).outputs[0]?.id ?? 'out')
  const targetPort =
    typeof o.targetPort === 'string' && o.targetPort
      ? o.targetPort
      : (portsOf(dstNode).inputs[0]?.id ?? 'in')

  return { id: makeEdgeId(source, sourcePort, target, targetPort), source, sourcePort, target, targetPort }
}

/**
 * 旧版数据源把每个特征与时间轴单独做成输出端口。新图只保留整表，因此在读文件时
 * 插入一个显式的拆列节点，保住这些连线原来的单列语义；不能等端口清理时再删掉。
 */
function migrateLegacySourceEdges(
  nodes: WorkflowNode[],
  nodeById: Map<string, WorkflowNode>,
  edges: WorkflowEdge[],
  ctx: PortContext | undefined,
  warnings: string[],
): void {
  const groups = new Map<string, { source: WorkflowNode; edges: WorkflowEdge[]; columns: string[] }>()

  for (const edge of edges) {
    const source = nodeById.get(edge.source)
    if (!source || source.type !== 'data.source' || edge.sourcePort === WHOLE_TABLE_PORT) continue

    // 有完整数据视图时，已关闭/不存在的列仍按旧规则视为无效；上下文缺失时则保留，
    // 因为换机器打开工程时无法证明这个旧端口原本无效。
    if (ctx && edge.sourcePort !== TIME_PORT) {
      const datasetId = String(source.params.datasetId ?? '')
      const datasetKnown = !!datasetId && (ctx.hasDataset ? ctx.hasDataset(datasetId) : true)
      if (datasetKnown && !ctx.featuresOf(datasetId).includes(edge.sourcePort)) continue
    }

    const group = groups.get(source.id) ?? { source, edges: [], columns: [] }
    group.edges.push(edge)
    if (!group.columns.includes(edge.sourcePort)) group.columns.push(edge.sourcePort)
    groups.set(source.id, group)
  }

  for (const [sourceId, group] of groups) {
    const baseId = `${sourceId}__legacy_columns`
    let adapterId = baseId
    let suffix = 2
    while (nodeById.has(adapterId)) adapterId = `${baseId}_${suffix++}`

    const source = group.source
    const params = defaultParams(getNodeTypeDef(COLUMNS_TYPE))
    // 旧数据源边缘携带的是实际端口名；迁移节点保留这些名字，保证没有上游摘要时
    // 端口 id 仍能与旧连线对上。共享算子的解析器继续支持这条兼容路径；新建/编辑
    // 拆列节点则使用 1-based 特征索引。
    params.columns = group.columns.join(',')
    const adapter: WorkflowNode = {
      id: adapterId,
      type: COLUMNS_TYPE,
      label: '拆列（旧工程兼容）',
      params,
      position: { x: source.position.x + 260, y: source.position.y },
    }
    nodes.push(adapter)
    nodeById.set(adapterId, adapter)
    edges.push({
      id: makeEdgeId(sourceId, WHOLE_TABLE_PORT, adapterId, 'data'),
      source: sourceId,
      sourcePort: WHOLE_TABLE_PORT,
      target: adapterId,
      targetPort: 'data',
    })

    for (const edge of group.edges) {
      edge.source = adapterId
      edge.id = makeEdgeId(edge.source, edge.sourcePort, edge.target, edge.targetPort)
    }
    warnings.push(
      `数据源「${source.label}」的旧列端口已迁移为「数据源整表 → 拆列 → 下游」；` +
        '原有连线与单列含义已保留',
    )
  }
}

/**
 * 旧版普通图表在节点参数中独立选择数据集。新契约要求数据来源由连线表达：
 * 没有输入边时将旧 datasetId 转成显式数据源节点与连线；已有输入边则以上游为准。
 */
function migrateLegacyChartDatasets(
  nodes: WorkflowNode[],
  nodeById: Map<string, WorkflowNode>,
  edges: WorkflowEdge[],
  ctx: PortContext | undefined,
  warnings: string[],
): void {
  for (const chart of nodes) {
    if (chart.type !== 'viz.chart' || !('datasetId' in chart.params)) continue

    const datasetId = String(chart.params.datasetId ?? '').trim()
    delete chart.params.datasetId
    if (!datasetId) continue

    const hasInput = edges.some((edge) => edge.target === chart.id && edge.targetPort === 'data')
    if (hasInput) {
      warnings.push(`旧图表「${chart.label}」已有上游数据连线；已保留该连线并移除旧的独立数据集设置`)
      continue
    }

    let source = nodes.find(
      (candidate) => candidate.type === 'data.source' && String(candidate.params.datasetId ?? '') === datasetId,
    )
    if (!source) {
      const baseId = `${chart.id}__legacy_source`
      let sourceId = baseId
      let suffix = 2
      while (nodeById.has(sourceId)) sourceId = `${baseId}_${suffix++}`
      const sourceParams = defaultParams(getNodeTypeDef('data.source'))
      sourceParams.datasetId = datasetId
      const datasetName = ctx?.identityOf?.(datasetId)?.name
      source = {
        id: sourceId,
        type: 'data.source',
        label: datasetName ? `数据源：${datasetName}` : '数据源（旧图表兼容）',
        params: sourceParams,
        position: { x: chart.position.x - 260, y: chart.position.y },
      }
      nodes.push(source)
      nodeById.set(source.id, source)
    }

    edges.push({
      id: makeEdgeId(source.id, WHOLE_TABLE_PORT, chart.id, 'data'),
      source: source.id,
      sourcePort: WHOLE_TABLE_PORT,
      target: chart.id,
      targetPort: 'data',
    })
    warnings.push(`旧图表「${chart.label}」的独立数据集已迁移为「${source.label} → ${chart.label}」显式连线`)
  }
}

export interface YamlParseOptions {
  /**
   * 允许**最外层**是一张空图。
   *
   * 默认不允许，而且这个默认是对的：一份"工作流 YAML"里一个节点都没有，就是空文件，
   * 报错比"打开了一份什么都没有"更有用。
   *
   * 但**工程文件**可以合法地没有计算节点 —— 画布批注（便签 / 表格 / 思维图 / 图片）与图是两回事，
   * "我先记两笔，图还没搭"是真实起点。不放开的话，那样一份文件会整个打不开，
   * 连带把里面记的读数一起读不出来。
   *
   * 这条只管最外层：**组块内部**允许为空，见 `normalizeWorkflowDocument` 里的判据。
   */
  allowEmptyNodes?: boolean
  /** 保留节点参数中的数据集 ID；工程打开时由数据边界映射到本机导入 ID。 */
  preserveDatasetIds?: boolean
}

function normalizeWorkflowDocument(
  doc: unknown,
  fallbackId: string,
  ctx: PortContext | undefined,
  options: YamlParseOptions,
  groupDepth: number,
): ParseResult {
  const warnings: string[] = []

  if (!isRecord(doc)) {
    return { error: 'YAML 内容为空或不是对象', warnings }
  }
  const root = doc

  if (!Array.isArray(root.nodes)) {
    return { error: 'YAML 缺少 nodes 列表', warnings }
  }

  const nodes: WorkflowNode[] = []
  for (let i = 0; i < root.nodes.length; i++) {
    const r = normalizeNode(root.nodes[i], i, warnings, ctx, options, groupDepth)
    if (typeof r === 'string') return { error: r, warnings }
    nodes.push(r)
  }
  /*
   * 空图只在**最外层**是错误（理由见 `YamlParseOptions.allowEmptyNodes`）。
   *
   * 组块内部的空图是合法状态，而且是产品造得出来的状态：只放批注的子空间
   * （`createAnnotationGroup` 造出来的 `画布批注` 组块，CANVAS-2）内部就是空的，
   * 把一个组块里的节点删光也一样。这里若照搬最外层那条规则，**导出的文件会读不回来** ——
   * 画布上只要有一个只放批注的组块，那份 YAML 就整个打不开，报
   * 「组块「…」 的内部 workflow 无效：nodes 列表是空的」，而 `.sciviz` 工程那条路
   * （`allowEmptyNodes` 传到了子图）却能开 —— 同一张图两种读法，这种不一致本身就是缺陷。
   */
  if (nodes.length === 0 && groupDepth === 0 && !options?.allowEmptyNodes) {
    return { error: 'nodes 列表是空的', warnings }
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  if (nodeById.size !== nodes.length) return { error: '存在重复的节点 id', warnings }

  const edges: WorkflowEdge[] = []
  if (root.edges !== undefined && !Array.isArray(root.edges)) {
    warnings.push('edges 不是列表，已忽略')
  }
  const rawEdges = Array.isArray(root.edges) ? root.edges : []
  for (let i = 0; i < rawEdges.length; i++) {
    const r = normalizeEdge(rawEdges[i], nodeById, ctx, i, warnings)
    if (typeof r === 'string') return { error: r, warnings }
    edges.push(r)
  }

  /*
   * 旧文件里连到「列拼表」槽位（`col_1…col_N`）的线，改写到现在那个多入端口上。
   *
   * **必须在读入这一步做**，不能留给用户去重连：`pruneInvalidEdges` 会清掉"目标端口
   * 已经不存在"的连线，于是打开一份旧工程就等于把人家接好的线静默删掉 —— 而这正是
   * 这条链路上最不能犯的那类错：它不报错，只是"我接好的线不见了，而且再也长不回来"。
   *
   * 改写后如果两条线变成同一条（同一个来源端口接了两次同一个拼表入口），只保留先来那条
   * 并说出来 —— 静默去重和静默删线是同一类失败。
   */
  {
    // 「列数」这个参数已经不存在了。留着它，打开一份旧工程会先吃一个 E_PARAM_INVALID ——
    // 而那句报错指向的是一个用户根本没填过的东西（它是老版本自动写进去的）
    for (const n of nodes) {
      if (n.type === COLLECT_TYPE && 'slots' in n.params) delete n.params.slots
    }
    const seen = new Set(edges.map((e) => e.id))
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]
      if (nodeById.get(e.target)?.type !== COLLECT_TYPE || !/^col_\d+$/.test(e.targetPort)) continue
      const id = makeEdgeId(e.source, e.sourcePort, e.target, COLLECT_IN_PORT)
      if (seen.has(id)) {
        edges.splice(i--, 1)
        warnings.push(`两条线从「${e.source}:${e.sourcePort}」接到同一个拼表入口，只保留先来的那条`)
        continue
      }
      seen.add(id)
      edges[i] = { ...e, targetPort: COLLECT_IN_PORT, id }
    }
  }

  migrateLegacySourceEdges(nodes, nodeById, edges, ctx, warnings)
  migrateLegacyChartDatasets(nodes, nodeById, edges, ctx, warnings)

  // 连线本该"接不上的那些"也要说清楚，而不是等画布悄悄把它删掉。
  // 这里只解释原因，不改图 —— 端口算不出来的节点（数据源没绑数据集、函数代码还没写好）
  // 保留连线，等用户把上游补齐后它自己就接上了。
  if (ctx) {
    for (const e of edges) {
      const src = nodeById.get(e.source)!
      const dst = nodeById.get(e.target)!
      const attached =
        resolvePorts(src, ctx).outputs.some((p) => p.id === e.sourcePort) &&
        resolvePorts(dst, ctx).inputs.some((p) => p.id === e.targetPort)
      if (attached) continue

      const blocked: string[] = []
      if (!portsTrustworthy(src, ctx)) blocked.push(`「${src.label}」的端口现在还定不下来`)
      if (!portsTrustworthy(dst, ctx)) blocked.push(`「${dst.label}」的端口现在还定不下来`)
      warnings.push(
        `连线「${src.label} → ${dst.label}」暂时接不上（${
          blocked.length > 0
            ? blocked.join('；')
            : `当前端口列表里没有 ${e.sourcePort} → ${e.targetPort}`
        }），已原样保留`,
      )
    }
  }

  /*
   * 组块的对外参数绑定可能已经悬空（封装之后又改了里面那个节点的函数签名）。
   * 留着它会让展开抛异常，而展开在每一轮调度的开头 —— 导入这样一份文件之后，
   * 整张画布一个块都不会再算。删了什么要说出来（与工程文件那条路同一条规矩）。
   */
  const pruned = pruneGroupParameterBindings({
    id: fallbackId,
    name: typeof root.name === 'string' && root.name ? root.name : '未命名工作流',
    description: typeof root.description === 'string' ? root.description : '',
    nodes,
    edges,
  })
  for (const gone of pruned.dropped) {
    warnings.push(
      `组块「${gone.groupLabel}」的参数「${gone.label}」已移除：内部节点里已经没有这个参数了（多半是函数签名改过）`,
    )
  }

  return { workflow: pruned.workflow, warnings }
}

export function yamlToWorkflow(
  text: string,
  fallbackId: string,
  ctx?: PortContext,
  options: YamlParseOptions = {},
): ParseResult {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (e) {
    return { error: `YAML 语法错误：${e instanceof Error ? e.message : String(e)}`, warnings: [] }
  }
  return normalizeWorkflowDocument(doc, fallbackId, ctx, options, 0)
}
