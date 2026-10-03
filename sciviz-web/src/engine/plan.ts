import {
  WHOLE_TABLE_PORT,
  resolvePorts,
  portsPendingReason,
  type PortContext,
} from '../workflow/ports'
import { isFunctionNode } from '../workflow/ports'
import { isUserModuleType } from '../workflow/userModules'
import { expandWorkflowGroups, nodeIdFromRuntimeId } from '../workflow/groups'
import { getNodeTypeDef, hasNodeType } from '../workflow/nodeRegistry'
import { OPERATOR_IMPLEMENTATION_HASHES } from '../contract/operatorHashes.generated'
import type { Workflow, WorkflowEdge, WorkflowNode } from '../workflow/types'
import type { InputBinding, Inputs, NodeRuntime, OutputPortSpec } from './protocol'

/**
 * 求值计划：全是纯函数，不碰 Worker、不碰 DOM。
 *
 * 单独成文件是为了能被 `node --test` 直接跑 —— 脏传播是这套引擎里最容易悄悄出错的一块
 * （少算一次不报错、只给旧值），必须有单测兜住。
 */

/**
 * 引擎负责的节点类型由 `NodeTypeDef.runtimeClass` 声明，不在这里维护第二张白名单。
 * 当前真引擎节点包括数据源、数据探针、列操作、图表、密度图、评估、用户函数以及
 * 宿主训练节点；数据划分、分帧、增强和特征工程由用户在外部或 `custom.script` 中显式完成。
 *
 * **自建模块（`custom.user.*`）在名单之外单独认**：它们就是用户写的函数，
 * 和 `custom.script` 是同一件事，只是多了名字和分类，所以按前缀放行，
 * 不为每个模块往这张表里塞一行（那样每建一个模块都要改代码）。
 *
 * `viz.chart` / `viz.density` 与 `custom.chart` 的 figure 输出统一走画布图形，
 * 接上上游后立即按实际表数据出图。
 */
/**
 * 这个节点是否由真实引擎计算。
 *
 * **判据来自算子清单本身**（`NodeTypeDef.runtimeClass`）。此前这里有一份 `ENGINE_NODES`
 * 白名单，与 `nodeRegistry.ts` 构成两处真相：新增算子必须同时改两处，漏改则节点
 * "看起来能跑、其实不走真引擎"，而且不报错 —— 正是 R1 要消灭的东西。
 * 现在只有清单一处声明，字段还是必填的（忘了写就编译不过）。
 */
export function isEngineNode(type: string): boolean {
  // 自建模块不在注册表里（运行时才建），按前缀认：它们就是用户写的函数
  if (isUserModuleType(type)) return true
  // 注册表里没有的类型不可执行：引擎当然算不了它
  return hasNodeType(type) ? getNodeTypeDef(type).runtimeClass === 'engine' : false
}

/**
 * 求值前需要先把用户代码编译进引擎的节点类型。
 *
 * 自定义函数和通用训练节点需要先编译用户代码。
 */
export function needsUserFn(type: string): boolean {
  return isFunctionNode(type) || isUserModuleType(type)
}

/**
 * 组装一个节点的输入绑定。
 *
 * 有两条容易踩的坑：
 * 1. **函数节点的形参默认值不在 `node.params` 里** —— 它们由 `parseSignature` 解析出来、
 *    挂在端口的 `paramSpec` 上，只有用户手动改过才会写进 params。所以默认值要从
 *    `paramSpec.default` 兜底，否则「有默认值所以不用接线」这个承诺就是假的。
 * 2. **不能靠 `paramSpec.default` 是否存在来判断"有没有默认值"** ——
 *    `fnParamToSpec` 对没有默认值的形参也会填一个 `''`。真正的判据是端口上的 `optional`
 *    （对函数节点即"签名里写了默认值"），否则 `def f(x, y)` 里的 `y` 会被悄悄绑成空字符串。
 */
