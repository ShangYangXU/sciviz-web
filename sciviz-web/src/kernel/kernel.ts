/**
 * 无头核：**"算出一张图"的唯一实现。**
 *
 * 抽出来的理由（架构总纲 A1 / RA-2）：这件事原先只发生在 `graphRunner.ts` 里，
 * 而那个文件直接 import 了 Zustand store 与浏览器侧的适配器选址，于是
 * "算出这张图"在结构上无法离开浏览器主线程。agent 因此永远只能驱动 DOM。
 *
 * 本模块是纯逻辑：不 import DOM、React、store、Worker、Pyodide。执行由注入的
 * `KernelAdapter` 负责，数据由注入的 `DatasetLookup` 负责 —— 所以
 * CLI 拿本地宿主当适配器、浏览器拿 Pyodide/宿主当适配器，走的都是这一段代码。
 *
 * 调度语义与 `graphRunner` 逐条对齐，不是"另一种调度"：
 * 指纹不变就不重算；上游失败则下游 blocked；失败**不**加版本号（没有新输出，
 * 加了会让整条下游无谓重算然后各报一遍同样的错）；改好上游后指纹变了，链路自己活过来。
 */

import { CancelledError, EngineError } from '../engine/errors'
import {
  blockedByUpstreamReason,
  edgeNeedsUpstreamValue,
  needsUserFn,
  nodeFingerprint,
  outputPortSpecs,
  planEvaluation,
} from '../engine/plan'
import { parseSignature } from '../workflow/functionSignature'
import { expandWorkflowGroups } from '../workflow/groups'
import { upstreamDatasetId } from '../workflow/ports'
import type { NodeRuntime, OutputRefBody } from '../engine/protocol'
import type { PortContext } from '../workflow/ports'
import type { Workflow, WorkflowNode } from '../workflow/types'
import type { JobRecord, KernelDeps, KernelLogEntry, KernelOptions, KernelResult } from './types'

/**
 * 这一步的结果能不能跨会话复用（契约规格 R6.4）。
 *
 * 能的两类：`deterministic`，以及 `seeded`（种子写在 params 里，因此也在指纹里 —
 * 换了种子指纹就换了，不会串）。不能的两类：`stochastic`（GPU 上的非确定性归约，
 * 复用它等于拿上一次的冒充这一次的）与 `volatile`（本来就每次都不同）。
 *
 * 判据只有这一处：引擎只认请求里那个布尔值，自己不判断子。
 */
function cacheableOf(facts: ReturnType<KernelDeps['operatorOf']>): boolean {
  const d = facts?.determinism
  return d === 'deterministic' || d === 'seeded'
}

/**
 * 这个节点的数据实际来自哪个数据集 → 它的采样率（Hz）。查不出来时 null。
 *
 * R3.4：采样率是数据的属性。所以这里**只查、不猜** —— 猜一个 1000 Hz 出来，
 * 下游每一个频率值都建立在一个编出来的数字上，而它们看起来都很正常。
 */
function sampleRateOfUpstream(
  workflow: Workflow,
  node: WorkflowNode,
  datasets: KernelDeps['datasets'],
): number | null {
  const datasetId = upstreamDatasetId(workflow, node.id)
  if (!datasetId) return null
  return datasets.ref(datasetId)?.sampleRate ?? null
}

export const IDLE_RUNTIME: NodeRuntime = {
  status: 'idle',
  outputVersion: 0,
  inputsFingerprint: null,
}

/**
 * 跑一张图。
 *
 * 抛错的情形只有一种：引擎起不来。那时**什么都不算**，绝不拿旧值或假值顶上
 * —— 这是 `graphRunner` 已有的判断，原样保留。
 */
