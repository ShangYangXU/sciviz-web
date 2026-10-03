/**
 * 补丁应用器 —— **把一批 op 落到工程上，或者一条都不落。**
 *
 * 四条设计决定，都是从"人与 agent 轮流改同一份工程"推出来的：
 *
 * 1. **原子**。要么全过、要么全不动。半途而废的工程比"改失败"更糟：人打开会看到
 *    一个既不是他的、也不是 agent 想要的状态，而且没人知道该回退到哪儿。
 * 2. **整图 L1 不是写入闸门**。图没接完、甚至带着几处错误，都是**正常的中间状态** ——
 *    人会把半截实验留在画布上，也会把许多子实验收进一个子空间（那里面本来就有
 *    故意断着的地方）。所以拦住的只有**这条 op 本身落不下去**的那些情况：
 *    引用了不存在的东西、端口不存在、类型不兼容、成环、参数非法、路径上的子空间不存在。
 *    op 全部落下之后，整图 L1（以及组块边界映射）照跑，结果原样放进 `validation`
 *    交给调用方（界面、CLI、agent）如实转达 —— **报告，但不否决**。
 *    判据是：L1 报错必须能归因到某条 op 才拦得住那份补丁；归因不到（错在别的节点上），
 *    它就不是这次改动的错。
 * 3. **判据复用校验器**。op 级的检查（端口是否存在、值是否合法）用与 `validateWorkflow`
 *    同一批函数，最后再整图跑一遍 L1。否则会出现"补丁说改好了、validate 说不行"。
 * 4. **动作按层寻址**。每条 op 可以带 `path` 指向某一层子空间（与界面的 activeGroupPath
 *    同一个含义）；缺省是根图。没有这一条，agent 对"收进子空间的实验"一个动作都做不了。
 */

import { defaultParams, getNodeTypeDef, hasNodeType } from '../workflow/nodeRegistry'
import { makeEdgeId, resolvePorts } from '../workflow/ports'
import { projectPortContext, projectToText, type Project } from '../workflow/project'
import { normalizeProjectColumns } from '../workflow/project'
import {
  createGroupFromSelection,
  runtimeIdMoves,
  syncGroupParameterMirrors,
  ungroupNode,
  WORKFLOW_GROUP_TYPE,
} from '../workflow/groups'
import {
  checkConnection,
  checkParamValue,
  validateWorkflow,
  type ValidationResult,
} from '../contract/validate'
import { diffLines } from './diff'
import { pathPrefix, type OpPath, type OpRejection, type PatchFile, type PatchOp } from '../contract/ops'
import type { Workflow, WorkflowGroupDefinition, WorkflowNode } from '../workflow/types'
import { projectEditFingerprint } from './editFingerprint'

export interface PatchResult {
  ok: boolean
  /** 通过时是新的工程；被拒时是**原样**那一份 */
  project: Project
  /**
   * 逐条 op 的拒绝理由。空表表示每条都落下了。
   *
   * 只有**这条 op 自己落不下去**才会进这里 —— 整图 L1 的问题不进（它们在 `validation`）。
   */
  rejections: OpRejection[]
  /** 每条成功 op 的一句话，按顺序。给人 review 用 */
  changes: string[]
  /** 改动前后的行级差异。没有改动时是空串 */
  diff: string
  /**
   * 整图跑一遍 L1 的结果。**它不影响 `ok`**：op 落了就落了，L1 的问题如实报出来，
   * 由人（或 agent）决定要不要接着改。
   */
  validation: ValidationResult | null
  /** 落下的改动里，图仍然没接完的地方（不是错误，是中间状态） */
  incomplete: string[]
  /**
   * 把这批改动**撤销**所需的动作，按"要执行的顺序"给（内部按逆序排好）。
   *
   * 有了它，"撤销 agent 刚才那次改动"就不需要另存一份旧文件 —— 反向动作本身就是
   * 那次改动的完整反面。构造方式：每条 op 成功时就地记下它的逆（带着改之前的值），
   * 最后整体倒序（先做的后撤）。
   */
  reverse: PatchOp[]
}

/** 节点自动摆放：排到最右边一列，不覆盖人已经摆好的版面 */
function autoPlace(nodes: WorkflowNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 80, y: 80 }
  const maxX = Math.max(...nodes.map((n) => n.position.x))
  const sameColumn = nodes.filter((n) => Math.abs(n.position.x - maxX) < 1)
  const minY = Math.min(...sameColumn.map((n) => n.position.y))
  return { x: maxX + 260, y: minY }
}

