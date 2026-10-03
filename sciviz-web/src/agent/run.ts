/**
 * 无头运行的编排层：装载工程 → 连宿主 → 跑核 → 写运行清单与报告。
 *
 * 它是 Facade 的一个用例（架构总纲 L4），只做编排，不含任何判定逻辑：
 * "算什么"在 `planEvaluation`，"怎么算"在核与适配器，"对不对"在校验器与真值脚本。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { planEvaluation, selectModelArtifact, type Plan } from '../engine/plan'
import { operatorFactsOf } from '../workflow/operatorFacts'
import { runGraph } from '../kernel/kernel'
import { buildRunManifest, type RunFigureArtifact, type RunFigureCaptureSummary, type RunManifest } from '../kernel/manifest'
import { compareManifests, type DriftReport } from '../kernel/drift'
import { environmentOf, HostAdapter, probeHost } from './hostAdapter'
import { InspectionSelectionError, selectResultNodes, selectRowPort } from './inspection'
import { loadProject, type DataBinding, type LoadedProject } from './project'
import { renderReport } from './report'
import { runtimeNodeIdForPath } from '../workflow/groups'
import { chartFromTable, CHART_MAX_POINTS } from '../workflow/chartFromTable'
import { ChartRenderer } from '../charts/ChartRenderer'
import type { KernelLogEntry, KernelResult } from '../kernel/types'
import type { PreviewTable } from '../engine/protocol'
import type { ProjectModelArtifactRef } from '../workflow/project'

export interface PlanSummary {
  project: LoadedProject
  plan: Plan
}

/** 只看"要算什么"。不连引擎，所以没有宿主时也能用 */
export async function planProject(
  yamlPath: string,
  bindings: DataBinding[],
  onProgress?: (dataset: string, phase: string, ratio: number) => void,
): Promise<PlanSummary> {
  const project = await loadProject(yamlPath, bindings, { onProgress })
  if (!project.workflow) {
    return {
      project,
      plan: { evaluate: [], blocked: [], missing: [], unchanged: [], manual: [], deferred: [] },
    }
  }
  // 空运行时 = "什么都没算过"，所以计划里会把所有该算的列出来。
  // 这正是"这张图跑一遍会做什么"的答案。
  const plan = planEvaluation(project.workflow, {}, project.catalog.portContext(), {})
  return { project, plan }
}

export interface RunOptions {
  yamlPath: string
  bindings: DataBinding[]
  hostUrl: string
  /** 运行目录的父目录。每次都写 `runs/<runId>/`，不覆盖历史 */
  outDir: string
  /** Persist bounded PNGs beside the run manifest for MCP/CLI visual inspection. */
  captureFigures?: boolean
  onProgress?: (dataset: string, phase: string, ratio: number) => void
  onLog?: (entry: KernelLogEntry) => void
  /**
   * 长任务的**节点级**进度。CLI 把它打到 stderr —— 过程量不进报告，也不进运行清单：
   * 那里只放"算完了什么"，一份清单里夹进几十行百分比就没人读了。
   */
  onNodeProgress?: (nodeId: string, ratio: number, message: string) => void
  onNode?: (nodeId: string, status: string) => void
  isCancelled?: () => boolean
  /** 跑完之后顺手取这些端口的前 N 行（`sciviz inspect --rows`） */
  heads?: HeadRequest[]
}

/** 要现取行值时用。全表留在引擎侧，只有这里会真的把行值搬过来 */
export interface HeadRequest {
  /** 节点 id；也接受当前运行结果中唯一的节点标签。 */
  nodeId: string
  /** 省略时从本次实际输出中选择唯一 table 端口。 */
  portId?: string
  rows: number
  /** 零起始分页偏移；对应 WorkerIn.head 已有的 offset 字段。 */
  rowOffset?: number
}

export interface RunOutcome {
  manifest: RunManifest
  manifestPath: string
  reportPath: string
  runDir: string
  engineInfo: string
  project: LoadedProject
  result: KernelResult
  /** 与上一次运行的对比。第一次运行时为 undefined */
  drift?: DriftReport
  /** 现取到的行值 */
  heads: { nodeId: string; portId: string; rows: number; table: PreviewTable }[]
  figures?: RunFigureArtifact[]
  figureCapture?: RunFigureCaptureSummary
}

