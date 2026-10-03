import {
  activeBackend,
  cancelNode,
  dropNode,
  ensureEngine,
  engineStatus,
  evalNode,
  loadFn,
  onNodeProgress,
  onEngineStatus,
  primeBackend,
  setDataset,
} from './backend'
import {
  finishNodeExecution,
  forgetNodeExecution,
  nodeExecutionForcesTraining,
  nodeExecutionRequested,
  onNodeExecutionRequest,
} from './nodeExecutionControl'
import { isEngineNode, selectModelArtifact } from './plan'
import { expandWorkflowGroups, runtimeNodeIdForPath, WORKFLOW_GROUP_TYPE } from '../workflow/groups'
import { operatorFactsOf } from '../workflow/operatorFacts'
import { buildPortContext } from './portContext'
import { buildDatasetRef, type DatasetRef } from '../kernel/dataset'
import { runGraph } from '../kernel/kernel'
import { featuresOf, getStoredDataset, timeColumnOf, useDataStore } from '../store/useDataStore'
import { useWorkflowStore } from '../store/useWorkflowStore'
import { useNodeOutputStore } from '../store/nodeOutputStore'
import type { ProjectModelArtifactRef } from '../workflow/project'
import type { DatasetLookup, KernelAdapter } from '../kernel/types'
import type { Workflow, WorkflowGroupDefinition, WorkflowNode } from '../workflow/types'
import type { NodeRuntime, OutputRefBody } from './protocol'
import type { StoredDataset } from '../data/columnStore'
import type { DatasetPayload, PreviewTable } from './protocol'

/**
 * 调度器：**界面侧的薄壳**。
 *
 * 真正"算出这张图"的逻辑在 `src/kernel/kernel.ts`，与无头 CLI 共用同一份。
 * 这里只剩界面这一侧的事：订阅 store、防抖、把 store 里的数据绑成核需要的依赖、
 * 再把核回调出来的结果写回 store。
 *
 * 这样做不是为了少写代码，而是为了**只有一处调度**。此前这里是一份独立实现，
 * 于是 agent 那条路要么再写一份（两份迟早不一致），要么根本走不通 —— 事实是后者：
 * 这个文件直接 import 了 store 与浏览器侧的适配器选址，无头环境里跑不起来。
 */

const DEBOUNCE_MS = 300

/** 执行适配器。核只认这个形状，不认"Pyodide 还是本地宿主" */
const adapter: KernelAdapter = {
  ensureReady: async () => {
    await ensureEngine()
    return engineStatus().detail
  },
  setDataset,
  loadFn,
  evalNode,
  dropNode,
  cancelNode,
  onNodeProgress,
  // 核本身不取行值（那是探针的事）。给一个说得清的失败，好过静默返回空表
  head: async (nodeId: string, portId: string): Promise<PreviewTable> => {
    throw new Error(`调度器不负责取行值（${nodeId}:${portId}）`)
  },
}

/**
 * 数据集身份缓存。
 *
 * 内容哈希要读完所有列的字节（100 万行 × 10 列约 40MB），而它在一次会话里不会变：
 * 导入时生成新的 id，内容之后不再改动（列开关变的是"视图"，不进哈希）。
 * 所以按 `id:importedAt` 缓存，重复运行只算一次。
 */
const refCache = new Map<string, DatasetRef>()

async function datasetLookup(workflow: {
  nodes: { type: string; params: Record<string, unknown> }[]
}): Promise<DatasetLookup> {
  const refs = new Map<string, DatasetRef>()
  const ids = new Set(
    workflow.nodes
      .filter((n) => n.type === 'data.source')
      .map((n) => String(n.params.datasetId ?? ''))
      .filter(Boolean),
  )
  for (const id of ids) {
    const ds = getStoredDataset(id)
    if (!ds) continue
    const key = `${ds.id}:${ds.importedAt}`
    let ref = refCache.get(key)
    if (!ref) {
      ref = await buildDatasetRef(ds)
      refCache.set(key, ref)
    }
    // Keep the stable ID used by the workflow in the execution catalog; the stored
    // dataset may have a session-local import ID resolved by getStoredDataset().
    refs.set(id, ref.id === id ? ref : { ...ref, id })
  }
  return {
    has: (id) => !!getStoredDataset(id),
    ref: (id) => refs.get(id),
    featuresOf,
    timeColumnOf,
    payload: (id) => {
      const ds = getStoredDataset(id)
      return ds ? payloadOf(ds, id) : undefined
    },
  }
}