export function buildInputBindings(
  node: WorkflowNode,
  workflow: Workflow,
  ctx: PortContext,
): { inputs: Inputs; missing: string[] } {
  const { inputs: portSpecs } = resolvePorts(node, ctx)
  const inputs: Inputs = {}
  const missing: string[] = []

  for (const port of portSpecs) {
    /*
     * 多入端口（契约规格 R13）：一个端口一串线，值送成**有序列表**。
     *
     * 展开发生在这一处、也只在这一处 —— 引擎侧不另建一套 `col_1…col_N` 的端口命名，
     * 否则"这个算子吃什么输入"就有两处说法了。
     */
    if (port.multiple) {
      const wired = workflow.edges.filter((e) => e.target === node.id && e.targetPort === port.id)
      if (wired.length > 0) {
        inputs[port.id] = wired.map((e) => ({
          kind: 'port' as const,
          nodeId: e.source,
          portId: e.sourcePort,
        }))
        continue
      }
      // 一根都没接：不在这里报"必需输入没接线"，交给算子自己说"还没接到任何列"
      if (port.optional) continue
      missing.push(port.label)
      continue
    }

    const edge = workflow.edges.find((e) => e.target === node.id && e.targetPort === port.id)
    if (edge) {
      // scaler 与 table 一样沿端口传递真实对象；标准化器由用户函数拟合，
      // 不在计划阶段偷偷重算或序列化。
      inputs[port.id] = { kind: 'port', nodeId: edge.source, portId: edge.sourcePort }
      continue
    }
    const own = node.params[port.id]
    if (own !== undefined) {
      inputs[port.id] = { kind: 'literal', value: own }
      continue
    }
    if (port.optional) {
      if (port.paramSpec) inputs[port.id] = { kind: 'literal', value: port.paramSpec.default }
      continue
    }
    missing.push(port.label)
  }

  return { inputs, missing }
}

/**
 * 这条边在本次求值里是否**真的**要从上游取值。
 *
 * 绑成字面量的端口不算依赖；真实输出端口（包括 scaler）都要从上游取值。
 *
 * 判据只写这一份：规划时（`planEvaluation`）与求值前复查（`kernel`）问的是两件不同的事
 * —— 前者看"这一轮开始时上游坏没坏"，后者看"同一轮里上游刚变坏没有"——
 * 但"哪条边算依赖"这一条对两边是同一条，所以共用这个函数。
 */
export function edgeNeedsUpstreamValue(inputs: Inputs, edge: WorkflowEdge): boolean {
  const b = inputs[edge.targetPort]
  // 多入端口的每一项都是真取值（连线顺序就是内容），所以列表一律算依赖
  if (Array.isArray(b)) return true
  return b?.kind !== 'literal'
}

/**
 * "这一步为什么不跑"的那句话 —— **只写这一处**。
 *
 * 规划（`planEvaluation`，看这一轮开始时上游坏没坏）与求值前的复查（`kernel`，看同一轮里
 * 上游刚变坏没有）问的是同一件事，两处各写一份的下场是**其中一份会说错话**：此前
 * `manual`（还没开始，比如等用户点「开始训练」的训练块）在一处被说成"出错"，
 * 在另一处被说成"没有可用输出"，而先落库的那份是"出错"——
 * 于是一张健康的图看起来像坏了，用户去查一个根本不存在的错误。
 *
 * 契约规格里"上游或绘图函数尚未产出数据"要求**提示等待或展示该步骤的真实错误**，
 * 所以这里按上游实际处于什么状态分档，不用"出错"兜底。
 *
 * `thisRound` 给规划用：它手里有"这一轮刚刚判定出来的原因"（延后 = 等显式启动、
 * 被跳过 = 它自己的上游有问题）。有这句就用这句 —— 直接说"还没开始"，
 * 比回头去读状态更准，因为状态要等这一轮写完才有。
 */
export function blockedByUpstreamReason(
  upstream: WorkflowNode,
  status: NodeRuntime['status'] | undefined,
  thisRound?: { state: 'deferred' | 'skipped'; reason: string },
): string {
  const name = `上游「${upstream.label}」`
  if (thisRound?.state === 'deferred') return `${name}还没开始：${thisRound.reason}`
  if (thisRound?.state === 'skipped') return `${name}这次被跳过：${thisRound.reason}`
  if (status === 'cancelled') return `${name}被取消，这次没有产出`
  if (status === 'blocked') return `${name}这次被跳过，它自己没有产出`
  if (status === 'error') return `${name}出错`
  if (status === 'manual') {
    // 还没开始，不是坏了：训练块等的是用户点「开始训练」，这句话必须说清这一点
    return `${name}还没开始（它需要显式启动，比如点「开始训练」）`
  }
  // 没算过、或者状态已经不可考：老实说"没有值"，不替上游编一个原因
  return `${name}当前没有可用输出`
}

/**
 * 输出端口的形状提示。
 * 端口 id 一律取自 `resolvePorts`，引擎不自己拼 —— 否则两处各有一套判断，迟早错位。
 */