function nextNodeId(nodes: WorkflowNode[]): string {
  let max = 0
  for (const n of nodes) {
    const m = /^n(\d+)/.exec(n.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${max + 1}`
}

/**
 * 一条 op 作用在**哪一层**子图上。
 *
 * 返回 null 表示路径本身坏了（某个 id 不存在，或者那个块不是子空间）—— 这是**这条 op
 * 自己的**错误，必须拒绝；与"整张图过不过得了 L1"无关。换言之：路径写在纸上的那一条，
 * 指到的东西必须真的存在，否则这条改动根本无处可落。
 */
function targetWorkflow(draft: Project, path: OpPath | undefined): Workflow | null {
  let current: Workflow = draft.graph
  for (const id of path ?? []) {
    const node = current.nodes.find((n) => n.id === id)
    if (!node?.group) return null
    current = node.group.workflow
  }
  return current
}

/** 路径上每一层的 label，用来把改动清单写成"在子空间「实验组」里：…" */
function pathLabeler(draft: Project, path: OpPath | undefined): (id: string) => string | undefined {
  const labels = new Map<string, string>()
  let current: Workflow = draft.graph
  for (const id of path ?? []) {
    const node = current.nodes.find((n) => n.id === id)
    if (!node?.group) break
    labels.set(id, node.label)
    current = node.group.workflow
  }
  return (id) => labels.get(id)
}

/** 新建子空间时用的空定义。组块节点必须带着它落地，否则这个块一出现就是坏的 */
function emptyGroupDefinition(parent: Workflow, id: string, label: string): WorkflowGroupDefinition {
  return {
    workflow: { id: `${parent.id}::${id}`, name: label, description: '', nodes: [], edges: [] },
    inputs: [],
    outputs: [],
    parameters: [],
  }
}

/**
 * 一份"看起来是组块定义"的东西。
 *
 * 只查到形状为止：**深层的边界映射是否自洽是 L1 的事**（`E_GROUP_INVALID`，报告不阻断）。
 * 这里查形状的理由不同 —— 形状不对（不是对象、缺 workflow/inputs/outputs/parameters）
 * 的话，这个节点一落地就会让**任何**读图的代码炸掉，那是 op 自己落不下去。
 */
function looksLikeGroupDefinition(value: unknown): value is WorkflowGroupDefinition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorkflowGroupDefinition>
  const wf = candidate.workflow as Workflow | undefined
  return !!wf && typeof wf === 'object' && Array.isArray(wf.nodes) && Array.isArray(wf.edges) &&
    Array.isArray(candidate.inputs) && Array.isArray(candidate.outputs) && Array.isArray(candidate.parameters)
}

/**
 * 按给定的 id 顺序重排一层里的节点。
 *
 * 顺序表里没提到的节点一律留在末尾、保持原有相对顺序 —— 顺序表描述的是"这些块原本
 * 在哪儿"，别的东西（比如后来新加的块）不该被这条 op 弄丢或乱序。
 */
function reorderNodes(nodes: WorkflowNode[], order: readonly string[] | undefined): WorkflowNode[] {
  if (!order || order.length === 0) return nodes
  const remaining = new Map(nodes.map((node) => [node.id, node]))
  const ordered: WorkflowNode[] = []
  for (const id of order) {
    const node = remaining.get(id)
    if (!node) continue
    ordered.push(node)
    remaining.delete(id)
  }
  for (const node of nodes) {
    if (remaining.has(node.id)) ordered.push(node)
  }
  return ordered
}

/**
 * 组块结构变了：把按运行时 id 归属的制品引用搬到新 id 上（契约规格 R5.5、接口文档 LIB-24）。
 *
 * 与界面那条路（`useWorkflowStore.migrateModelArtifacts`）是同一条规则 —— 搬什么由
 * `runtimeIdMoves` 一处说了算，这里只负责把它落到 `Project` 上。
 *
 * 为什么补丁这条路也必须搬：agent / CLI 改图的**唯一**通道就是补丁，而封装与解散会改
 * 内部节点的运行时 id。不搬的症状不是"少算一次"，是**训好的权重再也读不到** ——
 * 引用写的是旧 id，节点下次求值找不到自己的制品，界面上只显示"等待开始训练"或
 * "当前训练设置与已保存制品不匹配"，没有任何线索说明为什么。
 *
 * 删节点**不**动引用：撤销会把节点原样加回来（反向动作里带着连线），那时引用还得对得上。
 */
function migrateModelArtifacts(draft: Project, moves: Map<string, string>): void {
  if (moves.size === 0 || draft.modelArtifacts.length === 0) return
  draft.modelArtifacts = draft.modelArtifacts.map((ref) => {
    const to = moves.get(ref.nodeId)
    return to && to !== ref.nodeId ? { ...ref, nodeId: to } : ref
  })
}

/**
 * 清掉端口已经不存在的连线，返回被清掉的那些。
 *
 * 与界面上的 `pruneInvalidEdges` 是同一条规则。之所以只在这里调用（而不是每次补丁后都跑），
 * 是因为别的 op 不可能让端口凭空消失 —— 只有改数据集视图会。
 */
function pruneDanglingEdges(graph: Workflow, ctx: ReturnType<typeof projectPortContext>) {
  const kept = []
  const dropped = []
  for (const e of graph.edges) {
    const src = graph.nodes.find((n) => n.id === e.source)
    const dst = graph.nodes.find((n) => n.id === e.target)
    if (!src || !dst) {
      dropped.push(e)
      continue
    }
    const out = resolvePorts(src, ctx).outputs.some((p) => p.id === e.sourcePort)
    const inp = resolvePorts(dst, ctx).inputs.some((p) => p.id === e.targetPort)
    if (out && inp) kept.push(e)
    else dropped.push(e)
  }
  graph.edges = kept
  return dropped
}

export function applyPatch(project: Project, patch: PatchFile): PatchResult {
  const before = projectToText(project)
  const draft: Project = structuredClone(project)
  const rejections: OpRejection[] = []
  const changes: string[] = []
  /**
   * 每条成功 op 的反向动作，**按 op 分组**，组内已经排成"撤销时要执行的顺序"。
   *
   * 分组的理由：一条 op 可能对应好几个反向动作（删节点要先把节点加回来、再把连线接回来），
   * 而这些动作内部有先后。整体撤销时是**组与组倒序、组内保持原序** ——
   * 不是把所有动作混在一起倒序（那样 connect 会排在 addNode 前面，撤不回去）。
   */
  const undoGroups: PatchOp[][] = []

  const reject = (index: number, op: PatchOp, code: string, message: string, extra: Partial<OpRejection> = {}) => {
    rejections.push({ index, op: op.op, code, message, ...extra })
  }

  patch.ops.forEach((op, index) => {
    /*
     * 先定这一条 op 落在哪一层。节点 id 只在**它自己那一层**唯一 —— 子空间里的 `n7`
     * 与根图的 `n7` 是两回事，所以每条寻址都先解一次路径。
     */
    // addDataset.path 表示数据文件位置；只有其它 op 的 path 才是子图寻址路径。
    const path = op.op === 'addDataset' ? undefined : (op as { path?: OpPath }).path
    const target = targetWorkflow(draft, path)
    if (!target) {
      reject(index, op, 'E_UNKNOWN_REF', `子空间路径 ${JSON.stringify(path ?? [])} 上有块不存在，或那个块不是子空间`, {
        nodeId: (path ?? []).filter((id) => !draft.graph.nodes.some((n) => n.id === id)).join(' / ') || undefined,
      })
      return
    }
    const at = pathPrefix(path, pathLabeler(draft, path))
    const findNode = (id: string): WorkflowNode | undefined => target.nodes.find((n) => n.id === id)
    const backPath = path && path.length > 0 ? { path } : {}

    switch (op.op) {
      /* ---------------- 结构 ---------------- */
      case 'addNode': {
        if (!hasNodeType(op.type)) {
          reject(index, op, 'E_UNKNOWN_OPERATOR', `算子「${op.type}」不在清单里`, { portId: op.type })
          return
        }
        const id = op.id ?? nextNodeId(target.nodes)
        if (target.nodes.some((n) => n.id === id)) {
          reject(index, op, 'E_DUPLICATE_NODE_ID', `节点 id「${id}」已经有了`, { nodeId: id })
          return
        }
        const def = getNodeTypeDef(op.type)
        const params = { ...defaultParams(def), ...(op.params ?? {}) }
        const label = op.label ?? def.label
        /*
         * 子空间只有一种合法落地方式：带着它的内部定义一起。
         *
         * 此前 `addNode type=workflow.group` 会造出一个"没有 group 字段的组块节点" ——
         * 那是个坏块：任何读图的代码（校验器、展开器、界面）碰到它都只能报错，
         * 而它又删不掉（删除本身也要先读它）。所以这里自动补一个空子图，
         * 反向动作里带回来的定义（撤销"删掉一个子空间"）则原样沿用。
         */
        let group: WorkflowGroupDefinition | undefined
        if (op.type === WORKFLOW_GROUP_TYPE) {
          if (op.group !== undefined) {
            if (!looksLikeGroupDefinition(op.group)) {
              reject(index, op, 'E_PARAM_INVALID', '子空间定义不完整（要有 workflow / inputs / outputs / parameters）', { nodeId: id })
              return
            }
            group = structuredClone(op.group)
          } else {
            group = emptyGroupDefinition(target, id, label)
          }
        } else if (op.group !== undefined) {
          reject(index, op, 'E_PARAM_INVALID', `算子「${op.type}」不是子空间，不接受 group 定义`, { nodeId: id })
          return
        }
        // 子空间的对外参数由它自己的定义声明，不在算子注册表里
        const specByKey = new Map([
          ...def.params.map((p) => [p.key, p] as const),
          ...(group?.parameters ?? []).map((parameter) => [parameter.key, parameter.spec] as const),
        ])
        for (const [key, value] of Object.entries(op.params ?? {})) {
          const spec = specByKey.get(key)
          if (!spec) {
            reject(index, op, 'E_PARAM_INVALID', `参数「${key}」不是 ${op.type} 声明过的键`, { nodeId: id, portId: key })
            return
          }
          const fault = checkParamValue(spec, value)
          if (fault) {
            reject(index, op, 'E_PARAM_INVALID', `参数「${spec.label}」${fault}`, { nodeId: id, portId: key })
            return
          }
        }
        const placed: WorkflowNode = {
          id,
          type: op.type,
          label,
          params,
          position: op.position ?? autoPlace(target.nodes),
          ...(group ? { group } : {}),
        }
        if (typeof op.index === 'number' && Number.isFinite(op.index)) {
          const at = Math.max(0, Math.min(target.nodes.length, Math.floor(op.index)))
          target.nodes = [...target.nodes.slice(0, at), placed, ...target.nodes.slice(at)]
        } else {
          target.nodes.push(placed)
        }
        undoGroups.push([{ op: 'removeNode', ...backPath, id }])
        changes.push(`${at}加了节点 ${id}「${label}」（${op.type}）`)
        return
      }

      case 'removeNode': {
        const node = findNode(op.id)
        if (!node) {
          reject(index, op, 'E_UNKNOWN_REF', `没有 id 为「${op.id}」的节点`, { nodeId: op.id })
          return
        }
        const dropped = target.edges.filter((e) => e.source === op.id || e.target === op.id)
        // 记下它原来在第几个位置 —— 撤销要把它放回原处，而不是追加到末尾
        const indexInLayer = target.nodes.findIndex((n) => n.id === op.id)
        target.nodes = target.nodes.filter((n) => n.id !== op.id)
        target.edges = target.edges.filter((e) => e.source !== op.id && e.target !== op.id)
        // 删节点要把它的连线也带回来，否则撤销之后图是断的。
        // 组内顺序：先把节点加回来，再接线。子空间的内部定义也要一起带回来 ——
        // 只把 type 落回去的话，撤销出来的是一个空壳子空间。
        const undoRemove: PatchOp[] = [
          {
            op: 'addNode',
            ...backPath,
            id: node.id,
            type: node.type,
            label: node.label,
            params: { ...node.params },
            position: { ...node.position },
            index: indexInLayer,
            ...(node.group ? { group: structuredClone(node.group) } : {}),
          },
        ]
        for (const e of dropped) {
          undoRemove.push({
            op: 'connect',
            ...backPath,
            source: e.source,
            sourcePort: e.sourcePort,
            target: e.target,
            targetPort: e.targetPort,
          })
        }
        undoGroups.push(undoRemove)
        changes.push(
          `${at}删了节点 ${op.id}「${node.label}」` + (dropped.length ? `（连带 ${dropped.length} 条连线）` : ''),
        )
        return
      }

      case 'renameNode': {
        const node = findNode(op.id)
        if (!node) {
          reject(index, op, 'E_UNKNOWN_REF', `没有 id 为「${op.id}」的节点`, { nodeId: op.id })
          return
        }
        changes.push(`${at}把 ${op.id} 的名字从「${node.label}」改成「${op.label}」`)
        undoGroups.push([{ op: 'renameNode', ...backPath, id: op.id, label: node.label }])
        node.label = op.label
        return
      }

      case 'moveNode': {
        const node = findNode(op.id)
        if (!node) {
          reject(index, op, 'E_UNKNOWN_REF', `没有 id 为「${op.id}」的节点`, { nodeId: op.id })
          return
        }
        undoGroups.push([{ op: 'moveNode', ...backPath, id: op.id, position: { ...node.position } }])
        node.position = op.position
        changes.push(`${at}把 ${op.id} 挪到 (${op.position.x}, ${op.position.y})`)
        return
      }

      /* ---------------- 连线 ---------------- */
      case 'connect': {
        const malformedField = (['source', 'sourcePort', 'target', 'targetPort'] as const)
          .find((field) => typeof op[field] !== 'string' || op[field].trim().length === 0)
        if (malformedField) {
          reject(
            index,
            op,
            'E_PARAM_INVALID',
            `connect 缺少有效字段；必须提供 source、sourcePort、target、targetPort 字符串，当前缺少「${malformedField}」`,
          )
          return
        }
        const src = findNode(op.source)
        const dst = findNode(op.target)
        if (!src || !dst) {
          const missing = !src ? op.source : op.target
          reject(index, op, 'E_UNKNOWN_REF', `没有 id 为「${missing}」的节点`, { nodeId: missing })
          return
        }
        /*
         * 判据只有一处：与界面拖拽、L1 校验器同一个 `checkConnection`。
         * 这里曾经自己写了一遍端口/类型/占用/成环四件事 —— 那份判断与校验器的
         * 措辞并不一致（成环那句尤其），于是"补丁说不行、validate 说行"这种分歧
         * 没有任何地方会报错。
         */
        const hit = checkConnection(
          target,
          {
            source: op.source,
            sourcePort: op.sourcePort,
            target: op.target,
            targetPort: op.targetPort,
          },
          projectPortContext(draft),
        )
        if (hit) {
          reject(index, op, hit.code, hit.message, { nodeId: hit.nodeId, portId: hit.portId })
          return
        }
        target.edges.push({
          id: makeEdgeId(op.source, op.sourcePort, op.target, op.targetPort),
          source: op.source,
          sourcePort: op.sourcePort,
          target: op.target,
          targetPort: op.targetPort,
        })
        undoGroups.push([
          { op: 'disconnect', ...backPath, edgeId: makeEdgeId(op.source, op.sourcePort, op.target, op.targetPort) },
        ])
        changes.push(`${at}接上 ${src.label}.${op.sourcePort} → ${dst.label}.${op.targetPort}`)
        return
      }

      case 'disconnect': {
        const edge = target.edges.find((e) => e.id === op.edgeId)
        if (!edge) {
          reject(index, op, 'E_UNKNOWN_REF', `没有 id 为「${op.edgeId}」的连线`, {})
          return
        }
        target.edges = target.edges.filter((e) => e.id !== op.edgeId)
        undoGroups.push([
          {
            op: 'connect',
            ...backPath,
            source: edge.source,
            sourcePort: edge.sourcePort,
            target: edge.target,
            targetPort: edge.targetPort,
          },
        ])
        changes.push(`${at}断开连线 ${edge.source}.${edge.sourcePort} → ${edge.target}.${edge.targetPort}`)
        return
      }

      /* ---------------- 参数与元信息 ---------------- */
      case 'setParam': {
        const node = findNode(op.id)
        if (!node) {
          reject(index, op, 'E_UNKNOWN_REF', `没有 id 为「${op.id}」的节点`, { nodeId: op.id })
          return
        }
        const def = getNodeTypeDef(node.type)
        /*
         * 子空间的对外参数（R15.3 的"外部视图"）不在注册表里，它们在 `group.parameters`
         * 里。不认这一路的话，agent 连"把子空间里那个实验的学习率改小一点"都做不到 ——
         * 而对外值正是执行时生效的那一份（内部副本在读写工程时按它对齐）。
         */
        const groupSpec = node.group?.parameters.find((parameter) => parameter.key === op.key)?.spec
        const spec = groupSpec ?? def.params.find((p) => p.key === op.key)
        // 函数节点的形参不在注册表里：它们由代码签名解析而来，允许设
        const isSignatureParam = /^custom\./.test(node.type)
        if (!spec && !isSignatureParam) {
          reject(index, op, 'E_PARAM_INVALID', `参数「${op.key}」不是 ${node.type} 声明过的键`, {
            nodeId: op.id,
            portId: op.key,
          })
          return
        }
        if (spec) {
          const fault = checkParamValue(spec, op.value)
          if (fault) {
            reject(index, op, 'E_PARAM_INVALID', `参数「${spec.label}」${fault}`, {
              nodeId: op.id,
              portId: op.key,
            })
            return
          }
        }
        const from = node.params[op.key]
        node.params = { ...node.params, [op.key]: op.value }
        undoGroups.push([
          from === undefined
            ? { op: 'resetParams', ...backPath, id: op.id }
            : { op: 'setParam', ...backPath, id: op.id, key: op.key, value: from },
        ])
        changes.push(`${at}把「${node.label}」的 ${op.key} 从 ${JSON.stringify(from)} 改成 ${JSON.stringify(op.value)}`)
        return
      }

      case 'resetParams': {
        const node = findNode(op.id)
        if (!node) {
          reject(index, op, 'E_UNKNOWN_REF', `没有 id 为「${op.id}」的节点`, { nodeId: op.id })
          return
        }
        const snapshot = { ...node.params }
        // 子空间的对外参数按 `group.parameters` 的声明默认值复位；普通节点按注册表
        node.params = node.group
          ? Object.fromEntries(node.group.parameters.map((parameter) => [parameter.key, parameter.spec.default]))
          : defaultParams(getNodeTypeDef(node.type))
        // 复位是"整组替换"，所以逆动作要把快照里的每个键都设回去
        undoGroups.push(
          Object.entries(snapshot).map(([key, value]) => ({ op: 'setParam' as const, ...backPath, id: op.id, key, value })),
        )
        changes.push(`${at}把「${node.label}」的参数恢复成默认值`)
        return
      }

      /* ---------------- 子空间 ---------------- */
      case 'createGroup': {
        if (!Array.isArray(op.nodeIds) || op.nodeIds.length === 0) {
          reject(index, op, 'E_PARAM_INVALID', 'createGroup 要给出 nodeIds（至少一个）', {})
          return
        }
        if (!op.id || target.nodes.some((n) => n.id === op.id)) {
          reject(index, op, 'E_DUPLICATE_NODE_ID', `子空间 id「${op.id}」已经有了或用了个空 id`, { nodeId: op.id })
          return
        }
        const before = target.nodes.map((n) => n.id)
        // 被收进去的块（连同它们内部的节点）运行时 id 会多一层组路径，制品引用跟着搬。
        // 必须在 createGroupFromSelection 之前取到节点本体 —— 之后它们已经不在这一层了。
        const layerPath = path ?? []
        const movedNodes = target.nodes.filter((n) => op.nodeIds.includes(n.id))
        let built: ReturnType<typeof createGroupFromSelection>
        try {
          built = createGroupFromSelection(target, op.nodeIds, projectPortContext(draft), op.id, op.label)
        } catch (error: unknown) {
          reject(index, op, 'E_GROUP_INVALID', `封不成子空间：${error instanceof Error ? error.message : String(error)}`, { nodeId: op.id })
          return
        }
        target.nodes = built.workflow.nodes
        target.edges = built.workflow.edges
        const moves = new Map<string, string>()
        for (const moved of movedNodes) {
          for (const [from, to] of runtimeIdMoves(moved, layerPath, [...layerPath, op.id])) {
            moves.set(from, to)
          }
        }
        migrateModelArtifacts(draft, moves)
        /*
         * 反向动作带上 `restoreOrder`：所选块在原层里不相邻时，解散会把它们恢复成
         * 连续的一整段，图等价但工程文本不再是原样。有这条顺序，"撤销后一字不差"
         * 才对所有选择成立，而不是只对相邻选择成立。
         */
        undoGroups.push([{ op: 'ungroup', ...backPath, id: op.id, restoreOrder: before }])
        changes.push(`${at}把 ${op.nodeIds.length} 个块封装成子空间「${built.node.label}」（${op.id}）`)
        return
      }

      case 'ungroup': {
        const groupNode = findNode(op.id)
        if (!groupNode?.group) {
          reject(index, op, 'E_UNKNOWN_REF', `这一层里没有 id 为「${op.id}」的子空间`, { nodeId: op.id })
          return
        }
        // 解散：组内每个块（连同更深层）都少一层组路径，制品引用同样跟着搬回去。
        const layerPath = path ?? []
        const children = groupNode.group.workflow.nodes
        const restoreOrder = op.restoreOrder
        let next: Workflow
        try {
          next = ungroupNode(target, op.id, projectPortContext(draft))
        } catch (error: unknown) {
          reject(index, op, 'E_GROUP_INVALID', `解散不了子空间：${error instanceof Error ? error.message : String(error)}`, { nodeId: op.id })
          return
        }
        target.nodes = reorderNodes(next.nodes, restoreOrder)
        target.edges = next.edges
        const moves = new Map<string, string>()
        for (const child of children) {
          for (const [from, to] of runtimeIdMoves(child, [...layerPath, op.id], layerPath)) {
            moves.set(from, to)
          }
        }
        migrateModelArtifacts(draft, moves)
        undoGroups.push([
          {
            op: 'createGroup',
            ...backPath,
            id: groupNode.id,
            label: groupNode.label,
            nodeIds: groupNode.group.workflow.nodes.map((inner) => inner.id),
          },
        ])
        changes.push(`${at}解散了子空间「${groupNode.label}」（${op.id}），${groupNode.group.workflow.nodes.length} 个块回到这一层`)
        return
      }

      case 'setMeta': {
        if (op.name !== undefined) {
          undoGroups.push([{ op: 'setMeta', name: draft.name }])
          changes.push(`工程名从「${draft.name}」改成「${op.name}」`)
          draft.name = op.name
          draft.graph.name = op.name
        }
        if (op.description !== undefined) {
          undoGroups.push([{ op: 'setMeta', description: draft.description }])
          draft.description = op.description
          draft.graph.description = op.description
          changes.push('改了工程描述')
        }
        return
      }

      /* ---------------- 数据集 ---------------- */
      case 'addDataset': {
        if (draft.datasets.some((d) => d.id === op.id)) {
          reject(index, op, 'E_DUPLICATE_NODE_ID', `数据集 id「${op.id}」已经有了`, { nodeId: op.id })
          return
        }
        draft.datasets.push({
          id: op.id,
          name: op.name,
          ...(op.path !== undefined ? { path: op.path } : {}),
          ...(op.contentHash !== undefined ? { contentHash: op.contentHash } : {}),
          ...(op.rowCount !== undefined ? { rowCount: op.rowCount } : {}),
          ...(op.sampleRate !== undefined ? { sampleRate: op.sampleRate } : {}),
          ...(op.timeColumn !== undefined ? { timeColumn: op.timeColumn } : {}),
          ...(op.columns !== undefined
            ? { columns: normalizeProjectColumns(op.columns) ?? [] }
            : {}),
        })
        undoGroups.push([{ op: 'removeDataset', id: op.id }])
        changes.push(`登记了数据集「${op.name}」（id ${op.id}）`)
        return
      }

      case 'removeDataset': {
        const ds = draft.datasets.find((d) => d.id === op.id)
        if (!ds) {
          reject(index, op, 'E_UNKNOWN_REF', `工程里没有 id 为「${op.id}」的数据集`, { nodeId: op.id })
          return
        }
        draft.datasets = draft.datasets.filter((d) => d.id !== op.id)
        // id 与 name 单独给：剩下的字段（路径、哈希、列清单…）原样带回去
        const { id: _droppedId, name: _droppedName, ...restOfDataset } = structuredClone(ds)
        undoGroups.push([{ op: 'addDataset', id: ds.id, name: ds.name, ...restOfDataset }])
        changes.push(`摘掉了数据集「${ds.name}」（id ${ds.id}）`)
        return
      }

      case 'setDatasetView': {
        const ds = draft.datasets.find((d) => d.id === op.datasetId)
        if (!ds) {
          reject(index, op, 'E_UNKNOWN_REF', `工程里没有 id 为「${op.datasetId}」的数据集`, {
            nodeId: op.datasetId,
          })
          return
        }
        if (op.timeColumn !== undefined) {
          const known = ds.columns?.some((c) => c.name === op.timeColumn)
          if (op.timeColumn !== null && ds.columns && !known) {
            reject(index, op, 'E_UNKNOWN_PORT', `数据集「${ds.name}」里没有列「${op.timeColumn}」`, {
              portId: op.timeColumn,
            })
            return
          }
          changes.push(
            op.timeColumn === null
              ? `把数据集「${ds.name}」的时间列去掉`
              : `把数据集「${ds.name}」的时间列设为「${op.timeColumn}」`,
          )
          undoGroups.push([{ op: 'setDatasetView', datasetId: op.datasetId, timeColumn: ds.timeColumn ?? null }])
          ds.timeColumn = op.timeColumn
        }
        if (op.enabled) {
          const known = new Set((ds.columns ?? []).map((c) => c.name))
          const unknown = op.enabled.filter((name) => !known.has(name))
          if (unknown.length > 0) {
            reject(index, op, 'E_UNKNOWN_PORT', `数据集「${ds.name}」里没有这些列：${unknown.join('、')}`, {
              portId: unknown[0],
            })
            return
          }
          const on = new Set(op.enabled)
          const beforeEnabled = ds.columns?.map((c) => ({ name: c.name, enabled: c.enabled })) ?? []
          for (const c of ds.columns ?? []) {
            const before = c.enabled
            c.enabled = on.has(c.name) && c.type === 'number'
            if (before !== c.enabled && c.enabled) changes.push(`启用了列「${c.name}」`)
            if (before !== c.enabled && !c.enabled) changes.push(`关掉了列「${c.name}」`)
          }
          /*
           * 关掉一列会让接在那一列上的连线失去源头。
           *
           * 这里跟着把线清掉，**与界面上关掉一列的行为一致** —— 两边做同一件事，
           * 结果必须一样，否则"人在界面上关列"和"agent 跑一条 setDatasetView"
           * 会得到两张不同的图。清掉的线会进改动清单，不静默。
           */
          const dropped = pruneDanglingEdges(draft.graph, projectPortContext(draft))
          for (const e of dropped) {
            changes.push(`连带断开了 ${e.source}.${e.sourcePort} → ${e.target}.${e.targetPort}（那一列不再启用）`)
          }
          /*
           * 反向：先恢复列的开关，再把连带断掉的线接回来。
           * 顺序不能反 —— 列没启用的话，那条线接不上去（端口还不存在）。
           */
          const undoView: PatchOp[] = [
            {
              op: 'setDatasetView',
              datasetId: op.datasetId,
              enabled: beforeEnabled.filter((c) => c.enabled).map((c) => c.name),
            },
          ]
          for (const e of dropped) {
            undoView.push({
              op: 'connect',
              source: e.source,
              sourcePort: e.sourcePort,
              target: e.target,
              targetPort: e.targetPort,
            })
          }
          undoGroups.push(undoView)
        }
        return
      }
    }
  })

  const incomplete: string[] = []
  let validation: ValidationResult | null = null
  const applied = rejections.length === 0

  if (applied) {
    /*
     * 对外参数值与内部副本是同一个值的两个视图（R15.3）。写完之后对齐一次，
     * 内存里那份、写出去的文件、再读回来那份才是同一样东西 ——
     * 否则"补丁说改好了、validate 说不行"会换一个地方重新出现。
     */
    draft.graph = syncGroupParameterMirrors(draft.graph)
    validation = validateWorkflow(draft.graph, projectPortContext(draft))
    // 没接完不是错误：人可能正搭到一半。但要把"还缺什么"如实带出去
    incomplete.push(
      ...validation.errors.filter((e) => e.code === 'E_MISSING_INPUT').map((e) => e.message),
    )
  }

  return {
    /*
     * `ok` 只看"这条补丁自己落没落下去"。整图 L1 的问题（含 `E_GROUP_INVALID`）不改 `ok`：
     * 人会把半截实验与子空间留在画布上，那些地方本来就断着；让一个别的节点上的问题
     * 否决这次改动，结果是 agent 与人都什么都改不了（实测：对话栏会因此把失败
     * 谎报成基线不符，模型换一版基线重试，再失败，无限循环）。
     */
    ok: applied,
    project: applied ? draft : project,
    rejections,
    changes,
    diff: applied ? diffLines(before, projectToText(draft)) : '',
    validation,
    incomplete,
    // 组与组倒序、组内保持原序（见 undoGroups 的说明）
    reverse: applied ? undoGroups.slice().reverse().flat() : [],
  }
}

/**
 * 对话栏/MCP 的受保护写入口。CLI 的兼容入口仍可调用同步 `applyPatch`，但机器生成的
 * patch 从这里进：先算当前可编辑状态摘要，再决定是否允许落盘。
 */
export async function applyPatchGuarded(project: Project, patch: PatchFile): Promise<PatchResult> {
  const actual = await projectEditFingerprint(project)
  if (!patch.baseFingerprint || patch.baseFingerprint !== actual) {
    return {
      ok: false,
      project,
      rejections: [{ index: -1, op: 'patch', code: 'E_PATCH_BASE_MISMATCH', message: `补丁基线不匹配：当前是 ${actual}` }],
      changes: [],
      diff: '',
      validation: null,
      incomplete: [],
      reverse: [],
    }
  }
  return applyPatch(project, patch)
}

/** 图现在长什么样 —— 给"改完之后让我看一眼"用 */
export function summarizeGraph(graph: Workflow): string {
  const lines = [`${graph.name} · ${graph.nodes.length} 节点 · ${graph.edges.length} 连线`]
  for (const n of graph.nodes) lines.push(`  ${n.id.padEnd(10)} ${n.label}（${n.type}）`)
  return lines.join('\n')
}
