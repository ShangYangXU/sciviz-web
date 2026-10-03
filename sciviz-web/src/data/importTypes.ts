import type { ColumnRole, ColumnType } from '../types'
import type { ColumnStats } from './columnStore'

export interface ParsedColumn {
  name: string
  type: ColumnType
  role: ColumnRole
  stats: ColumnStats
}

export interface ParsedFile {
  rowCount: number
  timeColumn: string | null
  time: Float64Array | null
  /** 推断出的采样步长（秒），不规则为 null */
  stepSeconds: number | null
  /** 时间轴是否规则（95% 以上间隔等于步长） */
  regular: boolean
  columns: ParsedColumn[]
  /** 只有数值型列才有数组；ArrayBuffer 会 transfer 给主线程 */
  data: Record<string, Float32Array>
  delimiter: string
  encoding: string
}

export type WorkerIn = { type: 'start'; file: File }

export type WorkerOut =
  | { type: 'progress'; phase: string; ratio: number }
  | { type: 'error'; message: string }
  | { type: 'done'; result: ParsedFile }
