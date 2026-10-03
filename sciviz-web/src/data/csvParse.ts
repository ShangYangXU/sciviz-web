/**
 * CSV 解析核心：**浏览器 Worker 与无头 CLI 共用的唯一实现。**
 *
 * 原本这套两遍扫描的解析逻辑整个写在 `csvParseWorker.ts` 里，只能吃浏览器的 `File`。
 * 而无头运行（agent 面的 G1）同样需要"把一份 CSV 变成列式数据集"——若为它另写一份，
 * 就会出现两套行为不同的 CSV 解析：同样的文件在界面里和命令行里解析出不同的行数，
 * 而且要查很久才能发现。所以这里把核心抽出来，输入抽象成 `CsvSource`。
 *
 * `File` 天然满足 `CsvSource`（有 `size`，`slice().arrayBuffer()`）；Node 侧用一个
 * 包着 `fs` 的小对象满足它即可（见 `src/agent/fileSource.ts`）。
 *
 * 两遍扫描不能省：第一遍只数换行字节（不解码），用来精确预分配列缓冲。
 * 1000 万行 × 15 列时，按对象数组存是 1.2GB 且 GC 会崩，Float32 定长缓冲是 600MB。
 */

import type { ColumnRole, ColumnType } from '../types'
import type { ColumnStats, StoredDataset } from './columnStore'
import type { ParsedColumn, ParsedFile } from './importTypes'

/** 分块读取的数据来源。File 与"被 fs 包起来的本地文件"都满足它 */
export interface CsvSource {
  size: number
  slice(start: number, end: number): Promise<ArrayBuffer>
}

export interface ParseProgress {
  phase: string
  ratio: number
}

