import type { StoredDataset } from './columnStore'
import type { WorkerIn, WorkerOut } from './importTypes'
import { toStoredDataset } from './csvParse'

export interface ImportProgress {
  phase: string
  ratio: number
}

let seq = 0

/**
 * 在 Web Worker 里流式解析 CSV，返回列式数据集。
 *
 * 用 Worker 是必须的：58MB / 100 万行的两遍扫描在主线程上会把界面冻死十几秒；
 * 1000 万行更不用说。
 */
export function importCsvFile(
  file: File,
  onProgress: (p: ImportProgress) => void,
): Promise<StoredDataset> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./csvParseWorker.ts', import.meta.url), { type: 'module' })

    const cleanup = () => worker.terminate()

    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data
      if (msg.type === 'progress') {
        onProgress({ phase: msg.phase, ratio: msg.ratio })
        return
      }
      if (msg.type === 'error') {
        cleanup()
        reject(new Error(msg.message))
        return
      }
      cleanup()
      try {
      resolve(parsedToDataset(msg.result, file.name))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }

    worker.onerror = (ev) => {
      cleanup()
      reject(new Error(ev.message || 'Worker 解析失败'))
    }

    const payload: WorkerIn = { type: 'start', file }
    worker.postMessage(payload)
  })
}

/**
 * 包一层只为生成 id 与名字。列怎么建、哪些列默认启用，都在
 * `csvParse.toStoredDataset` 里 —— 界面与无头 CLI 必须得到同一种数据集，
 * 否则"同一份 CSV 在界面里和命令行里不一样"这类问题会反复出现。
 */
function parsedToDataset(
  parsed: Parameters<typeof toStoredDataset>[0],
  fileName: string,
): StoredDataset {
  return toStoredDataset(parsed, {
    id: `ds-${++seq}-${Date.now().toString(36)}`,
    name: fileName.replace(/\.(csv|txt|tsv)$/i, ''),
    source: fileName,
  })
}
