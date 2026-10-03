/**
 * 运行清单（RunManifest）—— **一次运行的机器可读事实。**
 *
 * 契约规格 R6.3 要求它是"复现的最小单位"。这里只装**能如实报出来的东西**：
 *
 * - 每个节点带上算子清单里的四项事实：版本与实现哈希（R7）、确定性等级（R6）、
 *   执行等级（R6.1）、执行面（R6.2）；
 * - `determinism = stochastic` 的节点进 `unreproducible` —— R6 要求"不可复现贡献项"
 *   必须被列出来，否则复现性报告就是在替不可复现的东西担保；
 * - 仍然没有的（环境信息、参数与种子全集）集中列在 `gaps` 里，让读的人一眼看到
 *   这份清单**没**承诺什么。写一个假值进去比缺这一项更糟：缺项能被发现，假值不能。
 */

import type { DatasetRef } from './dataset'
import type { KernelResult } from './types'
import type { Issue, SkippedCheck, ValidationResult } from '../contract/validate'
import type { OutputRefBody } from '../engine/protocol'
import type { FigureImage } from '../types'
import type { Determinism, OperatorFacts, RuntimeClass } from '../workflow/types'

/** 算子清单说了什么（不是这次运行干了什么） */
export type RunManifestOperator = Pick<OperatorFacts, 'version' | 'implementationHash' | 'determinism' | 'execClass'> & {
  runtimeClass: RuntimeClass
}

/**
 * 一个输出端口的摘要。
 *
 * 刻意**不含行值**：全表留在引擎那一侧，几百 MB 的行值进运行清单毫无意义。
 * 要看具体行值时用 `sciviz inspect --rows N`（它按需去引擎拉前 N 行）。
 * 这里放的是"这一步产出了什么"：规模、列名和指标值。
 */
export type OutputSummary = Omit<OutputRefBody, 'chart' | 'image'> & {
  image?: Omit<FigureImage, 'data'>
}

export interface RunManifestNode {
  nodeId: string
  nodeType: string
  label: string
  runtime: RuntimeClass
  status: string
  outputVersion: number
  /** 求值时的输入指纹。null = 从未求值 */
  fingerprint: string | null
  /**
   * 指纹的短哈希（前 8 位十六进制）。
   *
   * 给人看的那份报告用它。原始指纹是一长串以算子名开头的东西，截前 12 个字符
   * 只会得到 `data.source…` —— 看着像指纹，其实每个节点都一样。
   */
  fingerprintShort: string | null
  durationMs: number | null
  /**
   * true = 这一步的输出**复用了上一次同指纹的结果**（宿主侧缓存），没有重算。
   *
   * 为什么必须进清单：缓存省的是时间，但它同时改写了"这次运行到底算了什么"。
   * 不记的话，读清单的人会以为每个节点都刚跑过一遍 —— 而"这次和上次是不是同一件事"
   * 正是这份清单存在的理由。
   *
   * 只有 `deterministic` / `seeded` 的算子会命中（契约规格 R6.4）；`stochastic`
   * 的算子（两个训练算子）永远重算，所以它们的这一栏恒为 false。
   *
   * 可选是为了读得动旧清单（没有这一栏 = 没复用）。
   */
  reused?: boolean
  /**
   * 输出端口 → 摘要。
   *
   * 这是"跑完了"与"知道算出来什么"之间的那道坎：此前清单里只有状态、耗时与指纹，
   * agent 跑完一张图仍然读不出任何一个数字，报告里也就没有结论可看。
   */
  outputs: Record<string, OutputSummary>
  /**
   * 这个节点落盘的产物（训练节点的权重与 meta）。
   *
   * 路径是**宿主机器上的绝对路径** —— 换台机器就不成立，所以每条同时记 `fingerprint`：
   * "这是不是同一份输入算出来的"才是能跨机器比较的那个判据。
   */
  artifacts?: import('../engine/protocol').ArtifactRef[]
  /**
   * 这个节点**自报**的元信息（用了什么设备、哪一版库…）。
   *
   * 指标只收数值，所以这类事实单独记 —— "同一张图在 CPU 上跑还是在 3050 上跑"
   * 靠它才分得开。
   */
  meta?: import('../engine/protocol').NodeMeta
  /**
   * 这个节点用的算子，在**清单里**是怎么声明的。
   *
   * null = 这个类型不在清单里。正常不该发生（校验会拦住未知算子），
   * 真发生了就说明这份工程引用了一个本机没有的算子 —— 那件事必须看得见。
   */
  operator: RunManifestOperator | null
  error?: { message: string; traceback: string }
}

