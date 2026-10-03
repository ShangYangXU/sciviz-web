/**
 * 无头侧的工程装载：把"`一份 .sciviz`（或旧的工作流 YAML）+ 若干 CSV"变成核能直接跑的东西。
 *
 * 两条从"人与 agent 轮流干活"推出来的规则：
 *
 * 1. **数据集按名字/身份绑定，不按 id。** YAML 里的 `datasetId` 是导入时现生成的
 *    （`ds-1-xxxx`），换一次会话必然失效。文件里稳定的东西是 `datasets[].name`
 *    与 `contentHash`。
 * 2. **人做的视图决定要生效。** 启用了哪些列、哪一列是时间轴，这些记在工程文件的
 *    `datasets[].columns` 里。agent 接手时必须按**人的那套视图**来算，
 *    而不是按 CSV 解析出来的默认值 —— 否则同一份数据，人跑出来和 agent 跑出来不一样。
 *
 * 装载分两趟是刻意的：先拿到"引用了哪些数据集"，载入数据、建好目录，**再**用真正的
 * 端口上下文解析图。顺序反过来的话，数据源端口在第一趟里必然算不出来，
 * 于是每条连线都会被记一条"暂时接不上"的告警 —— 而那些线其实是好的。
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseCsv, toStoredDataset } from '../data/csvParse'
import { DatasetCatalog, buildDatasetRef, type DatasetRef } from '../kernel/dataset'
import { textToProject, type Project, type ProjectDatasetRef } from '../workflow/project'
import { validateWorkflow, type ValidationResult } from '../contract/validate'
import { fileSource } from './fileSource'
import type { StoredDataset } from '../data/columnStore'
import type { Workflow } from '../workflow/types'
import type { ParsedFile } from '../data/importTypes'

export interface DataBinding {
  key: string
  path: string
}

/** 工程里出现的一次数据集引用：工程文件里的一条 + 哪些节点在用它 */
interface DatasetUse {
  ref: ProjectDatasetRef
  nodeIds: string[]
  nodeLabels: string[]
}

export interface BoundDataset {
  datasetId: string
  /** 用哪个键绑上的：`--data` 的键，或者工程里记的 path */
  boundBy: string
  path: string
  name: string
  rowCount: number
  declaredRowCount?: number
  /** 行数与工程里记的不一致。不是错误，但必须让调用方看见 */
  rowCountMismatch: boolean
  /** 内容哈希与工程里记的不一致 —— 这几乎肯定是"换了一份数据" */
  contentHashMismatch: boolean
  ref: DatasetRef
}

export interface UnboundDataset {
  datasetId: string
  name?: string
  nodeIds: string[]
  /** 工程里记了路径但文件不在 */
  missingPath?: string
}

export interface LoadedProject {
  /** 图读不动时为 null。注意：数据缺失**不**让它为 null */
  workflow: Workflow | null
  /** 规范化后的工程（含数据集视图）。patch 与保存都基于它 */
  project: Project | null
  parseError?: string
  catalog: DatasetCatalog
  datasets: DatasetRef[]
  bound: BoundDataset[]
  unbound: UnboundDataset[]
  importWarnings: string[]
  /** 装载阶段的用法问题（文件不存在等）。不是契约违约 */
  usageErrors: string[]
  /** 工程里记的版本高于本机支持的版本 */
  versionTooNew?: number
  validation: ValidationResult | null
}

/** 原始节点数组。旧文件把身份信息写在节点上，这里要用一下 */
function rawNodes(text: string): Record<string, unknown>[] {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch {
    return []
  }
  const root = doc as Record<string, unknown> | null
  if (!root || typeof root !== 'object') return []
  const graph = (root.graph && typeof root.graph === 'object' ? root.graph : root) as Record<
    string,
    unknown
  >
  return (Array.isArray(graph.nodes) ? graph.nodes : []).filter(
    (n): n is Record<string, unknown> => !!n && typeof n === 'object',
  )
}

/**
 * 收集数据集引用。
 *
 * `datasets:` 段**复用工程文件的解析器**（`textToProject`）—— 列视图这类结构不能再读一遍，
 * 两份读法迟早会分叉。节点上的 `dataset:` 段是旧格式的遗留，单独扫一下补 name/rowCount。
 */
