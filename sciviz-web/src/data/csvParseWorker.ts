/// <reference lib="webworker" />
import { parseCsv, transferablesOf, type CsvSource } from './csvParse'
import type { WorkerIn, WorkerOut } from './importTypes'

/**
 * CSV 解析的 **Worker 外壳**。
 *
 * 解析逻辑本身在 `csvParse.ts` 里，与无头 CLI 共用一份（见那里的说明）。
 * 这个文件只剩"浏览器这一侧"的事：把 File 包成 CsvSource、把进度与结果 post 回去、
 * 把列缓冲 transfer 给主线程（避免 1000 万行时复制一遍几百 MB）。
 */

const post = (msg: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? [])

async function run(file: File) {
  // File 的 slice() 返回 Blob 而不是 Promise<ArrayBuffer>，形状对不上 CsvSource，
  // 所以在这里显式适配一次 —— 而不是把 CsvSource 定义改成迁就 Blob
  const source: CsvSource = {
    size: file.size,
    slice: (start, end) => file.slice(start, end).arrayBuffer(),
  }

  const result = await parseCsv(source, (p) => post({ type: 'progress', ...p }))
  post({ type: 'done', result }, transferablesOf(result))
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  if (e.data?.type !== 'start') return
  run(e.data.file).catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  })
}