const MAX_CAPTURED_FIGURES = 20
const MAX_CAPTURED_FIGURE_BYTES = 8 * 1024 * 1024
const MAX_CAPTURED_FIGURE_TOTAL_BYTES = 24 * 1024 * 1024

interface FigureNodeSource {
  nodeId: string
  groupPath: string[]
  runtimeId: string
  label: string
}

interface CapturedPng {
  bytes: Buffer
  width: number
  height: number
}

const figureKey = (runtimeId: string, portId: string): string => `${runtimeId}\u0000${portId}`

function indexFigureSources(sourceWorkflow: LoadedProject['workflow']): Map<string, FigureNodeSource> {
  const sourceNodes = new Map<string, FigureNodeSource>()
  const indexNodes = (workflow: NonNullable<LoadedProject['workflow']>, groupPath: string[] = []) => {
    for (const node of workflow.nodes) {
      const runtimeId = runtimeNodeIdForPath(groupPath, node.id)
      sourceNodes.set(runtimeId, { nodeId: node.id, groupPath: [...groupPath], runtimeId, label: node.label })
      if (node.group) indexNodes(node.group.workflow, [...groupPath, node.id])
    }
  }
  if (sourceWorkflow) indexNodes(sourceWorkflow)
  return sourceNodes
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function chromeExecutable(playwrightPath: string): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    playwrightPath,
    ...(process.platform === 'win32' ? [
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
      process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : undefined,
    ] : process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ] : [
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    ]),
  ]
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate))
}