export function outputPortSpecs(node: WorkflowNode, ctx: PortContext): OutputPortSpec[] {
  return resolvePorts(node, ctx).outputs.map((p) => {
    if (node.type !== 'data.source') {
      return { id: p.id, shape: 'auto' as const, kind: p.type }
    }
    if (p.id === WHOLE_TABLE_PORT) return { id: p.id, shape: 'table' as const, kind: p.type }
    return { id: p.id, shape: 'table' as const, kind: p.type }
  })
}

/**
 * 输入指纹：完整记录"这次求值时，这个节点的输入长什么样"。
 *
 * 拿它直接比字符串，不取哈希 —— 几十个节点、每条几百字节，比对比哈希还便宜，
 * 而哈希碰撞会静默漏掉一次重算，那是最难查的一类错。
 *
 * 数据源要特殊处理：它的参数里只有 `datasetId`，"启用哪些列"和"时间列"存在数据面板里
 * （`useDataStore`）。不并入这两项的话，用户在数据面板里开关一列，画布上这条链路不会重算。
 */
export function nodeFingerprint(
  node: WorkflowNode,
  inputs: Inputs,
  versions: Record<string, number>,
  ctx: PortContext,
  /**
   * 上游节点的指纹（拿不到时给 null）。
   *
   * **这条不能省。** 只记上游的版本号是不够的：版本号在每次会话里都从 1 重新数，
   * 于是"结构相同、但上游喂的是另一份数据"的两张图，下游指纹一模一样 ——
   * 加跨运行缓存时当场撞上：两个实验的"时域特征"被判成同一份缓存，第二个实验
   * 直接拿到了第一个实验的数，而清单、日志、数字看起来全都正常。
   *
   * 两个都记（内容 + 版本号）是有意的：内容让指纹**跨会话**可认，版本号让"同一次会话里
   * 上游重算过"这件事仍然会让下游失效（`stochastic` 的节点重算两次得到不同的数，
   * 而它的指纹是一样的 —— 那种情况只能靠版本号）。
   */
  upstreamFingerprint?: (nodeId: string) => string | null,
): string {
  const parts: string[] = [node.type]

  // 算子实现进指纹。少了这一项，改一次 operators.py，图里已算出的节点指纹不变，
  // 界面会继续把旧结果显示为"最新" —— 同图、同参数、不同结果，而系统不报警。
  // 哈希由 scripts/gen-operator-hashes.mjs 生成，测试守着它不会过期。
  // 函数节点（custom.*）取到空串是对的：它们的"实现"就是用户写在 params 里的代码，
  // 那部分本来就在下面的 params 里。
  parts.push(`impl=${OPERATOR_IMPLEMENTATION_HASHES[node.type] ?? ''}`)

  const params = Object.keys(node.params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(node.params[k])}`)
  parts.push(params.join('\u0001'))

  if (node.type === 'data.source') {
    const datasetId = String(node.params.datasetId ?? '')
    parts.push(`cols=${ctx.featuresOf(datasetId).join(',')}`)
    parts.push(`time=${ctx.timeColumnOf(datasetId) ?? ''}`)
    /*
     * **数据集的内容进指纹。** 少了这一项，"换了一份数据、但列名与时间列没变"
     * 会让指纹一模一样 —— 界面于是继续把上一次的结果当成这一次的结果显示，
     * 而图、参数、列、时间列全都对得上，只有数是别人的（契约规格 R3.2）。
     *
     * 拿不到哈希时（调用方没提供）留空：退化成旧行为，而不是编一个值。
     */
    parts.push(`data=${ctx.contentHashOf?.(datasetId) ?? ''}`)
  }

  const one = (portId: string, b: InputBinding): string => {
    if (b.kind === 'literal') return `${portId}=lit:${JSON.stringify(b.value)}`
    const up = upstreamFingerprint?.(b.nodeId) ?? ''
    /*
     * 上游这边写的是它的**身份**（节点 id），不是它**此刻的位置**（运行时 id 带组路径）。
     *
     * 理由：把一块挪进/挪出组块只改了它在画布上的位置，没改任何一个像素的计算 ——
     * 而指纹是"这份结果属于哪个计算"的判据，位置进去就会让"训练一次就好了"不成立：
     * 封装过的训练节点指纹与训练时不同，工程里的制品引用（以及宿主 meta.json 里记的
     * 指纹）当场全部对不上，用户只能重训。根层节点本来就没有路径，所以这条对它们不变。
     *
     * 组路径仍在**运行时 id** 里（输出、运行时状态、清单按它归属），只是不进指纹。
     */
    const upstreamId = nodeIdFromRuntimeId(b.nodeId) ?? b.nodeId
    return `${portId}=port:${upstreamId}:${b.portId}@${up}#${versions[b.nodeId] ?? 0}`
  }
  const bindings = Object.keys(inputs)
    .sort()
    .map((portId) => {
      const b = inputs[portId]
      /*
       * 多入端口是一个列表，**列表内部不排序**：顺序就是连线在图里的先后，而它是内容
       * （拼表先接哪列，出来的列序就是哪样）。先接 A 后接 B 与反过来必须是两个不同的指纹 ——
       * 否则换了列序却不重算，界面继续把旧列序的结果显示成"最新"。
       */
      return Array.isArray(b) ? b.map((x) => one(portId, x)).join('\u0001') : one(portId, b)
    })
  parts.push(bindings.join('\u0001'))

  return parts.join('\u0002')
}