function collectDatasetUses(text: string): DatasetUse[] {
  const byId = new Map<string, DatasetUse>()

  const parsed = textToProject(text, undefined, 'wf-cli')
  for (const ref of parsed.project?.datasets ?? []) {
    byId.set(ref.id, { ref: { ...ref }, nodeIds: [], nodeLabels: [] })
  }

  for (const raw of rawNodes(text)) {
    const n = raw as {
      id?: unknown
      label?: unknown
      type?: unknown
      params?: { datasetId?: unknown }
      dataset?: { name?: unknown; rowCount?: unknown }
    }
    const datasetId = n?.params?.datasetId
    if (typeof datasetId !== 'string' || !datasetId) continue
    let use = byId.get(datasetId)
    if (!use) {
      // 旧文件没有 datasets: 段，身份信息只写在节点上（name + rowCount）
      use = {
        ref: {
          id: datasetId,
          name: typeof n.dataset?.name === 'string' ? n.dataset.name : datasetId,
          ...(typeof n.dataset?.rowCount === 'number' ? { rowCount: n.dataset.rowCount } : {}),
        },
        nodeIds: [],
        nodeLabels: [],
      }
      byId.set(datasetId, use)
    }
    if (typeof n.id === 'string') use.nodeIds.push(n.id)
    use.nodeLabels.push(typeof n.label === 'string' ? n.label : String(n.type ?? datasetId))
  }

  return [...byId.values()]
}

/**
 * 把工程里记的**视图**套到刚解析出来的数据上。
 *
 * 这是"人机轮流"最容易出错的一处：人对 CSV 的默认解析结果做过调整（关掉几列、
 * 指定时间列），如果 agent 接手时不套用，同一份数据在两边会算出不同的图 ——
 * 而且两边都不会报错。
 */
function applyView(
  ds: StoredDataset,
  ref: ProjectDatasetRef,
  warnings: string[],
): void {
  if (ref.timeColumn !== undefined && ref.timeColumn !== null && ref.timeColumn !== ds.timeColumn) {
    warnings.push(
      `工程里把「${ref.timeColumn}」记作时间列，但数据里识别出来的是` +
        `${ds.timeColumn ? `「${ds.timeColumn}」` : '（没有时间列）'} —— 已按工程为准`,
    )
  }
  if (!ref.columns || ref.columns.length === 0) return

  const byName = new Map(ds.columns.map((c) => [c.name, c]))
  for (const view of ref.columns) {
    const column = byName.get(view.name)
    if (!column) {
      warnings.push(`工程里启用了列「${view.name}」，但这份数据里没有这一列 —— 请确认是不是同一份数据`)
      continue
    }
    column.enabled = view.enabled && column.type === 'number'
    column.role = view.role
  }
}

export interface LoadProjectOptions {
  /** 解析 CSV 的进度回调。CLI 用它打点，避免大文件时看起来像卡死 */
  onProgress?: (dataset: string, phase: string, ratio: number) => void
}