async function renderStandardChartPngs(
  adapter: HostAdapter,
  result: KernelResult,
  sourceNodes: Map<string, FigureNodeSource>,
): Promise<{ images: Map<string, CapturedPng>; warnings: string[] }> {
  const pending: { key: string; nodeId: string; portId: string; svg: string }[] = []
  const warnings: string[] = []
  const existingPngCount = Object.values(result.refs).reduce((sum, refs) => sum + Object.values(refs).filter((output) => output.kind === 'figure' && output.image?.mimeType === 'image/png').length, 0)
  const maxStandardCharts = Math.max(0, MAX_CAPTURED_FIGURES - existingPngCount)
  for (const node of result.workflow.nodes) {
    const outputs = result.refs[node.id] ?? {}
    for (const [portId, output] of Object.entries(outputs)) {
      if (output.kind !== 'figure' || output.image) continue
      const source = sourceNodes.get(node.id)
      if (!source || !output.rowCount || output.rowCount < 1) continue
      if (pending.length >= maxStandardCharts) {
        warnings.push(`${node.id}:${portId}：本次运行图像总数超过 ${MAX_CAPTURED_FIGURES} 张上限`)
        continue
      }
      try {
        const table = await adapter.head(node.id, portId, Math.min(CHART_MAX_POINTS, output.rowCount))
        const chart = chartFromTable(node, table, {
          totalRows: output.rowCount,
          chartId: `run-${result.runtimes[node.id]?.outputVersion ?? 0}-${node.id}-${portId}`,
        })
        const markup = renderToStaticMarkup(createElement(ChartRenderer, {
          chart,
          dataset: chart.inline!,
          onHover: () => undefined,
          mini: false,
        }))
        if (Buffer.byteLength(markup, 'utf8') > 16 * 1024 * 1024) throw new Error('图表 SVG 超过 16 MiB 上限')
        pending.push({ key: figureKey(node.id, portId), nodeId: node.id, portId, svg: markup })
      } catch (error) {
        warnings.push(`${node.id}:${portId}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  if (pending.length === 0) return { images: new Map(), warnings }

  let browser: import('playwright-core').Browser | undefined
  try {
    const { chromium } = await import('playwright-core')
    const executablePath = chromeExecutable(chromium.executablePath())
    if (!executablePath) throw new Error('未找到 Chromium；请设置 CHROME_PATH 后重新运行')
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage({ viewport: { width: 800, height: 560 }, deviceScaleFactor: 1 })
    const images = new Map<string, CapturedPng>()
    for (const item of pending) {
      try {
        await page.setContent(`<html><body style="margin:0;width:800px;min-height:560px;background:#fff">${item.svg}</body></html>`)
        const bytes = Buffer.from(await page.locator('svg').first().screenshot({ type: 'png', animations: 'disabled' }))
        const dimensions = pngDimensions(bytes)
        if (!dimensions || bytes.length === 0 || bytes.length > MAX_CAPTURED_FIGURE_BYTES) {
          throw new Error('渲染图像无效或超过 8 MiB 上限')
        }
        images.set(item.key, { bytes, ...dimensions })
      } catch (error) {
        warnings.push(`${item.nodeId}:${item.portId}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { images, warnings }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(...pending.map((item) => `${item.nodeId}:${item.portId}：${message}`))
    return { images: new Map(), warnings }
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

function captureFigureArtifacts(
  result: KernelResult,
  runDir: string,
  sourceNodes: Map<string, FigureNodeSource>,
  standardImages: Map<string, CapturedPng>,
  warnings: string[],
): { figures: RunFigureArtifact[]; summary: RunFigureCaptureSummary } {
  const figures: RunFigureArtifact[] = []
  let totalBytes = 0
  let omitted = 0
  const pngFiles = path.join(runDir, 'figures')
  try {
    fs.mkdirSync(pngFiles, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const count = Object.values(result.refs).reduce((sum, refs) => sum + Object.values(refs).filter((output) => output.kind === 'figure').length, 0)
    return { figures: [], summary: { captured: 0, omitted: count, warnings: [...warnings, `无法创建图像目录：${message}`] } }
  }
  for (const node of result.workflow.nodes) {
    const outputs = result.refs[node.id] ?? {}
    for (const [portId, output] of Object.entries(outputs)) {
      if (output.kind !== 'figure') continue
      const source = sourceNodes.get(node.id) ?? { nodeId: node.id, groupPath: [], runtimeId: node.id, label: node.label }
      let bytes: Buffer | undefined
      let width = 0
      let height = 0
      if (output.image?.mimeType === 'image/png' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.image.data)) {
        bytes = Buffer.from(output.image.data, 'base64')
        width = output.image.width
        height = output.image.height
      } else {
        const rendered = standardImages.get(figureKey(node.id, portId))
        if (rendered) {
          bytes = rendered.bytes
          width = rendered.width
          height = rendered.height
        }
      }
      if (!bytes || bytes.length === 0 || bytes.length > MAX_CAPTURED_FIGURE_BYTES) {
        omitted += 1
        if (!warnings.some((warning) => warning.startsWith(`${node.id}:${portId}：`))) warnings.push(`${node.id}:${portId}：没有可保存的 PNG 图像`)
        continue
      }
      if (figures.length >= MAX_CAPTURED_FIGURES || totalBytes + bytes.length > MAX_CAPTURED_FIGURE_TOTAL_BYTES) {
        omitted += 1
        warnings.push(`${node.id}:${portId}：本次运行图像总量超过 20 张或 24 MiB 上限`)
        continue
      }
      const filename = `figure-${String(figures.length + 1).padStart(2, '0')}.png`
      try {
        fs.writeFileSync(path.join(pngFiles, filename), bytes, { flag: 'wx' })
      } catch (error) {
        omitted += 1
        warnings.push(`${node.id}:${portId}：保存图像失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const runtime = result.runtimes[node.id]
      figures.push({
        nodeId: source.nodeId,
        groupPath: [...source.groupPath],
        runtimeId: source.runtimeId,
        portId,
        label: source.label,
        path: `figures/${filename}`,
        mimeType: 'image/png',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        width,
        height,
        ...(runtime?.inputsFingerprint
          ? { fingerprintSha256: crypto.createHash('sha256').update(runtime.inputsFingerprint, 'utf8').digest('hex') }
          : {}),
      })
      totalBytes += bytes.length
    }
  }
  return { figures, summary: { captured: figures.length, omitted, warnings: warnings.slice(0, 40) } }
}

function newRunId(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${rand}`
}

/**
 * 无头运行的制品挑选：工程里已有的引用能对上就恢复，不为"跑一遍"白训一次。
 *
 * 规则本身在 `plan.ts` 的 `selectModelArtifact` —— 与画布调度器**同一个函数**。
 * 这里只把工程里那几条引用绑进去（CLI 读的是磁盘上那份 `.sciviz`，没有第二种来源）。
 */
export function artifactLookupOf(modelArtifacts: readonly ProjectModelArtifactRef[]) {
  return (nodeId: string, fingerprint: string) => {
    const ref = selectModelArtifact(modelArtifacts, nodeId, fingerprint)
    return ref
      ? {
          artifactId: ref.artifactId,
          manifestSha256: ref.manifestSha256,
          trainingFingerprint: ref.trainingFingerprint,
        }
      : undefined
  }
}

export async function runProject(options: RunOptions): Promise<RunOutcome> {
  const project = await loadProject(options.yamlPath, options.bindings, {
    onProgress: options.onProgress,
  })
  if (!project.workflow) {
    throw new Error(project.parseError ?? '工程文件解析失败')
  }

  const adapter = new HostAdapter(options.hostUrl)
  const offProgress = options.onNodeProgress
    ? adapter.onNodeProgress((nodeId, ratio, message) =>
        options.onNodeProgress?.(nodeId, ratio, message),
      )
    : null
  // 环境问在跑之前：它描述的是"这台机器"，与这次跑成没跑成无关。
  // 问到什么记什么，问不到就记 null —— 缺项能被发现，假值不能
  const health = await probeHost(options.hostUrl)
  let result: KernelResult
  const heads: RunOutcome['heads'] = []
  const sourceNodes = options.captureFigures ? indexFigureSources(project.workflow) : new Map<string, FigureNodeSource>()
  let standardImages = new Map<string, CapturedPng>()
  let figureWarnings: string[] = []
  try {
    result = await runGraph(
      {
        adapter,
        datasets: project.catalog,
        ctx: project.catalog.portContext(),
        // 与界面用同一份算子事实（同一个函数，不是各写一遍）
        operatorOf: operatorFactsOf,
        // CLI 永远连着宿主（没有宿主就直接报错，不回落），所以这里恒为真
        canRunHostOperators: () => true,
        /*
         * 工程里已有的模型制品引用照常生效：命令行跑一个带训练节点的工程时，
         * 对得上的就直接恢复，不重训（契约规格 §训练制品：保存工程后任何一次打开
         * 都必须自动按引用恢复，不得静默重训）。制品缺失或校验不过时由宿主显式报错，
         * 与界面同一条规矩。
         */
        modelArtifactForNode: artifactLookupOf(project.project?.modelArtifacts ?? []),
      },
      project.workflow,
      {
        onLog: options.onLog,
        onRuntime: (id, rt) => options.onNode?.(id, rt.status),
        ...(options.isCancelled ? { isCancelled: options.isCancelled } : {}),
      },
    )
    if (options.captureFigures) {
      const rendered = await renderStandardChartPngs(adapter, result, sourceNodes)
      standardImages = rendered.images
      figureWarnings = rendered.warnings
    }
    // 必须在这个 try 里取：产物只活在这个引擎会话里，adapter 一关就没了
    for (const req of options.heads ?? []) {
      const nodeSelection = selectResultNodes(
        result.workflow.nodes.map((node) => ({
          nodeId: node.id,
          label: node.label,
          outputs: result.refs[node.id] ?? {},
        })),
        req.nodeId,
      )
      if (!nodeSelection.ok) {
        throw new InspectionSelectionError(nodeSelection.message, {
          availableNodes: nodeSelection.availableNodes,
        })
      }
      const node = nodeSelection.nodes[0]
      const portSelection = selectRowPort(node.outputs, req.portId)
      if (!portSelection.ok) {
        throw new InspectionSelectionError(portSelection.message, {
          availablePorts: portSelection.availablePorts,
        })
      }
      const table = await adapter.head(node.nodeId, portSelection.portId, req.rows, req.rowOffset ?? 0)
      heads.push({
        nodeId: node.nodeId,
        portId: portSelection.portId,
        rows: req.rows,
        table,
      })
    }
  } finally {
    offProgress?.()
    adapter.close()
  }

  const runId = newRunId()
  const manifest = await buildRunManifest(result, {
    runId,
    validation: project.validation,
    datasets: project.datasets,
    operatorOf: operatorFactsOf,
    environment: environmentOf(health),
  })

  // 与上一次的对比要在写盘之前算：它本身要进清单（L3）
  const previous = readPreviousManifest(options.outDir, runId, manifest.graphFingerprint)
  const drift = previous ? compareManifests(previous, manifest) : undefined
  if (drift) manifest.drift = drift

  const runDir = path.join(options.outDir, runId)
  fs.mkdirSync(runDir, { recursive: true })
  const captured = options.captureFigures
    ? captureFigureArtifacts(result, runDir, sourceNodes, standardImages, figureWarnings)
    : undefined
  if (captured) {
    manifest.figures = captured.figures
    manifest.figureCapture = captured.summary
  }
  const manifestPath = path.join(runDir, 'run.json')
  const reportPath = path.join(runDir, 'report.md')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(reportPath, renderReport(manifest), 'utf8')
  appendIndex(options.outDir, manifest)

  return {
    manifest,
    manifestPath,
    reportPath,
    runDir,
    engineInfo: result.engineInfo,
    project,
    result,
    ...(drift ? { drift } : {}),
    heads,
    ...(captured ? { figures: captured.figures, figureCapture: captured.summary } : {}),
  }
}

/**
 * 找上一次运行。
 *
 * 优先找**同一张图**（图指纹相同）的最近一次：只有那样数值才可比。
 * 找不到就退回最近一次，让对比至少能说清"这张图改过"。
 */
function readPreviousManifest(
  outDir: string,
  currentRunId: string,
  graphFingerprint: string,
): RunManifest | null {
  const indexPath = path.join(outDir, 'index.json')
  if (!fs.existsSync(indexPath)) return null
  let entries: IndexEntry[] = []
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (Array.isArray(raw)) entries = raw as IndexEntry[]
  } catch {
    return null
  }

  const load = (runId: string): RunManifest | null => {
    const p = path.join(outDir, runId, 'run.json')
    if (!fs.existsSync(p)) return null
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as RunManifest
    } catch {
      return null
    }
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.runId === currentRunId || e.graphFingerprint !== graphFingerprint) continue
    const m = load(e.runId)
    if (m) return m
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.runId === currentRunId) continue
    const m = load(e.runId)
    if (m) return m
  }
  return null
}

interface IndexEntry {
  runId: string
  at: number
  workflow: string
  status: string
  graphFingerprint: string
  durationMs: number
  failedNodes: string[]
  notComputed: string[]
}

/**
 * 运行历史索引。
 *
 * 只追加、不重写既有条目。它是"这次和上次哪里不一样"（契约规格 §7 的 L3）的起点：
 * 没有历史就谈不上漂移。
 */
function appendIndex(outDir: string, manifest: RunManifest): void {
  const indexPath = path.join(outDir, 'index.json')
  let entries: IndexEntry[] = []
  if (fs.existsSync(indexPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      if (Array.isArray(raw)) entries = raw as IndexEntry[]
    } catch {
      // 索引坏了不该让运行失败：它只是历史，重建即可
      entries = []
    }
  }
  entries.push({
    runId: manifest.runId,
    at: manifest.startedAt,
    workflow: manifest.workflow.name,
    status: manifest.status,
    graphFingerprint: manifest.graphFingerprint,
    durationMs: manifest.durationMs,
    failedNodes: manifest.nodes.filter((n) => n.status === 'error').map((n) => n.nodeId),
    notComputed: manifest.notComputed.map((n) => n.nodeId),
  })
  fs.writeFileSync(indexPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}