export async function runGraph(
  deps: KernelDeps,
  workflow: Workflow,
  options: KernelOptions & { initialRuntimes?: Record<string, NodeRuntime> } = {},
): Promise<KernelResult> {
  // 保证无论调用方来自画布还是 CLI，子图都沿现有节点调度与适配器执行。
  workflow = expandWorkflowGroups(workflow, deps.ctx)
  const clock = deps.clock ?? (() => Date.now())
  const startedAt = clock()
  const maxRounds = options.maxRounds ?? 64
  const logs: KernelLogEntry[] = []
  const jobs: JobRecord[] = []
  const notComputed: KernelResult['notComputed'] = []

  const log = (entry: KernelLogEntry) => {
    logs.push(entry)
    options.onLog?.(entry)
  }

  const engineInfo = await deps.adapter.ensureReady()

  const local: Record<string, NodeRuntime> = { ...(options.initialRuntimes ?? {}) }
  const refs: Record<string, Record<string, OutputRefBody>> = {}

  /**
   * 端口上下文：把调用方答不上来的那两项补上。它只在这里补，是因为**只有核同时握着**
   * 这两样东西，而三处调用方（界面 / CLI / 测试替身）都不必各自实现一遍：
   *
   * - `columnsOf` —— 上游那张表实际有哪些列。界面从 `nodeOutputStore` 取，无头侧没有 store，
   *   但核自己就记着每个节点算出来的输出摘要（`refs`），所以拆列（`data.columns`）这类
   *   "端口由上游实际的列长出来"的节点能在本轮算完之后、下一轮规划时长出端口
   *   （调度本来就是定点循环）。缺了它，拆列在界面能用、在 CLI 永远算不出来，两边都不报错。
   * - `contentHashOf` —— 数据集的内容哈希。它进 `data.source` 的指纹：换了一份数据、
   *   但列名与时间列没变时，指纹必须跟着变，否则"新数据"会显示成"旧结果"（R3.2）。
   *
   * 两处都是"给了就用调用方的"（界面路径已经有了），没给才由核补。
   */
  const ctx: PortContext = {
    ...deps.ctx,
    columnsOf:
      deps.ctx.columnsOf ??
      ((nodeId, portId) => {
        const edge = workflow.edges.find((e) => e.target === nodeId && e.targetPort === portId)
        if (!edge) return null
        const ref = refs[edge.source]?.[edge.sourcePort]
        if (!ref || ref.kind !== 'table' || !ref.columns || ref.columns.length === 0) return null
        return ref.columns
      }),
    featureColumnsOf:
      deps.ctx.featureColumnsOf ??
      ((nodeId, portId) => {
        const edge = workflow.edges.find((candidate) => candidate.target === nodeId && candidate.targetPort === portId)
        if (!edge) return null
        const ref = refs[edge.source]?.[edge.sourcePort]
        if (!ref || ref.kind !== 'table' || !ref.columns || ref.columns.length === 0) return null
        return ref.columns.filter((column) => column !== ref.timeColumn)
      }),
    contentHashOf:
      deps.ctx.contentHashOf ?? ((id) => deps.datasets.ref(id)?.contentHash ?? null),
  }

  /** 已送进引擎的数据集：id → 当时的内容哈希。哈希变了才重送 */
  const loadedDatasets = new Map<string, string>()
  /** 已编译进引擎的用户函数：节点 id → 源码。代码变了才重新编译 */
  const loadedFns = new Map<string, string>()

  const emitRuntime = (nodeId: string, runtime: NodeRuntime) => {
    local[nodeId] = runtime
    options.onRuntime?.(nodeId, runtime)
  }

  const setRefs = (nodeId: string, body: Record<string, OutputRefBody>, version: number) => {
    refs[nodeId] = body
    options.onRefs?.(nodeId, body, version)
  }

  /**
   * 把数据集送进引擎。
   *
   * 判据是**内容哈希**而不是"行列数 + 列名"：后者会让两份列名相同、内容不同的 CSV
   * 被当成同一份数据（契约规格 R3.2 明列的第一类缺陷）。换数据不重送，结果是
   * "看着改了数据、算出来的还是旧数据的值"，而且不报错。
   */
  async function ensureDataset(datasetId: string): Promise<void> {
    const ref = deps.datasets.ref(datasetId)
    if (!ref) {
      throw new EngineError(
        `数据集「${datasetId}」不在这次运行里。若它来自另一台机器导出的工程，` +
          '请用 --data 指定同名数据集对应的 CSV',
      )
    }
    if (loadedDatasets.get(datasetId) === ref.contentHash) return
    const payload = deps.datasets.payload(datasetId)
    if (!payload) throw new EngineError(`数据集「${ref.name}」取不到数值列`)
    if (Object.keys(payload.data).length === 0) throw new EngineError('这份数据集没有启用任何列')
    await deps.adapter.setDataset(payload)
    loadedDatasets.set(datasetId, ref.contentHash)
  }

  async function ensureFn(node: WorkflowNode): Promise<void> {
    const code = String(node.params.code ?? '')
    if (loadedFns.get(node.id) === code) return
    const sig = parseSignature(code)
    if (sig.error) throw new EngineError(`函数代码解析失败：${sig.error}`)
    await deps.adapter.loadFn(node.id, code, sig.fnName)
    loadedFns.set(node.id, code)
  }

  let cancelled = false

  for (let round = 0; round < maxRounds; round++) {
    if (options.isCancelled?.()) {
      cancelled = true
      break
    }

    const versions: Record<string, number> = {}
    for (const [id, rt] of Object.entries(local)) versions[id] = rt.outputVersion

    const plan = planEvaluation(workflow, local, ctx, versions, deps.deferNode)

    for (const item of plan.blocked) {
      const prev = local[item.node.id] ?? IDLE_RUNTIME
      emitRuntime(item.node.id, {
        ...prev,
        status: 'blocked',
        error: { message: item.reason, traceback: '' },
      })
      // 上下游断了就得把上一次的输出丢掉：留着的话，探针会拿旧表冒充这一次的结果。
      // 只在确实还挂着旧输出时才写 —— 空写会触发订阅方的反复重排。
      if (Object.keys(refs[item.node.id] ?? {}).length > 0) setRefs(item.node.id, {}, prev.outputVersion)
    }

    for (const item of plan.missing) {
      const prev = local[item.node.id] ?? IDLE_RUNTIME
      emitRuntime(item.node.id, {
        ...prev,
        status: 'error',
        error: { message: `缺少必需输入：${item.ports.join('、')}`, traceback: '' },
      })
      if (Object.keys(refs[item.node.id] ?? {}).length > 0) setRefs(item.node.id, {}, prev.outputVersion)
    }

    // 引擎算不了的节点必须有一个说得清的状态：否则下游只能落到
    // 兜底文案"等待上游求值…"，而那句话在这里是错的 —— 不是"还没轮到"，
    // 而是"这一步永远不会自己算"。
    for (const id of plan.manual) {
      const prev = local[id] ?? IDLE_RUNTIME
      const node = workflow.nodes.find((n) => n.id === id)
      if (prev.status !== 'ready') {
        emitRuntime(id, { ...prev, status: 'manual' })
      }
      if (node && !notComputed.some((x) => x.nodeId === id)) {
        notComputed.push({
          nodeId: id,
          nodeType: node.type,
          reason:
            '这个节点没有可用的真实执行实现，所以这里不产出任何数值 —— ' +
            '编一个出来比不产出更糟',
        })
      }
    }

    for (const item of plan.deferred) {
      const prev = local[item.node.id] ?? IDLE_RUNTIME
      emitRuntime(item.node.id, {
        ...prev,
        status: 'manual',
        inputsFingerprint: item.fingerprint,
        error: { message: item.reason, traceback: '' },
        progress: undefined,
      })
      // 输入或参数已经变化时，旧模型不再代表当前图，必须立即撤下。
      setRefs(item.node.id, {}, prev.outputVersion)
      if (!notComputed.some((entry) => entry.nodeId === item.node.id)) {
        notComputed.push({
          nodeId: item.node.id,
          nodeType: item.node.type,
          reason: item.reason,
        })
      }
    }

    if (plan.evaluate.length === 0) break

    for (const item of plan.evaluate) {
      if (options.isCancelled?.()) {
        cancelled = true
        break
      }
      const node = item.node
      const id = node.id
      const prev = local[id] ?? IDLE_RUNTIME
      const facts = deps.operatorOf(node.type)
      const runtimeClass = facts?.runtimeClass ?? 'engine'

      /*
       * 求值前再看一眼上游：**上游现在就是坏的 → 本步 blocked，不去算。**
       *
       * plan 已经在轮次开始时做过这个判断，但那是"上一轮结束时"的状态。
       * 同一轮里上游先求值、先失败，下游却还挂在这一次的 evaluate 名单上 ——
       * 结果是下游被白白送进引擎，拿一个含义模糊的错（取不到上游产物），
       * 要等下一轮才被改写成"上游出错"。这一步把那个空转去掉，
       * 也让失败原因从第一轮起就是准的。
       */
      const badUpstream = workflow.edges
        .filter((e) => e.target === id && edgeNeedsUpstreamValue(item.inputs, e))
        .map((e) => workflow.nodes.find((n) => n.id === e.source))
        .find((up) => {
          if (!up) return false
          const st = local[up.id]?.status
          return st === 'error' || st === 'blocked' || st === 'manual' || st === 'cancelled'
        })
      if (badUpstream) {
        // 原因只有一份（见 plan.blockedByUpstreamReason）：这里问的和规划时问的是同一件事
        const reason = blockedByUpstreamReason(badUpstream, local[badUpstream.id]?.status)
        emitRuntime(id, { ...prev, status: 'blocked', error: { message: reason, traceback: '' } })
        if (Object.keys(refs[id] ?? {}).length > 0) setRefs(id, {}, prev.outputVersion)
        continue
      }

      /*
       * 共享边界之外的算子（AGENTS.md R4）：只有一个执行面能跑它。
       *
       * 在浏览器引擎下点 train.mlp，如果不管，引擎会回报一句"不认识的算子：train.mlp" ——
       * 既没说为什么，也没说下一步做什么。这里**当场**把要求里那句话给出来，
       * 加上一个能照着做的动作。判据来自清单（`requires.runtime`），不是在这里写死类型名。
       */
      if (facts?.requires?.runtime === 'host' && !(deps.canRunHostOperators?.() ?? true)) {
        const reason = facts.requires.reason
        emitRuntime(id, {
          ...prev,
          status: 'error',
          error: {
            message: `「${node.label}」只能由本地宿主算：${reason}。启动宿主（sciviz-local\\run-host.ps1）后刷新页面重试`,
            traceback: '',
          },
        })
        if (Object.keys(refs[id] ?? {}).length > 0) setRefs(id, {}, prev.outputVersion)
        continue
      }

      emitRuntime(id, { ...prev, status: 'computing' })
      const startedAtMs = clock()

      /*
       * 存下的指纹必须是**求值那一刻**的指纹，而不是本轮开始时算出来的那个。
       *
       * 这一处修掉的是一个既有缺陷：plan 在轮次开始时依据当时的版本号算指纹，
       * 而同一轮里上游会先求值、版本 +1，于是下游存下的指纹当场就过期了。
       * 后果是"一张全新的图"要把每个节点算 2–3 遍（逐层"结算"指纹），
       * 版本号也跟着白涨 —— 界面上表现为每次重建都多算几轮，且下游的
       * outputVersion 与"真的变了几次"对不上。
       *
       * 上游在拓扑序里已经先算完，所以此刻 local 里的版本就是对的值：
       * 直接用它重算一遍指纹，全新图一轮结算、增量改一处只算一条链。
       */
      const versionsNow: Record<string, number> = {}
      for (const [vid, rt] of Object.entries(local)) versionsNow[vid] = rt.outputVersion
      const settledFingerprint = nodeFingerprint(
        node,
        item.inputs,
        versionsNow,
        ctx,
        // 上游刚算完，指纹就在它们的 runtime 里 —— 用它才能"沿链路认内容"
        (id) => local[id]?.inputsFingerprint ?? null,
      )

      try {
        if (node.type === 'data.source') {
          await ensureDataset(String(node.params.datasetId ?? ''))
        } else if (needsUserFn(node.type)) {
          await ensureFn(node)
        }

        const savedModelArtifact = deps.modelArtifactForNode?.(id, settledFingerprint)
        const lineage = Array.from(new Set(
          Object.values(item.inputs).flatMap((binding) => {
            const bindings = Array.isArray(binding) ? binding : [binding]
            return bindings
              .filter((entry): entry is Extract<typeof entry, { kind: 'port' }> => entry.kind === 'port')
              .flatMap((entry) => {
                const source = `${entry.nodeId}:${entry.portId}`
                const upstream = refs[entry.nodeId]?.[entry.portId]?.lineage ?? []
                return [...upstream, source]
              })
          }),
        ))
        const evaluated = await deps.adapter.evalNode({
          nodeId: id,
          nodeType: node.type,
          params: node.params,
          inputs: item.inputs,
          outputPorts: item.outputPorts ?? outputPortSpecs(node, ctx),
          // 引擎算不出这个指纹（它只看得到参数与上游产物），所以由这里给。
          // 产物按它归档：同一份输入算两次落在同一个目录（T18 的立足点）
          /*
           * 恢复时带的是**制品自己的指纹**（工程引用里记的那一个）：这一步要恢复的就是它，
           * 而宿主拿它和制品 `meta.json` 里的值严格比对（见 `gpu_ops.restore_training_artifact`）。
           * 训练时带的仍是当前指纹 —— 新产物按它归档。
           */
          fingerprint: savedModelArtifact ? savedModelArtifact.trainingFingerprint : settledFingerprint,
          ...(savedModelArtifact
            ? {
                restoreArtifactId: savedModelArtifact.artifactId,
                restoreArtifactSha256: savedModelArtifact.manifestSha256,
              }
            : {}),
          // 采样率是**数据的属性**（契约规格 R3.4）：从上游数据集的身份里查出来。
          // 查不出来时给 null —— 引擎不许猜一个默认值，那等于编一个采样率出来
          sampleRate: sampleRateOfUpstream(workflow, node, deps.datasets),
          // 能不能复用上一次的结果，由算子声明的确定性等级说了算（R6.4）
          cacheable: cacheableOf(facts),
          ...(lineage.length > 0 ? { lineage } : {}),
        })
        const { refs: body, artifacts, meta, cached } = evaluated
        const version = prev.outputVersion + 1
        const finishedAt = clock()
        emitRuntime(id, {
          status: 'ready',
          outputVersion: version,
          inputsFingerprint: settledFingerprint,
          // 产物是节点状态的一部分：界面据此说"产物在哪儿"，清单也从这里取
          ...(artifacts.length > 0 ? { artifacts } : {}),
          ...(evaluated.restored ? { loadedFromArtifact: true } : {}),
          // 元信息是"数字之外的事实"（用了什么设备、哪一版实现），指标里放不下
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
          // 「这次没算，用的是上次那份」是节点状态的一部分：用户据此判断看到的数有多新
          ...(cached ? { reused: true } : {}),
        })
        setRefs(id, body, version)
        jobs.push({
          nodeId: id,
          nodeType: node.type,
          runtime: runtimeClass,
          fingerprint: settledFingerprint,
          status: 'done',
          startedAt: startedAtMs,
          finishedAt,
          durationMs: finishedAt - startedAtMs,
        })
        log({
          at: finishedAt,
          nodeId: id,
          level: 'ok',
          message: cached
            ? `↺ ${node.label}：复用上一次的结果（输入指纹没变，省掉一次重算）`
            : `✔ ${node.label}（${finishedAt - startedAtMs} ms）`,
        })
      } catch (err) {
        /*
         * 取消不是失败。三件事要一起做对：
         *
         * 1. 状态记 `cancelled`（不是 `error`）—— 界面据此给「重跑」，而不是让别人
         *    在一条本来就没打算跑完的记录里找原因；
         * 2. 产物丢掉 —— 这次没有产出，不能拿上一次的顶上；
         * 3. **指纹照记**。它记的是"这次试过什么输入"。记下之后，下一轮调度不会
         *    自动把它再跑一遍 —— 否则用户一按取消它就立刻重新开始，那正是"取消
         *    看起来没生效"最常见的样子。重跑由用户按（节点上的「重跑」）。
         */
        if (err instanceof CancelledError) {
          const { progress: _progress, error: _error, ...rest } = prev
          emitRuntime(id, { ...rest, status: 'cancelled', inputsFingerprint: settledFingerprint })
          if (Object.keys(refs[id] ?? {}).length > 0) setRefs(id, {}, prev.outputVersion)
          log({ at: clock(), nodeId: id, level: 'warn', message: `⊘ ${node.label} 已取消` })
          continue
        }
        // 失败**不**加版本：没有新输出。加了会让整条下游无谓重算，然后各自报一遍同样的错
        const e = err as EngineError
        const finishedAt = clock()
        // 进度属于"这一次求值"，失败之后不该留着 —— 否则节点上会挂着一条
        // "第 37 轮"的进度条，而它已经不在算了
        const { progress: _stale, ...restOnFailure } = prev
        emitRuntime(id, {
          ...restOnFailure,
          status: 'error',
          inputsFingerprint: settledFingerprint,
          error: { message: e?.message ?? String(err), traceback: e?.traceback ?? '' },
        })
        setRefs(id, {}, prev.outputVersion)
        jobs.push({
          nodeId: id,
          nodeType: node.type,
          runtime: runtimeClass,
          fingerprint: item.fingerprint,
          status: 'failed',
          startedAt: startedAtMs,
          finishedAt,
          durationMs: finishedAt - startedAtMs,
          error: { message: e?.message ?? String(err), traceback: e?.traceback ?? '' },
        })
        log({
          at: finishedAt,
          nodeId: id,
          level: 'error',
          message: `✘ ${node.label}：${e?.message ?? String(err)}`,
        })
      }
    }

    if (cancelled) break
  }

  const finishedAt = clock()
  return {
    workflow,
    engineInfo,
    runtimes: local,
    refs,
    jobs,
    logs,
    notComputed,
    cancelled,
    startedAt,
    finishedAt,
  }
}