/**
 * 送进引擎的载荷。
 *
 * 只送启用的数值列：没启用的列不进 Python，省内存也避免误用。
 * 这条与核里的 `DatasetCatalog.payload` 是同一条规则 —— 两边都必须如此，
 * 因为"哪些列进引擎"决定了图里能连什么线。
 */
function payloadOf(ds: StoredDataset, datasetId = ds.id): DatasetPayload {
  const data: Record<string, Float32Array> = {}
  for (const c of ds.columns) {
    if (!c.enabled || c.type !== 'number') continue
    if (!(c.name in ds.data)) continue
    data[c.name] = ds.data[c.name]
  }
  return {
    datasetId,
    rowCount: ds.rowCount,
    timeColumn: ds.timeColumn,
    time: ds.time,
    data,
  }
}

/** 仅查当前 `.sciviz` 明确保存的引用；相同指纹有多次随机训练时取最近保存的一次。 */
function modelArtifactForNode(nodeId: string, fingerprint: string) {
  if (nodeExecutionForcesTraining(nodeId)) return undefined
  /*
   * 挑选规则在 `plan.ts`：比的是**同一个计算的身份**，位置（块在根层还是在组块里）
   * 不算内容（契约规格 R5.4/R5.5）。CLI 的无头运行调的是同一个函数 ——
   * 两条路各写一份的结果是"界面能恢复、命令行却白训一遍"。
   */
  return selectModelArtifact(useNodeOutputStore.getState().modelArtifacts, nodeId, fingerprint)
}

function recordArtifactReference(nodeId: string, runtime: import('./protocol').NodeRuntime): void {
  if (runtime.status !== 'ready') return
  const manifest = runtime.artifacts?.find((artifact) => artifact.kind === 'meta' && artifact.artifactId)
  if (!manifest?.artifactId || !manifest.fingerprint || !manifest.sha256 || !manifest.createdAt) return
  const reference: ProjectModelArtifactRef = {
    nodeId,
    artifactId: manifest.artifactId,
    trainingFingerprint: manifest.fingerprint,
    manifestSha256: manifest.sha256,
    createdAt: manifest.createdAt,
  }
  useNodeOutputStore.getState().recordModelArtifact(reference)
}

let running = false
let reschedule = false
/** 上一轮见过的节点 id。用来在节点被删掉时回收引擎侧的产出 */
let lastNodeIds = new Set<string>()

interface GroupOutputAlias {
  portId: string
  nodeId: string
  sourcePortId: string
}

interface GroupRuntimeInfo {
  nodeId: string
  descendants: string[]
  outputs: GroupOutputAlias[]
}

function resolveGroupOutput(
  node: WorkflowNode,
  portId: string,
  path: readonly string[],
  depth = 0,
): { nodeId: string; portId: string } {
  if (depth > 32) throw new Error('组块嵌套超过最大深度 32')
  if (node.type !== WORKFLOW_GROUP_TYPE) {
    return { nodeId: runtimeNodeIdForPath(path, node.id), portId }
  }
  const output = node.group?.outputs.find((entry) => entry.id === portId)
  if (!output || !node.group) throw new Error(`组块「${node.label}」缺少输出映射「${portId}」`)
  const source = node.group.workflow.nodes.find((entry) => entry.id === output.sourceNodeId)
  if (!source) throw new Error(`组块「${node.label}」的输出映射引用了不存在的内部节点`)
  return resolveGroupOutput(source, output.sourcePortId, [...path, node.id], depth + 1)
}