/** Optional, portable-to-the-run-directory PNG outputs captured for external visual inspection. */
export interface RunFigureArtifact {
  /** Stable node id from the saved project graph. */
  nodeId: string
  /** Location of the node inside nested groups. */
  groupPath: string[]
  /** Expanded id used by this run's nodes and runtimes. */
  runtimeId: string
  portId: string
  label: string
  path: string
  mimeType: 'image/png'
  sha256: string
  width: number
  height: number
  fingerprintSha256?: string
}

export interface RunFigureCaptureSummary {
  captured: number
  omitted: number
  warnings: string[]
}

/** 一个"不可复现贡献项"（契约规格 R6） */
export interface UnreproducibleContribution {
  nodeId: string
  nodeType: string
  label: string
  determinism: Determinism
  /** 为什么它不可复现 —— 给一句人话，别让人回去读算子源码 */
  reason: string
}

/**
 * 这次运行所在的**环境**（契约规格 R6.3 里的"环境信息"）。
 *
 * 记的是宿主自报的事实，不是我们猜的。它存在的唯一理由是：换台机器重跑结果对不上时，
 * 这些字段是唯一能做差的东西 —— torch / CUDA / 显卡型号都会改数值。
 * 字段可能缺（宿主没答上来、机器上没装 torch），缺的时候写 null，不编。
 */
export interface RunEnvironment {
  python: string
  numpy: string
  pandas: string
  scipy: string | null
  torch: string | null
  cuda: string | null
  gpuNames: string[]
  totalMemoryMb: number | null
  /** 实际可用的设备。与"图里写的意图"不同：这是这台机器的事实 */
  device: 'cuda' | 'cpu'
}

export interface RunManifest {
  manifestVersion: 1
  runId: string
  startedAt: number
  finishedAt: number
  durationMs: number
  status: 'done' | 'failed' | 'cancelled' | 'partial'
  workflow: { name: string; description: string; nodeCount: number; edgeCount: number }
  /**
   * 图指纹：所有节点输入指纹的汇总哈希。
   * 「同一张图」的机器可读判据，用于回答"这次和上次是不是同一件事"。
   */
  graphFingerprint: string
  engine: { info: string }
  /**
   * 环境信息（R6.3）。null = 没问到（例如 /health 不答），
   * 而不是"这台机器什么都没有"。
   */
  environment: RunEnvironment | null
  datasets: DatasetRef[]
  nodes: RunManifestNode[]
  /** Present only when a caller requests figure capture; image bytes live beside run.json. */
  figures?: RunFigureArtifact[]
  /** Present when figure capture was requested, including any images that could not be captured. */
  figureCapture?: RunFigureCaptureSummary
  /**
   * 算子版本集合（R6.3）：这次用到哪些算子、分别是哪一版实现。
   *
   * 按类型去重 —— 同一张图里同一个算子是同一份实现，列两遍只会稀释信号。
   */
  operatorVersions: { type: string; version: string; implementationHash: string | null }[]
  /**
   * 不可复现贡献项（R6）。空表的意思只有一个：**没有已知的**不可复现来源 ——
   * 它不等于"结果必然逐位相同"。
   */
  unreproducible: UnreproducibleContribution[]
  /** 引擎算不了的节点。如实列出，不编数值 */
  notComputed: KernelResult['notComputed']
  contract: {
    ok: boolean
    errors: Issue[]
    warnings: Issue[]
    notChecked: SkippedCheck[]
  } | null
  /**
   * 与上一次运行的对比（L3）。没有上一次运行时为 undefined。
   *
   * 它是"可复现"这个主张的机器判据：同一张图两次运行，数值应当一致。
   */
  drift?: import('./drift').DriftReport
  /** 这次运行**没有**承诺的东西。空表要配一句说明，不能让人误读成"全都 reproducible" */
  gaps: string[]
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 图指纹。
 *
 * 取节点输入指纹的排序拼接，再加工作流名字。不含位置、不含 UI 选择状态 ——
 * 那些变了不该影响"这是不是同一张图"。节点集合或任一节点的输入变了，它就变。
 */
export async function graphFingerprintOf(result: KernelResult): Promise<string> {
  const parts = Object.entries(result.runtimes)
    .map(([id, rt]) => `${id}:${rt.inputsFingerprint ?? '·'}`)
    .sort()
  return `sha256:${await sha256Hex(`${result.workflow.name}\u0002${parts.join('\u0001')}`)}`
}

async function shortHash(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 8)
}

/** 只留"这一步产出了什么"。图表配置与 PNG 字节不进清单：它们属于预览，体积也不小 */
function summarizeOutputs(refs: Record<string, OutputRefBody> | undefined): Record<string, OutputSummary> {
  const out: Record<string, OutputSummary> = {}
  for (const [portId, body] of Object.entries(refs ?? {})) {
    const { chart: _chart, image, ...rest } = body
    out[portId] = {
      ...rest,
      ...(image ? { image: { mimeType: image.mimeType, width: image.width, height: image.height } } : {}),
    }
  }
  return out
}

