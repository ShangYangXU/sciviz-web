import { makeEdgeId, portsTrustworthy, resolvePorts, type PortContext } from './ports'
import { getNodeTypeDef } from './nodeRegistry'
import type {
  ParamSpec,
  PortSpec,
  Workflow,
  WorkflowEdge,
  WorkflowGroupDefinition,
  WorkflowGroupInput,
  WorkflowGroupParameter,
  WorkflowGroupOutput,
  WorkflowNode,
} from './types'

export const WORKFLOW_GROUP_TYPE = 'workflow.group'

const MAX_GROUP_DEPTH = 32
const EMPTY_PORT_CONTEXT: PortContext = {
  featuresOf: () => [],
  timeColumnOf: () => null,
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function clonePort(port: PortSpec): PortSpec {
  return {
    ...port,
    ...(port.paramSpec
      ? {
          paramSpec: {
            ...port.paramSpec,
            ...(port.paramSpec.options
              ? { options: port.paramSpec.options.map((option) => ({ ...option })) }
              : {}),
          },
        }
      : {}),
  }
}

function cloneParamSpec(spec: ParamSpec): ParamSpec {
  return {
    ...spec,
    ...(spec.options ? { options: spec.options.map((option) => ({ ...option })) } : {}),
  }
}

function cloneGroup(group: WorkflowGroupDefinition, depth = 0): WorkflowGroupDefinition {
  if (depth > MAX_GROUP_DEPTH) {
    throw new Error(`组块嵌套超过最大深度 ${MAX_GROUP_DEPTH}，无法安全复制工作流`)
  }
  return {
    workflow: cloneWorkflow(group.workflow, depth),
    inputs: group.inputs.map((input) => ({ ...input, port: clonePort(input.port) })),
    outputs: group.outputs.map((output) => ({ ...output, port: clonePort(output.port) })),
    parameters: group.parameters.map((parameter) => ({
      ...parameter,
      spec: cloneParamSpec(parameter.spec),
    })),
  }
}

/**
 * 深拷贝一个节点（组块连内联子图、边界映射与参数绑定一起复制）。
 *
 * 导出的理由只有一个：**"怎么算把一个块复制干净"只该有一处实现**。组块的封装、解散、
 * 展开与剪贴板粘贴都要它；各写一份的后果是"某一条路漏拷了 group 里的某个字段"，
 * 而那表现为粘贴出来的组块看起来一样、跑起来不一样。
 */
export function cloneWorkflowNode(node: WorkflowNode, depth = 0): WorkflowNode {
  return {
    ...node,
    params: { ...node.params },
    ...(node.paramNotes ? { paramNotes: { ...node.paramNotes } } : {}),
    position: { ...node.position },
    ...(node.group ? { group: cloneGroup(node.group, depth) } : {}),
  }
}

function cloneWorkflow(workflow: Workflow, depth = 0): Workflow {
  if (depth > MAX_GROUP_DEPTH) {
    throw new Error(`组块嵌套超过最大深度 ${MAX_GROUP_DEPTH}，无法安全复制工作流`)
  }
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => cloneWorkflowNode(node, depth)),
    edges: workflow.edges.map((edge) => ({ ...edge })),
  }
}

function endpointKey(nodeId: string, portId: string): string {
  return JSON.stringify([nodeId, portId])
}

function boundaryPortId(direction: 'input' | 'output', nodeId: string, portId: string): string {
  return `${direction}:${encodeURIComponent(nodeId)}:${encodeURIComponent(portId)}`
}

function parameterKey(nodeId: string, paramKey: string): string {
  return `param:${encodeURIComponent(nodeId)}:${encodeURIComponent(paramKey)}`
}

function clonePortWithId(port: PortSpec, id: string, label: string): PortSpec {
  return { ...clonePort(port), id, label }
}

function cloneBoundaryInputPort(port: PortSpec, id: string, label: string): PortSpec {
  const boundary = clonePort(port)
  // 内部参数端口映射到 boundary 时是普通连接句柄；公开的组参数由参数映射另行提供。
  delete boundary.kind
  delete boundary.paramKey
  delete boundary.paramSpec
  return { ...boundary, id, label }
}

function collectParameterSpecs(
  node: WorkflowNode,
  ctx: PortContext,
): ParamSpec[] {
  // 嵌套组块的参数继续作为当前子图里的可提升参数。
  if (node.type === WORKFLOW_GROUP_TYPE) {
    if (!node.group) throw new Error(`组块节点「${node.id}」缺少 group 定义`)
    return node.group.parameters.map((parameter) => cloneParamSpec(parameter.spec))
  }

  const byKey = new Map<string, ParamSpec>()
  for (const spec of getNodeTypeDef(node.type).params) {
    if (spec.type !== 'code' && spec.key !== 'code') byKey.set(spec.key, cloneParamSpec(spec))
  }
  for (const port of resolvePorts(node, ctx).inputs) {
    const spec = port.paramSpec
    if (port.kind === 'param' && spec && spec.type !== 'code' && spec.key !== 'code') {
      byKey.set(port.paramKey ?? spec.key, cloneParamSpec({ ...spec, key: port.paramKey ?? spec.key }))
    }
  }
  return [...byKey.values()]
}

/**
 * 将所选节点封装成一个复合节点。
 * 输入会包含实际跨入连线以及当前未连接的数据端口；输出会包含跨出连线以及未被子图消费的输出端口。
 */