function collectGroupRuntimeInfo(workflow: Workflow): GroupRuntimeInfo[] {
  const result: GroupRuntimeInfo[] = []
  const visit = (current: Workflow, path: readonly string[]): string[] => {
    const currentLeaves: string[] = []
    for (const node of current.nodes) {
      if (node.type !== WORKFLOW_GROUP_TYPE) {
        currentLeaves.push(runtimeNodeIdForPath(path, node.id))
        continue
      }
      const group: WorkflowGroupDefinition | undefined = node.group
      if (!group) continue
      const descendants = visit(group.workflow, [...path, node.id])
      const outputs = group.outputs.map((output) => {
        const source = group.workflow.nodes.find((entry) => entry.id === output.sourceNodeId)
        if (!source) return null
        const resolved = resolveGroupOutput(source, output.sourcePortId, [...path, node.id])
        return { portId: output.id, nodeId: resolved.nodeId, sourcePortId: resolved.portId }
      }).filter((entry): entry is GroupOutputAlias => entry !== null)
      result.push({
        nodeId: runtimeNodeIdForPath(path, node.id),
        descendants,
        outputs,
      })
      currentLeaves.push(...descendants)
    }
    return currentLeaves
  }
  visit(workflow, [])
  return result
}

function aggregateGroupRuntime(
  info: GroupRuntimeInfo,
  current: Record<string, NodeRuntime>,
): NodeRuntime {
  const children = info.descendants.map((id) => current[id]).filter(Boolean)
  const outputVersion = children.reduce((max, child) => Math.max(max, child.outputVersion), 0)
  const computing = children.find((child) => child.status === 'computing')
  if (computing) return { ...computing, outputVersion, inputsFingerprint: null }
  const failed = children.find((child) => child.status === 'error')
  if (failed) return { ...failed, outputVersion, inputsFingerprint: null }
  const blocked = children.find((child) => child.status === 'blocked')
  if (blocked) return { ...blocked, outputVersion, inputsFingerprint: null }
  const cancelled = children.find((child) => child.status === 'cancelled')
  if (cancelled) return { ...cancelled, outputVersion, inputsFingerprint: null }
  const manual = children.find((child) => child.status === 'manual')
  if (manual) return { ...manual, outputVersion, inputsFingerprint: null }
  return {
    status: children.length > 0 && children.every((child) => child.status === 'ready') ? 'ready' : 'idle',
    outputVersion,
    inputsFingerprint: null,
  }
}

function aliasedGroupRefs(
  info: GroupRuntimeInfo,
  refsByNode: Record<string, Record<string, OutputRefBody>>,
): Record<string, OutputRefBody> {
  const aliases: Record<string, OutputRefBody> = {}
  for (const output of info.outputs) {
    const value = refsByNode[output.nodeId]?.[output.sourcePortId]
    if (value) aliases[output.portId] = value
  }
  return aliases
}

function setGroupRefsIfChanged(
  nodeId: string,
  refs: Record<string, OutputRefBody>,
  version: number,
): void {
  const current = useNodeOutputStore.getState().refs[nodeId] ?? {}
  const currentKeys = Object.keys(current).sort()
  const nextKeys = Object.keys(refs).sort()
  if (
    currentKeys.length === nextKeys.length &&
    currentKeys.every((key, index) => {
      const next = refs[nextKeys[index]]
      return key === nextKeys[index] && JSON.stringify(current[key]) === JSON.stringify({ ...next, version })
    })
  ) return
  useNodeOutputStore.getState().setRefs(nodeId, refs, version)
}

function setGroupRuntimeIfChanged(nodeId: string, runtime: NodeRuntime): void {
  const current = useNodeOutputStore.getState().runtimes[nodeId]
  if (JSON.stringify(current) === JSON.stringify(runtime)) return
  useNodeOutputStore.getState().setRuntime(nodeId, runtime)
}

function groupOutputVersion(info: GroupRuntimeInfo): number {
  const runtimes = useNodeOutputStore.getState().runtimes
  return info.descendants.reduce((max, id) => Math.max(max, runtimes[id]?.outputVersion ?? 0), 0)
}

