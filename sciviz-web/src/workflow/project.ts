/**
 * `.sciviz` 工程文件 —— **人与 agent 共用的那一份状态**。
 *
 * 为什么要有它（而不是继续用现在的工作流 YAML）：现在的 YAML 只装得下"图"。
 * 而人在界面上做的决定有一半不在图里 —— 启用了哪些列、哪一列是时间轴、数据是哪一份。
 * 那些状态只活在浏览器的 store 里，刷新即丢，agent 也看不见。于是"人做了一半、
 * agent 接着做"这件事在结构上不成立：agent 接手时看不到人的那一半。
 *
 * 本文件把"一个工程现在是什么状态"补全成一件事：
 *
 *   version      工程格式版本（迁移的判据，契约规格 R11）
 *   graph        图（节点 + 连线 + 位置）—— 复用 `yamlToWorkflow`，不重写一遍
 *   datasets     数据集身份 + **视图**（启用列、时间列）
 *   environment  环境锁
 *   runs         运行记录的**引用**（记录本身在 runs/ 目录里）
 *   annotations  画布批注（便签 / 表格 / 思维图 / 图片）—— 与 graph 平级，**不进图**
 *
 * 三条边界，写在这里免得后来的人改错：
 *
 * 1. **不含数据本身。** 100 万行的数值不进文本文件。文件里记的是身份（内容哈希）
 *    与路径；数据要另外提供，且**内容哈希对不上就报警**。
 * 2. **位置是内容的一部分。** 节点坐标要原样保存：那是人摆的版面，agent 改图时
 *    不该把它抖散 —— 抖散了，人打开就认不出自己的图了。
 * 3. **向后兼容旧的 YAML。** 没有 `version` / `datasets` 的文件照样能读
 *    （按"只有图"处理），否则人和 agent 手上已有的文件会一夜失效。
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { workflowToYamlObject, yamlToWorkflow } from './yaml'
import {
  annotationGroupPath,
  annotationGroupPathExists,
  normalizeAnnotation,
  type Annotation,
  type MindBranch,
} from './annotations'
import type { ColumnRole, ColumnType } from '../types'
import { WHOLE_TABLE_PORT, type PortContext } from './ports'
import {
  expandWorkflowGroups,
  nodeIdFromRuntimeId,
  pruneGroupParameterBindings,
  runtimeIdsByNodeId,
  syncGroupParameterMirrors,
} from './groups'
import type { Workflow } from './types'

export const PROJECT_VERSION = 1

/** 数据集在工程里的**视图**：同一份数据，可以开不同的列 */
export interface ProjectColumnView {
  name: string
  type: ColumnType
  role: ColumnRole
  /** 是否进入下游计算。关掉的列不出端口、不参与执行 */
  enabled: boolean
}

/**
 * 数据集引用。
 *
 * `path` 只是方便（让 `--data` 可以省掉），**身份是 `contentHash`**。
 * 两者不一致时报错而不是静默采用 —— 那是"换了数据但结果没变"这类错的第一道闸。
 */
export interface ProjectDatasetRef {
  id: string
  name: string
  /** 相对工程文件的路径。人把这行改了就知道该去哪儿找数据 */
  path?: string
  contentHash?: string
  rowCount?: number
  timeColumn?: string | null
  /** 采样率 Hz。数据的属性，不是算子参数（契约规格 R3.4） */
  sampleRate?: number | null
  columns?: ProjectColumnView[]
}

export interface ProjectEnvironment {
  /** 核心算子包的版本。P4 的节点包机制落地前，这里只是记录 */
  coreVersion?: string
  python?: string
  device?: string
}

/** 工程对不可变模型制品的引用。权重留在 `.artifacts`，这里不存模型数据。 */
export interface ProjectModelArtifactRef {
  nodeId: string
  /** 新制品为 32 位 UUID；16 位仅用于兼容 2026-09-18 之前的旧制品目录。 */
  artifactId: string
  /** 训练节点输入指纹；当前图完全匹配才可自动恢复 */
  trainingFingerprint: string
  /** 对 meta.json 原始字节的 SHA-256，作为工程侧完整性锚点 */
  manifestSha256: string
  createdAt: string
}