/**
 * 同一个计算的**身份**：把指纹里那三样"记账"抹掉 —— 上游**在哪一层**、**会话内算过几次**，
 * 以及**算子实现是哪一版**。
 *
 * 只用在**训练制品**这一件事上：判断工程里的引用是不是属于这个节点这次的计算。
 * 判据与契约规格 R5.4/R5.5 是同一条 —— 记账不是内容：一个块在根层还是在组块里、
 * 上游这次会话里算过一遍还是三遍，都没改任何一个像素的计算，所以那份权重认得它。
 *
 * 三样分别怎么抹：
 *
 * 1. **位置**：老写法 `port:group:["g1"]:"n16":…` → `port:n16:…`（2026-09-21 之前，
 *    指纹里的上游写的是运行时 id，带组路径）。新写法只有节点 id，这条替换对它是空操作。
 * 2. **会话内的计数**：`…@上游指纹#3` → `…@上游指纹#`。它记的是"这次会话里第几次算"，
 *    每次开工程都从 1 重新数；拿它比对等于要求"训练那天上游刚好也只算过一遍"，
 *    于是"动一下上游再训练、下次打开"就认不出自己的权重。
 * 3. **算子实现哈希**：`impl=<64 位十六进制>` → `impl=`。本节点的、以及上游链路里嵌着的都抹。
 *
 * 第 3 条是 2026-09-22 补的，代价很具体：宿主侧实现一改（`gpu_ops.py` / `operators.py`
 * 改过之后要重跑 `gen-operator-hashes.mjs`），`impl=` 就变，于是**工程里所有训练节点的
 * 引用当场失配** —— 界面上是"当前训练设置与已保存制品不匹配，旧结果已过期并保留"，
 * 下游评估/图表块跟着停摆，而用户自己的参数、代码、数据一个字节都没动。
 *
 * 实现哈希进指纹是对的（它管**缓存**：改一次实现，旧结果不能再当成最新的，见 R5.3），
 * 但它不是"这是哪个实验"的一部分。真正判断"这份权重还能不能用"的是宿主那几项**实测**：
 * 清单校验值、节点类型、当前训练参数（含用户代码）、模型定义源码、模型参数，以及
 * train/val/test 三份输入的实际内容哈希（`restore_training_artifact`）—— 任一不符就显式
 * 失败，不会静默用错权重。残余写在契约规格 R5.5 里，别当成没有。
 *
 * 为什么只在制品匹配上用、不改指纹本身：指纹同时是**缓存键**与运行清单里的复现判据，
 * 动它会让同一次会话里"上游重算过"这件事失去记录（R5.3 与 §5 的说明）—— 那件事防的是
 * "随机上游重跑、数变了，下游却复用旧产物"，与"这份权重属于哪个计算"是两件事。
 * 恢复请求带的是引用里那份指纹，宿主仍严格比对制品 `meta.json`，一个字没松。
 */
