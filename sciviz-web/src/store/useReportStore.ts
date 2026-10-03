import { create } from 'zustand'
import type { ReportFigureCapture } from '../agent/reportFigure'
import type { ProjectReport } from '../workflow/project'
import {
  materializeReportFigures,
  reportFigureReference,
  validateProjectReports,
  validateReportImages,
  type StagedReportImage,
} from '../workflow/report'
import { journalDelete, journalRead, journalWrite } from './reportJournal'
import { confirmDiscardReportDraft } from './reportDraftGuard'

interface ReportState {
  projectId: string | null
  reports: ProjectReport[]
  selectedReportId: string | null
  setAll: (projectId: string, reports: ProjectReport[]) => void
  selectReport: (id: string | null) => void
}

export const useReportStore = create<ReportState>((set) => ({
  projectId: null,
  reports: [],
  selectedReportId: null,
  setAll: (projectId, reports) => set((state) => ({
    projectId,
    reports,
    selectedReportId: state.projectId === projectId && reports.some((report) => report.id === state.selectedReportId)
      ? state.selectedReportId : reports[0]?.id ?? null,
  })),
  selectReport: (id) => set((state) => ({
    selectedReportId: id && state.reports.some((report) => report.id === id) ? id : null,
  })),
}))

interface PendingReports {
  /** Reports in the file before the first unsaved mutation. */
  base: string
  reports: ProjectReport[]
}

const reportsKey = (projectId: string): string => `reports:${projectId}`
const figuresKey = (projectId: string, sessionId: string, taskId: string): string =>
  `figures:${projectId}:${sessionId}:${taskId}`

let projectWriter: ((projectId: string) => Promise<ProjectWriteOutcome>) | null = null

/**
 * 写回失败的原因。**这是判据，不是措辞** —— 从前这条路上只有一个 `false`，
 * 于是"没打开文件""浏览器没给写权限""磁盘上的文件更新了""写入被拒"长得一模一样，
 * 工具结果只能笼统地说"请检查文件权限或磁盘变化"（见 docs/开发日志.md 2026-09-27）。
 */
export type ProjectWriteFailureReason = 'no-handle' | 'permission' | 'disk-changed' | 'write-error'

export interface ProjectWriteFailure {
  ok: false
  reason: ProjectWriteFailureReason
  /** 浏览器/文件系统给的原话（DOMException 名与消息），有就带上，便于当场判断。 */
  detail?: string
}

export type ProjectWriteOutcome = { ok: true } | ProjectWriteFailure

/** ProjectFileBar registers its exact file-handle write path here. `no-handle` means no opened file. */
export function registerReportProjectWriter(writer: ((projectId: string) => Promise<ProjectWriteOutcome>) | null): void {
  projectWriter = writer
}

const WRITE_FAILURE_TEXT: Record<ProjectWriteFailureReason, { full: string; brief: string }> = {
  'no-handle': {
    full: '当前没有打开工程文件，报告已保存在本机草稿；点顶栏「保存工程」导出或写回 .sciviz 即可',
    brief: '还没打开工程文件',
  },
  permission: {
    full: '浏览器没有给这个工程文件的写权限（写权限只能在一次点击里申请），报告草稿已完整保留 —— 点工程工具条上的「允许写回」授权一次即可写入',
    brief: '浏览器还没给写权限，点工具条上的「允许写回」授权一次',
  },
  'disk-changed': {
    full: '磁盘上的工程文件已被其他窗口或外部程序修改，这份报告已保存在本地草稿 —— 先在工程工具条上「重新载入」核对，再保存写入',
    brief: '工程文件被别处改过，先「重新载入」再保存',
  },
  'write-error': {
    full: '写回工程文件失败，这份报告已保存在本地草稿 —— 修好之后点「保存工程」即可写入',
    brief: '写回被拒，报告已留在本机草稿',
  },
}

/** 同一条失败在两处要用不同长度的话：工具结果说清怎么做，工具条只占一行。字符串只写一份。 */
export function reportWriteFailureText(failure: ProjectWriteFailure, form: 'full' | 'brief' = 'full'): string {
  const text = WRITE_FAILURE_TEXT[failure.reason][form]
  return failure.detail ? `${text}（${failure.detail}）` : text
}

let queue: Promise<void> = Promise.resolve()
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task)
  queue = result.then(() => undefined, () => undefined)
  return result
}