/** 报告里的图像出处；像素只在 Markdown 的 data URL 中保存一次。 */
export interface ProjectReportFigure {
  id: string
  nodeId: string
  groupPath: string[]
  runtimeId: string
  portId: string
  label: string
  caption: string
  sha256: string
  /** 求值输入指纹的摘要；不把可能含用户代码的原指纹写进报告。 */
  sourceFingerprintSha256?: string
  width: number
  height: number
}

/** 报告与图并列保存，编辑报告不会使计算结果失效。 */
export interface ProjectReport {
  id: string
  title: string
  markdown: string
  createdAt: string
  updatedAt: string
  source?: {
    kind: 'agent-task'
    sessionId: string
    taskId: string
    evidenceRefs: string[]
  }
  figures: ProjectReportFigure[]
}

export interface Project {
  version: number
  /** 稳定工程身份；会话存储按它寻址，不参与计算指纹。旧工程可暂时没有。 */
  projectId?: string
  name: string
  description: string
  graph: Workflow
  /*
   * 画布批注。放在**顶层**而不是 graph 里，是为了让"它不参与计算"这件事由结构保证：
   * `Workflow` 这个类型不动，L1 校验器、求值计划、指纹、运行清单就都看不见它 ——
   * 不需要在每一处都记得加一句"如果是便签就跳过"（那种"记得加"迟早会漏一处，
   * 而漏一处的症状是一句 agent 试图去运行一张表格）。
   */
  annotations: Annotation[]
  /**
   * 实验笔记（Markdown 正文，空 = 还没记）。便签下架之后，记录住在这里。
   *
   * 为什么是"一整篇"而不是分节的数据树：大纲由标题（`## 实验 3`）自动生成，
   * 记的时候不用先想"这该放哪一节" —— 记录这件事的门槛必须低到"想记就记"。
   */
  notebook: string
  /** 可独立管理的 Markdown 报告；与随手记录的 notebook 分开。 */
  reports: ProjectReport[]
  datasets: ProjectDatasetRef[]
  /** 所有训练结果引用（含历史版本），与图节点参数和求值指纹分开 */
  modelArtifacts: ProjectModelArtifactRef[]
  environment: ProjectEnvironment
  runs: { index?: string; lastRunId?: string }
  /**
   * 最近几次改动。
   *
   * 为什么记在文件里而不是另存一份：**界面只拿到这一个文件**。浏览器里选文件之后
   * 拿不到"旁边那个文件"，所以要让"撤销 agent 刚才的改动"在界面上可用，
   * 记录就必须跟着工程走。
   *
   * 只留最近若干条：这是"这份工程刚被改过什么"的记录，不是完整审计（完整审计靠 git）。
   * 动作按结构存（`Record<string, unknown>`）：L0 的 IR 不认识 L1 的 op 类型，
   * 依赖方向不能倒过来。
   */
  patches: ProjectPatchRecord[]
}

export interface ProjectPatchRecord {
  at: number
  /** 这次改动是干什么的。review 时先看它 */
  reason?: string
  ops: Record<string, unknown>[]
  /** 撤销这次改动所需的动作 */
  reverse: Record<string, unknown>[]
}

/** 改动记录最多留几条。再多就该去看 git 了 */
export const PATCH_HISTORY_LIMIT = 20

/** 思维图的一支 → 文本。键序固定（id → text → children），理由同批注那一段 */
function branchToDoc(b: MindBranch): Record<string, unknown> {
  return {
    id: b.id,
    text: b.text,
    // 空 children 不写出来：`children: []` 与没有这一项是同一件事，写出来只会让 diff 变响
    ...(b.children.length > 0 ? { children: b.children.map(branchToDoc) } : {}),
  }
}

export function emptyProject(graph: Workflow): Project {
  return {
    version: PROJECT_VERSION,
    name: graph.name,
    description: graph.description,
    graph,
    annotations: [],
    notebook: '',
    reports: [],
    datasets: [],
    modelArtifacts: [],
    environment: {},
    runs: {},
    patches: [],
  }
}