export function trainingIdentity(fingerprint: string): string {
  return fingerprint
    /*
     * 实现哈希：钉在 64 位（sha256）上，免得误伤用户代码里出现的 "impl=…" 字样。
     * 空的 `impl=`（函数节点没有算子实现）两边本来就是同一个样子，不用管。
     */
    .replace(/impl=[0-9a-f]{64}/g, 'impl=')
    .replace(/port:group:\[[^\]]*\]:("(?:[^"\\]|\\.)*")/g, (_match, quoted: string) => {
      try {
        const nodeId: unknown = JSON.parse(quoted)
        return typeof nodeId === 'string' ? `port:${nodeId}` : `port:${quoted}`
      } catch {
        return `port:${quoted}`
      }
    })
    /*
     * 会话内的计数：`#3` → `#`。判据是它后面一定紧跟分隔符（\u0001 端口之间 /
     * \u0002 段之间）或结尾 —— 参数值里的 `#1` 后面跟的是引号，不会被误伤。
     */
    .replace(/#\d+(?=[\u0001\u0002]|$)/g, '#')
}

/**
 * 工程引用里属于"这个节点这次计算"的那一条（同一指纹训练过多次时取最近保存的一条）。
 *
 * **一条规则两处用**：画布调度器与 CLI 的无头运行。抽出来之前 CLI 那份根本不存在 ——
 * 症状是"界面重开能恢复、命令行跑一遍却把模型重训了一次"，而且两条路各自演化。
 */
export function selectModelArtifact<T extends { nodeId: string; trainingFingerprint: string }>(
  refs: readonly T[],
  nodeId: string,
  fingerprint: string,
): T | undefined {
  const matches = refs.filter(
    (ref) =>
      ref.nodeId === nodeId &&
      trainingIdentity(ref.trainingFingerprint) === trainingIdentity(fingerprint),
  )
  return matches[matches.length - 1]
}

interface PlanItem {
  node: WorkflowNode
  fingerprint: string
  inputs: Inputs
  outputPorts: OutputPortSpec[]
}

export interface Plan {
  /** 按拓扑序，需要真正（重新）求值的引擎节点 */
  evaluate: PlanItem[]
  /** 上游失败或上游产物不可用，跳过求值 */
  blocked: { node: WorkflowNode; reason: string }[]
  /** 必需输入没接线 */
  missing: { node: WorkflowNode; ports: string[] }[]
  /** 指纹没变，不需要重算 */
  unchanged: string[]
  /** 未注册或不支持的节点，本次计划不含它们 */
  manual: string[]
  /** 有真实实现，但客户端要求等待显式启动 */
  deferred: { node: WorkflowNode; fingerprint: string; reason: string }[]
}

/**
 * 算出这次要重算哪些节点。
 *
 * 关键点：指纹里已经含了上游的输出版本，所以**脏是自动传播的** ——
 * 上游重算后版本 +1，下游的指纹自然就不一样了，不需要另写一套沿着边扩散的脏标记。
 * 少一个机制，就少一处能写错的地方。
 *
 * 判定顺序（不能换）：
 * 1. 非引擎节点 → 标记为未执行并算作"坏源"。
 * 2. **上游现在就是坏的 → 本步 blocked。** 这一步必须排在"指纹变了就重算"之前：
 *    上游拿不到值，下游重算注定失败，直接说清原因比让它去报一个含糊的错有用得多。
 * 3. **指纹变了 → 重算。** 这是从错误里恢复的唯一出口：改好上游的代码，上游指纹变了才会
 *    重跑；重跑成功、版本 +1，下游指纹跟着变，整条链自动活过来。
 * 4. 指纹没变、上游也好 → unchanged，一个字节都不重算。但若自己上次就是错的，
 *    仍要算作坏源 —— 否则下游会拿着旧值当新值显示。
 *
 * 反过来，求值失败时**不能**给输出加版本 —— 没有新输出，加版本会让整条下游
 * 无谓地重算一遍，然后各自报一遍同样的错。
 */