export async function loadProject(
  yamlPath: string,
  bindings: DataBinding[],
  options: LoadProjectOptions = {},
): Promise<LoadedProject> {
  const usageErrors: string[] = []
  const empty: LoadedProject = {
    workflow: null,
    project: null,
    catalog: new DatasetCatalog(),
    datasets: [],
    bound: [],
    unbound: [],
    importWarnings: [],
    usageErrors,
    validation: null,
  }

  if (!fs.existsSync(yamlPath)) {
    usageErrors.push(`工程文件不存在：${yamlPath}`)
    return empty
  }
  const text = fs.readFileSync(yamlPath, 'utf8')
  const dir = path.dirname(path.resolve(yamlPath))

  const uses = collectDatasetUses(text)
  const byKey = new Map(bindings.map((b) => [b.key, b.path]))

  /** 同一个路径只解析一次：两个数据集 id 指向同一个 CSV 是常事 */
  const parsedCache = new Map<string, ParsedFile>()
  const catalog = new DatasetCatalog()
  const bound: BoundDataset[] = []
  const datasets: DatasetRef[] = []
  const usedKeys = new Set<string>()
  const importWarnings: string[] = []

  for (const use of uses) {
    const { ref } = use
    const key =
      (byKey.has(ref.id) && ref.id) ||
      (byKey.has(ref.name) && ref.name) ||
      null
    const fromProject = ref.path ? path.resolve(dir, ref.path) : null
    const csvPath = key ? byKey.get(key)! : fromProject

    if (!csvPath) {
      continue // 交给下面的 unbound 汇总，那里有更完整的上下文
    }
    if (key) usedKeys.add(key)
    if (!fs.existsSync(csvPath)) {
      if (key) usageErrors.push(`--data ${key} 指向的文件不存在：${csvPath}`)
      continue
    }

    let parsed = parsedCache.get(csvPath)
    if (!parsed) {
      const source = fileSource(csvPath)
      try {
        parsed = await parseCsv(source, (p) => options.onProgress?.(ref.name, p.phase, p.ratio))
      } finally {
        source.close()
      }
      parsedCache.set(csvPath, parsed)
    }

    const name = ref.name ?? path.basename(csvPath).replace(/\.(csv|txt|tsv)$/i, '')
    // 注册在节点真正引用的 id 上：端口解析、指纹、载荷查询全都按它来
    const stored: StoredDataset = toStoredDataset(parsed, {
      id: ref.id,
      name,
      source: path.basename(csvPath),
      importedAt: 0,
    })
    applyView(stored, ref, importWarnings)

    // 启用的列不能是数据里没有的列。applyView 已经逐列提过，这里补一句总结
    const enabled = catalogFeatures(stored)
    if (enabled.length === 0) {
      importWarnings.push(`数据集「${name}」按工程里的视图没有任何启用列 —— 下游会拿不到数据`)
    }

    const refOut = await buildDatasetRef(stored)
    catalog.add(stored, refOut)
    datasets.push(refOut)

    const hashMismatch = !!ref.contentHash && ref.contentHash !== refOut.contentHash
    if (hashMismatch) {
      importWarnings.push(
        `数据集「${name}」的内容与工程里记的不是同一份：` +
          `工程记 ${ref.contentHash?.slice(0, 14)}…，实际是 ${refOut.contentHash.slice(0, 14)}…。` +
          '如果你只是换了一份数据，这是对的；如果不是，请核对路径',
      )
    }
    const rowCountMismatch = ref.rowCount !== undefined && ref.rowCount !== refOut.rowCount
    if (rowCountMismatch) {
      importWarnings.push(
        `数据集「${name}」工程里记 ${ref.rowCount} 行，实际 ${refOut.rowCount} 行 —— 请确认是不是同一份数据`,
      )
    }

    bound.push({
      datasetId: ref.id,
      boundBy: key ?? 'path',
      path: csvPath,
      name,
      rowCount: refOut.rowCount,
      ...(ref.rowCount !== undefined ? { declaredRowCount: ref.rowCount } : {}),
      rowCountMismatch,
      contentHashMismatch: hashMismatch,
      ref: refOut,
    })
  }

  for (const b of bindings) {
    if (!usedKeys.has(b.key)) {
      usageErrors.push(`--data 的键「${b.key}」在工程里没有任何节点引用（可用 id 或数据集名字）`)
    }
  }

  const unbound: UnboundDataset[] = []
  for (const use of uses) {
    if (catalog.has(use.ref.id)) continue
    const missingPath = use.ref.path ? path.resolve(dir, use.ref.path) : undefined
    unbound.push({
      datasetId: use.ref.id,
      ...(use.ref.name ? { name: use.ref.name } : {}),
      nodeIds: use.nodeIds,
      ...(missingPath ? { missingPath } : {}),
    })
  }

  // 数据绑好之后再用真正的端口上下文解析一遍：这一遍的端口与告警才是准的
  const parsedProject = textToProject(text, catalog.portContext())
  if (!parsedProject.project) {
    return { ...empty, parseError: parsedProject.error ?? '解析失败', importWarnings: parsedProject.warnings }
  }
  importWarnings.push(...parsedProject.warnings)

  for (const u of unbound) {
    const label = u.name ? `「${u.name}」（id ${u.datasetId}）` : `id ${u.datasetId}`
    importWarnings.push(
      u.missingPath
        ? `数据集 ${label} 记的路径找不到文件：${u.missingPath} —— 把它放回去，或用 --data ${u.name ?? u.datasetId}=<路径.csv> 指定`
        : `数据集 ${label} 没有对应的 CSV：用 --data ${u.name ?? u.datasetId}=<路径.csv> 绑定，` +
          '否则它上面这些节点的端口算不出来，连线也不会被判定',
    )
  }

  const project = parsedProject.project
  // 版本比本机新：不阻断，但必须说出来（R11：禁止静默继续）
  const versionTooNew = project.version > PROJECT_SUPPORTED ? project.version : undefined
  if (versionTooNew) {
    importWarnings.push(
      `这份工程是 v${versionTooNew}，本机只认到 v${PROJECT_SUPPORTED} —— 可能有本版读不懂的字段，请核对`,
    )
  }

  return {
    workflow: project.graph,
    project,
    catalog,
    datasets,
    bound,
    unbound,
    importWarnings,
    usageErrors,
    ...(versionTooNew ? { versionTooNew } : {}),
    validation: validateWorkflow(project.graph, catalog.portContext()),
  }
}

/** 本机能读的工程版本。与 `workflow/project.ts` 的 PROJECT_VERSION 对齐 */
export const PROJECT_SUPPORTED = 1

function catalogFeatures(ds: StoredDataset): string[] {
  return ds.columns.filter((c) => c.enabled && c.type === 'number' && c.name in ds.data).map((c) => c.name)
}