export function createGroupFromSelection(
  workflow: Workflow,
  selectedNodeIds: Iterable<string>,
  ctx: PortContext,
  groupId: string,
  label?: string,
): { workflow: Workflow; node: WorkflowNode } {
  if (!groupId.trim()) throw new Error('组块 id 不能为空')
  const selected = new Set(selectedNodeIds)
  if (selected.size === 0) throw new Error('至少选择一个节点才能创建组块')

  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]))
  if (nodeById.size !== workflow.nodes.length) throw new Error('工作流存在重复的节点 id，无法创建组块')
  for (const edge of workflow.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      throw new Error(`无法封装：连线「${edge.id}」引用了不存在的节点`)
    }
  }
  for (const id of selected) {
    if (!nodeById.has(id)) throw new Error(`所选节点「${id}」不存在`)
  }
  if (workflow.nodes.some((node) => !selected.has(node.id) && node.id === groupId)) {
    throw new Error(`组块 id「${groupId}」与现有节点冲突`)
  }

  const selectedNodes = workflow.nodes.filter((node) => selected.has(node.id))
  const selectedPorts = new Map(
    selectedNodes.map((node) => [node.id, resolvePorts(node, ctx)]),
  )
  const inputBindings = new Map<string, WorkflowGroupInput>()
  const outputBindings = new Map<string, WorkflowGroupOutput>()

  const inputBindingFor = (nodeId: string, port: PortSpec): WorkflowGroupInput => {
    const key = endpointKey(nodeId, port.id)
    let binding = inputBindings.get(key)
    if (!binding) {
      const id = boundaryPortId('input', nodeId, port.id)
      const node = nodeById.get(nodeId)!
      const bindingLabel = `${node.label} · ${port.label}`
      binding = {
        id,
        label: bindingLabel,
        port: cloneBoundaryInputPort(port, id, bindingLabel),
        targetNodeId: nodeId,
        targetPortId: port.id,
      }
      inputBindings.set(key, binding)
    }
    return binding
  }

  const outputBindingFor = (nodeId: string, port: PortSpec): WorkflowGroupOutput => {
    const key = endpointKey(nodeId, port.id)
    let binding = outputBindings.get(key)
    if (!binding) {
      const id = boundaryPortId('output', nodeId, port.id)
      const node = nodeById.get(nodeId)!
      const bindingLabel = `${node.label} · ${port.label}`
      binding = {
        id,
        label: bindingLabel,
        port: clonePortWithId(port, id, bindingLabel),
        sourceNodeId: nodeId,
        sourcePortId: port.id,
      }
      outputBindings.set(key, binding)
    }
    return binding
  }

  // 已存在的跨界连线必须逐条映射到唯一的内部端点。
  for (const edge of workflow.edges) {
    const sourceInside = selected.has(edge.source)
    const targetInside = selected.has(edge.target)
    if (sourceInside === targetInside) continue
    if (targetInside) {
      const port = selectedPorts.get(edge.target)?.inputs.find((candidate) => candidate.id === edge.targetPort)
      if (!port) throw new Error(`无法封装：节点「${edge.target}」没有输入端口「${edge.targetPort}」`)
      inputBindingFor(edge.target, port)
    } else {
      const port = selectedPorts.get(edge.source)?.outputs.find((candidate) => candidate.id === edge.sourcePort)
      if (!port) throw new Error(`无法封装：节点「${edge.source}」没有输出端口「${edge.sourcePort}」`)
      outputBindingFor(edge.source, port)
    }
  }

  // 未连接的数据输入仍然公开，用户封装后还能从组块外接入数据。
  for (const node of selectedNodes) {
    for (const port of selectedPorts.get(node.id)!.inputs) {
      if (port.kind === 'param') continue
      const alreadyConnectedInside = workflow.edges.some(
        (edge) => edge.target === node.id && edge.targetPort === port.id && selected.has(edge.source),
      )
      if (!alreadyConnectedInside) inputBindingFor(node.id, port)
    }
  }

  // 未在子图里消费的输出也公开，方便封装后再接下游。
  for (const node of selectedNodes) {
    for (const port of selectedPorts.get(node.id)!.outputs) {
      const consumedInside = workflow.edges.some(
        (edge) => edge.source === node.id && edge.sourcePort === port.id && selected.has(edge.target),
      )
      if (!consumedInside) outputBindingFor(node.id, port)
    }
  }

  const connectedParamKeys = new Map<string, Set<string>>()
  for (const node of selectedNodes) {
    const keys = new Set<string>()
    const parameterPorts = selectedPorts.get(node.id)!.inputs.filter((port) => port.kind === 'param')
    for (const edge of workflow.edges) {
      if (edge.target !== node.id) continue
      const port = parameterPorts.find((candidate) => candidate.id === edge.targetPort)
      if (port) keys.add(port.paramKey ?? edge.targetPort)
    }
    connectedParamKeys.set(node.id, keys)
  }

  const parameters: WorkflowGroupDefinition['parameters'] = []
  const groupParams: WorkflowNode['params'] = {}
  for (const node of selectedNodes) {
    for (const spec of collectParameterSpecs(node, ctx)) {
      if (spec.type === 'code' || spec.key === 'code') continue
      if (connectedParamKeys.get(node.id)?.has(spec.key)) continue
      const key = parameterKey(node.id, spec.key)
      const currentValue = node.params[spec.key]
      const initialValue = isScalar(currentValue) ? currentValue : spec.default
      const exposedSpec = { ...cloneParamSpec(spec), key, default: initialValue }
      const exposedLabel = `${node.label} · ${spec.label}`
      parameters.push({
        key,
        label: exposedLabel,
        nodeId: node.id,
        paramKey: spec.key,
        spec: exposedSpec,
      })
      // 对函数必填形参，签名解析出来的 `default` 只是控件占位；原参数缺失时不能把占位值
      // 写成字面量，否则展开后会把“未填写”伪装成“传了空字符串/0”。
      if (isScalar(currentValue) || !spec.required) groupParams[key] = initialValue
    }
  }

  const internalNodes = selectedNodes.map((node) => cloneWorkflowNode(node))
  const internalEdges = workflow.edges
    .filter((edge) => selected.has(edge.source) && selected.has(edge.target))
    .map((edge) => ({ ...edge }))
  const childWorkflow: Workflow = {
    id: `${workflow.id}::${groupId}`,
    name: label?.trim() || selectedNodes.map((node) => node.label).join(' / '),
    description: '',
    nodes: internalNodes,
    edges: internalEdges,
  }
  const group: WorkflowGroupDefinition = {
    workflow: childWorkflow,
    inputs: [...inputBindings.values()],
    outputs: [...outputBindings.values()],
    parameters,
  }

  const position = {
    x: selectedNodes.reduce((sum, node) => sum + node.position.x, 0) / selectedNodes.length,
    y: selectedNodes.reduce((sum, node) => sum + node.position.y, 0) / selectedNodes.length,
  }
  const groupNode: WorkflowNode = {
    id: groupId,
    type: WORKFLOW_GROUP_TYPE,
    label: label?.trim() || childWorkflow.name || '组块',
    params: groupParams,
    position,
    group,
  }

  const edges: WorkflowEdge[] = []
  for (const edge of workflow.edges) {
    const sourceInside = selected.has(edge.source)
    const targetInside = selected.has(edge.target)
    if (sourceInside && targetInside) continue
    if (!sourceInside && !targetInside) {
      edges.push({ ...edge })
      continue
    }
    if (targetInside) {
      const binding = inputBindings.get(endpointKey(edge.target, edge.targetPort))
      if (!binding) throw new Error(`无法映射进入组块的连线「${edge.id}」`)
      edges.push({
        id: makeEdgeId(edge.source, edge.sourcePort, groupId, binding.id),
        source: edge.source,
        sourcePort: edge.sourcePort,
        target: groupId,
        targetPort: binding.id,
      })
    } else {
      const binding = outputBindings.get(endpointKey(edge.source, edge.sourcePort))
      if (!binding) throw new Error(`无法映射离开组块的连线「${edge.id}」`)
      edges.push({
        id: makeEdgeId(groupId, binding.id, edge.target, edge.targetPort),
        source: groupId,
        sourcePort: binding.id,
        target: edge.target,
        targetPort: edge.targetPort,
      })
    }
  }

  const nodes: WorkflowNode[] = []
  let inserted = false
  for (const node of workflow.nodes) {
    if (!selected.has(node.id)) {
      nodes.push(cloneWorkflowNode(node))
    } else if (!inserted) {
      nodes.push(groupNode)
      inserted = true
    }
  }
  return { workflow: { ...workflow, nodes, edges }, node: groupNode }
}

