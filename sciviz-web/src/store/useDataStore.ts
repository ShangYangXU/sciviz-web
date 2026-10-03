import { useMemo } from 'react'
import { create } from 'zustand'
import type { DecimateMode, StoredDataset } from '../data/columnStore'
import { materializeView } from '../data/columnStore'
import type { Dataset } from '../types'
// 只用类型：身份描述的定义放在 ports 里（端口上下文要用它），运行时不会因此产生循环依赖
import type { DatasetIdentity } from '../workflow/ports'

/** 数据集选择器用的统一引用。数据必须由用户显式导入。 */
export interface DatasetRef {
  id: string
  name: string
  kind: 'imported'
  rowCount: number
  /** 可用的数值特征数 */
  featureCount: number
  description: string
}

/** `.sciviz` 中保存的稳定数据集引用；列视图用于本机 CSV 匹配成功时恢复。 */
export interface ProjectDatasetBinding {
  id: string
  name: string
  rowCount?: number
  columns?: Array<{ name: string; enabled: boolean }>
}

interface DataState {
  imported: StoredDataset[]
  /** 工程里的稳定 datasetId → 本机本次导入生成的 ID。 */
  datasetBindings: Record<string, string>
  projectDatasetRefs: ProjectDatasetBinding[]
  setProjectDatasetRefs: (refs: ProjectDatasetBinding[]) => void
  addImported: (ds: StoredDataset) => void
  removeImported: (id: string) => void
  setColumnEnabled: (dsId: string, col: string, enabled: boolean) => void
  setColumnsEnabled: (dsId: string, cols: string[], enabled: boolean) => void
}

function matchProjectDataset(
  ref: ProjectDatasetBinding,
  imported: StoredDataset[],
): { dataset: StoredDataset; exact: boolean } | null {
  const byId = imported.find((dataset) => dataset.id === ref.id)
  if (byId) return { dataset: byId, exact: true }

  const sameName = imported.filter((dataset) => dataset.name === ref.name)
  const byNameAndRows = sameName.find((dataset) => dataset.rowCount === ref.rowCount)
  if (byNameAndRows) return { dataset: byNameAndRows, exact: true }
  if (ref.rowCount === undefined && sameName.length > 0) {
    return { dataset: sameName[sameName.length - 1], exact: false }
  }
  if (sameName.length === 1) return { dataset: sameName[0], exact: false }
  return null
}

function refreshProjectBindings(
  imported: StoredDataset[],
  refs: ProjectDatasetBinding[],
  previous: Record<string, string>,
  forceApplyViews = false,
): { imported: StoredDataset[]; datasetBindings: Record<string, string> } {
  const datasetBindings: Record<string, string> = {}
  const viewByLocalId = new Map<string, ProjectDatasetBinding>()
  for (const ref of refs) {
    const match = matchProjectDataset(ref, imported)
    if (!match) continue
    datasetBindings[ref.id] = match.dataset.id
    if (forceApplyViews || previous[ref.id] !== match.dataset.id) {
      viewByLocalId.set(match.dataset.id, ref)
    }
  }

  if (viewByLocalId.size === 0) return { imported, datasetBindings }
  return {
    datasetBindings,
    imported: imported.map((dataset) => {
      const ref = viewByLocalId.get(dataset.id)
      if (!ref?.columns?.length) return dataset
      const enabledByName = new Map(ref.columns.map((column) => [column.name, column.enabled]))
      return {
        ...dataset,
        columns: dataset.columns.map((column) =>
          enabledByName.has(column.name)
            ? { ...column, enabled: enabledByName.get(column.name)! }
            : column,
        ),
      }
    }),
  }
}

export const useDataStore = create<DataState>((set) => ({
  imported: [],
  datasetBindings: {},
  projectDatasetRefs: [],

  setProjectDatasetRefs: (refs) => {
    const projectDatasetRefs = refs.map((ref) => ({
      ...ref,
      ...(ref.columns ? { columns: ref.columns.map((column) => ({ ...column })) } : {}),
    }))
    set((state) => ({
      projectDatasetRefs,
      ...refreshProjectBindings(state.imported, projectDatasetRefs, {}, true),
    }))
  },

  addImported: (ds) =>
    set((state) =>
      refreshProjectBindings(
        [...state.imported, ds],
        state.projectDatasetRefs,
        state.datasetBindings,
      ),
    ),

  removeImported: (id) =>
    set((state) =>
      refreshProjectBindings(
        state.imported.filter((dataset) => dataset.id !== id),
        state.projectDatasetRefs,
        state.datasetBindings,
      ),
    ),

  setColumnEnabled: (dsId, col, enabled) =>
    set((s) => ({
      imported: s.imported.map((d) =>
        d.id === dsId
          ? { ...d, columns: d.columns.map((c) => (c.name === col ? { ...c, enabled } : c)) }
          : d,
      ),
    })),

  setColumnsEnabled: (dsId, cols, enabled) =>
    set((s) => {
      const target = new Set(cols)
      return {
        imported: s.imported.map((d) =>
          d.id === dsId
            ? { ...d, columns: d.columns.map((c) => (target.has(c.name) ? { ...c, enabled } : c)) }
            : d,
        ),
      }
    }),

}))