/**
 * 从工程文件**声明**的数据集列推出端口上下文 —— 不需要真的把数据读进来。
 *
 * 这条能力很值：agent 改图时手上常常没有 CSV（数据在另一台机器上、或者几十个 G），
 * 但只要工程里记着列清单，端口就能算出来，连线是否合法就能判。
 * 判据与"数据已载入"时一致 —— 前提是工程里的列与数据一致，而这由内容哈希守着。
 */
export function projectPortContext(project: Project): PortContext {
  const byId = new Map(project.datasets.map((d) => [d.id, d]))
  const nodesById = new Map(project.graph.nodes.map((node) => [node.id, node]))

  // 没有运行摘要时，工程文件仍能为「数据源 → 拆列」提供静态表头。
  // 只从直接数据源推导；中间节点的列必须等它真正算出摘要后再决定。
  const sourceDatasetOf = (nodeId: string, portId: string): ProjectDatasetRef | null => {
    if (portId !== 'data') return null
    const edge = project.graph.edges.find((item) => item.target === nodeId && item.targetPort === portId)
    if (!edge || edge.sourcePort !== WHOLE_TABLE_PORT) return null
    const source = nodesById.get(edge.source)
    if (!source || source.type !== 'data.source') return null
    return byId.get(String(source.params.datasetId ?? '')) ?? null
  }

  const sourceTableColumnsOf = (nodeId: string, portId: string): string[] | null => {
    const dataset = sourceDatasetOf(nodeId, portId)
    if (!dataset?.columns) return null
    const features = dataset.columns
      .filter((column) => column.enabled && column.type === 'number')
      .map((column) => column.name)
    return dataset.timeColumn ? [dataset.timeColumn, ...features] : features
  }

  const sourceFeatureColumnsOf = (nodeId: string, portId: string): string[] | null => {
    const dataset = sourceDatasetOf(nodeId, portId)
    if (!dataset?.columns) return null
    return dataset.columns
      .filter((column) => column.enabled && column.type === 'number')
      .map((column) => column.name)
  }

  return {
    featuresOf: (id) =>
      (byId.get(id)?.columns ?? [])
        .filter((c) => c.enabled && c.type === 'number')
        .map((c) => c.name),
    timeColumnOf: (id) => byId.get(id)?.timeColumn ?? null,
    hasDataset: (id) => byId.has(id),
    columnsOf: sourceTableColumnsOf,
    featureColumnsOf: sourceFeatureColumnsOf,
  }
}

/* ------------------------------------------------------------------ */
/* 写出                                                               */
/* ------------------------------------------------------------------ */

/**
 * 序列化成文本。
 *
 * 排布刻意保持稳定（同样的工程 → 同样的文本）：这份文件的用途之一就是
 * **看差异**。字段顺序、缩进只要抖一下，diff 里就会出现一堆噪声，
 * 而"快速看出来 agent 改了什么"正是它存在的理由。
 */