export async function buildRunManifest(
  result: KernelResult,
  extra: {
    runId: string
    validation: ValidationResult | null
    datasets: DatasetRef[]
    /** 查一个算子类型的事实。注入而不是 import：核这一层不许依赖算子注册表 */
    operatorOf: (type: string) => OperatorFacts | null
    /** 这次运行所在的环境。宿主没答上来时传 null */
    environment?: RunEnvironment | null
  },
): Promise<RunManifest> {
  const jobsByNode = new Map(result.jobs.map((j) => [j.nodeId, j]))
  const nodes: RunManifestNode[] = []
  const operatorVersions = new Map<string, RunManifest['operatorVersions'][number]>()
  const unreproducible: UnreproducibleContribution[] = []
  for (const node of result.workflow.nodes) {
    const rt = result.runtimes[node.id]
    const job = jobsByNode.get(node.id)
    const facts = extra.operatorOf(node.type)
    if (facts) {
      operatorVersions.set(node.type, {
        type: node.type,
        version: facts.version,
        implementationHash: facts.implementationHash,
      })
      // 只有**真的产出过东西**的节点才算贡献项：没算出来就没有产物可担保
      if (facts.determinism === 'stochastic' && rt?.status === 'ready') {
        unreproducible.push({
          nodeId: node.id,
          nodeType: node.type,
          label: node.label,
          determinism: facts.determinism,
            reason: node.type.startsWith('custom.')
              ? '用户写的代码：我们无法替它承诺可复现 —— 里面有没有用随机源，只有代码自己知道'
              : '算子声明为 stochastic：不承诺同一份输入得到同一份输出',
        })
      }
    }
    nodes.push({
      nodeId: node.id,
      nodeType: node.type,
      label: node.label,
      runtime: job?.runtime ?? 'engine',
      status: rt?.status ?? 'idle',
      outputVersion: rt?.outputVersion ?? 0,
      fingerprint: rt?.inputsFingerprint ?? null,
      fingerprintShort: rt?.inputsFingerprint ? await shortHash(rt.inputsFingerprint) : null,
      durationMs: job?.durationMs ?? null,
      reused: rt?.reused === true,
      outputs: summarizeOutputs(result.refs[node.id]),
      ...(rt?.artifacts && rt.artifacts.length > 0 ? { artifacts: rt.artifacts } : {}),
      ...(rt?.meta && Object.keys(rt.meta).length > 0 ? { meta: rt.meta } : {}),
      operator: facts
        ? {
            version: facts.version,
            implementationHash: facts.implementationHash,
            runtimeClass: facts.runtimeClass,
            determinism: facts.determinism,
            execClass: facts.execClass,
          }
        : null,
      ...(rt?.error ? { error: rt.error } : {}),
    })
  }

  const failed = nodes.some((n) => n.status === 'error')
  const status: RunManifest['status'] = result.cancelled
    ? 'cancelled'
    : failed
      ? 'failed'
      : result.notComputed.length > 0
        ? 'partial'
        : 'done'

  return {
    manifestVersion: 1,
    runId: extra.runId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.finishedAt - result.startedAt,
    status,
    workflow: {
      name: result.workflow.name,
      description: result.workflow.description,
      nodeCount: result.workflow.nodes.length,
      edgeCount: result.workflow.edges.length,
    },
    graphFingerprint: await graphFingerprintOf(result),
    engine: { info: result.engineInfo },
    environment: extra.environment ?? null,
    datasets: extra.datasets,
    nodes,
    operatorVersions: [...operatorVersions.values()].sort((a, b) => a.type.localeCompare(b.type)),
    unreproducible,
    notComputed: result.notComputed,
    contract: extra.validation
      ? {
          ok: extra.validation.ok,
          errors: extra.validation.errors,
          warnings: extra.validation.warnings,
          notChecked: extra.validation.notChecked,
        }
      : null,
    gaps: [
      '参数全集与随机种子全集没有单独列出 —— 它们在每个节点的指纹里（指纹含规范化参数与数据身份），' +
        '只是没有以"人能直接读"的形式出现。',
      '用户代码（custom.* 与自建模块）没有实现哈希：它的实现在参数里、已随参数进指纹，' +
        '但清单里没有一个可以拿来比对的哈希。',
      '指纹里还没有 determinism 一项（契约规格 R5.1 列了它）：算子把确定性等级改一档，' +
        '已经算出来的产物不会因此失效。',
    ],
  }
}