export function planEvaluation(
  workflow: Workflow,
  runtimes: Record<string, NodeRuntime>,
  ctx: PortContext,
  versions: Record<string, number>,
  deferNode?: (node: WorkflowNode, fingerprint: string) => string | null,
): Plan {
  // GUI、CLI 与测试替身都在同一纯逻辑边界展开复合组块。
  workflow = expandWorkflowGroups(workflow, ctx)
  const order = topoOrder(workflow)
  const plan: Plan = { evaluate: [], blocked: [], missing: [], unchanged: [], manual: [], deferred: [] }

  /** 上游不可用（手动 / 出错 / 阻断）的节点集合 */
  const bad = new Set<string>()
  /**
   * 这一轮里"它为什么没有产出"的一句话，逐节点记下来。
   *
   * 下游要的是"上游到底怎么了"，而这件事在这一轮**当场就知道**：是延后（等显式启动）、
   * 还是被自己的上游挡住。回头去读状态表是读不到的 —— 状态要等这一轮写完才落库，
   * 于是只能退回到"当前没有可用输出"这种听着像出错、其实什么都没说的兜底。
   */
  const badReason = new Map<string, string>()

  for (const node of order) {
    if (!isEngineNode(node.type)) {
      plan.manual.push(node.id)
      bad.add(node.id)
      badReason.set(node.id, blockedByUpstreamReason(node, undefined))
      continue
    }

    const { inputs, missing } = buildInputBindings(node, workflow, ctx)
    // 上游的指纹从上一次求值的记录里取（`NodeRuntime.inputsFingerprint`）——
    // 这正是"沿链路认内容"所需的输入，见 nodeFingerprint 的说明
    const fingerprint = nodeFingerprint(node, inputs, versions, ctx, (id) =>
      runtimes[id]?.inputsFingerprint ?? null,
    )

    const badUpstream = workflow.edges
      .filter((e) => e.target === node.id && edgeNeedsUpstreamValue(inputs, e))
      .map((e) => workflow.nodes.find((n) => n.id === e.source))
      .filter((n): n is WorkflowNode => !!n)
      .find((n) => bad.has(n.id))

    if (badUpstream) {
      plan.blocked.push({
        node,
        reason: badReason.get(badUpstream.id) ?? blockedByUpstreamReason(badUpstream, runtimes[badUpstream.id]?.status),
      })
      bad.add(node.id)
      badReason.set(node.id, blockedByUpstreamReason(node, 'blocked'))
      continue
    }

    if (missing.length > 0) {
      plan.missing.push({ node, ports: missing })
      bad.add(node.id)
      badReason.set(node.id, blockedByUpstreamReason(node, 'blocked'))
      continue
    }

    // 端口还算不出来就不该求值。最典型的是拆列节点：它的端口由上游那张表有哪些列决定，
    // 而第一轮里上游还没算过 —— 拿空端口列表去求值，引擎只会报"还没有输出端口"，
    // 用户看到的是节点闪了一下错误，而真相只是"还没轮到"。
    // 这一轮记成 blocked，下一轮上游算完、端口长出来，它会被重新规划并正常求值。
    const pending = portsPendingReason(node, ctx)
    if (pending) {
      plan.blocked.push({ node, reason: pending })
      bad.add(node.id)
      badReason.set(node.id, blockedByUpstreamReason(node, 'blocked', { state: 'skipped', reason: pending }))
      continue
    }

    const deferredReason = deferNode?.(node, fingerprint)
    const previousStatus = runtimes[node.id]?.status
    // manual → 显式请求后，即使输入指纹没变也必须真正执行一次。
    const explicitlyReleased = previousStatus === 'manual' && !deferredReason
    if (runtimes[node.id]?.inputsFingerprint === fingerprint && !explicitlyReleased) {
      plan.unchanged.push(node.id)
      // 被取消的节点与出错的一样：它这次没有产出，下游不该拿上一轮的数据接着算
      if (
        previousStatus === 'error' ||
        previousStatus === 'blocked' ||
        previousStatus === 'cancelled' ||
        previousStatus === 'manual'
      ) {
        bad.add(node.id)
        badReason.set(node.id, blockedByUpstreamReason(node, previousStatus))
      }
      continue
    }

    if (deferredReason) {
      plan.deferred.push({ node, fingerprint, reason: deferredReason })
      bad.add(node.id)
      badReason.set(node.id, blockedByUpstreamReason(node, 'manual', { state: 'deferred', reason: deferredReason }))
      continue
    }

    plan.evaluate.push({ node, fingerprint, inputs, outputPorts: outputPortSpecs(node, ctx) })
  }

  return plan
}

/** Kahn 拓扑序。与 executor 的那份同源思路，但这里只排序、不报环错 */
function topoOrder(workflow: Workflow): WorkflowNode[] {
  const indeg = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const n of workflow.nodes) {
    indeg.set(n.id, 0)
    out.set(n.id, [])
  }
  for (const e of workflow.edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
    out.get(e.source)!.push(e.target)
  }
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]))
  const queue = workflow.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const sorted: WorkflowNode[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node) sorted.push(node)
    for (const next of out.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1)
      if ((indeg.get(next) ?? 0) <= 0) queue.push(next)
    }
  }
  // 成环时漏掉的节点排在最后，至少还能各自求值（不会卡住整张图）
  for (const n of workflow.nodes) if (!seen.has(n.id)) sorted.push(n)
  return sorted
}