/** 创建一个没有计算节点的子空间，用来收纳纯画布批注。 */
export function createAnnotationGroup(
  workflow: Workflow,
  groupId: string,
  position: { x: number; y: number },
): { workflow: Workflow; node: WorkflowNode } {
  if (!groupId.trim()) throw new Error('组块 id 不能为空')
  if (workflow.nodes.some((node) => node.id === groupId)) throw new Error(`组块 id「${groupId}」与现有节点冲突`)
  const childWorkflow: Workflow = {
    id: `${workflow.id}::${groupId}`,
    name: '画布批注',
    description: '',
    nodes: [],
    edges: [],
  }
  const node: WorkflowNode = {
    id: groupId,
    type: WORKFLOW_GROUP_TYPE,
    label: '批注组块',
    params: {},
    position: { ...position },
    group: { workflow: childWorkflow, inputs: [], outputs: [], parameters: [] },
  }
  return { workflow: { ...workflow, nodes: [...workflow.nodes, node] }, node }
}

/** 根图节点保留原 id；组内节点使用可重复计算的路径命名空间。 */
export function runtimeNodeIdForPath(path: readonly string[], nodeId: string): string {
  return path.length === 0 ? nodeId : `group:${JSON.stringify(path)}:${JSON.stringify(nodeId)}`
}

/**
 * 一棵子树从旧层级搬到新层级时，里面每个节点的运行时 id 对照（旧 → 新）。
 *
 * 存在的理由：**按运行时 id 归属的东西必须跟着块走**。`.sciviz` 的模型制品引用就是按
 * 运行时 id 存的，而封装、解散、再嵌一层都会让内部节点的运行时 id 变（`n16` →
 * `group:["g1"]:"n16"`）。不搬的话，"训练一次就好了"只在节点一动不动时成立 ——
 * 用户把训好的块组合起来，权重就再也读不到了。
 *
 * 复制粘贴同样要搬：粘出来的块是新 id，但内容（代码、参数、上游身份）常常一模一样，
 * 指纹也就一样 —— 那份权重本来就是这个计算的结果。指纹对不上时引用自然不生效，
 * 所以这里只需要把对照关系给出来。
 *
 * 与批注的 `groupPath` 是同一条纪律（FILE-1）：结构变了，跟着层级走的东西一起更新。
 */
export function runtimeIdMoves(
  node: WorkflowNode,
  from: readonly string[],
  to: readonly string[],
  /**
   * 这一支里节点的 id 是否变了（粘贴会给新块发新 id；组内节点的 id 不变，
   * 它们的新位置由组路径表达）。默认谁也不改。
   */
  rename: (nodeId: string) => string = (nodeId) => nodeId,
): Map<string, string> {
  const moves = new Map<string, string>()
  const walk = (current: WorkflowNode, fromPath: readonly string[], toPath: readonly string[]): void => {
    const toId = rename(current.id)
    moves.set(runtimeNodeIdForPath(fromPath, current.id), runtimeNodeIdForPath(toPath, toId))
    for (const child of current.group?.workflow.nodes ?? []) {
      /*
       * 子节点的新路径要带**改名后**的父 id：粘贴一个组块时组块自己的 id 会换
       * （`rename`），而组内节点的 id 不变 —— 它们的层级由路径表达。此前这里两边都写
       * `current.id`，于是副本里每个内部节点的"新运行时 id"都指着一个不存在的组块
       * （`group:["旧组 id"]:…`），按运行时 id 归属的制品引用跟着落到空处 ——
       * 症状是"复制一份训好的子空间，副本里的训练块再也读不到自己的权重"。
       */
      walk(child, [...fromPath, current.id], [...toPath, toId])
    }
  }
  walk(node, [...from], [...to])
  return moves
}

/**
 * 图里每个节点 id（不带组路径）→ 它此刻的运行时 id 列表。
 *
 * 用途只有一个：把老工程里"写的是节点 id / 旧路径"的制品引用重新对上 ——
 * 节点在组块里的**身份**始终是那个节点 id，组路径只是它此刻所在的位置。
 * 同一份图里节点 id 应当唯一；真撞上了就返回多条，调用方按"有歧义就不猜"处理。
 *
 * 入参必须是**带 `group` 子图的图**，不是 `expandWorkflowGroups` 展开后的那张 ——
 * 展开后的节点 id 本身就已经是运行时 id 了，剥不出身份。
 */
export function runtimeIdsByNodeId(workflow: Workflow): Map<string, string[]> {
  const index = new Map<string, string[]>()
  const walk = (current: Workflow, path: readonly string[]): void => {
    for (const node of current.nodes) {
      const runtimeId = runtimeNodeIdForPath(path, node.id)
      index.set(node.id, [...(index.get(node.id) ?? []), runtimeId])
      if (node.group) walk(node.group.workflow, [...path, node.id])
    }
  }
  walk(workflow, [])
  return index
}

