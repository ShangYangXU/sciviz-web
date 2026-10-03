import type { Column, ColumnRole, ColumnType, Dataset, Row } from '../types'

/** 列级统计，导入时在 Worker 里算好 */
export interface ColumnStats {
  min: number
  max: number
  mean: number
  /** 值为 0 的行数。锅炉停机段会产生大量 0，是重要线索 */
  zeros: number
  /** 空单元格数 */
  missing: number
  /** 解析不成数字的单元格数 */
  nonNumeric: number
}

export interface StoredColumn {
  name: string
  type: ColumnType
  role: ColumnRole
  unit?: string
  stats: ColumnStats
  /** 是否进入下游计算。关掉的列不占用端口，也不参与执行 */
  enabled: boolean
}

/**
 * 列式数据集。
 *
 * 关键设计：特征存 Float32Array、时间存 Float64Array。
 * 1000 万行 × 15 列时，Float32 是 600MB，而按对象数组存是 1.2GB+ 且 GC 会崩。
 * 这里**不做任何隐式清洗** —— 停机段的 0 原样保留，交给下游的函数节点处理。
 */
export interface StoredDataset {
  id: string
  name: string
  /** 来源文件名 */
  source: string
  importedAt: number
  rowCount: number
  /** 时间列名；无时间列时为 null */
  timeColumn: string | null
  /** epoch 秒。列式存储，与 data 各列行对齐 */
  time: Float64Array | null
  /** 推断出的采样步长（秒）；不规则或无法判断时为 null */
  stepSeconds: number | null
  columns: StoredColumn[]
  /** 列名 → 数值列。只含数值型的列 */
  data: Record<string, Float32Array>
}

export function storedColumn(ds: StoredDataset, name: string): StoredColumn | undefined {
  return ds.columns.find((c) => c.name === name)
}

/** 启用的数值列名 */
export function enabledColumnNames(ds: StoredDataset): string[] {
  return ds.columns.filter((c) => c.enabled && c.type === 'number' && c.name in ds.data).map((c) => c.name)
}

export function estimateBytes(ds: StoredDataset): number {
  let n = ds.time ? ds.time.byteLength : 0
  for (const k of Object.keys(ds.data)) n += ds.data[k].byteLength
  return n
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/* ------------------------------------------------------------------ */
/* 抽稀                                                                */
/* ------------------------------------------------------------------ */

export type DecimateMode =
  /** min/max 包络：保住毛刺与极值，用于折线/散点 */
  | 'envelope'
  /** 等距抽样：无偏，用于柱状/箱线/直方图这类要真实分布的图 */
  | 'stride'

/**
 * 返回抽稀后的行下标。
 *
 * envelope 模式下每个桶取该列的最小与最大两个点，因此 1000 万行压缩到 2 万个点
 * 也**不会漏掉单点毛刺** —— 这对故障诊断的冲击类特征是必需的。
 */
function decimateIndices(
  values: ArrayLike<number> | null,
  rowCount: number,
  maxPoints: number,
  mode: DecimateMode = 'envelope',
): Int32Array {
  if (rowCount <= 0) return new Int32Array(0)

  if (rowCount <= maxPoints || mode === 'stride') {
    const step = Math.max(1, Math.ceil(rowCount / maxPoints))
    const out = new Int32Array(Math.ceil(rowCount / step))
    let w = 0
    for (let i = 0; i < rowCount; i += step) out[w++] = i
    return out.subarray(0, w)
  }

  if (!values) {
    const step = Math.max(1, Math.ceil(rowCount / maxPoints))
    const out = new Int32Array(Math.ceil(rowCount / step))
    let w = 0
    for (let i = 0; i < rowCount; i += step) out[w++] = i
    return out.subarray(0, w)
  }

  const buckets = Math.max(1, Math.floor(maxPoints / 2))
  const bucketSize = rowCount / buckets
  const out = new Int32Array(buckets * 2)
  let w = 0

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * bucketSize)
    const end = Math.min(rowCount, Math.floor((b + 1) * bucketSize))
    let minI = -1
    let maxI = -1
    let minV = Infinity
    let maxV = -Infinity
    for (let i = start; i < end; i++) {
      const v = values[i]
      if (!Number.isFinite(v)) continue
      if (v < minV) {
        minV = v
        minI = i
      }
      if (v > maxV) {
        maxV = v
        maxI = i
      }
    }
    if (minI < 0) {
      // 整桶都是无效值，退化为桶首
      out[w++] = start
      continue
    }
    // 保持时间先后顺序，避免折线出现回折
    if (minI <= maxI) {
      out[w++] = minI
      if (maxI !== minI) out[w++] = maxI
    } else {
      out[w++] = maxI
      if (maxI !== minI) out[w++] = minI
    }
  }
  return out.subarray(0, w)
}