function assertProject(projectId: string): ProjectReport[] {
  const state = useReportStore.getState()
  if (!projectId || state.projectId !== projectId) throw new Error('报告所属工程已改变，请重新打开当前工程')
  return state.reports
}

async function persistReports(projectId: string, reports: ProjectReport[]): Promise<boolean> {
  validateProjectReports(reports)
  const before = assertProject(projectId)
  const key = reportsKey(projectId)
  const prior = await journalRead<PendingReports>(key).catch(() => undefined)
  let journalError: unknown = null
  try {
    await journalWrite<PendingReports>(key, { base: prior?.base ?? JSON.stringify(before), reports })
  } catch (error) {
    journalError = error
  }
  useReportStore.getState().setAll(projectId, reports)
  let outcome: ProjectWriteOutcome = { ok: false, reason: 'no-handle' }
  try {
    outcome = await projectWriter?.(projectId) ?? { ok: false, reason: 'no-handle' }
  } catch (error) {
    if (journalError) useReportStore.getState().setAll(projectId, before)
    throw error
  }
  if (outcome.ok) {
    if (!journalError) await journalDelete(key).catch(() => undefined)
    return true
  }
  if (journalError) {
    // 报告一条都没落地：既没进工程文件，也没进本机草稿 —— 只有这种情况必须当失败。
    useReportStore.getState().setAll(projectId, before)
    throw new Error(`报告既未写入工程文件，也未能保存到本地草稿：${String(journalError)}`)
  }
  if (outcome.reason === 'no-handle') {
    // 还没打开文件：草稿就是权威副本，调用方按"待保存"呈现，不算失败。
    return false
  }
  throw new Error(reportWriteFailureText(outcome))
}

export interface ReportSaveResult {
  reportId: string
  /** False means durable local draft; Save Project writes it into .sciviz. */
  projectFileSaved: boolean
}

export async function createProjectReport(projectId: string, title = '新报告'): Promise<ReportSaveResult> {
  return serialize(async () => {
    const now = new Date().toISOString()
    const report: ProjectReport = {
      id: `report-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      title,
      markdown: `# ${title}\n`,
      createdAt: now,
      updatedAt: now,
      figures: [],
    }
    const projectFileSaved = await persistReports(projectId, [...assertProject(projectId), report])
    useReportStore.getState().selectReport(report.id)
    return { reportId: report.id, projectFileSaved }
  })
}

export async function updateProjectReport(
  projectId: string,
  reportId: string,
  changes: { title?: string; markdown?: string; figures?: ProjectReport['figures'] },
  expectedUpdatedAt?: string,
): Promise<ReportSaveResult> {
  return serialize(async () => {
    const reports = assertProject(projectId)
    const current = reports.find((report) => report.id === reportId)
    if (!current) throw new Error('这份报告已不在当前工程中')
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== current.updatedAt) {
      throw new Error('报告已被其他操作更新；请先载入最新版本，再保存编辑')
    }
    const priorTimestamp = Date.parse(current.updatedAt)
    const nextTimestamp = Math.max(Date.now(), Number.isFinite(priorTimestamp) ? priorTimestamp + 1 : 0)
    const next = reports.map((report) => report.id === reportId
      ? { ...report, ...changes, updatedAt: new Date(nextTimestamp).toISOString() } : report)
    const projectFileSaved = await persistReports(projectId, next)
    return { reportId, projectFileSaved }
  })
}

export async function deleteProjectReport(projectId: string, reportId: string): Promise<{ projectFileSaved: boolean }> {
  return serialize(async () => {
    const reports = assertProject(projectId)
    if (!reports.some((report) => report.id === reportId)) throw new Error('这份报告已不在当前工程中')
    const projectFileSaved = await persistReports(projectId, reports.filter((report) => report.id !== reportId))
    return { projectFileSaved }
  })
}

export interface TaskReportKey {
  projectId: string
  sessionId: string
  taskId: string
}

export interface StageTaskReportFigureInput extends TaskReportKey {
  figure: ReportFigureCapture
  caption?: string
}