export function projectToText(project: Project): string {
  const doc: Record<string, unknown> = {
    version: project.version,
    ...(project.projectId ? { projectId: project.projectId } : {}),
    name: project.name,
    description: project.description,
    graph: workflowToYamlObject(project.graph, undefined, { includeId: false, includeMetadata: false }),
  }

  /*
   * 批注排在 datasets 之前：它是画布内容，与图最近。
   *
   * 这里的字段顺序刻意稳定（id → kind → title → groupPath → position → 内容）—— 这份文件是
   * **人 diff 的对象**，键序抖一下，一次改内容就会在 diff 里变成"整条批注重写过"。
   * 位置取整：与节点坐标同一口径（那是人摆的版面，不该因为一次缩放留下 0.9999）。
   */
  if (project.annotations.length > 0) {
    doc.annotations = project.annotations.map((a) => {
      const head: Record<string, unknown> = {
        id: a.id,
        kind: a.kind,
        ...(a.title ? { title: a.title } : {}),
        ...(a.groupPath?.length ? { groupPath: [...a.groupPath] } : {}),
        position: { x: Math.round(a.position.x), y: Math.round(a.position.y) },
      }
      if (a.kind === 'table') return { ...head, columns: a.columns, rows: a.rows }
      if (a.kind === 'image') {
        return {
          ...head,
          src: a.src,
          alt: a.alt,
          width: Math.round(a.width),
          height: Math.round(a.height),
          ...(a.source ? { source: a.source } : {}),
        }
      }
      return { ...head, root: branchToDoc(a.root) }
    })
  }

  /*
   * 实验笔记。写在批注之后、datasets 之前：它同样是"画布之外的内容"，与批注挨着最好找。
   * 用 YAML 的块标量（`|`）而不是转义字符串：笔记是多行文本，转义之后人就没法 diff 了。
   */
  if (project.notebook.trim()) {
    doc.notebook = { markdown: project.notebook }
  }

  if (project.reports.length > 0) {
    doc.reports = project.reports.map((report) => ({
      id: report.id,
      title: report.title,
      markdown: report.markdown,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      ...(report.source ? { source: report.source } : {}),
      ...(report.figures.length > 0 ? { figures: report.figures } : {}),
    }))
  }

  if (project.datasets.length > 0) {
    doc.datasets = project.datasets.map((d) => {
      const out: Record<string, unknown> = { id: d.id, name: d.name }
      if (d.path !== undefined) out.path = d.path
      if (d.contentHash !== undefined) out.contentHash = d.contentHash
      if (d.rowCount !== undefined) out.rowCount = d.rowCount
      if (d.timeColumn !== undefined) out.timeColumn = d.timeColumn
      if (d.sampleRate !== undefined) out.sampleRate = d.sampleRate
      if (d.columns && d.columns.length > 0) {
        out.columns = d.columns.map((c) => ({
          name: c.name,
          type: c.type,
          role: c.role,
          enabled: c.enabled,
        }))
      }
      return out
    })
  }

  if (project.modelArtifacts.length > 0) {
    doc.modelArtifacts = project.modelArtifacts.map((artifact) => ({
      nodeId: artifact.nodeId,
      artifactId: artifact.artifactId,
      trainingFingerprint: artifact.trainingFingerprint,
      manifestSha256: artifact.manifestSha256,
      createdAt: artifact.createdAt,
    }))
  }

  if (Object.keys(project.environment).length > 0) doc.environment = project.environment
  if (Object.keys(project.runs).length > 0) doc.runs = project.runs
  if (project.patches.length > 0) {
    doc.patches = project.patches.map((p) => ({
      at: p.at,
      ...(p.reason ? { reason: p.reason } : {}),
      ops: p.ops,
      reverse: p.reverse,
    }))
  }

  const body = stringifyYaml(doc, { lineWidth: 0, indent: 2 })
  return `# SciViz 工程文件 v${project.version} —— 人与 agent 共用这一份\n${body}`
}

/* ------------------------------------------------------------------ */
/* 读入                                                               */
/* ------------------------------------------------------------------ */

export interface ParseProjectResult {
  project?: Project
  error?: string
  warnings: string[]
}

export interface ProjectParseOptions {
  /** `.sciviz` 重开时保留图中的稳定 ID，由工程数据集绑定在执行边界解析到本机。 */
  preserveDatasetIds?: boolean
}

const isBasic = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

