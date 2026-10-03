/**
 * 无头侧的数据来源：把本地文件包成 `CsvSource`。
 *
 * 只有这一处用 `node:fs` —— 所以界线必须清楚：`src/agent/` 下的东西只给 CLI 用，
 * 界面不许 import（否则打包时会把 fs 一起拖进浏览器包里）。
 */

import fs from 'node:fs'
import type { CsvSource } from '../data/csvParse'

/** CsvSource + 显式关闭。文件描述符不能指望 GC 回收 */
export interface FileCsvSource extends CsvSource {
  close(): void
}

/** 按偏移读文件块。用 fd 而不是每次重新 open：58MB 的文件会被切成上百块 */
export function fileSource(path: string): FileCsvSource {
  const fd = fs.openSync(path, 'r')
  const size = fs.fstatSync(fd).size
  return {
    size,
    slice: async (start: number, end: number) => {
      const length = Math.max(0, end - start)
      const buf = Buffer.allocUnsafe(length)
      fs.readSync(fd, buf, 0, length, start)
      // Buffer 可能来自分配池，byteOffset 不一定为 0，必须按实际范围切
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    },
    close: () => fs.closeSync(fd),
  }
}
