import { create } from 'zustand'
import { emptyWorkflow } from '../workflow/defaultWorkflow'
import { defaultDatasetId } from './useDataStore'
import { defaultParams, getNodeTypeDef, hasNodeType, producesFigure } from '../workflow/nodeRegistry'
import { isEngineNode } from '../engine/plan'
import { useNodeOutputStore } from './nodeOutputStore'
import type { OutputRefBody } from '../engine/protocol'
import {
  COLLECT_TYPE,
  isSyntheticPort,
  makeEdgeId,
  portsTrustworthy,
  resolveFigureUpstreamTable,
  resolvePorts,
  type PortContext,
} from '../workflow/ports'
import {
  buildCollectAsset,
  buildSourceAsset,
  makeRunId,
  nextAssetId,
} from './runAssets'
import { cancelNode as cancelNodeInEngine } from '../engine/backend'
import { requestNodeExecution } from '../engine/nodeExecutionControl'
import { figurePortId, resolveNodeChart } from './nodeChart'
import { recordCanvasHistory } from './canvasHistory'
import { useAnnotationStore } from './useAnnotationStore'
import {
  annotationGroupPath,
  annotationGroupPathExists,
  moveAnnotationsIntoGroup,
  removeGroupAnnotations,
  ungroupAnnotationScopes,
  wrapAnnotationScopes,
} from '../workflow/annotations'
import {
  buildClipboardPayload,
  pasteClipboardPayload,
  type ClipboardPayload,
} from '../workflow/clipboard'
import {
  createAnnotationGroup,
  createGroupFromSelection,
  replaceWorkflowAtGroupPath,
  runtimeIdMoves,
  runtimeNodeIdForPath,
  setWorkflowParam,
  setWorkflowParams,
  ungroupNode,
  workflowAtGroupPath,
} from '../workflow/groups'
import { repairArtifactNodeIds } from '../workflow/project'
import {
  LEGACY_TRAINING_PARAM_KEYS,
  usesRawTableTrainingProtocol,
} from '../workflow/functionSignature'
import type {
  NodeRunStatus,
  ParamSpec,
  Run,
  RunAsset,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from '../workflow/types'

/** 执行中断标志（同时只允许一个 Run） */
const cancelFlag = { current: false }

let nodeSeq = 0
let annotationCopySeq = 0

/**
 * 新节点 id。
 *
 * 前缀与批注（`a*`）分开是有意的：节点与批注会一起进 React Flow 的同一份 nodes 数组，
 * 撞了 id 就是"两个东西变成一个"，而那不会报错，只会有一块画布行为诡异。
 * "怎么造一个新块"只该有一处 —— 拖节点库、粘贴、以后任何加块的动作都走这里。
 */
function nextNodeId(): string {
  return `n${++nodeSeq}_${Date.now().toString(36).slice(-4)}`
}

/**
 * 新批注 id（复制/粘贴批注用）。传入的 `existing` 会被就地补充，因为一次粘贴里要生成好几个
 * id，它们之间也不能撞 —— 生成器只看得到图上原有的那些。
 */
function nextAnnotationCopyId(existing: Set<string>): string {
  let id = ''
  do {
    id = `a-copy${++annotationCopySeq}_${Date.now().toString(36).slice(-4)}`
  } while (existing.has(id))
  existing.add(id)
  return id
}

function activeWorkflow(state: Pick<State, 'workflow' | 'activeGroupPath'>): Workflow {
  return workflowAtGroupPath(state.workflow, state.activeGroupPath)
}

/**
 * 组块结构变了（封装 / 解散）：把按运行时 id 归属的模型制品引用搬到新 id 上。
 *
 * 与批注的 `groupPath` 是同一条纪律 —— 跟着层级走的东西必须一起更新。不搬的后果不是
 * "少算一次"，而是**训好的权重再也读不到**：引用写的是旧 id，节点下次求值找不到自己的
 * 制品，界面上只显示"等待开始训练"，没有任何线索说明为什么。
 */
function migrateModelArtifacts(moves: Map<string, string>): void {
  if (moves.size === 0) return
  const outputStore = useNodeOutputStore.getState()
  let changed = false
  const next = outputStore.modelArtifacts.map((ref) => {
    const to = moves.get(ref.nodeId)
    if (!to || to === ref.nodeId) return ref
    changed = true
    return { ...ref, nodeId: to }
  })
  if (changed) outputStore.setModelArtifacts(next)
}

/**
 * 复制出来的块：把原件的制品引用**照着复制一份**给副本（原件那份留着）。
 *
 * 与"搬家"不同：粘贴之后两个块都在。副本的内容与原件一样时指纹一样，那份权重本来就是
 * 这个计算的结果；改过代码或参数之后指纹变了，引用自然不再生效，不需要另加判断。
 */
function duplicateModelArtifacts(moves: Map<string, string>): void {
  if (moves.size === 0) return
  const outputStore = useNodeOutputStore.getState()
  const copies = outputStore.modelArtifacts.flatMap((ref) => {
    const to = moves.get(ref.nodeId)
    return to && to !== ref.nodeId ? [{ ...ref, nodeId: to }] : []
  })
  if (copies.length > 0) {
    outputStore.setModelArtifacts([...outputStore.modelArtifacts, ...copies])
  }
}

/** 一次粘贴的结果规模，给画布写提示与做选中用（数量而不是内容：界面不需要知道细节） */
export interface ClipboardPasteSummary {
  nodes: number
  edges: number
  annotations: number
  /** 这次粘出来的节点 id（按载荷顺序），供画布选中它们 */
  nodeIds: string[]
  annotationIds: string[]
  /** 复制时因跨选择边界没跟走的连线数。复制与粘贴可能不是同一个会话（跨标签页），所以由载荷带过来 */
  droppedEdges: number
}

interface State {
  /** 项目根图始终保存在这里；画布用 activeGroupPath 投影到要编辑的子图。 */
  workflow: Workflow
  activeGroupPath: string[]
  /**
   * 选中的节点。存数组而不是单值 —— 框选必须支持多选，
   * 参数面板取其中"最后选中"的那个作为主节点。
   */
  selectedNodeIds: string[]
  /**
   * 选中的连线。React Flow 走受控模式时不会自己记住边的 selected
   * （triggerEdgeChanges 只在 hasDefaultEdges 下写内部 store），
   * 必须由这里持有、再回写进 edges prop，否则边永远选不中、Delete 也删不掉。
   */
  selectedEdgeIds: string[]
  /** 临时展开的可选参数接线口；仅是画布视图状态。 */
  visibleParamPorts: string[]

  runs: Run[]
  activeRunId: string | null
  isRunning: boolean
  /** 1 = 真实感耗时，4 = 快进，0 = 立即完成 */
  speed: number

  /* 工作流编辑 */
  setWorkflow: (wf: Workflow) => void
  enterGroup: (id: string) => void
  setActiveGroupPath: (path: string[]) => void
  groupSelection: (ctx: PortContext) => string | null
  moveAnnotationsIntoGroup: (groupId: string) => void
  ungroupSelection: () => void
  /**
   * 把当前选中的块与批注打包成一份剪贴板载荷。**纯读取**，不改任何状态；没有可复制的就返回 null
   * （调用方据此不去动系统剪贴板）。传输见 `src/canvas/blockClipboard.ts`。
   */
  copySelection: () => ClipboardPayload | null
  /** 把载荷粘进当前编辑的子图（`origin` 是内容的落点）。返回本次粘进来的规模，供提示与选中 */
  pasteClipboard: (payload: ClipboardPayload, origin: { x: number; y: number }) => ClipboardPasteSummary | null
  renameWorkflow: (name: string) => void
  setDescription: (desc: string) => void
  addNode: (type: string, position: { x: number; y: number }) => string
  removeNode: (id: string) => void
  /** 移动一个工作流节点。拖谁就动谁 —— 块之间不再有吸附关系（2026-09-20 去掉） */
  moveNode: (id: string, position: { x: number; y: number }) => void
  renameNode: (id: string, label: string) => void
  setParam: (id: string, key: string, value: string | number | boolean) => void
  setParamNote: (id: string, key: string, note: string) => void
  toggleParamPort: (id: string, key: string) => void
  /** 根据自定义模型代码同步模型超参数；训练参数不受影响 */
  syncModelParams: (id: string, specs: ParamSpec[]) => void
  /** 根据训练函数签名同步动态参数，删除已从代码中移除的旧参数 */
  syncTrainingFunctionParams: (id: string, specs: ParamSpec[]) => void
  resetParams: (id: string) => void
  connect: (edge: Omit<WorkflowEdge, 'id'>) => void
  disconnect: (edgeId: string) => void
  /** 清理引用了不存在端口的连线（主要用于代码/拆列节点的动态端口） */
  pruneInvalidEdges: (ctx: PortContext) => void
  /**
   * 兼容旧的逐列数据源连线：换数据集时按列序映射到新特征。
   * 新工程的数据源只有整表端口，不需要调用此动作。
   */
  remapSourcePorts: (nodeId: string, oldFeatures: string[], newFeatures: string[]) => void
  /** 单选：点某个节点或点空白 */
  selectNode: (id: string | null) => void
  /** 整体替换选择集：框选走这里 */
  setNodeSelection: (ids: string[]) => void
  /** 整体替换选中的连线集合 */
  setEdgeSelection: (ids: string[]) => void

  /* 执行 */
  setSpeed: (n: number) => void
  runWorkflow: () => Promise<void>
  /** 只跑指定的节点（节点框上的「运行」按钮）。引擎算得出来的节点会被忽略 */
  runNodes: (ids: string[]) => Promise<void>
  cancelRun: () => void
  /** 请引擎停下某个节点（长任务）。返回 false = 当前执行面做不到 */
  cancelNode: (id: string) => boolean
  /** 显式启动一个高成本节点；当前用于 train.function。 */
  startNode: (id: string) => void
  /** 取消之后重跑一个节点：把指纹清掉，下一轮调度自然会重算它 */
  retryNode: (id: string) => void
  clearRuns: () => void
}

const emptyRun = (workflow: Workflow): Run => ({
  id: makeRunId(),
  workflowId: workflow.id,
  workflowName: workflow.name,
  startedAt: Date.now(),
  finishedAt: null,
  status: 'running',
  nodeStatus: Object.fromEntries(workflow.nodes.map((n) => [n.id, 'pending' as NodeRunStatus])),
  durations: {},
  assets: [],
  logs: [],
})

/**
 * 把数据面节点按真实规模登记成资产。
 *
 * 不这么做的话，资产库会凭空少掉"数据集""列拼表"这些条目 —— 而数据集条目的详情里
 * 有整套时序总览 / 列统计 / 时间轴校验，少掉它等于把一个功能藏起来了。
 *
 * 数据源规模来自导入存储；拼表与变换规模必须来自引擎真实输出摘要。
 *
 * 数据划分 / 分帧 / 增强 / 时域 / 频域这些变换节点不一样：它们的行列数由参数和上游
 * 数据共同决定，猜不出来，所以**必须等引擎真的算出来**才登记 —— 编一个占位规模出来
 * 正好是这套探针最反对的事。
 */
async function liveAssets(
  workflow: Workflow,
): Promise<{ assets: RunAsset[]; warnings: string[] }> {
  const out: RunAsset[] = []
  const warnings: string[] = []
  const store = useNodeOutputStore.getState()

  for (const node of workflow.nodes) {
    if (!isEngineNode(node.type)) continue

    if (node.type === 'data.source') {
      const asset = buildSourceAsset(node, {})
      if (asset) out.push(asset)
    } else if (node.type === COLLECT_TYPE) {
      const table = Object.values(store.refs[node.id] ?? {}).find((ref) => ref.kind === 'table')
      const asset = buildCollectAsset(node, table)
      if (asset) out.push(asset)
    } else if (producesFigure(node.type, node)) {
      // 图表与概率密度图走同一条路：图由引擎算出（抽稀后的点），这里只把它包成资产。
      // 判据是端口声明，不是类型名单 —— 加下一个出图算子不用回来补一处 if
      const r = await chartAsset(node, workflow)
      if (r.asset) out.push(r.asset)
      if (r.warning) warnings.push(r.warning)
    } else {
      out.push(...engineTransformAssets(node, store))
    }
  }
  return { assets: out, warnings }
}

/**
 * 图表节点的资产。
 *
 * "这张图该长什么样"的判断在 `store/nodeChart.ts`，与画布上那张缩略图共用一份。
 * 这里只多两件事：**等**（点「运行」时上游可能刚好在重算，缩略图可以下一轮再看，
 * 一次运行不能等）与**登记**（包成 RunAsset，并写上"图上的点 / 原始行数"那组数）。
 *
 * 原始行数用的是上游那张表自己的行数，不是这张抽样小表的 —— 拿后者会写成
 * "来自 5 999 行的抽稀"，把"这是一个抽样"这件事说反。
 */
async function chartAsset(
  node: WorkflowNode,
  workflow: Workflow,
): Promise<{ asset: RunAsset | null; warning?: string }> {
  const upstream = resolveFigureUpstreamTable(workflow, node.id)
  if (!upstream) {
    return {
      asset: null,
      warning: '未产出图：绘图块必须连接上游数据。把数据源或处理结果接入后，节点会直接出图。',
    }
  }
  await waitForTableRef(upstream.nodeId, upstream.portId)
  const figurePort = figurePortId(node)
  if (figurePort) await waitForTableRef(node.id, figurePort)

  const r = await resolveNodeChart(node, workflow, nextAssetId())
  if (r) {
    const asset: RunAsset = {
      id: r.chart.id,
      kind: 'figure',
      name: r.chart.name,
      nodeId: node.id,
      nodeLabel: node.label,
      nodeType: node.type,
      createdAt: Date.now(),
      chart: r.chart,
    }
    asset.summary = {
      数据来源: `上游「${upstream.label}」`,
      图上的点: r.points,
      原始行数: r.totalRows ?? r.points,
    }
    return { asset }
  }

  return {
    asset: null,
    warning:
      `未产出图：上游「${upstream.label}」这次没有算出表（可能还没算完，或它自己失败了）。`,
  }
}

/**
 * 等某个输出端口算出表来。
 *
 * 点「运行」时上游可能刚好在重算（引擎是防抖 + 多轮推进的），这一瞬间没有 ref 不代表
 * 接不上。等一小会儿，但引擎明确报了错/被阻断就立刻放弃 —— 那是等不来的。
 */
async function waitForTableRef(
  nodeId: string,
  portId: string,
  timeoutMs = 5000,
): Promise<OutputRefBody | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = useNodeOutputStore.getState()
    const ref = state.refs[nodeId]?.[portId]
    if (ref && (ref.kind === 'table' || ref.kind === 'figure')) return ref
    const status = state.runtimes[nodeId]?.status
    if (status === 'error' || status === 'blocked') return null
    if (Date.now() > deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * 引擎算出来的数据变换节点 → 资产。
 *
 * 名称与类别沿用节点自己的资产配方（分帧样本 / 数据划分 / 时域特征表…），
 * 行列数换成引擎的真实输出。少了这条，跑完整条链路后资产库里就凭空少掉这些条目。
 */
function engineTransformAssets(
  node: WorkflowNode,
  store: ReturnType<typeof useNodeOutputStore.getState>,
): RunAsset[] {
  const recipe = getNodeTypeDef(node.type).assetRecipes?.[0]
  if (!recipe) return []

  const refs = store.refs[node.id]
  if (!refs) return []
  const table = Object.values(refs).find((r) => r.kind === 'table')
  if (!table) return []

  return [
    {
      id: nextAssetId(),
      kind: recipe.kind,
      name: recipe.nameTemplate,
      nodeId: node.id,
      nodeLabel: node.label,
      nodeType: node.type,
      createdAt: Date.now(),
      table: { rows: table.rowCount ?? 0, cols: table.columns?.length ?? 0 },
    },
  ]
}

export const useWorkflowStore = create<State>((set, get) => {
  /** 就地更新当前 Run */
  const patchRun = (fn: (run: Run) => Run) => {
    const { runs, activeRunId } = get()
    if (!activeRunId) return
    set({ runs: runs.map((r) => (r.id === activeRunId ? fn(r) : r)) })
  }

  return {
    // 启动即空白画布，节点与数据都由用户显式添加
    workflow: emptyWorkflow('wf-blank'),
    activeGroupPath: [],
    selectedNodeIds: [],
    selectedEdgeIds: [],
    visibleParamPorts: [],
    runs: [],
    activeRunId: null,
    isRunning: false,
    speed: 4,

    /* ---------------- 工作流编辑 ---------------- */

    setWorkflow: (wf) => {
      recordCanvasHistory('workflow:set')
      useAnnotationStore.setState((state) => ({
        annotations: state.annotations.map((annotation) =>
          annotationGroupPathExists(wf, annotationGroupPath(annotation))
            ? annotation
            : { ...annotation, groupPath: [] },
        ),
        selectedIds: [],
      }))
      set({ workflow: wf, activeGroupPath: [], selectedNodeIds: [], selectedEdgeIds: [], visibleParamPorts: [] })
      /*
       * 整份换一张图（打开工程、YAML 导入、画布撤回 / 重做）时，按**节点身份**把制品引用
       * 重新对上：撤回一次封装，块从组块里回到本层，引用也得跟着回来 —— 不跟的话症状是
       * "撤回一下，训好的权重就读不到了"，而画布上看不出任何异常。
       *
       * 用"按身份重新对上"而不是"把引用整份换成快照里那份"：撤回之前可能又训过一次
       * （引用是新加的），整份回滚会把那份新引用一起抹掉。规则只此一处
       * （`repairArtifactNodeIds`，打开工程时也走它）；对不上的（比如撤回一次粘贴，
       * 副本那个块已经不在了）原样留着 —— 重做之后它还认得回来。
       */
      const outputStore = useNodeOutputStore.getState()
      const repaired = repairArtifactNodeIds(wf, outputStore.modelArtifacts, [])
      if (repaired.some((ref, index) => ref.nodeId !== outputStore.modelArtifacts[index]?.nodeId)) {
        outputStore.setModelArtifacts(repaired)
      }
    },

    enterGroup: (id) => {
      const current = activeWorkflow(get())
      if (!current.nodes.some((node) => node.id === id && node.group)) return
      useAnnotationStore.setState({ selectedIds: [] })
      set((s) => ({
        activeGroupPath: [...s.activeGroupPath, id],
        selectedNodeIds: [],
        selectedEdgeIds: [],
      }))
    },

    setActiveGroupPath: (path) =>
      set((s) => {
        // Не принимаем путь в несуществующий узел: это может произойти после undo/импорта.
        let current = s.workflow
        const valid: string[] = []
        for (const id of path) {
          const group = current.nodes.find((node) => node.id === id && node.group)
          if (!group?.group) break
          valid.push(id)
          current = group.group.workflow
        }
        useAnnotationStore.setState({ selectedIds: [] })
        return { activeGroupPath: valid, selectedNodeIds: [], selectedEdgeIds: [] }
      }),

    groupSelection: (ctx) => {
      const state = get()
      const current = activeWorkflow(state)
      const annotationState = useAnnotationStore.getState()
      const selectedAnnotations = annotationState.annotations.filter(
        (annotation) =>
          annotationState.selectedIds.includes(annotation.id) &&
          annotationGroupPath(annotation).length === state.activeGroupPath.length &&
          annotationGroupPath(annotation).every((id, index) => id === state.activeGroupPath[index]),
      )
      const id = `group${++nodeSeq}_${Date.now().toString(36).slice(-4)}`
      let result: ReturnType<typeof createGroupFromSelection>
      let selectedGroupIds = new Set<string>()
      if (state.selectedNodeIds.length > 0) {
        selectedGroupIds = new Set(
          current.nodes
            .filter((node) => state.selectedNodeIds.includes(node.id) && node.group)
            .map((node) => node.id),
        )
        result = createGroupFromSelection(current, state.selectedNodeIds, ctx, id)
      } else {
        if (selectedAnnotations.length === 0) return null
        const position = {
          x: selectedAnnotations.reduce((sum, item) => sum + item.position.x, 0) / selectedAnnotations.length,
          y: selectedAnnotations.reduce((sum, item) => sum + item.position.y, 0) / selectedAnnotations.length,
        }
        result = createAnnotationGroup(current, id, position)
      }
      recordCanvasHistory(`workflow:group:${id}`)
      set((s) => ({
        workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, () => result.workflow),
        selectedNodeIds: [id],
        selectedEdgeIds: [],
      }))
      // 被封装进去的每个块（连同它内部的节点）运行时 id 都多了一层组路径：制品引用跟着搬
      const moves = new Map<string, string>()
      for (const moved of current.nodes.filter((node) => state.selectedNodeIds.includes(node.id))) {
        for (const [from, to] of runtimeIdMoves(moved, state.activeGroupPath, [...state.activeGroupPath, id])) {
          moves.set(from, to)
        }
      }
      migrateModelArtifacts(moves)
      const selectedAnnotationIds = new Set(selectedAnnotations.map((annotation) => annotation.id))
      useAnnotationStore.setState((s) => ({
        annotations: wrapAnnotationScopes(
          s.annotations,
          state.activeGroupPath,
          id,
          selectedAnnotationIds,
          selectedGroupIds,
        ),
        selectedIds: [],
      }))
      return id
    },

    moveAnnotationsIntoGroup: (groupId) => {
      const state = get()
      const target = activeWorkflow(state).nodes.find((node) => node.id === groupId && node.group)
      if (!target?.group) return
      const annotationState = useAnnotationStore.getState()
      const selected = annotationState.annotations.filter(
        (annotation) =>
          annotationState.selectedIds.includes(annotation.id) &&
          annotationGroupPath(annotation).length === state.activeGroupPath.length &&
          annotationGroupPath(annotation).every((id, index) => id === state.activeGroupPath[index]),
      )
      if (selected.length === 0) return
      recordCanvasHistory(`annotation:move-into-group:${groupId}`)
      const ids = new Set(selected.map((annotation) => annotation.id))
      useAnnotationStore.setState((s) => ({
        annotations: moveAnnotationsIntoGroup(s.annotations, ids, state.activeGroupPath, groupId),
        selectedIds: [],
      }))
      set({ selectedNodeIds: [groupId], selectedEdgeIds: [] })
    },

    ungroupSelection: () => {
      const state = get()
      const id = state.selectedNodeIds[state.selectedNodeIds.length - 1]
      const groupNode = id
        ? activeWorkflow(state).nodes.find((node) => node.id === id && node.group)
        : undefined
      if (!id || !groupNode?.group) return
      // 先计算工作流结果：无效的手工组定义可能令 ungroupNode 抛错，失败时批注也必须留在原层级。
      const workflow = replaceWorkflowAtGroupPath(state.workflow, state.activeGroupPath, (current) => ungroupNode(current, id))
      recordCanvasHistory(`workflow:ungroup:${id}`)
      // 解散：组内每个块（连同更深层）都少了一层组路径，制品引用同样跟着搬回去
      const moves = new Map<string, string>()
      for (const child of groupNode.group.workflow.nodes) {
        for (const [from, to] of runtimeIdMoves(
          child,
          [...state.activeGroupPath, id],
          state.activeGroupPath,
        )) {
          moves.set(from, to)
        }
      }
      migrateModelArtifacts(moves)
      useAnnotationStore.setState((s) => ({
        annotations: ungroupAnnotationScopes(s.annotations, state.activeGroupPath, id),
        selectedIds: [],
      }))
      set({
        workflow,
        selectedNodeIds: [],
        selectedEdgeIds: [],
      })
    },

    /*
     * 「复制组块」这条专用路径在 2026-09-21 并进了通用的复制粘贴（CANVAS-9）：
     * 组块复制不再有第二份实现，它只是"选择里有组块"的那一个用例。
     */
    copySelection: () => {
      const state = get()
      return buildClipboardPayload(
        activeWorkflow(state),
        useAnnotationStore.getState().annotations,
        state.activeGroupPath,
        state.selectedNodeIds,
        useAnnotationStore.getState().selectedIds,
      )
    },

    pasteClipboard: (payload, origin) => {
      const state = get()
      const annotationState = useAnnotationStore.getState()
      const existingAnnotationIds = new Set(annotationState.annotations.map((annotation) => annotation.id))
      // 先算再记历史：粘贴失败时不该留下一步"什么都不做"的撤回
      const result = pasteClipboardPayload(payload, {
        workflow: activeWorkflow(state),
        annotations: annotationState.annotations,
        path: state.activeGroupPath,
        origin,
        isKnownType: hasNodeType,
        ids: {
          node: nextNodeId,
          annotation: () => nextAnnotationCopyId(existingAnnotationIds),
        },
      })
      if (!result) return null
      recordCanvasHistory('workflow:paste')
      set((s) => ({
        workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, () => result.workflow),
        // 粘出来的东西成为唯一选中：接着拖/改的就是刚粘的那一批
        selectedNodeIds: result.nodes.map((node) => node.id),
        selectedEdgeIds: [],
      }))
      useAnnotationStore.setState({
        annotations: result.annotations,
        selectedIds: result.annotationIds,
      })
      /*
       * 粘出来的块如果内容和原件一样（代码、参数、上游身份都没变），指纹就一样 ——
       * 那份权重本来就是这个计算的结果，跟着搬过去，别让人为了一个副本再训一次。
       * 指纹对不上时引用自然不会生效，这里不需要另加判断。
       */
      const moves = new Map<string, string>()
      for (const entry of payload.nodes) {
        const renamed = (nodeId: string) => result.nodeIdMap.get(nodeId) ?? nodeId
        const source = { ...entry.node, id: entry.id }
        for (const [from, to] of runtimeIdMoves(source, payload.from, state.activeGroupPath, renamed)) {
          moves.set(from, to)
        }
      }
      duplicateModelArtifacts(moves)
      return {
        nodes: result.nodes.length,
        edges: result.edges.length,
        annotations: result.annotationIds.length,
        nodeIds: result.nodes.map((node) => node.id),
        annotationIds: result.annotationIds,
        droppedEdges: payload.droppedEdges,
      }
    },

    renameWorkflow: (name) => {
      recordCanvasHistory('workflow:name')
      set((s) => ({ workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({ ...graph, name })) }))
    },

    setDescription: (description) => {
      recordCanvasHistory('workflow:description')
      set((s) => ({ workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({ ...graph, description })) }))
    },

    addNode: (type, position) => {
      const def = getNodeTypeDef(type)
      const id = nextNodeId()
      const params = defaultParams(def)
      // 数据源默认绑定最近导入的数据；绘图节点必须通过画布连线明确选择数据来源。
      const preferred = defaultDatasetId()
      if (type === 'data.source' && preferred) params.datasetId = preferred
      const node: WorkflowNode = { id, type, label: def.label, params, position }
      recordCanvasHistory(`workflow:add:${id}`)
      // 新加的节点是唯一选中：批注那边留着选中，拖动这个节点会把那条批注也拖走
      useAnnotationStore.getState().setSelection([])
      set((s) => ({
        workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({
          ...graph,
          nodes: [...graph.nodes, node],
        })),
        selectedNodeIds: [id],
      }))
      return id
    },

    removeNode: (id) => {
      const state = get()
      const node = activeWorkflow(state).nodes.find((n) => n.id === id)
      if (!node) return
      recordCanvasHistory(`workflow:remove:${id}`)
      useAnnotationStore.setState((s) => {
        // 组块被删时连带它内部那一层（含嵌套组）的批注；普通节点没有"内部的批注"
        const kept = node.group
          ? removeGroupAnnotations(s.annotations, state.activeGroupPath, id)
          : s.annotations
        const alive = new Set(kept.map((annotation) => annotation.id))
        const selectedIds = s.selectedIds.filter((selectedId) => alive.has(selectedId))
        if (kept === s.annotations && selectedIds.length === s.selectedIds.length) return s
        return { annotations: kept, selectedIds }
      })
      set((s) => {
        const next = replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => {
          const edges = graph.edges.filter((e) => e.source !== id && e.target !== id)
          return {
            ...graph,
            nodes: graph.nodes.filter((n) => n.id !== id),
            edges,
          }
        })
        const edges = workflowAtGroupPath(next, s.activeGroupPath).edges
        const alive = new Set(edges.map((e) => e.id))
        return {
          workflow: next,
          selectedNodeIds: s.selectedNodeIds.filter((x) => x !== id),
          // 边 id 由端口拼成、可复现，残留的选中 id 会把重连后的新边误标为选中
          selectedEdgeIds: s.selectedEdgeIds.filter((x) => alive.has(x)),
        }
      })
    },

    moveNode: (id, position) => {
      recordCanvasHistory(`workflow:move:${id}`)
      set((s) => ({
        workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({
          ...graph,
          nodes: graph.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
        })),
      }))
    },

    renameNode: (id, label) => {
      recordCanvasHistory(`workflow:rename:${id}`)
      set((s) => ({
        workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({
          ...graph,
          nodes: graph.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
        })),
      }))
    },

    setParam: (id, key, value) => {
      recordCanvasHistory(`workflow:param:${id}:${key}`)
      set((s) => ({ workflow: setWorkflowParam(s.workflow, s.activeGroupPath, id, key, value) }))
    },

    setParamNote: (id, key, note) => {
      const trimmed = note.slice(0, 80)
      recordCanvasHistory(`workflow:param-note:${id}:${key}`)
      set((s) => ({
        workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({
          ...graph,
          nodes: graph.nodes.map((node) => {
            if (node.id !== id) return node
            const paramNotes = { ...node.paramNotes }
            if (trimmed.trim()) paramNotes[key] = trimmed
            else delete paramNotes[key]
            return { ...node, paramNotes }
          }),
        })),
      }))
    },

    toggleParamPort: (id, key) => set((s) => {
      const portKey = JSON.stringify([...s.activeGroupPath, id, key])
      const visible = new Set(s.visibleParamPorts)
      if (visible.has(portKey)) visible.delete(portKey)
      else visible.add(portKey)
      return { visibleParamPorts: [...visible] }
    }),

    syncModelParams: (id, specs) => {
      const current = activeWorkflow(get()).nodes.find((node) => node.id === id)
      if (!current || current.type !== 'custom.model') return
      const fixedKeys = new Set(getNodeTypeDef(current.type).params.map((param) => param.key))
      const modelKeys = new Set(specs.map((spec) => spec.key))
      const nextParams: Record<string, string | number | boolean> = {}
      for (const [key, value] of Object.entries(current.params)) {
        if (fixedKeys.has(key) || modelKeys.has(key)) nextParams[key] = value
      }
      for (const spec of specs) {
        if (nextParams[spec.key] === undefined && !spec.required) nextParams[spec.key] = spec.default
      }
      if (JSON.stringify(nextParams) === JSON.stringify(current.params)) return
      recordCanvasHistory(`workflow:model-params-sync:${id}`)
      set((s) => ({
        workflow: setWorkflowParams(s.workflow, s.activeGroupPath, id, nextParams, { replace: true }),
      }))
    },

    syncTrainingFunctionParams: (id, specs) => {
      const current = activeWorkflow(get()).nodes.find((node) => node.id === id)
      if (!current || current.type !== 'train.function') return
      const fixedKeys = new Set(getNodeTypeDef(current.type).params.map((param) => param.key))
      if (!usesRawTableTrainingProtocol(String(current.params.code ?? ''))) {
        for (const key of LEGACY_TRAINING_PARAM_KEYS) fixedKeys.add(key)
      }
      const dynamicKeys = new Set(specs.map((spec) => spec.key))
      const nextParams: Record<string, string | number | boolean> = {}
      for (const [key, value] of Object.entries(current.params)) {
        if (fixedKeys.has(key) || dynamicKeys.has(key)) nextParams[key] = value
      }
      for (const spec of specs) {
        if (nextParams[spec.key] === undefined && !spec.required) nextParams[spec.key] = spec.default
      }
      if (JSON.stringify(nextParams) === JSON.stringify(current.params)) return
      recordCanvasHistory(`workflow:train-function-params-sync:${id}`)
      set((s) => ({
        workflow: setWorkflowParams(s.workflow, s.activeGroupPath, id, nextParams, { replace: true }),
      }))
    },

    resetParams: (id) => {
      recordCanvasHistory(`workflow:params-reset:${id}`)
      set((s) => {
        const node = activeWorkflow(s).nodes.find((candidate) => candidate.id === id)
        /*
         * 组块：「恢复默认」改的是对外参数，内部副本跟着一起回到默认值 —— 它们是
         * 同一个值的两个视图（见 `setWorkflowParams`）。
         * 普通节点：整份替换成该类型的默认参数，这是「恢复默认」本来的语义。
         */
        if (node?.group) {
          const defaults: Record<string, string | number | boolean> = {}
          for (const parameter of node.group.parameters) defaults[parameter.key] = parameter.spec.default
          return {
            workflow: setWorkflowParams(s.workflow, s.activeGroupPath, id, defaults, { replace: true }),
          }
        }
        return {
          workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({
            ...graph,
            nodes: graph.nodes.map((n) =>
              n.id === id ? { ...n, params: defaultParams(getNodeTypeDef(n.type)) } : n,
            ),
          })),
        }
      })
    },

    connect: (edge) => {
      const id = makeEdgeId(edge.source, edge.sourcePort, edge.target, edge.targetPort)
      if (activeWorkflow(get()).edges.some((e) => e.id === id)) return
      recordCanvasHistory(`workflow:connect:${id}`)
      set((s) => {
        if (activeWorkflow(s).edges.some((e) => e.id === id)) return {}
        const next = replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => {
          const edges = [...graph.edges, { ...edge, id }]
          return { ...graph, edges }
        })
        // 只加一条边，不动任何节点参数。以前这里有一段"接满槽位就自动加一个槽"的魔法，
        // 那是为了让"列拼表"这个要手填列数的节点能用得下去；现在它是多入端口（R13），
        // 接几路就是几路，不需要有人替用户改图。
        return { workflow: next }
      })
    },

    pruneInvalidEdges: (ctx) => {
      set((s) => {
        const graph = activeWorkflow(s)
        const alive = graph.edges.filter((e) => {
          const src = graph.nodes.find((n) => n.id === e.source)
          const dst = graph.nodes.find((n) => n.id === e.target)
          if (!src || !dst) return false
          // 端口列表"算不出来"和"端口被删了"长得一样，但只有后者该清线。
          // 前者（数据源还没绑数据集 / 函数代码还没写好）一律留着 ——
          // 否则导入一份 YAML 就会把用户搭好的线静默删掉，且再也长不回来。
          if (!portsTrustworthy(src, ctx) || !portsTrustworthy(dst, ctx)) return true
          const outOk = resolvePorts(src, ctx).outputs.some((p) => p.id === e.sourcePort)
          const inOk = resolvePorts(dst, ctx).inputs.some((p) => p.id === e.targetPort)
          return outOk && inOk
        })
        // 没变化就返回空对象，否则 effect 会陷入死循环
        if (alive.length === graph.edges.length) return {}
        return { workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (current) => ({ ...current, edges: alive })) }
      })
    },

    remapSourcePorts: (nodeId, oldFeatures, newFeatures) => {
      set((s) => {
        const graph = activeWorkflow(s)
        const posOf = new Map(oldFeatures.map((f, i) => [f, i]))
        const edges = graph.edges.flatMap((e) => {
          if (e.source !== nodeId) return [e]
          // 合成端口（整表 / 时间轴）与列名无关，换数据集后原样保留
          if (isSyntheticPort(e.sourcePort)) return [e]
          const i = posOf.get(e.sourcePort)
          // 旧端口不在这份数据里，或新数据集特征更少 → 这条线留不住
          if (i === undefined) return []
          const next = newFeatures[i]
          if (!next) return []
          return [{ ...e, sourcePort: next, id: makeEdgeId(e.source, next, e.target, e.targetPort) }]
        })
        if (edges.length === graph.edges.length && edges.every((e, i) => e.id === graph.edges[i].id)) {
          return {}
        }
        return { workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (current) => ({ ...current, edges })) }
      })
    },

    disconnect: (edgeId) => {
      if (!activeWorkflow(get()).edges.some((e) => e.id === edgeId)) return
      recordCanvasHistory(`workflow:disconnect:${edgeId}`)
      set((s) => ({
        workflow: replaceWorkflowAtGroupPath(s.workflow, s.activeGroupPath, (graph) => ({
          ...graph,
          edges: graph.edges.filter((e) => e.id !== edgeId),
        })),
        selectedEdgeIds: s.selectedEdgeIds.filter((x) => x !== edgeId),
      }))
    },

    selectNode: (id) => set({ selectedNodeIds: id ? [id] : [] }),

    setNodeSelection: (ids) =>
      set((s) => {
        // 内容相同就不更新，否则 React Flow 的 select 变化会引发死循环
        if (ids.length === s.selectedNodeIds.length && ids.every((x, i) => x === s.selectedNodeIds[i])) {
          return {}
        }
        return { selectedNodeIds: ids }
      }),

    setEdgeSelection: (ids) =>
      set((s) => {
        // 同上：内容相同必须返回空对象
        if (ids.length === s.selectedEdgeIds.length && ids.every((x, i) => x === s.selectedEdgeIds[i])) {
          return {}
        }
        return { selectedEdgeIds: ids }
      }),

    /* ---------------- 执行 ---------------- */

    setSpeed: (speed) => set({ speed }),

    cancelRun: () => {
      cancelFlag.current = true
      set({ isRunning: false })
    },

    cancelNode: (id) => {
      /*
       * 只把请求送出去，**不在这里改界面状态**。
       *
       * 引擎要跑到下一个可中断点才真的停（训练是一步一步看的），这中间节点还是
       * "正在算"。立刻把它改成"已取消"就是撒谎，而且会让"根本没停下来"这件事
       * 变得看不见 —— 界面上说取消了，后台还在烧 GPU。
       */
      const runtimeId = runtimeNodeIdForPath(get().activeGroupPath, id)
      return cancelNodeInEngine(runtimeId)
    },

    startNode: (id) => {
      const state = get()
      const node = activeWorkflow(state).nodes.find((candidate) => candidate.id === id)
      if (!node || node.type !== 'train.function') return
      const runtimeId = runtimeNodeIdForPath(state.activeGroupPath, id)
      const outputStore = useNodeOutputStore.getState()
      const runtime = outputStore.runtimes[runtimeId] ?? {
        status: 'idle' as const,
        outputVersion: 0,
        inputsFingerprint: null,
      }
      const { error: _error, progress: _progress, reused: _reused, ...rest } = runtime
      requestNodeExecution(runtimeId, { force: true })
      outputStore.setRefs(runtimeId, {}, runtime.outputVersion)
      outputStore.setRuntime(runtimeId, {
        ...rest,
        status: 'idle',
        inputsFingerprint: null,
      })
    },

    retryNode: (id) => {
      // 取消时刻意记下了"这次试过什么输入"（见核里那段注释），所以重跑必须显式
      // 把指纹清掉：否则下一轮调度会认为它已经算过，按钮按下去什么都不会发生
      const state = get()
      const runtimeId = runtimeNodeIdForPath(state.activeGroupPath, id)
      const runtime = useNodeOutputStore.getState().runtimes[runtimeId]
      if (!runtime || runtime.status !== 'cancelled') return
      const node = activeWorkflow(state).nodes.find((candidate) => candidate.id === id)
      if (node?.type === 'train.function') {
        get().startNode(id)
        return
      }
      useNodeOutputStore.getState().setRuntime(runtimeId, {
        ...runtime,
        status: 'idle',
        inputsFingerprint: null,
        progress: undefined,
      })
    },

    clearRuns: () => set({ runs: [], activeRunId: null }),

    runWorkflow: async () => {
      await get().runNodes(get().workflow.nodes.map((n) => n.id))
    },

    runNodes: async (ids) => {
      if (get().isRunning) return
      const workflow = get().workflow
      // 所有产品节点都由真实执行引擎计算。运行按钮只刷新真实资产登记，
    // 只登记真实引擎产物，不生成模板或占位数据。
      void ids
      if (workflow.nodes.length === 0) return

      cancelFlag.current = false
      const run = emptyRun(workflow)
      // 把已有 Run 的节点状态清空，避免上一次的颜色残留
      set((s) => ({ runs: [run, ...s.runs].slice(0, 20), activeRunId: run.id, isRunning: true }))

      const outputStore = useNodeOutputStore.getState()
      const nodeStatus: Record<string, NodeRunStatus> = Object.fromEntries(
        workflow.nodes.map((node) => {
          const status = outputStore.runtimes[node.id]?.status
          return [node.id, status === 'ready' ? 'done' : status === 'error' ? 'failed' : 'idle']
        }),
      )
      const live = await liveAssets(workflow)
      patchRun((r) => ({
        ...r,
        status: Object.values(nodeStatus).some((status) => status === 'failed') ? 'failed' : 'done',
        finishedAt: Date.now(),
        nodeStatus,
        assets: live.assets,
        logs: live.warnings.map((message) => ({
          at: Date.now(),
          nodeId: null,
          level: 'warn' as const,
          message,
        })),
      }))
      set({ isRunning: false })
    },
  }
})

/* ---------------- 选择器 ---------------- */

export function useActiveRun(): Run | null {
  const runs = useWorkflowStore((s) => s.runs)
  const activeRunId = useWorkflowStore((s) => s.activeRunId)
  return runs.find((r) => r.id === activeRunId) ?? null
}

export function useSelectedNode(): WorkflowNode | null {
  const nodes = useWorkflowStore((s) => activeWorkflow(s).nodes)
  const ids = useWorkflowStore((s) => s.selectedNodeIds)
  // 多选时以最后选中的那个作为参数面板的主节点
  const id = ids.length > 0 ? ids[ids.length - 1] : null
  return nodes.find((n) => n.id === id) ?? null
}

/** 画布、属性面板与节点库读取当前正在编辑的图；保存和运行始终读取根 `workflow`。 */
export function useEditingWorkflow(): Workflow {
  return useWorkflowStore((s) => activeWorkflow(s))
}

/** 参数面板要用的主选中节点 id */
export function usePrimarySelectedId(): string | null {
  return useWorkflowStore((s) => (s.selectedNodeIds.length ? s.selectedNodeIds[s.selectedNodeIds.length - 1] : null))
}