/**
 * 从运行时 id 里取回节点 id（取不出来返回 null）。
 *
 * 只做一件事：剥掉 `group:["路径"]:` 这一段。取不出来就不取 —— 调用方据此放弃修复，
 * 而不是拿半截字符串去猜一个节点。
 */
export function nodeIdFromRuntimeId(runtimeId: string): string | null {
  if (!runtimeId) return null
  if (!runtimeId.startsWith('group:')) return runtimeId
  const cut = runtimeId.lastIndexOf(']:')
  if (cut < 0) return null
  try {
    const nodeId = JSON.parse(runtimeId.slice(cut + 2))
    return typeof nodeId === 'string' && nodeId ? nodeId : null
  } catch {
    return null
  }
}

/**
 * 从根图沿组块路径取当前编辑子图；路径上有节点不存在时，安全回到最近可用的那一层。
 *
 * 放在这里而不是 store 里：路径遍历是"组块怎么嵌套"的一部分，而 store 与
 * 参数写入都要用它。两处各写一份的结果是"某一处忘了某个边界情况"。
 */
export function workflowAtGroupPath(root: Workflow, path: readonly string[]): Workflow {
  let current = root
  for (const id of path) {
    const child = current.nodes.find((node) => node.id === id)?.group?.workflow
    if (!child) break
    current = child
  }
  return current
}

/** 在当前编辑子图上做一次替换，返回新的**根**图（其余层级原样保留）。 */
export function replaceWorkflowAtGroupPath(
  root: Workflow,
  path: readonly string[],
  update: (workflow: Workflow) => Workflow,
): Workflow {
  if (path.length === 0) return update(root)
  const [head, ...tail] = path
  return {
    ...root,
    nodes: root.nodes.map((node) => {
      if (node.id !== head || !node.group) return node
      return {
        ...node,
        group: {
          ...node.group,
          workflow: replaceWorkflowAtGroupPath(node.group.workflow, tail, update),
        },
      }
    }),
  }
}

interface ParamWrite {
  path: string[]
  nodeId: string
  key: string
  value: string | number | boolean
}

/**
 * 除"当前编辑层这一处"之外，一次参数编辑还要落到哪些地方。
 *
 * 组块的公开参数（组节点上的 `param:<内部节点 id>:<键>`）与内部节点自己的那份是
 * **同一个值的两个视图**（规格 R15.3：执行时以组实例的公开值为准）。两边分开写就会
 * 出现"看着改了、引擎拿到的还是旧值"：在子图里改内部节点，改的是被覆盖的那一份；
 * 在组块面板上改公开值，内部那份又留着旧数。所以一次编辑要对齐整条链：
 *
 * - **向下**：改的是组块的公开参数时，顺着参数绑定把内部节点（可能又是组块）的副本一起改；
 * - **向上**：改的节点位于组块里、而外层组块公开了这个参数时，把外层那份一并改写。
 *
 * 两层都不需要"偷偷传播"：绑定本身就是一张明确的映射表，链上每一跳都查得到。
 */
function mirrorParamWrites(
  root: Workflow,
  path: readonly string[],
  nodeId: string,
  key: string,
  value: string | number | boolean,
): ParamWrite[] {
  const writes: ParamWrite[] = []

  let downPath = [...path]
  let downId = nodeId
  let downKey = key
  for (;;) {
    const node = workflowAtGroupPath(root, downPath).nodes.find((entry) => entry.id === downId)
    const parameter =
      node?.type === WORKFLOW_GROUP_TYPE
        ? node.group?.parameters.find((entry) => entry.key === downKey)
        : undefined
    if (!parameter) break
    downPath = [...downPath, downId]
    downId = parameter.nodeId
    downKey = parameter.paramKey
    writes.push({ path: downPath, nodeId: downId, key: downKey, value })
  }

  let childId = nodeId
  let childKey = key
  for (let level = path.length - 1; level >= 0; level -= 1) {
    const groupId = path[level]
    const exposedKey = parameterKey(childId, childKey)
    const group = workflowAtGroupPath(root, path.slice(0, level)).nodes.find(
      (node) => node.id === groupId,
    )
    const parameter = group?.group?.parameters.find((entry) => entry.key === exposedKey)
    if (!parameter) break
    writes.push({ path: path.slice(0, level), nodeId: groupId, key: exposedKey, value })
    childId = groupId
    childKey = exposedKey
  }

  return writes
}

/**
 * 改一个节点的一组参数，并把被组块公开的那些副本一起对齐。
 *
 * `replace` 为真时整份替换（用于"参数由代码签名推导"的节点：签名里删掉的参数必须
 * 真的消失），否则按键合并。
 */
export function setWorkflowParams(
  root: Workflow,
  path: readonly string[],
  nodeId: string,
  params: Record<string, string | number | boolean>,
  options: { replace?: boolean } = {},
): Workflow {
  const replace = options.replace === true
  let next = replaceWorkflowAtGroupPath(root, path, (graph) => ({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? { ...node, params: replace ? { ...params } : { ...node.params, ...params } }
        : node,
    ),
  }))
  for (const [key, value] of Object.entries(params)) {
    for (const write of mirrorParamWrites(root, path, nodeId, key, value)) {
      next = replaceWorkflowAtGroupPath(next, write.path, (graph) => ({
        ...graph,
        nodes: graph.nodes.map((node) =>
          node.id === write.nodeId
            ? { ...node, params: { ...node.params, [write.key]: write.value } }
            : node,
        ),
      }))
    }
  }
  /*
   * 改完顺手清一遍悬空的组块对外绑定：改的可能正是某个节点的 `code`
   * （`custom.script` / `custom.chart` 的参数来自签名），签名里删掉一个参数之后，
   * 外层那条绑定就悬空了 —— 而它会**抛异常**，症状是"改完代码，整张画布再也不算了"。
   */
  return pruneGroupParameterBindings(next).workflow
}

/** 改一个参数值。见 `setWorkflowParams`。 */
export function setWorkflowParam(
  root: Workflow,
  path: readonly string[],
  nodeId: string,
  key: string,
  value: string | number | boolean,
): Workflow {
  return setWorkflowParams(root, path, nodeId, { [key]: value })
}

