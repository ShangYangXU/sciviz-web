import type { StoredDataset } from './columnStore'
import { importCsvFile, type ImportProgress } from './importCsv'
import { localEngineUrl } from '../engine/localClient'

export const FIXED_DATASET_ID = 'fixed-sheet1'
const FIXED_DATASET_FILE = 'Sheet1.csv'

type CsvImporter = (file: File, onProgress: (progress: ImportProgress) => void) => Promise<StoredDataset>
type FixedDatasetFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** 从桌面宿主的固定文件接口取 CSV，再交给唯一的浏览器 CSV 导入流程解析。 */
export class FixedDatasetLoader {
  private pending: Promise<StoredDataset> | null = null

  constructor(
    private readonly fetcher: FixedDatasetFetcher = (...args) => globalThis.fetch(...args),
    private readonly importer: CsvImporter = importCsvFile,
    private readonly url: () => string = () => `${localEngineUrl()}/fixed-dataset/sheet1.csv`,
  ) {}

  load(onProgress: (progress: ImportProgress) => void = () => {}): Promise<StoredDataset> {
    if (this.pending) return this.pending
    const pending = this.readAndParse(onProgress).finally(() => {
      if (this.pending === pending) this.pending = null
    })
    this.pending = pending
    return pending
  }

  private async readAndParse(
    onProgress: (progress: ImportProgress) => void,
  ): Promise<StoredDataset> {
    onProgress({ phase: '读取固定数据集', ratio: 0 })
    const response = await this.fetcher(this.url(), { cache: 'no-store' })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`.trim()
      try {
        const body = (await response.json()) as { detail?: unknown }
        if (typeof body.detail === 'string') detail = body.detail
      } catch {
        // 服务端可能返回纯文本错误，保留 HTTP 状态作为原因。
      }
      throw new Error(`固定数据集 ${FIXED_DATASET_FILE} 读取失败：${detail}`)
    }

    const blob = await response.blob()
    if (blob.size === 0) throw new Error(`固定数据集 ${FIXED_DATASET_FILE} 是空文件`)
    const file = new File([blob], FIXED_DATASET_FILE, { type: 'text/csv' })
    const imported = await this.importer(file, onProgress)
    return {
      ...imported,
      id: FIXED_DATASET_ID,
      name: FIXED_DATASET_FILE.replace(/\.csv$/i, ''),
      source: FIXED_DATASET_FILE,
    }
  }
}

export const fixedDatasetLoader = new FixedDatasetLoader()