/**
 * 表头里重名的列 → 唯一名字：`x` / `x (2)` / `x (3)…`（第一个**原样保留**）。
 *
 * 为什么非改不可：这张表往下走的每一层都拿**列名当身份** —— 数据源的端口名、
 * 拆列的端口、函数节点形参、标准化器的列清单、训练的特征列。列名重名时：
 *
 * - `data` 那个字典会把后一列**覆盖**前一列（实测：表头 `t,x,x,y` 解析出来
 *   `columns` 有两个 x，而数值只有一份 x 的数据）—— 一整列数据就这么没了，且不报错；
 * - 端口 / 句柄同名，界面上两个端口叠在一起，连哪一个是哪一个说不清。
 *
 * 改名之后这两件事都消失，而且**看得见**：第二列清清楚楚叫 `x (2)`。
 * 宁可让人看见"这列被改叫 x (2) 了"，也不能让他拿到一张少了一列的表。
 */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((raw) => {
    const name = raw.trim()
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name} (${count + 1})`
  })
}

const CHUNK = 4 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 第一行嗅探分隔符：候选里出现次数最多的那个 */
function sniffDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t', '|']
  let best = ','
  let bestCount = -1
  for (const d of candidates) {
    const n = headerLine.split(d).length - 1
    if (n > bestCount) {
      bestCount = n
      best = d
    }
  }
  return best
}

/**
 * 按 RFC4180 拆一行。无引号时走 split 快路径 ——
 * 数值型 CSV 绝大多数行不含引号，这个分支决定 1000 万行能否在可接受时间内跑完。
 */
function splitLine(line: string, delim: string): string[] {
  if (line.indexOf('"') < 0) return line.split(delim)

  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuote = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuote = true
    } else if (ch === delim) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

/** "YYYY-MM-DD HH:MM:SS" / "YYYY/MM/DD" / ISO / 纯数字 epoch → epoch 秒 */
function parseTimestamp(s: string): number | null {
  if (s.length >= 19) {
    const y = +s.slice(0, 4)
    if (y >= 1900 && y <= 2200) {
      const mo = +s.slice(5, 7)
      const d = +s.slice(8, 10)
      const h = +s.slice(11, 13)
      const mi = +s.slice(14, 16)
      const se = +s.slice(17, 19)
      if (Number.isFinite(mo) && Number.isFinite(d) && Number.isFinite(h)) {
        // 用本地时间构造，不要用 Date.UTC：
        // 这类时间戳是"墙上时间"，没有时区信息。按 UTC 解析再按本地显示会平白差出一个时区
        // —— 实测北京时区下 13:51:54 会显示成 21:51:54。
        return new Date(y, mo - 1, d, h, mi, se).getTime() / 1000
      }
    }
  }
  const n = Number(s)
  if (Number.isFinite(n) && n > 1e8) return n > 1e11 ? n / 1000 : n
  const t = Date.parse(s)
  return Number.isFinite(t) ? t / 1000 : null
}

const TIME_NAME_RE = /时间|日期|时刻|time|date|timestamp/i

function inferRole(stats: ColumnStats, rowCount: number, isTime: boolean): ColumnRole {
  if (isTime) return 'time'
  const valid = rowCount - stats.missing - stats.nonNumeric
  /*
   * 一个有效数值都没有的列不是数值列。
   *
   * 这条判据原先漏了：valid === 0 时 min/max 是 NaN，`min === max` 为假，
   * 比例判据又要求 valid > 0，于是整列文字会一路落到 continuous ——
   * 变成一列全 NaN 的特征喂给下游，还会出现在模型输入里。数据面板里那一列
   * 看着是"数值列、全是 NaN"，而不是"这是文字列"。
   */
  if (valid === 0) return 'categorical'
  if (stats.min === stats.max) return 'categorical'
  if (stats.nonNumeric / valid > 0.2) return 'categorical'
  return 'continuous'
}

/* ------------------------------------------------------------------ */
/* 精确预分配的列缓冲                                                  */
/* ------------------------------------------------------------------ */

/** capacity 由 pass 1 的行数给出，正常情况下一次都不需要扩容 */
class F32Buf {
  arr: Float32Array
  len = 0
  constructor(cap: number) {
    this.arr = new Float32Array(Math.max(16, cap))
  }
  push(v: number) {
    if (this.len >= this.arr.length) {
      const next = new Float32Array(Math.max(16, Math.ceil(this.arr.length * 1.6)))
      next.set(this.arr)
      this.arr = next
    }
    this.arr[this.len++] = v
  }
}

class F64Buf {
  arr: Float64Array
  len = 0
  constructor(cap: number) {
    this.arr = new Float64Array(Math.max(16, cap))
  }
  push(v: number) {
    if (this.len >= this.arr.length) {
      const next = new Float64Array(Math.max(16, Math.ceil(this.arr.length * 1.6)))
      next.set(this.arr)
      this.arr = next
    }
    this.arr[this.len++] = v
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export async function parseCsv(
  source: CsvSource,
  onProgress?: (p: ParseProgress) => void,
): Promise<ParsedFile> {
  const report = (phase: string, ratio: number) => onProgress?.({ phase, ratio })

  // ---- Pass 1：只数换行字节，不解码，用来精确预分配 ----
  report('统计行数', 0.02)
  let newlineCount = 0
  let lastByte = -1
  for (let off = 0; off < source.size; off += CHUNK) {
    const end = Math.min(source.size, off + CHUNK)
    const buf = new Uint8Array(await source.slice(off, end))
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlineCount++
    if (buf.length > 0) lastByte = buf[buf.length - 1]
    report('统计行数', 0.02 + (off / source.size) * 0.08)
  }
  const endsWithNewline = lastByte === 0x0a
  const headerLines = 1
  const estRows = Math.max(1, newlineCount - headerLines + (endsWithNewline ? 0 : 1))

  // ---- 编码判定 ----
  // 必须用 stream:true，否则切片末尾被截断的多字节字符会解出 U+FFFD，把 UTF-8 误判成 GBK
  const headBytes = new Uint8Array(await source.slice(0, Math.min(source.size, 256 * 1024)))
  const encoderProbe = new TextDecoder('utf-8')
  let headText = encoderProbe.decode(headBytes, { stream: true })
  let encoding = 'utf-8'
  let decoder = new TextDecoder('utf-8')

  if (headText.includes('\uFFFD')) {
    const gbkProbe = new TextDecoder('gbk')
    const alt = gbkProbe.decode(headBytes, { stream: true })
    if (!alt.includes('\uFFFD')) {
      encoding = 'gbk'
      headText = alt
      decoder = new TextDecoder('gbk')
    }
  }

  // ---- 解析表头 ----
  const firstNl = headText.indexOf('\n')
  const rawHeader = (firstNl >= 0 ? headText.slice(0, firstNl) : headText)
    .replace(/^\uFEFF/, '')
    .replace(/\r$/, '')
  const delimiter = sniffDelimiter(rawHeader)
  // 空表头补成 col_N，重名的改名（见 uniqueNames 的说明）——两者都为了"列名能当身份"
  const header = uniqueNames(splitLine(rawHeader, delimiter).map((h, i) => h.trim() || `col_${i + 1}`))
  const ncol = header.length
  const timeIdx = header.findIndex((h) => TIME_NAME_RE.test(h.trim()))

  // ---- 分配（每列独立缓冲，行对齐靠"每个非空行每列都 push 一次"来保证）----
  const isTimeCol = header.map((_, i) => i === timeIdx)
  const colBuf: (F32Buf | null)[] = header.map((_, i) => (isTimeCol[i] ? null : new F32Buf(estRows)))
  const timeBuf = timeIdx >= 0 ? new F64Buf(estRows) : null

  const zeros = new Int32Array(ncol)
  const missing = new Int32Array(ncol)
  const nonNumeric = new Int32Array(ncol)
  const minV = new Float64Array(ncol).fill(Infinity)
  const maxV = new Float64Array(ncol).fill(-Infinity)
  const sumV = new Float64Array(ncol)
  const validCnt = new Int32Array(ncol)

  // ---- Pass 2 ----
  let carry = ''
  let headerSkipped = false
  let rowIdx = 0
  let prevTime: number | null = null
  const deltas = new Map<number, number>()

  /**
   * 处理一行数据（含"第一行是表头"这条规则）。
   *
   * 抽成函数是为了能处理**最后一行**：如果文件结尾没有换行符，那一行会留在
   * `carry` 里，循环只处理"完整切开的行"。原先的实现直接把 carry 丢掉，
   * 于是最后一行被静默吞掉 —— 100 万行的文件少一行不会报错，只会让下游的
   * 帧数、划分比例、统计量全部偏一点。这类错最难查，所以必须在这里处理掉。
   */
  const consumeLine = (rawLine: string) => {
    if (!headerSkipped) {
      headerSkipped = true
      return
    }
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) return

    const fields = splitLine(line, delimiter)

    if (timeBuf && timeIdx >= 0) {
      const raw = timeIdx < fields.length ? fields[timeIdx] : ''
      const t = raw ? parseTimestamp(raw) : null
      if (t === null) {
        missing[timeIdx]++
        timeBuf.push(NaN)
      } else {
        timeBuf.push(t)
        if (prevTime !== null) {
          const d = Math.round(t - prevTime)
          if (d >= 0) deltas.set(d, (deltas.get(d) ?? 0) + 1)
        }
        prevTime = t
      }
    }

    for (let c = 0; c < ncol; c++) {
      if (isTimeCol[c]) continue
      const buf = colBuf[c]!
      const raw = c < fields.length ? fields[c] : ''
      if (raw === '') {
        missing[c]++
        buf.push(NaN)
        continue
      }
      const v = Number(raw)
      if (!Number.isFinite(v)) {
        nonNumeric[c]++
        buf.push(NaN)
        continue
      }
      buf.push(v)
      validCnt[c]++
      sumV[c] += v
      if (v === 0) zeros[c]++
      if (v < minV[c]) minV[c] = v
      if (v > maxV[c]) maxV[c] = v
    }
    rowIdx++
  }

  for (let off = 0; off < source.size; off += CHUNK) {
    const end = Math.min(source.size, off + CHUNK)
    const bytes = new Uint8Array(await source.slice(off, end))
    const text = carry + decoder.decode(bytes, { stream: end < source.size })
    const lines = text.split('\n')
    carry = lines.pop() ?? ''

    for (let li = 0; li < lines.length; li++) {
      consumeLine(lines[li])
    }

    report('解析数据', 0.1 + (off / source.size) * 0.85)
  }

  // 结尾没有换行符时，最后一行还留在 carry 里
  if (carry.length > 0) consumeLine(carry)

  if (rowIdx === 0) throw new Error('文件里没有解析到任何数据行')

  // ---- 采样步长与规整性 ----
  let stepSeconds: number | null = null
  let regular = false
  if (deltas.size > 0) {
    let modeDelta = 0
    let modeCount = 0
    for (const [d, n] of deltas) {
      if (n > modeCount) {
        modeCount = n
        modeDelta = d
      }
    }
    if (modeDelta > 0) {
      stepSeconds = modeDelta
      regular = modeCount / Math.max(1, rowIdx - 1) > 0.95
    }
  }

  report('整理列', 0.97)

  // ---- 组装结果 ----
  const columns: ParsedColumn[] = []
  const data: Record<string, Float32Array> = {}

  header.forEach((name, i) => {
    const stats: ColumnStats = {
      min: Number.isFinite(minV[i]) ? minV[i] : NaN,
      max: Number.isFinite(maxV[i]) ? maxV[i] : NaN,
      mean: validCnt[i] > 0 ? sumV[i] / validCnt[i] : NaN,
      zeros: zeros[i],
      missing: missing[i],
      nonNumeric: nonNumeric[i],
    }
    const role = inferRole(stats, rowIdx, isTimeCol[i])
    const type: ColumnType = isTimeCol[i] || role === 'continuous' ? 'number' : 'string'
    columns.push({ name, type, role, stats })

    if (!isTimeCol[i] && type === 'number') {
      // 容量按 pass 1 精确分配，正常情况下 subarray 就是整个 buffer，无浪费
      data[name] = colBuf[i]!.arr.subarray(0, rowIdx)
    }
  })

  let time: Float64Array | null = null
  if (timeBuf) time = timeBuf.arr.subarray(0, rowIdx)

  report('完成', 1)
  return {
    rowCount: rowIdx,
    timeColumn: timeIdx >= 0 ? header[timeIdx] : null,
    time,
    stepSeconds,
    regular,
    columns,
    data,
    delimiter,
    encoding,
  }
}

/**
 * 结果里那些需要 transfer 的 ArrayBuffer（Worker 用）。
 * 单独给一个函数，是为了不在 Worker 里重算一遍"哪些是列"。
 */
export function transferablesOf(parsed: ParsedFile): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>()
  for (const col of Object.values(parsed.data)) seen.add(col.buffer as ArrayBuffer)
  if (parsed.time) seen.add(parsed.time.buffer as ArrayBuffer)
  return [...seen]
}

/**
 * 解析结果 → 列式数据集。
 *
 * 放在这里而不是留在某个调用方里：界面导入、无头 CLI 载入 CSV，得到的数据集
 * 必须是同一种东西（同一套 enabled 规则、同一个 id/来源字段），否则"同一份 CSV
 * 在界面里和在命令行里不一样"这种问题会反复出现。
 */
export function toStoredDataset(
  parsed: ParsedFile,
  meta: { id: string; name: string; source: string; importedAt?: number },
): StoredDataset {
  return {
    id: meta.id,
    name: meta.name,
    source: meta.source,
    importedAt: meta.importedAt ?? Date.now(),
    rowCount: parsed.rowCount,
    timeColumn: parsed.timeColumn,
    time: parsed.time,
    stepSeconds: parsed.stepSeconds,
    columns: parsed.columns.map((c) => ({
      name: c.name,
      type: c.type,
      role: c.role,
      stats: c.stats,
      // 时间列不是"特征"，默认关闭（它作为独立的时间轴存在）
      enabled: c.role !== 'time' && c.type === 'number',
    })),
    data: parsed.data,
  }
}