/**
 * 把组块公开参数的值对齐到内部节点的副本上（逐层递归，**自上而下**）。
 *
 * 用在读工程文件那一步：文件可能是手改的，也可能是旧编辑器写的 —— 那时候在子图里
 * 改参数只改了内部副本，执行时却被组块公开值覆盖，于是文件里两处值不一样。
 * 执行时生效的一直是公开值（R15.3），所以对齐方向是**公开值 → 内部副本**；
 * 反过来会拿一个从未生效过的值去改图的结果。
 */
export function syncGroupParameterMirrors(workflow: Workflow): Workflow {
  // 先清掉悬空的对外绑定，再对齐值 —— 两件事的顺序不能反：悬空绑定的值没有对应的
  // 内部参数可写，先在"哪些绑定还算数"这一步把它去掉，后面才对得准
  return mirrorGroupParameterValues(pruneGroupParameterBindings(workflow).workflow)
}

/** 被清掉的一条组块对外参数绑定（交给调用方报告，不静默） */
export interface DroppedGroupParameter {
  groupId: string
  groupLabel: string
  key: string
  label: string
  nodeId: string
  paramKey: string
}

/**
 * 清掉"内部已经没有这个参数了"的组块对外参数绑定。
 *
 * 什么时候会变成这样：把一个块封装成组块之后，又改了里面那个节点的函数签名
 * （`custom.script` / `custom.chart` 这类节点的参数来自代码签名），旧的对外绑定就悬空了。
 * 它必须在**读入 / 改完**这一步清掉，不能留到执行时：`assertGroupBindings` 会抛异常，
 * 而展开发生在每一轮调度的开头 —— 于是一条悬空绑定就让**整张画布再也算不出任何结果**，
 * 而界面上什么都不说（只在控制台留下一条未处理的异常）。实测就是这么发生的：
 * 打开一份工程，所有的块停在空状态，谁也看不出是哪个组块的哪一条绑定。
 *
 * 判据只看"内部那个节点现在还声明不声明这个参数"：绑定连同它在外层的那个值一起删，
 * 免得文件里留着一个界面上根本不存在的参数。
 */
export function pruneGroupParameterBindings(workflow: Workflow): {
  workflow: Workflow
  dropped: DroppedGroupParameter[]
} {
  const dropped: DroppedGroupParameter[] = []

  const pruneLevel = (current: Workflow): Workflow => ({
    ...current,
    nodes: current.nodes.map((node) => {
      if (node.type !== WORKFLOW_GROUP_TYPE || !node.group) return node
      // 先修里面那一层：外层绑定的判据要看内层**修好之后**的声明
      const inner = pruneLevel(node.group.workflow)
      const innerById = new Map(inner.nodes.map((entry) => [entry.id, entry]))
      const kept: WorkflowGroupParameter[] = []
      let params = node.params
      let changed = false
      for (const parameter of node.group.parameters) {
        const target = innerById.get(parameter.nodeId)
        if (target && nodeDeclaresParameter(target, parameter.paramKey)) {
          kept.push(parameter)
          continue
        }
        changed = true
        dropped.push({
          groupId: node.id,
          groupLabel: node.label,
          key: parameter.key,
          label: parameter.label,
          nodeId: parameter.nodeId,
          paramKey: parameter.paramKey,
        })
        if (params[parameter.key] !== undefined) {
          const next = { ...params }
          delete next[parameter.key]
          params = next
        }
      }
      if (!changed) return { ...node, group: { ...node.group, workflow: inner } }
      return { ...node, params, group: { ...node.group, workflow: inner, parameters: kept } }
    }),
  })

  return { workflow: pruneLevel(workflow), dropped }
}

function mirrorGroupParameterValues(workflow: Workflow): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (node.type !== WORKFLOW_GROUP_TYPE || !node.group) return node
      const mirrors = new Map<string, Record<string, { value: string | number | boolean; declaredDefault: string | number | boolean }>>()
      for (const parameter of node.group.parameters) {
        if (parameter.spec.required && node.params[parameter.key] === undefined) continue
        const value = node.params[parameter.key] ?? parameter.spec.default
        if (!isScalar(value)) continue
        const bucket = mirrors.get(parameter.nodeId) ?? {}
        bucket[parameter.paramKey] = { value, declaredDefault: parameter.spec.default }
        mirrors.set(parameter.nodeId, bucket)
      }
      const mirrored: Workflow = {
        ...node.group.workflow,
        nodes: node.group.workflow.nodes.map((inner) => {
          const bucket = mirrors.get(inner.id)
          if (!bucket) return inner
          let params = inner.params
          for (const [key, entry] of Object.entries(bucket)) {
            // 与展开时同一条判据：只有会改变有效值的才写（默认值与"缺失"是同一个状态）
            if (!paramWriteChangesValue(params[key], entry.value, entry.declaredDefault)) continue
            params = { ...params, [key]: entry.value }
          }
          return params === inner.params ? inner : { ...inner, params }
        }),
      }
      return {
        ...node,
        group: { ...node.group, workflow: mirrorGroupParameterValues(mirrored) },
      }
    }),
  }
}

function groupDefinition(node: WorkflowNode): WorkflowGroupDefinition {
  if (node.type !== WORKFLOW_GROUP_TYPE) {
    throw new Error(`节点「${node.id}」携带了组块定义，但类型不是 ${WORKFLOW_GROUP_TYPE}`)
  }
  if (!node.group) throw new Error(`组块节点「${node.id}」缺少 group 定义`)
  if (!Array.isArray(node.group.inputs) || !Array.isArray(node.group.outputs) || !Array.isArray(node.group.parameters)) {
    throw new Error(`组块节点「${node.id}」的端口或参数映射格式不正确`)
  }
  return node.group
}

function nodeDeclaresParameter(node: WorkflowNode, paramKey: string): boolean {
  if (node.type === WORKFLOW_GROUP_TYPE) {
    return !!node.group?.parameters.some((parameter) => parameter.key === paramKey)
  }
  if (getNodeTypeDef(node.type).params.some((parameter) => parameter.key === paramKey)) return true
  return resolvePorts(node, EMPTY_PORT_CONTEXT).inputs.some(
    (port) => port.kind === 'param' && (port.paramKey ?? port.id) === paramKey,
  )
}