export function normalizeProjectColumns(raw: unknown): ProjectColumnView[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: ProjectColumnView[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    if (typeof c.name !== 'string' || !c.name) continue
    out.push({
      name: c.name,
      type: c.type === 'string' ? 'string' : 'number',
      role:
        c.role === 'time' || c.role === 'categorical' || c.role === 'continuous'
          ? c.role
          : 'continuous',
      // 缺省是"启用"：老文件里没有这一段时，行为要与导入时的默认一致
      enabled: c.enabled !== false,
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 读一份工程。
 *
 * `ctx` 为图里的端口解析提供当前数据视图。一般调用方会先绑定数据；`.sciviz` 重开
 * 也可设 `preserveDatasetIds`，先保留工程 ID，再由调用方在执行边界建立本机映射。
 * 不提供 `ctx` 时图仍然读得进来，只是动态数据源端口暂时算不出来。
 */
export function textToProject(
  text: string,
  ctx?: PortContext,
  fallbackId = 'project',
  options: ProjectParseOptions = {},
): ParseProjectResult {
  const warnings: string[] = []

  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (e) {
    return { error: `YAML 语法错误：${e instanceof Error ? e.message : String(e)}`, warnings }
  }
  if (!doc || typeof doc !== 'object') {
    return { error: '文件是空的，或者不是一份工程', warnings }
  }
  const root = doc as Record<string, unknown>

  // 没有 version 的按"旧工作流 YAML"处理：图在顶层，没有数据集与视图
  const isProject = typeof root.version === 'number'
  if (!isProject && root.graph === undefined) {
    warnings.push('这份文件没有 version 与 graph，按旧版工作流 YAML 读取（只有图，没有数据集视图）')
  }

  const graphSource = root.graph !== undefined ? root.graph : root
  /*
   * 工程文件允许一张空图，旧版工作流 YAML 不允许（判据在 `yamlToWorkflow` 的
   * `allowEmptyNodes` 上）。区别对待的理由是内容不同：工程里除了图还有数据集视图、
   * 改动记录与**批注**，"我只在画布上记了两张便签、图还没搭"是一份有内容的工程；
   * 而一份 nodes 为空的 YAML 就是空文件，报错比"打开后什么都没有"有用。
   *
   * 不放开的话症状很难看：那样一份文件**整个打不开**，人记的读数跟着一起读不出来。
   */
  const graphForParse =
    isProject && !Array.isArray((graphSource as { nodes?: unknown })?.nodes)
      ? { nodes: [], edges: [] }
      : graphSource
  const parsed = yamlToWorkflow(
    stringifyYaml(graphForParse, { lineWidth: 0 }),
    fallbackId,
    ctx,
    {
      allowEmptyNodes: isProject,
      preserveDatasetIds: isProject && options.preserveDatasetIds === true,
    },
  )
  if (!parsed.workflow) return { error: parsed.error ?? '图读不出来', warnings: parsed.warnings ?? [] }
  warnings.push(...(parsed.warnings ?? []))

  /*
   * 工程的名字与描述在**顶层**，而图那一段里没有它们（图只装节点与连线）。
   * 只把 graph: 子树交给 `yamlToWorkflow` 是为了复用同一套图解析，代价就是这两项
   * 要从这里补回去 —— 漏了的话，往返一次工程名就变成"未命名工作流"。
   */
  if (typeof root.name === 'string' && root.name) parsed.workflow.name = root.name
  if (typeof root.description === 'string') parsed.workflow.description = root.description

  const datasets: ProjectDatasetRef[] = []
  if (Array.isArray(root.datasets)) {
    for (const item of root.datasets) {
      if (!item || typeof item !== 'object') continue
      const d = item as Record<string, unknown>
      if (typeof d.id !== 'string' || !d.id) {
        warnings.push('datasets 里有一项没有 id，已跳过')
        continue
      }
      const ref: ProjectDatasetRef = {
        id: d.id,
        name: typeof d.name === 'string' && d.name ? d.name : d.id,
      }
      if (typeof d.path === 'string' && d.path) ref.path = d.path
      if (typeof d.contentHash === 'string' && d.contentHash) ref.contentHash = d.contentHash
      if (typeof d.rowCount === 'number') ref.rowCount = d.rowCount
      if (typeof d.timeColumn === 'string') ref.timeColumn = d.timeColumn
      if (d.timeColumn === null) ref.timeColumn = null
      if (typeof d.sampleRate === 'number') ref.sampleRate = d.sampleRate
      const columns = normalizeProjectColumns(d.columns)
      if (columns) ref.columns = columns
      datasets.push(ref)
    }
  }

  const environment: ProjectEnvironment = {}
  if (root.environment && typeof root.environment === 'object') {
    const e = root.environment as Record<string, unknown>
    if (isBasic(e.coreVersion)) environment.coreVersion = String(e.coreVersion)
    if (isBasic(e.python)) environment.python = String(e.python)
    if (isBasic(e.device)) environment.device = String(e.device)
  }

  const modelArtifacts: ProjectModelArtifactRef[] = []
  if (Array.isArray(root.modelArtifacts)) {
    let invalid = 0
    for (const raw of root.modelArtifacts) {
      if (!raw || typeof raw !== 'object') {
        invalid += 1
        continue
      }
      const artifact = raw as Record<string, unknown>
      if (
        typeof artifact.nodeId !== 'string' || !artifact.nodeId ||
        typeof artifact.artifactId !== 'string' || !/^(?:[a-f0-9]{16}|[a-f0-9]{32})$/i.test(artifact.artifactId) ||
        typeof artifact.trainingFingerprint !== 'string' || !artifact.trainingFingerprint ||
        typeof artifact.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.manifestSha256) ||
        typeof artifact.createdAt !== 'string' || !artifact.createdAt
      ) {
        invalid += 1
        continue
      }
      modelArtifacts.push({
        nodeId: artifact.nodeId,
        artifactId: artifact.artifactId,
        trainingFingerprint: artifact.trainingFingerprint,
        manifestSha256: artifact.manifestSha256,
        createdAt: artifact.createdAt,
      })
    }
    if (invalid > 0) {
      warnings.push(`modelArtifacts 里有 ${invalid} 条制品引用缺少有效身份或校验值，已阻止自动恢复`)
    }
  }

  const runs: Project['runs'] = {}
  if (root.runs && typeof root.runs === 'object') {
    const r = root.runs as Record<string, unknown>
    if (typeof r.index === 'string') runs.index = r.index
    if (typeof r.lastRunId === 'string') runs.lastRunId = r.lastRunId
  }

  const patches: ProjectPatchRecord[] = []
  /*
   * 批注。认不出来的条目**报数**而不是静默跳过 —— "我写的表格没了"是这批功能里
   * 最伤的一种失败，而它的成因往往只是 kind 拼错了一个字母。
   */
  const annotations: Annotation[] = []
  if (Array.isArray(root.annotations)) {
    let skipped = 0
    let skippedNotes = 0
    for (const raw of root.annotations) {
      // 缺 id 的思维图分支按"文件里第几条 + 第几支"补一个：稳定可复现，
      // 用随机数会让同一份文件每次读进来都不一样（diff 与测试都会疯）
      const index = annotations.length + skipped
      let branchSeq = 0
      const a = normalizeAnnotation(raw, () => `m${index}_${++branchSeq}`)
      if (!a) {
        // 便签单独数一遍：它不是"认不出来的垃圾"，而是一个**下架的功能** ——
        // 报出来的那句话要能告诉人"你的记录去哪儿了"，而不是"格式不对"
        const kind = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).kind : null
        if (kind === 'note') skippedNotes += 1
        skipped += 1
        continue
      }
      const path = annotationGroupPath(a)
      if (!annotationGroupPathExists(parsed.workflow, path)) {
        annotations.push({ ...a, groupPath: [] })
        warnings.push(`annotations[${index}] 引用了不存在的组块路径，已移回主画布`)
      } else {
        annotations.push(a)
      }
    }
    if (skippedNotes > 0) {
      warnings.push(
        `annotations 里有 ${skippedNotes} 条便签：便签已下架（记录改到右侧「实验笔记」栏），这些条目被忽略，请把那几段字搬进笔记`,
      )
    }
    if (skipped - skippedNotes > 0) {
      warnings.push(
        `annotations 里有 ${skipped - skippedNotes} 条认不出来（kind 不是 table / mindmap / image，或缺 id），已跳过`,
      )
    }
  }

  /*
   * 组块的对外参数与内部节点的那份副本必须是同一个值（契约规格 R15.3：执行时以对外值为准）。
   * 文件是手改的、或者是旧编辑器写的（那时在子图里改参数只改了内部副本，被对外值盖掉了），
   * 两处就会不一样 —— 打开时按"对外值"对齐一次，界面显示的数才和真正参与计算的数一致。
   */
  /*
   * 组块的对外参数绑定可能已经悬空（封装之后又改了里面那个节点的函数签名），
   * 先清掉再说：留着它会让展开抛异常，而展开在每一轮调度的开头 ——
   * 一份带着这种绑定的工程打开后，整张画布一个块都不会再算。删了什么要说出来。
   */
  const pruned = pruneGroupParameterBindings(parsed.workflow)
  for (const gone of pruned.dropped) {
    warnings.push(
      `组块「${gone.groupLabel}」的参数「${gone.label}」已移除：内部节点里已经没有这个参数了（多半是函数签名改过）`,
    )
  }
  const liveGraph = syncGroupParameterMirrors(pruned.workflow)
  /*
   * 制品引用按运行时 id 归属，而组块结构变化会改它；老文件里可能留着对不上的那条。
   * 打开时按节点身份重新对上，并把结果说清楚（见 `repairArtifactNodeIds`）。
   */
  const liveModelArtifacts = repairArtifactNodeIds(liveGraph, modelArtifacts, warnings)
  const liveAnnotations = annotations

  /*
   * 实验笔记。宽容读取：也接受直接写成一整段字符串（`notebook: |`），那种写法人手改起来更顺。
   */
  let notebook = ''
  if (typeof root.notebook === 'string') notebook = root.notebook
  else if (root.notebook && typeof root.notebook === 'object') {
    const raw = (root.notebook as Record<string, unknown>).markdown
    if (typeof raw === 'string') notebook = raw
  }

  const reports: ProjectReport[] = []
  if (Array.isArray(root.reports)) {
    const ids = new Set<string>()
    for (const raw of root.reports) {
      if (!raw || typeof raw !== 'object') {
        warnings.push('reports 中有无效条目，已跳过')
        continue
      }
      const item = raw as Record<string, unknown>
      if (typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
          typeof item.title !== 'string' || typeof item.markdown !== 'string') {
        warnings.push('reports 中有缺少 id、标题或正文，或 id 重复的条目，已跳过')
        continue
      }
      ids.add(item.id)
      const source = item.source && typeof item.source === 'object'
        ? item.source as Record<string, unknown>
        : null
      const figures: ProjectReportFigure[] = []
      if (Array.isArray(item.figures)) {
        for (const rawFigure of item.figures) {
          if (!rawFigure || typeof rawFigure !== 'object') continue
          const figure = rawFigure as Record<string, unknown>
          if (typeof figure.id !== 'string' || typeof figure.nodeId !== 'string' ||
              typeof figure.sha256 !== 'string') continue
          figures.push({
            id: figure.id,
            nodeId: figure.nodeId,
            groupPath: Array.isArray(figure.groupPath) ? figure.groupPath.filter((part): part is string => typeof part === 'string') : [],
            runtimeId: typeof figure.runtimeId === 'string' ? figure.runtimeId : figure.nodeId,
            portId: typeof figure.portId === 'string' ? figure.portId : 'figure',
            label: typeof figure.label === 'string' ? figure.label : figure.nodeId,
            caption: typeof figure.caption === 'string' ? figure.caption : '',
            sha256: figure.sha256,
            ...(typeof figure.sourceFingerprintSha256 === 'string' ? { sourceFingerprintSha256: figure.sourceFingerprintSha256 } : {}),
            width: typeof figure.width === 'number' ? figure.width : 0,
            height: typeof figure.height === 'number' ? figure.height : 0,
          })
        }
      }
      reports.push({
        id: item.id,
        title: item.title,
        markdown: item.markdown,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
        ...(source?.kind === 'agent-task' && typeof source.sessionId === 'string' && typeof source.taskId === 'string'
          ? { source: {
              kind: 'agent-task' as const,
              sessionId: source.sessionId,
              taskId: source.taskId,
              evidenceRefs: Array.isArray(source.evidenceRefs)
                ? source.evidenceRefs.filter((ref): ref is string => typeof ref === 'string') : [],
            } }
          : {}),
        figures,
      })
    }
  }

  if (Array.isArray(root.patches)) {
    for (const raw of root.patches) {
      if (!raw || typeof raw !== 'object') continue
      const p = raw as Record<string, unknown>
      if (!Array.isArray(p.ops)) continue
      patches.push({
        at: typeof p.at === 'number' ? p.at : 0,
        ...(typeof p.reason === 'string' && p.reason ? { reason: p.reason } : {}),
        ops: p.ops as Record<string, unknown>[],
        reverse: Array.isArray(p.reverse) ? (p.reverse as Record<string, unknown>[]) : [],
      })
    }
    // 超出上限的老记录直接丢：它们该由 git 管
    if (patches.length > PATCH_HISTORY_LIMIT) patches.splice(0, patches.length - PATCH_HISTORY_LIMIT)
  }

  return {
    project: {
      version: typeof root.version === 'number' ? root.version : 0,
      ...(typeof root.projectId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(root.projectId)
        ? { projectId: root.projectId }
        : {}),
      name: parsed.workflow.name,
      description: parsed.workflow.description,
      graph: liveGraph,
      annotations: liveAnnotations,
      notebook,
      reports,
      datasets,
      modelArtifacts: liveModelArtifacts,
      environment,
      runs,
      patches,
    },
    warnings,
  }
}

/**
 * 打开工程时把模型制品引用重新对上节点。
 *
 * 引用的归属是**运行时 id**（组块里的节点是 `group:["g1"]:"n16"` 这种），而封装 / 解散 /
 * 再嵌一层都会改它。结构变化本身已经会搬运引用（`useWorkflowStore.migrateModelArtifacts`），
 * 但老工程（以及手写、旧版编辑器写下的文件）里可能留着对不上的那条 —— 症状是训练节点
 * 一声不响地回到"等待开始训练"，用户看不出是权重丢了。
 *
 * 修复的判据只有一条：**节点 id 本身**（组路径只是它此刻的位置），而且必须唯一。
 * 有歧义、找不到、或者整图展开失败时原样保留 —— 宁可让人看到"引用没被用上"，
 * 也不能凭猜测把别人的权重塞给一个节点。
 */
export function repairArtifactNodeIds(
  graph: Workflow,
  refs: ProjectModelArtifactRef[],
  warnings: string[],
): ProjectModelArtifactRef[] {
  if (refs.length === 0) return refs
  let runtimeIds: Set<string>
  let byNodeId: Map<string, string[]>
  try {
    const flat = expandWorkflowGroups(graph)
    runtimeIds = new Set(flat.nodes.map((node) => node.id))
    // 节点身份要从**带 group 子图的图**里读：展开后的 id 已经是运行时 id 了
    byNodeId = runtimeIdsByNodeId(graph)
  } catch {
    // 图本身有问题时不碰引用：先把文件打开，把问题留给校验与执行面去说
    return refs
  }

  let repaired = 0
  let unmatched = 0
  const next = refs.map((ref) => {
    if (runtimeIds.has(ref.nodeId)) return ref
    const nodeId = nodeIdFromRuntimeId(ref.nodeId)
    const candidates = nodeId ? byNodeId.get(nodeId) ?? [] : []
    if (candidates.length === 1) {
      repaired += 1
      return { ...ref, nodeId: candidates[0] }
    }
    unmatched += 1
    return ref
  })

  if (repaired > 0) {
    warnings.push(
      `有 ${repaired} 条模型制品引用按节点身份重新对上了组块里的节点（组块结构变化会改节点的运行时 id）`,
    )
  }
  if (unmatched > 0) {
    warnings.push(
      `有 ${unmatched} 条模型制品引用在当前图里找不到对应节点，不会被自动恢复；权重文件仍在磁盘上（删节点不会连带删权重）`,
    )
  }
  return next
}