/** 新建数据源节点默认选最近导入的数据；没有数据时保持空值。 */
export function defaultDatasetId(): string {
  const list = useDataStore.getState().imported
  return list.length > 0 ? list[list.length - 1].id : ''
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

export function getStoredDataset(id: string): StoredDataset | undefined {
  const state = useDataStore.getState()
  const localId = state.datasetBindings[id] ?? id
  return state.imported.find((d) => d.id === localId)
}

/** 工程节点保留稳定 ID；需要呈现本机会话的选择项时用这个解析到本地 ID。 */
export function localDatasetIdFor(id: string): string {
  return useDataStore.getState().datasetBindings[id] ?? id
}

/** 枚举全部已导入的数据集。 */
export function listDatasetRefs(): DatasetRef[] {
  const imported: DatasetRef[] = useDataStore.getState().imported.map((d) => ({
    id: d.id,
    name: d.name,
    kind: 'imported',
    rowCount: d.rowCount,
    featureCount: d.columns.filter((c) => c.enabled && c.type === 'number').length,
    description: `${d.source} · ${d.rowCount.toLocaleString('en-US')} 行`,
  }))
  return imported
}

/** 某数据集当前启用的特征列名，供动态端口用 */
export function featuresOf(datasetId: string): string[] {
  const stored = getStoredDataset(datasetId)
  if (stored) {
    return stored.columns.filter((c) => c.enabled && c.type === 'number').map((c) => c.name)
  }
  return []
}

/** 某数据集的时间列名；没有时间列时为 null */
export function timeColumnOf(datasetId: string): string | null {
  return getStoredDataset(datasetId)?.timeColumn ?? null
}

/**
 * 这个 id 在本机有没有数据集。
 *
 * 光看 `featuresOf(id).length` 判断不了：一份数据集可能把列全关掉，那时端口列表同样是空的。
 * 连线清理要区分的是"数据集在不在"，所以这里只认登记本身。
 */
export function hasDataset(datasetId: string): boolean {
  if (!datasetId) return false
  return !!getStoredDataset(datasetId)
}

/**
 * 数据集对外的身份：名字 + 行数。
 *
 * 只写进 YAML 供别处认回来用，不承担身份校验（同名同行的两份不同 CSV 会被认成同一份，
 * 这是有意的取舍 —— 宁可让用户改一次，也不要因为一个查不到的 id 把整张图断掉）。
 */
export function datasetIdentityOf(datasetId: string): DatasetIdentity | null {
  const stored = getStoredDataset(datasetId)
  if (stored) return { name: stored.name, rowCount: stored.rowCount }
  return null
}

/**
 * 按身份反查本机数据集。
 *
 * 优先名字 + 行数都对上的那份；只有名字对上时，本机只有一份同名数据才认（exact=false，
 * 让调用方提示用户确认行数）；本机有多份同名、行数又都不一样时不猜，返回 null。
 */
export function findDatasetByIdentity(
  identity: DatasetIdentity,
): { id: string; exact: boolean } | null {
  const imported = useDataStore.getState().imported.filter((d) => d.name === identity.name)
  const exact = imported.find((d) => d.rowCount === identity.rowCount)
  if (exact) return { id: exact.id, exact: true }
  if (identity.rowCount === undefined && imported.length > 0) {
    return { id: imported[imported.length - 1].id, exact: false }
  }
  if (imported.length === 1) return { id: imported[0].id, exact: false }
  return null
}

/* ------------------------------------------------------------------ */
/* 视图缓存                                                            */
/* ------------------------------------------------------------------ */

/** 图表视图的抽稀上限。散点/折线用包络保毛刺，其余用等距抽样保分布 */
const VIEW_MAX_ROWS = 6000

/**
 * 抽稀方式按图型分：
 * - 折线 / 散点 —— 包络抽稀，保住单点毛刺
 * - 其余（直方图 / 密度 / 箱线 / 柱状）—— 等距抽样，保证分布无偏
 *
 * 密度图和直方图拿包络抽稀的样本会失真（包络专门挑极值，分布形状会被扭曲），
 * 所以这里必须按图型区分，不能一律用包络。
 */
export function decimateModeFor(chartType: string): DecimateMode {
  return chartType === 'scatter' || chartType === 'line' ? 'envelope' : 'stride'
}

const viewCache = new Map<string, { sig: string; view: Dataset }>()

function viewSignature(ds: StoredDataset, maxRows: number, mode: DecimateMode): string {
  const cols = ds.columns.filter((c) => c.enabled).map((c) => c.name).join(',')
  return `${cols}|${maxRows}|${mode}`
}

/**
 * 把 datasetId 解析成图表引擎认识的 Dataset。
 * 导入的数据集按需抽稀并缓存 —— 1000 万行动辄上秒，不能每次渲染都重算。
 */
export function resolveDatasetView(
  datasetId: string,
  maxRows = VIEW_MAX_ROWS,
  mode: DecimateMode = 'envelope',
): Dataset | null {
  const stored = getStoredDataset(datasetId)
  if (!stored) return null

  const sig = viewSignature(stored, maxRows, mode)
  const hit = viewCache.get(datasetId)
  if (hit && hit.sig === sig) return hit.view

  const view = materializeView(stored, { maxRows, mode })
  viewCache.set(datasetId, { sig, view })
  return view
}

/** 抽稀到图表视图前，原始有多少行 */
export function storedRowCount(datasetId: string): number | null {
  const stored = getStoredDataset(datasetId)
  return stored ? stored.rowCount : null
}

/* ------------------------------------------------------------------ */
/* Hooks                                                              */
/* ------------------------------------------------------------------ */

export function useImportedDatasets(): StoredDataset[] {
  return useDataStore((s) => s.imported)
}

/** 响应式地取图表视图；imported 变化（列开关、新导入）时自动重算 */
export function useDatasetView(datasetId: string | null | undefined): Dataset | null {
  const imported = useDataStore((s) => s.imported)
  return useMemo(() => {
    if (!datasetId) return null
    // 依赖 imported 以便列启用状态变化时重建缓存
    void imported
    return resolveDatasetView(datasetId)
  }, [datasetId, imported])
}