function assertUniqueNodeIds(workflow: Workflow, scope: string): Map<string, WorkflowNode> {
  const nodes = new Map<string, WorkflowNode>()
  for (const node of workflow.nodes) {
    if (!node.id || nodes.has(node.id)) throw new Error(`${scope}存在空或重复的节点 id「${node.id}」`)
    if (node.group && node.type !== WORKFLOW_GROUP_TYPE) {
      throw new Error(`节点「${node.id}」携带了组块定义，但类型不是 ${WORKFLOW_GROUP_TYPE}`)
    }
    nodes.set(node.id, node)
  }
  return nodes
}

function assertGroupBindings(
  node: WorkflowNode,
  nodes: Map<string, WorkflowNode>,
  ctx: PortContext,
): WorkflowGroupDefinition {
  const group = groupDefinition(node)
  if (!group.workflow || !Array.isArray(group.workflow.nodes) || !Array.isArray(group.workflow.edges)) {
    throw new Error(`组块节点「${node.id}」缺少有效的内部工作流`)
  }
  const childNodes = assertUniqueNodeIds(group.workflow, `组块「${node.label}」内部`)
  for (const edge of group.workflow.edges) {
    if (!childNodes.has(edge.source) || !childNodes.has(edge.target)) {
      throw new Error(`组块「${node.label}」内部连线「${edge.id}」引用了不存在的节点`)
    }
  }

  const inputIds = new Set<string>()
  const allInputPortIds = new Set<string>()
  for (const input of group.inputs) {
    if (!input.id || inputIds.has(input.id)) throw new Error(`组块「${node.label}」存在空或重复的输入端口 id「${input.id}」`)
    inputIds.add(input.id)
    allInputPortIds.add(input.id)
    if (!childNodes.has(input.targetNodeId)) {
      throw new Error(`组块「${node.label}」的输入「${input.label}」引用了不存在的内部节点「${input.targetNodeId}」`)
    }
    if (!input.targetPortId) throw new Error(`组块「${node.label}」的输入「${input.label}」缺少内部端口 id`)
    // 内部目标若本身是组块，继续核对它公开了这个输入映射。
    const targetNode = childNodes.get(input.targetNodeId)!
    resolveInputEndpoint(targetNode, input.targetPortId, [], 1)
    const targetPort = resolvePorts(targetNode, ctx).inputs.find((port) => port.id === input.targetPortId)
    if (!targetPort && portsTrustworthy(targetNode, ctx)) {
      throw new Error(`组块「${node.label}」的输入「${input.label}」引用了不存在的内部端口「${input.targetPortId}」`)
    }
    if (targetPort && input.port.type !== targetPort.type) {
      throw new Error(`组块「${node.label}」的输入「${input.label}」类型与内部端口不一致`)
    }
  }
  const outputIds = new Set<string>()
  for (const output of group.outputs) {
    if (!output.id || outputIds.has(output.id)) {
      throw new Error(`组块「${node.label}」存在空或重复的输出端口 id「${output.id}」`)
    }
    outputIds.add(output.id)
    if (!childNodes.has(output.sourceNodeId)) {
      throw new Error(`组块「${node.label}」的输出「${output.label}」引用了不存在的内部节点「${output.sourceNodeId}」`)
    }
    if (!output.sourcePortId) throw new Error(`组块「${node.label}」的输出「${output.label}」缺少内部端口 id`)
    // 内部来源若本身是组块，继续核对它公开了这个输出映射。
    const sourceNode = childNodes.get(output.sourceNodeId)!
    resolveOutputEndpoint(sourceNode, output.sourcePortId, [], 1)
    const sourcePort = resolvePorts(sourceNode, ctx).outputs.find((port) => port.id === output.sourcePortId)
    if (!sourcePort && portsTrustworthy(sourceNode, ctx)) {
      throw new Error(`组块「${node.label}」的输出「${output.label}」引用了不存在的内部端口「${output.sourcePortId}」`)
    }
    if (sourcePort && sourcePort.type !== output.port.type) {
      throw new Error(`组块「${node.label}」的输出「${output.label}」类型与内部端口不一致`)
    }
  }
  const parameterKeys = new Set<string>()
  for (const parameter of group.parameters) {
    if (!parameter.key || parameterKeys.has(parameter.key)) {
      throw new Error(`组块「${node.label}」存在空或重复的参数 key「${parameter.key}」`)
    }
    parameterKeys.add(parameter.key)
    if (allInputPortIds.has(parameter.key)) {
      throw new Error(`组块「${node.label}」的参数「${parameter.key}」与数据输入端口 id 冲突`)
    }
    allInputPortIds.add(parameter.key)
    if (!childNodes.has(parameter.nodeId)) {
      throw new Error(`组块「${node.label}」的参数「${parameter.label}」引用了不存在的内部节点「${parameter.nodeId}」`)
    }
    if (!nodeDeclaresParameter(childNodes.get(parameter.nodeId)!, parameter.paramKey)) {
      throw new Error(`组块「${node.label}」的参数「${parameter.label}」引用了不存在的内部参数「${parameter.paramKey}」`)
    }
    if (!parameter.paramKey || !parameter.spec || !isScalar(parameter.spec.default)) {
      throw new Error(`组块「${node.label}」的参数「${parameter.label}」定义不完整`)
    }
    const targetNode = childNodes.get(parameter.nodeId)!
    const targetSpec = collectParameterSpecs(targetNode, ctx).find((spec) => spec.key === parameter.paramKey)
    if (!targetSpec) {
      throw new Error(`组块「${node.label}」的参数「${parameter.label}」引用了不存在的内部参数「${parameter.paramKey}」`)
    }
    if (
      targetSpec.type !== parameter.spec.type ||
      targetSpec.required !== parameter.spec.required ||
      targetSpec.min !== parameter.spec.min ||
      targetSpec.max !== parameter.spec.max ||
      targetSpec.step !== parameter.spec.step ||
      JSON.stringify(targetSpec.options ?? []) !== JSON.stringify(parameter.spec.options ?? [])
    ) {
      throw new Error(`组块「${node.label}」的参数「${parameter.label}」与内部参数定义不一致`)
    }
    if (node.params[parameter.key] !== undefined && !isScalar(node.params[parameter.key])) {
      throw new Error(`组块「${node.label}」的参数「${parameter.label}」不是基本类型`)
    }
  }
  // Guard against unused group definitions that point at a parent node by mistake.
  if (!nodes.has(node.id)) throw new Error(`组块节点「${node.id}」不属于当前工作流`)
  return group
}