async function runPlan(): Promise<void> {
  if (running) {
    reschedule = true
    return
  }
  running = true
  try {
    try {
      await runPlanOnce()
      reportGraphError(null)
    } catch (error) {
      /*
       * 图本身有结构问题（组块边界、内部映射、id 重复…）时，展开会抛异常。
       * **绝不能就这样算了**：展开在每一轮调度的开头，异常一抛，整张画布一个块都算不了，
       * 而用户看到的是"所有块都空着，谁也没说为什么"——实测踩到过一条悬空的组块参数绑定，
       * 打开工程后整张图再也不出数，一句解释都没有。这里把原因留在画布上。
       */
      const message = error instanceof Error ? error.message : String(error)
      reportGraphError(message)
    }
  } finally {
    running = false
    if (reschedule) {
      reschedule = false
      void runPlan()
    }
  }
}

/**
 * 记下/撤下"整张图算不了"的原因，**只在内容真的变了才写 store**。
 *
 * 这条不是优化：调度器订阅着这个 store（任何写入都会重排一次），每轮都写一遍同样的值
 * 就成了自己触发自己的死循环。同样的原因写一次就够 —— 界面上那句话不会变。
 */
function reportGraphError(message: string | null): void {
  const store = useNodeOutputStore.getState()
  if ((store.graphError?.message ?? null) === message) return
  if (message) console.error('[SciViz] 这张图现在算不了：', message)
  store.setGraphError(message ? { message } : null)
}

async function runPlanOnce(): Promise<void> {
  const workflow = useWorkflowStore.getState().workflow
  const expandedWorkflow = expandWorkflowGroups(workflow)
  if (!expandedWorkflow.nodes.some((n) => isEngineNode(n.type))) return

  try {
    await ensureEngine()
  } catch {
    // 引擎起不来就什么都不算：界面上由引擎状态交代原因，绝不拿旧值或假值顶上
    return
  }

  // 已经删掉的节点，把它们在引擎侧的产出也丢掉，否则大表会一直占着内存
  const groupRuntimeInfo = collectGroupRuntimeInfo(workflow)
  const alive = new Set([
    ...expandedWorkflow.nodes.map((n) => n.id),
    ...groupRuntimeInfo.map((group) => group.nodeId),
  ])
  for (const id of lastNodeIds) {
    if (alive.has(id)) continue
    dropNode(id)
    forgetNodeExecution(id)
    useNodeOutputStore.getState().forget(id)
  }
  lastNodeIds = alive

  const datasets = await datasetLookup(expandedWorkflow)
  // 组块边界映射可能刚被编辑，但内层节点的指纹与输出没有变化，不会触发新的 onRefs。
  // 每次运行前按当前定义从已缓存的叶节点摘要重建外层端口，且只在内容变化时写 store。
  const cachedRefs = useNodeOutputStore.getState().refs
  const cachedRuntimes = useNodeOutputStore.getState().runtimes
  for (const group of groupRuntimeInfo) {
    setGroupRefsIfChanged(group.nodeId, aliasedGroupRefs(group, cachedRefs), groupOutputVersion(group))
    setGroupRuntimeIfChanged(group.nodeId, aggregateGroupRuntime(group, cachedRuntimes))
  }

  await runGraph(
    {
      adapter,
      datasets,
      ctx: buildPortContext(expandedWorkflow),
      operatorOf: operatorFactsOf,
      // 只有真的连上了本地宿主，才允许"只有宿主能跑"的算子进引擎
      canRunHostOperators: () => activeBackend() === 'local',
      deferNode: (node, fingerprint) => {
        const isTrainingNode = ['train.function', 'train.custom', 'train.mlp', 'train.cnn1d'].includes(node.type)
        if (!isTrainingNode || nodeExecutionRequested(node.id)) return null
        if (modelArtifactForNode(node.id, fingerprint)) return null
        const hasOlderResult = useNodeOutputStore
          .getState()
          .modelArtifacts.some((artifact) => artifact.nodeId === node.id)
        if (hasOlderResult) {
          return '当前训练设置与已保存制品不匹配，旧结果已过期并保留；请恢复原设置或重新训练'
        }
        // 新工程里的传统内置训练节点仍按既有调度行为运行；自定义训练函数需显式启动。
        return node.type === 'train.function' ? '等待点击「开始训练」' : null
      },
      modelArtifactForNode,
    },
    workflow,
    {
      initialRuntimes: useNodeOutputStore.getState().runtimes,
      onRuntime: (id, runtime) => {
        useNodeOutputStore.getState().setRuntime(id, runtime)
        recordArtifactReference(id, runtime)
        for (const group of groupRuntimeInfo) {
          if (!group.descendants.includes(id)) continue
          const current = useNodeOutputStore.getState().runtimes
          setGroupRuntimeIfChanged(group.nodeId, aggregateGroupRuntime(group, current))
        }
      },
      onRefs: (id, refs, version) => {
        useNodeOutputStore.getState().setRefs(id, refs, version)
        const refsByNode = useNodeOutputStore.getState().refs
        for (const group of groupRuntimeInfo) {
          if (!group.descendants.includes(id)) continue
          const aliases = aliasedGroupRefs(group, refsByNode)
          const groupVersion = Math.max(version, groupOutputVersion(group))
          setGroupRefsIfChanged(group.nodeId, aliases, groupVersion)
        }
      },
    },
  )
  for (const id of [...lastNodeIds]) {
    const status = useNodeOutputStore.getState().runtimes[id]?.status
    if (status === 'ready' || status === 'error' || status === 'cancelled') {
      finishNodeExecution(id)
    }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runPlan()
  }, DEBOUNCE_MS)
}