/* ------------------------------------------------------------------ */
/* 图表视图                                                            */
/* ------------------------------------------------------------------ */

interface ViewOptions {
  /** 抽稀到多少行以内，默认 8000 */
  maxRows?: number
  mode?: DecimateMode
  /** envelope 模式下按哪一列保极值；不传则用第一列 */
  measure?: string
}

/** 时间列在视图里的固定列名 */
export const TIME_VIEW_COLUMN = '时间'

/**
 * 视图行上的原始行号。
 *
 * 有它之后，时间戳是**派生值**（`ds.time[_row]`），而不是随表搬运的独立数据 ——
 * 派生的东西没有"搬运错"这个失败模式。
 * 刻意不写进 `columns`：它不是可映射的数据列，别出现在字段映射下拉里。
 */
export const ROW_VIEW_COLUMN = '_row'

function toViewRole(col: StoredColumn): ColumnRole {
  if (col.role === 'time') return 'time'
  return col.role
}

/**
 * 逐点校验视图的时间列确实由原始行号派生。
 *
 * 一旦某处把行和时间解了耦（筛选后重排、抽稀下标用错），形状仍然正确、
 * 数值却是假的，而且不会抛错。所以这个不变量必须显式查，不能靠约定。
 */
export function countTimeMisalignment(ds: StoredDataset, view: Dataset): number {
  if (!ds.time) return 0
  let bad = 0
  for (const r of view.rows) {
    const i = r[ROW_VIEW_COLUMN]
    if (typeof i !== 'number') return -1 // 缺主键，无法校验
    if (r[TIME_VIEW_COLUMN] !== ds.time[i]) bad++
  }
  return bad
}

/**
 * 按采样步长统计时间轴断裂处数。
 *
 * 筛掉停机段之后断裂是**正常且有用的信息**（工作段本来就是分立的），
 * 不是错误 —— 所以这里只报数，不报警。
 */
export function countTimeGaps(ds: StoredDataset, tolerance = 1.5): number {
  const t = ds.time
  const step = ds.stepSeconds
  if (!t || !step || t.length < 2) return 0
  let gaps = 0
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > step * tolerance) gaps++
  }
  return gaps
}

/**
 * 把列式存储抽稀成图表引擎认识的 Dataset（对象数组）。
 *
 * 图表引擎沿用 V1 的 Row[] 接口，这样 5 种图一行不用改。
 * 代价是抽稀后仍是对象数组，所以 maxRows 必须控制在万级 —— 这正是抽稀的意义。
 */
export function materializeView(ds: StoredDataset, opts: ViewOptions = {}): Dataset {
  const maxRows = opts.maxRows ?? 8000
  const measure = opts.measure ?? enabledColumnNames(ds)[0] ?? null
  const measureArr = measure && ds.data[measure] ? ds.data[measure] : null
  const idx = decimateIndices(measureArr, ds.rowCount, maxRows, opts.mode ?? 'envelope')

  const viewColumns: Column[] = []
  if (ds.time && ds.timeColumn) {
    viewColumns.push({ name: TIME_VIEW_COLUMN, type: 'number', role: 'time' })
  }
  for (const c of ds.columns) {
    if (!c.enabled || c.type !== 'number' || !(c.name in ds.data)) continue
    viewColumns.push({ name: c.name, type: 'number', role: toViewRole(c), unit: c.unit })
  }
  for (const c of ds.columns) {
    if (c.type !== 'string') continue
    // 文本列不进视图（当前数据源里没有），保留分支便于将来扩展
  }

  const rows: Row[] = new Array(idx.length)
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]
    const row: Row = { [ROW_VIEW_COLUMN]: i }
    if (ds.time) row[TIME_VIEW_COLUMN] = ds.time[i]
    for (const c of ds.columns) {
      if (!c.enabled || !(c.name in ds.data)) continue
      row[c.name] = ds.data[c.name][i]
    }
    rows[k] = row
  }

  return {
    id: ds.id,
    name: ds.name,
    description: `${ds.source} · 原始 ${ds.rowCount.toLocaleString('en-US')} 行 · 视图抽稀至 ${idx.length.toLocaleString('en-US')} 行`,
    columns: viewColumns,
    rows,
    primaryMeasure: measure ?? undefined,
  }
}