function childWorkflowWithGroupParams(
  node: WorkflowNode,
  group: WorkflowGroupDefinition,
  wiredParameterKeys: ReadonlySet<string> = new Set(),
): Workflow {
  const child = cloneWorkflow(group.workflow)
  const childById = new Map(child.nodes.map((inner) => [inner.id, inner]))
  for (const parameter of group.parameters) {
    // 连线绑定优先于组块字段值。跳过字面量复制后，展开边会直接驱动内部参数端口。
    if (wiredParameterKeys.has(parameter.key)) continue
    if (parameter.spec.required && node.params[parameter.key] === undefined) continue
    const target = childById.get(parameter.nodeId)
    if (!target) throw new Error(`组块「${node.label}」的参数「${parameter.label}」引用了不存在的内部节点「${parameter.nodeId}」`)
    const value = node.params[parameter.key] ?? parameter.spec.default
    if (!isScalar(value)) throw new Error(`组块「${node.label}」的参数「${parameter.label}」不是基本类型`)
    if (paramWriteChangesValue(target.params[parameter.paramKey], value, parameter.spec.default)) {
      target.params[parameter.paramKey] = value
    }
  }
  return child
}

/**
 * 这次"对外值 → 内部副本"的写入值不值得做。
 *
 * 判据只有一条：**只有写入会改变内部节点的有效值时才写**。签名参数没写进 `params` 时，
 * 求值会用同一份声明默认值兜底（见 `buildInputBindings`），所以"缺失"与"等于默认值"
 * 是同一个状态；把默认值补写进去只是把同一个值换个地方存，却会让节点指纹变
 * （params 整份进指纹），于是"训练一次、之后把块封装起来"当场对不上 ——
 * 工程里的制品引用和宿主 `meta.json` 记的指纹都按指纹严格比对，对不上就只能重训。
 */
function paramWriteChangesValue(
  current: string | number | boolean | undefined,
  value: string | number | boolean,
  declaredDefault: string | number | boolean,
): boolean {
  if (current === value) return false
  return !(current === undefined && value === declaredDefault)
}

interface RuntimeEndpoint {
  nodeId: string
  portId: string
}

/** 解析组块输出映射，直到找到展开图里的普通节点。 */
function resolveOutputEndpoint(
  node: WorkflowNode,
  portId: string,
  path: readonly string[],
  depth: number,
): RuntimeEndpoint {
  if (depth > MAX_GROUP_DEPTH) throw new Error(`组块嵌套超过最大深度 ${MAX_GROUP_DEPTH}，请检查是否存在循环定义`)
  if (node.type !== WORKFLOW_GROUP_TYPE) return { nodeId: runtimeNodeIdForPath(path, node.id), portId }
  const group = groupDefinition(node)
  const output = group.outputs.find((candidate) => candidate.id === portId)
  if (!output) throw new Error(`组块「${node.label}」不存在输出端口「${portId}」`)
  const childById = assertUniqueNodeIds(group.workflow, `组块「${node.label}」内部`)
  const source = childById.get(output.sourceNodeId)
  if (!source) throw new Error(`组块「${node.label}」的输出「${output.label}」引用了不存在的内部节点`)
  return resolveOutputEndpoint(source, output.sourcePortId, [...path, node.id], depth + 1)
}

/** 解析组块输入映射，直到找到展开图里的普通节点。 */
function resolveInputEndpoint(
  node: WorkflowNode,
  portId: string,
  path: readonly string[],
  depth: number,
): RuntimeEndpoint {
  if (depth > MAX_GROUP_DEPTH) throw new Error(`组块嵌套超过最大深度 ${MAX_GROUP_DEPTH}，请检查是否存在循环定义`)
  if (node.type !== WORKFLOW_GROUP_TYPE) return { nodeId: runtimeNodeIdForPath(path, node.id), portId }
  const group = groupDefinition(node)
  const parameter = group.parameters.find((candidate) => candidate.key === portId)
  if (parameter) {
    const childById = assertUniqueNodeIds(group.workflow, `组块「${node.label}」内部`)
    const target = childById.get(parameter.nodeId)
    if (!target) throw new Error(`组块「${node.label}」的参数「${parameter.label}」引用了不存在的内部节点`)
    return resolveInputEndpoint(target, parameter.paramKey, [...path, node.id], depth + 1)
  }
  const input = group.inputs.find((candidate) => candidate.id === portId)
  if (!input) throw new Error(`组块「${node.label}」不存在输入端口「${portId}」`)
  const childById = assertUniqueNodeIds(group.workflow, `组块「${node.label}」内部`)
  const target = childById.get(input.targetNodeId)
  if (!target) throw new Error(`组块「${node.label}」的输入「${input.label}」引用了不存在的内部节点`)
  return resolveInputEndpoint(target, input.targetPortId, [...path, node.id], depth + 1)
}

/**
 * 递归展开组块并将所有父子边界连线直接接到普通节点上。
 * 返回值保留根工作流元信息，所有 node id 与 edge id 在结果中唯一。
 */