export async function stageTaskReportFigure(input: StageTaskReportFigureInput): Promise<{ imageId: string; markdownRef: string }> {
  return serialize(async () => {
    assertProject(input.projectId)
    const key = figuresKey(input.projectId, input.sessionId, input.taskId)
    const previous = await journalRead<StagedReportImage[]>(key) ?? []
    const imageId = input.figure.sha256.toLowerCase()
    const staged: StagedReportImage = { figure: input.figure, caption: input.caption?.trim() || input.figure.label }
    const next = [...previous.filter((item) => item.figure.sha256.toLowerCase() !== imageId), staged]
    validateReportImages(next)
    await journalWrite(key, next)
    return { imageId, markdownRef: reportFigureReference(input.figure, staged.caption) }
  })
}

export async function getStagedTaskReportFigures(key: TaskReportKey): Promise<ReportFigureCapture[]> {
  return (await journalRead<StagedReportImage[]>(figuresKey(key.projectId, key.sessionId, key.taskId)) ?? [])
    .map((item) => item.figure as ReportFigureCapture)
}

export interface SaveTaskReportInput extends TaskReportKey {
  title: string
  markdown: string
  evidenceRefs: string[]
  images?: ReportFigureCapture[]
}

export async function saveTaskReport(input: SaveTaskReportInput): Promise<ReportSaveResult> {
  return serialize(async () => {
    const reports = assertProject(input.projectId)
    const key = figuresKey(input.projectId, input.sessionId, input.taskId)
    // Reports without staged figures can still be written straight to an opened .sciviz
    // if this browser has no IndexedDB. Staging itself remains fail-closed.
    const existingStaged = await journalRead<StagedReportImage[]>(key).catch(() => undefined) ?? []
    const staged = [...existingStaged]
    for (const figure of input.images ?? []) {
      if (!staged.some((item) => item.figure.sha256 === figure.sha256)) {
        staged.push({ figure, caption: figure.label })
      }
    }
    const materialized = materializeReportFigures(input.markdown, staged)
    const existing = reports.find((report) => report.source?.kind === 'agent-task' &&
      report.source.sessionId === input.sessionId && report.source.taskId === input.taskId)
    const now = new Date().toISOString()
    const report: ProjectReport = {
      id: existing?.id ?? `task-report:${input.sessionId}:${input.taskId}`,
      title: input.title,
      markdown: materialized.markdown,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      source: {
        kind: 'agent-task',
        sessionId: input.sessionId,
        taskId: input.taskId,
        evidenceRefs: [...new Set(input.evidenceRefs)],
      },
      figures: materialized.figures,
    }
    const next = existing
      ? reports.map((item) => item.id === existing.id ? report : item)
      : [...reports, report]
    const projectFileSaved = await persistReports(input.projectId, next)
    await journalDelete(key).catch(() => undefined)
    useReportStore.getState().selectReport(report.id)
    return { reportId: report.id, projectFileSaved }
  })
}

/** Apply only a matching unsaved journal. A newer file never gets silently overwritten. */
export async function restorePendingProjectReports(projectId: string): Promise<'none' | 'restored' | 'conflict'> {
  const pending = await journalRead<PendingReports>(reportsKey(projectId))
  if (!pending) return 'none'
  const current = assertProject(projectId)
  if (JSON.stringify(current) === JSON.stringify(pending.reports)) {
    await journalDelete(reportsKey(projectId))
    return 'none'
  }
  if (JSON.stringify(current) !== pending.base) return 'conflict'
  validateProjectReports(pending.reports)
  useReportStore.getState().setAll(projectId, pending.reports)
  return 'restored'
}

/** Called only after the same store snapshot has been written to the opened project file. */
export async function clearPendingProjectReports(projectId: string, savedReports: ProjectReport[]): Promise<void> {
  const key = reportsKey(projectId)
  const pending = await journalRead<PendingReports>(key)
  if (pending && JSON.stringify(pending.reports) === JSON.stringify(savedReports)) await journalDelete(key)
}

export function getProjectReport(reportId: string): ProjectReport | undefined {
  return useReportStore.getState().reports.find((report) => report.id === reportId)
}

export function openProjectReport(reportId: string): void {
  if (!getProjectReport(reportId)) throw new Error('这份报告已不在当前工程中')
  if (!confirmDiscardReportDraft()) return
  useReportStore.getState().selectReport(reportId)
  window.dispatchEvent(new CustomEvent('sciviz-open-report', { detail: { reportId } }))
}

export function downloadProjectReport(reportId: string): void {
  const report = getProjectReport(reportId)
  if (!report) throw new Error('这份报告已不在当前工程中')
  const blob = new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${report.title.replace(/[\\/:*?"<>|]/g, '_') || '报告'}.md`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