/** 订阅画布与数据的变化。返回取消订阅的函数 */
export function startEngineRunner(): () => void {
  const offEngine = onEngineStatus((status, detail) => {
    useNodeOutputStore.getState().setEngine(status, detail)
    if (status === 'ready') schedule()
  })

  const offWorkflow = useWorkflowStore.subscribe(schedule)
  // 手动节点跑完后会往这里写输出（版本 +1），下游的引擎节点需要据此重算。
  // 这也让"任何输出变了就重新规划"成为一条统一规则，不用额外挂通知。
  const offOutput = useNodeOutputStore.subscribe(schedule)
  const offExplicitRequest = onNodeExecutionRequest(schedule)
  const offData = useDataStore.subscribe((s, prev) => {
    if (s.imported !== prev.imported) {
      // 数据集换了内容，引擎侧那份就作废了
      refCache.clear()
      lastNodeIds = new Set()
      schedule()
    }
  })

  // 进度走 store（它本来就是"节点状态"的一部分），而不是另开一条订阅线：
  // 界面上那根进度条与状态徽标说的是同一件事，分开就会有两个版本
  const offProgress = onNodeProgress((nodeId, ratio, message) => {
    useNodeOutputStore.getState().setProgress(nodeId, ratio, message)
  })

  /*
   * 先把执行面确立下来，再等"有东西要算"。
   *
   * 选址（宿主 / 浏览器引擎）与"它连上没有"都是页面级事实：顶栏状态、节点上的
   * 「需宿主 / 本地模式」标签、以及"哪些算子允许进引擎"这条能力门都读它。此前它只在
   * `runPlan` 真正要算一个节点时才发生，于是空画布上永远不会发生 —— 宿主在跑，
   * 顶栏却说"引擎未启动"（见 `backend.primeBackend`）。
   *
   * 失败不在这里处理：原因由引擎状态那条线带给界面，这里吞掉只是不产生未处理的 rejection。
   */
  void primeBackend().catch(() => {})

  schedule()

  return () => {
    offEngine()
    offWorkflow()
    offOutput()
    offExplicitRequest()
    offData()
    offProgress()
    if (timer) clearTimeout(timer)
  }
}