export function expandWorkflowGroups(workflow: Workflow, ctx: PortContext = EMPTY_PORT_CONTEXT): Workflow {
  const flatNodes: WorkflowNode[] = []
  const flatEdges: WorkflowEdge[] = []
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()

  const expandLevel = (current: Workflow, path: readonly string[], depth: number): void => {
    if (depth > MAX_GROUP_DEPTH) {
      throw new Error(`组块嵌套超过最大深度 ${MAX_GROUP_DEPTH}，请检查是否存在循环定义`)
    }
    const currentNodes = assertUniqueNodeIds(current, path.length ? `组块「${path.at(-1)}」内部` : '工作流')
    for (const edge of current.edges) {
      if (!currentNodes.has(edge.source) || !currentNodes.has(edge.target)) {
        throw new Error(`工作流连线「${edge.id}」引用了不存在的节点`)
      }
    }
    const scopedCtx: PortContext = ctx.columnsOf
      ? {
          ...ctx,
          columnsOf: (nodeId, portId) => ctx.columnsOf!(runtimeNodeIdForPath(path, nodeId), portId),
        }
      : ctx

    // 普通节点直接加入结果；组块节点展开其内部工作流。
    for (const node of current.nodes) {
      if (node.type === WORKFLOW_GROUP_TYPE) {
        const group = assertGroupBindings(node, currentNodes, scopedCtx)
        const wiredParameterKeys = new Set(
          current.edges
            .filter((edge) => edge.target === node.id)
            .map((edge) => edge.targetPort)
            .filter((portId) => group.parameters.some((parameter) => parameter.key === portId)),
        )
        expandLevel(
          childWorkflowWithGroupParams(node, group, wiredParameterKeys),
          [...path, node.id],
          depth + 1,
        )
        continue
      }
      const id = runtimeNodeIdForPath(path, node.id)
      if (nodeIds.has(id)) throw new Error(`组块展开后节点 id「${id}」重复`)
      nodeIds.add(id)
      flatNodes.push({ ...cloneWorkflowNode(node), id })
    }

    for (const edge of current.edges) {
      const sourceNode = currentNodes.get(edge.source)!
      const targetNode = currentNodes.get(edge.target)!
      const source = resolveOutputEndpoint(sourceNode, edge.sourcePort, path, depth)
      const target = resolveInputEndpoint(targetNode, edge.targetPort, path, depth)
      const id =
        path.length === 0 && source.nodeId === edge.source && target.nodeId === edge.target
          ? edge.id
          : makeEdgeId(source.nodeId, source.portId, target.nodeId, target.portId)
      if (edgeIds.has(id)) throw new Error(`组块展开后连线 id「${id}」重复`)
      edgeIds.add(id)
      flatEdges.push({
        id,
        source: source.nodeId,
        sourcePort: source.portId,
        target: target.nodeId,
        targetPort: target.portId,
      })
    }
  }

  expandLevel(workflow, [], 0)
  return { ...workflow, nodes: flatNodes, edges: flatEdges }
}

/**
 * 撤销一次组块封装：恢复内部节点与边，并把父工作流的边界连线接回内部端点。
 */
export function ungroupNode(
  workflow: Workflow,
  groupNodeId: string,
  ctx: PortContext = EMPTY_PORT_CONTEXT,
): Workflow {
  const parentNodes = assertUniqueNodeIds(workflow, '工作流')
  for (const edge of workflow.edges) {
    if (!parentNodes.has(edge.source) || !parentNodes.has(edge.target)) {
      throw new Error(`无法解散组块：连线「${edge.id}」引用了不存在的节点`)
    }
  }
  const groupNode = parentNodes.get(groupNodeId)
  if (!groupNode) throw new Error(`找不到组块节点「${groupNodeId}」`)
  const group = assertGroupBindings(groupNode, parentNodes, ctx)
  const wiredParameterKeys = new Set(
    workflow.edges
      .filter((edge) => edge.target === groupNodeId)
      .map((edge) => edge.targetPort)
      .filter((portId) => group.parameters.some((parameter) => parameter.key === portId)),
  )
  const child = childWorkflowWithGroupParams(groupNode, group, wiredParameterKeys)
  const childNodes = new Map(child.nodes.map((node) => [node.id, node]))
  const otherParentNodes = workflow.nodes.filter((node) => node.id !== groupNodeId)
  const existingIds = new Set(otherParentNodes.map((node) => node.id))
  for (const node of child.nodes) {
    if (existingIds.has(node.id)) throw new Error(`无法解散组块：内部节点 id「${node.id}」与外部节点冲突`)
    existingIds.add(node.id)
  }

  const inputById = new Map(group.inputs.map((input) => [input.id, input]))
  const outputById = new Map(group.outputs.map((output) => [output.id, output]))
  const edges: WorkflowEdge[] = []
  for (const edge of workflow.edges) {
    if (edge.source === groupNodeId && edge.target === groupNodeId) {
      throw new Error(`组块「${groupNode.label}」存在自连线「${edge.id}」，无法解散`)
    }
    if (edge.target === groupNodeId) {
      const input = inputById.get(edge.targetPort)
      const parameter = group.parameters.find((candidate) => candidate.key === edge.targetPort)
      const targetNodeId = input?.targetNodeId ?? parameter?.nodeId
      const targetPortId = input?.targetPortId ?? parameter?.paramKey
      if (!targetNodeId || !targetPortId) {
        throw new Error(`组块「${groupNode.label}」不存在输入端口「${edge.targetPort}」`)
      }
      if (!childNodes.has(targetNodeId)) {
        throw new Error(`组块「${groupNode.label}」的输入映射引用了不存在的内部节点「${targetNodeId}」`)
      }
      edges.push({
        id: makeEdgeId(edge.source, edge.sourcePort, targetNodeId, targetPortId),
        source: edge.source,
        sourcePort: edge.sourcePort,
        target: targetNodeId,
        targetPort: targetPortId,
      })
    } else if (edge.source === groupNodeId) {
      const output = outputById.get(edge.sourcePort)
      if (!output) throw new Error(`组块「${groupNode.label}」不存在输出端口「${edge.sourcePort}」`)
      if (!childNodes.has(output.sourceNodeId)) {
        throw new Error(`组块「${groupNode.label}」的输出映射引用了不存在的内部节点「${output.sourceNodeId}」`)
      }
      edges.push({
        id: makeEdgeId(output.sourceNodeId, output.sourcePortId, edge.target, edge.targetPort),
        source: output.sourceNodeId,
        sourcePort: output.sourcePortId,
        target: edge.target,
        targetPort: edge.targetPort,
      })
    } else {
      edges.push({ ...edge })
    }
  }
  edges.push(...child.edges.map((edge) => ({ ...edge })))

  const nodes: WorkflowNode[] = []
  for (const node of workflow.nodes) {
    if (node.id === groupNodeId) {
      nodes.push(...child.nodes.map((inner) => cloneWorkflowNode(inner)))
    } else {
      nodes.push(cloneWorkflowNode(node))
    }
  }
  return { ...workflow, nodes, edges }
}
