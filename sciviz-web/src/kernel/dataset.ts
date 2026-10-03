/**
 * 数据集身份与目录 —— agent 面的 B4 缺口。
 *
 * 两件事在这里落地：
 *
 * 1. **身份是内容哈希，不是形状签名。** 现状的 `graphRunner.datasetSignature` 算的是
 *    `行数 | 时间列 | 启用列名`，于是两份列名列数完全相同、内容不同的 CSV 会被判成
 *    同一份数据，复用错误的引擎侧状态（契约规格 R3.2 明列的第一类缺陷）。
 *    在无头场景下这个缺陷更危险：agent 真的会去换数据。
 * 2. **数据要能在没有浏览器的地方被喂进引擎。** 这里只依赖 `StoredDataset` 这份纯数据，
 *    不碰列式存储的 store，也不碰 Worker。
 *
 * 采样率（`sampleRate`）是**数据属性**而不是算子参数（契约规格 R3.4）。这里把它算出来
 * 记进 `DatasetRef`，数据属性只在需要时沿端口传递 —— 这是契约层的事实，
 * 属于 P0 的范围。所以这个字段现在只是"如实记录"，不是"已经被算子消费"。
 */

import type { ColumnRole, ColumnType } from '../types'
import type { StoredDataset } from '../data/columnStore'
import type { PortContext } from '../workflow/ports'
import type { DatasetPayload } from '../engine/protocol'

export interface DatasetColumnRef {
  name: string
  type: ColumnType
  role: ColumnRole
  /**
   * 是否进入下游计算。
   *
   * **刻意不进内容哈希**：列开关属于"视图"，属于指纹（见 `plan.ts` 的 nodeFingerprint），
   * 不属于这份数据的身份。把视图算进身份，同一个文件会随开关变化产生多个身份，
   * 缓存与运行清单都会跟着乱。
   */
  enabled: boolean
}

export interface DatasetRef {
  id: string
  name: string
  /** 来源文件名 */
  source: string
  /** `sha256:...` —— 内容哈希。身份是内容，不是"行列数 + 列名" */
  contentHash: string
  rowCount: number
  timeColumn: string | null
  /** 采样率 Hz，由采样步长推出；推不出来时为 null */
  sampleRate: number | null
  columns: DatasetColumnRef[]
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  // 用 WebCrypto 而不是 node:crypto：同一个函数在浏览器与 Node 里都能跑，
  // 而"数据集身份"这件事两边必须算出同一个值
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 内容哈希。
 *
 * 逐列算再汇总，而不是把所有列拼成一个大 buffer：1000 万行 × 10 列是 400MB，
 * 再拼一份就翻倍。逐列的话峰值内存只有一列的字节数，而 SHA-256 本来就是
 * 为"分块喂入"设计的，这样并不损失任何强度。
 *
 * 参与哈希的只有内容本身：列名、类型、角色、每一列的字节。行数不进哈希
 * （它由列长决定），列开关不进（那是视图）。
 */
export async function datasetContentHash(ds: StoredDataset): Promise<string> {
  const parts: string[] = []
  for (const col of ds.columns) {
    const values: Float32Array | Float64Array | undefined =
      col.role === 'time' ? (ds.time ?? undefined) : ds.data[col.name]
    if (!values) continue
    // 直接传 subarray 视图：subtle.digest 认 byteOffset/byteLength，不会带上尾部空闲容量
    const bytes = new Uint8Array(values.buffer as ArrayBuffer, values.byteOffset, values.byteLength)
    parts.push(`${col.name}\u0000${col.type}\u0000${col.role}\u0000${await sha256Hex(bytes)}`)
  }
  return `sha256:${await sha256Hex(new TextEncoder().encode(parts.join('\u0001')))}`
}

/** 造一份数据集身份。异步只因为要算哈希 */
export async function buildDatasetRef(ds: StoredDataset): Promise<DatasetRef> {
  return {
    id: ds.id,
    name: ds.name,
    source: ds.source,
    contentHash: await datasetContentHash(ds),
    rowCount: ds.rowCount,
    timeColumn: ds.timeColumn,
    sampleRate: ds.stepSeconds && ds.stepSeconds > 0 ? 1 / ds.stepSeconds : null,
    columns: ds.columns.map((c) => ({
      name: c.name,
      type: c.type,
      role: c.role,
      enabled: c.enabled,
    })),
  }
}

/**
 * 一次运行里可用的数据集。
 *
 * 它同时承担三件此前散在浏览器 store 里的职责：查身份、给端口上下文、
 * 造送进引擎的载荷。三件事都只依赖纯数据，所以无头与浏览器可以共用。
 */
export class DatasetCatalog {
  private readonly stored = new Map<string, StoredDataset>()
  private readonly refs = new Map<string, DatasetRef>()

  add(ds: StoredDataset, ref: DatasetRef): void {
    this.stored.set(ds.id, ds)
    this.refs.set(ds.id, ref)
  }

  has(id: string): boolean {
    return this.stored.has(id)
  }

  ref(id: string): DatasetRef | undefined {
    return this.refs.get(id)
  }

  all(): DatasetRef[] {
    return [...this.refs.values()]
  }

  /** 启用中的数值列名。端口与指纹都取它 */
  featuresOf(id: string): string[] {
    const ds = this.stored.get(id)
    if (!ds) return []
    return ds.columns
      .filter((c) => c.enabled && c.type === 'number' && c.name in ds.data)
      .map((c) => c.name)
  }

  timeColumnOf(id: string): string | null {
    return this.stored.get(id)?.timeColumn ?? null
  }

  portContext(): PortContext {
    return {
      featuresOf: (id) => this.featuresOf(id),
      timeColumnOf: (id) => this.timeColumnOf(id),
      hasDataset: (id) => this.has(id),
    }
  }

  /**
   * 送进执行引擎的载荷。
   *
   * 只送启用的数值列：没启用的列不进 Python，省内存也避免误用
   * （这条与 `graphRunner.ensureDataset` 完全一致，不是新规则）。
   */
  payload(id: string): DatasetPayload | undefined {
    const ds = this.stored.get(id)
    if (!ds) return undefined
    const data: Record<string, Float32Array> = {}
    for (const col of ds.columns) {
      if (!col.enabled || col.type !== 'number') continue
      if (!(col.name in ds.data)) continue
      data[col.name] = ds.data[col.name]
    }
    return {
      datasetId: ds.id,
      rowCount: ds.rowCount,
      timeColumn: ds.timeColumn,
      time: ds.time,
      data,
    }
  }
}
