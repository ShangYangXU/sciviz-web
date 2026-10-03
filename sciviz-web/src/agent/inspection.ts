/**
 * 结果发现与取数消歧。
 *
 * 这里不执行图，只回答三件纯粹的问题：当前有哪些输出、用户说的是哪个节点、
 * `--rows` 应该向哪个表端口取值。CLI 与无头运行共用，避免再出现默认猜 `data`
 * 而真实端口叫 `head` 的分歧。
 */

import fs from 'node:fs'
import path from 'node:path'

// Keep the pure selection logic available to the CLI while keeping node:fs/path
// out of the browser bundle. The re-export preserves the existing CLI imports.
export {
  InspectionSelectionError,
  inspectablePorts,
  selectResultNodes,
  selectRowPort,
} from './inspectionCore'
export type { InspectablePort, InspectablePortOptions, NodeSelection, RowPortSelection } from './inspectionCore'

interface RunIndexEntry {
  runId?: unknown
  workflow?: unknown
}

export interface LatestManifestOptions {
  projectPath: string
  workflowName: string
  runs?: { index?: string; lastRunId?: string }
  /** 显式 `--out`。传入后只查这一个运行目录，避免意外读到别处。 */
  outDir?: string
  /** 默认运行目录；CLI 传 `cwd/runs`，测试可注入。 */
  defaultOutDir: string
}

export type LatestManifestResult =
  | { ok: true; manifestPath: string; indexPath: string; runId: string }
  | { ok: false; message: string; searched: string[] }

/** 从运行索引找最近一次同名工程；绝不退回另一个工程的结果。 */
export function findLatestManifest(options: LatestManifestOptions): LatestManifestResult {
  const projectDir = path.dirname(path.resolve(options.projectPath))
  const candidates = options.outDir
    ? [path.join(path.resolve(options.outDir), 'index.json')]
    : [
        ...(options.runs?.index
          ? [path.resolve(projectDir, options.runs.index)]
          : []),
        path.join(path.resolve(options.defaultOutDir), 'index.json'),
      ]
  const searched = [...new Set(candidates)]

  for (const indexPath of searched) {
    if (!fs.existsSync(indexPath)) continue
    let entries: RunIndexEntry[]
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      if (!Array.isArray(parsed)) continue
      entries = parsed
    } catch {
      continue
    }

    const preferredId = options.runs?.lastRunId
    const matching =
      (preferredId ? entries.find((entry) => entry.runId === preferredId) : undefined) ??
      [...entries].reverse().find((entry) => entry.workflow === options.workflowName)
    if (!matching || typeof matching.runId !== 'string') continue
    const manifestPath = path.join(path.dirname(indexPath), matching.runId, 'run.json')
    if (!fs.existsSync(manifestPath)) continue
    return { ok: true, manifestPath, indexPath, runId: matching.runId }
  }

  return {
    ok: false,
    message: `找不到工程「${options.workflowName}」最近一次可读取的运行清单`,
    searched,
  }
}
