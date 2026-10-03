/**
 * 会话级长程 Agent 任务状态。
 *
 * 计划以 task_checkpoint 的 tool_result 事件保存，不另建一份会话或运行事实来源。
 * 这个模块只校验和还原结构；不依赖 DOM、React、store 或宿主。
 */

export type AgentTaskStatus = 'active' | 'blocked' | 'completed'
export type AgentTaskStepStatus = 'pending' | 'running' | 'blocked' | 'completed'

export interface AgentTaskStep {
  id: string
  title: string
  successCriteria: string
  status: AgentTaskStepStatus
  evidenceRefs: string[]
  notes: string[]
}

export interface AgentTask {
  schemaVersion: 1
  taskId: string
  goal: string
  status: AgentTaskStatus
  steps: AgentTaskStep[]
  planHistory: string[]
  createdAt: string
  updatedAt: string
  blocker?: string
  completionSummary?: string
  finalEvidenceRefs?: string[]
  report?: string
  /** The matching report in the current .sciviz project's report collection. */
  reportId?: string
  /** Whether the latest report version was written to an opened .sciviz file. */
  reportFileSaved?: boolean
}

export interface TaskCheckpointResult {
  ok: boolean
  task?: AgentTask
  message: string
  error?: { code: 'E_PARAM_INVALID'; message: string }
}

const MAX_STEPS = 20
const MAX_REPORT_CHARS = 16_000
const MAX_NOTE_CHARS = 2_000
const MAX_NOTES_PER_STEP = 8
/** A single user request may span several bounded provider/tool windows. */
export const TASK_AUTO_RUN_LIMITS = {
  windows: 6,
  elapsedMs: 30 * 60_000,
} as const
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/
const stepStatuses = new Set<AgentTaskStepStatus>(['pending', 'running', 'blocked', 'completed'])

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const cleanText = (value: unknown, max = MAX_NOTE_CHARS): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

function refsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 24)
    : []
}

function stepDefinitions(value: unknown, existing: readonly AgentTaskStep[] = []): AgentTaskStep[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STEPS) return null
  const seen = new Set(existing.map((step) => step.id))
  const result: AgentTaskStep[] = []
  for (const raw of value) {
    const item = recordOf(raw)
    const id = cleanText(item.id, 40)
    const title = cleanText(item.title, 180)
    const successCriteria = cleanText(item.successCriteria, 500)
    if (!idPattern.test(id) || !title || !successCriteria || seen.has(id)) return null
    seen.add(id)
    result.push({ id, title, successCriteria, status: 'pending', evidenceRefs: [], notes: [] })
  }
  if (existing.length + result.length > MAX_STEPS) return null
  return result
}

function normalizeTask(value: unknown): AgentTask | null {
  const raw = recordOf(value)
  if (raw.schemaVersion !== 1 || typeof raw.taskId !== 'string' || typeof raw.goal !== 'string') return null
  if (!['active', 'blocked', 'completed'].includes(String(raw.status)) || !Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_STEPS) return null
  const seen = new Set<string>()
  const steps: AgentTaskStep[] = []
  for (const rawStep of raw.steps) {
    const step = recordOf(rawStep)
    const id = cleanText(step.id, 40)
    const title = cleanText(step.title, 180)
    const successCriteria = cleanText(step.successCriteria, 500)
    const status = step.status as AgentTaskStepStatus
    if (!idPattern.test(id) || !title || !successCriteria || seen.has(id) || !stepStatuses.has(status)) return null
    seen.add(id)
    steps.push({
      id,
      title,
      successCriteria,
      status,
      evidenceRefs: refsOf(step.evidenceRefs),
      notes: Array.isArray(step.notes) ? step.notes.filter((note): note is string => typeof note === 'string').map((note) => cleanText(note)).filter(Boolean).slice(-MAX_NOTES_PER_STEP) : [],
    })
  }
  const createdAt = cleanText(raw.createdAt, 80)
  const updatedAt = cleanText(raw.updatedAt, 80)
  if (!createdAt || !updatedAt) return null
  const planHistory = Array.isArray(raw.planHistory)
    ? raw.planHistory.filter((note): note is string => typeof note === 'string').map((note) => cleanText(note)).filter(Boolean).slice(-20)
    : []
  return {
    schemaVersion: 1,
    taskId: cleanText(raw.taskId, 100),
    goal: cleanText(raw.goal, 1_000),
    status: raw.status as AgentTaskStatus,
    steps,
    planHistory,
    createdAt,
    updatedAt,
    ...(cleanText(raw.blocker) ? { blocker: cleanText(raw.blocker) } : {}),
    ...(cleanText(raw.completionSummary) ? { completionSummary: cleanText(raw.completionSummary) } : {}),
    ...(refsOf(raw.finalEvidenceRefs).length ? { finalEvidenceRefs: refsOf(raw.finalEvidenceRefs) } : {}),
    ...(cleanText(raw.report, MAX_REPORT_CHARS) ? { report: cleanText(raw.report, MAX_REPORT_CHARS) } : {}),
    ...(cleanText(raw.reportId, 120) ? { reportId: cleanText(raw.reportId, 120) } : {}),
    ...(typeof raw.reportFileSaved === 'boolean' ? { reportFileSaved: raw.reportFileSaved } : {}),
  }
}

/** Continue only while an active task has work left and the automatic run is within its bounds. */
export function canAutoContinueTask(task: AgentTask | null, windowsStarted: number, elapsedMs: number): boolean {
  return task?.status === 'active'
    && task.steps.some((step) => step.status !== 'completed')
    && windowsStarted < TASK_AUTO_RUN_LIMITS.windows
    && elapsedMs < TASK_AUTO_RUN_LIMITS.elapsedMs
}

/** Most recent valid task checkpoint in this session, or null when no task was planned. */
export function taskFromEvents(events: readonly unknown[]): AgentTask | null {
  let latest: AgentTask | null = null
  for (const rawEvent of events) {
    const event = recordOf(rawEvent)
    if (event.type !== 'tool_result') continue
    const payload = recordOf(event.payload)
    if (payload.tool !== 'task_checkpoint' || payload.ok !== true) continue
    const data = recordOf(payload.data)
    const task = normalizeTask(data.task)
    if (task) latest = task
  }
  return latest
}

/** Successful completed tool results that a task step may cite as evidence. */
export function successfulToolCallIds(events: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const rawEvent of events) {
    const event = recordOf(rawEvent)
    if (event.type !== 'tool_result') continue
    const result = recordOf(event.payload)
    if (result.ok !== true || result.status !== 'done' || result.tool === 'task_checkpoint') continue
    const callId = cleanText(result.callId, 120)
    if (callId) ids.add(callId)
  }
  return ids
}

function checkpointError(message: string): TaskCheckpointResult {
  return { ok: false, message, error: { code: 'E_PARAM_INVALID', message } }
}

function addNote(notes: string[], value: string): string[] {
  return value ? [...notes, value].slice(-MAX_NOTES_PER_STEP) : notes
}

/** Apply and validate one task_checkpoint tool call. */
export function applyTaskCheckpoint(
  current: AgentTask | null,
  rawInput: unknown,
  callId: string,
  availableEvidence: ReadonlySet<string>,
  now = new Date().toISOString(),
): TaskCheckpointResult {
  const input = recordOf(rawInput)
  const action = input.action

  if (action === 'plan') {
    const goal = cleanText(input.goal, 1_000)
    const steps = stepDefinitions(input.steps)
    if (!goal || !steps) return checkpointError('新计划需要 goal 和 1–20 个唯一 id 的步骤；每步要有 title 与 successCriteria')
    const task: AgentTask = {
      schemaVersion: 1,
      taskId: callId,
      goal,
      status: 'active',
      steps,
      planHistory: [],
      createdAt: now,
      updatedAt: now,
    }
    return { ok: true, task, message: `已保存任务计划：${steps.length} 个步骤` }
  }

  if (!current) return checkpointError('当前会话没有活动任务；请先用 action="plan" 创建计划')

  if (action === 'replan') {
    if (current.status === 'completed') return checkpointError('任务已完成；如有新目标，请创建新计划')
    const rationale = cleanText(input.rationale)
    const additions = stepDefinitions(input.steps, current.steps)
    if (!rationale || !additions) return checkpointError('重规划需要 rationale 和至少一个唯一 id 的新增步骤；已完成步骤会保留')
    const task: AgentTask = {
      ...current,
      status: 'active',
      steps: [...current.steps, ...additions],
      planHistory: addNote(current.planHistory, rationale),
      updatedAt: now,
      blocker: undefined,
      completionSummary: undefined,
      finalEvidenceRefs: undefined,
      report: undefined,
      reportId: undefined,
      reportFileSaved: undefined,
    }
    return { ok: true, task, message: `已按新证据调整计划，保留原有 ${current.steps.length} 步并增加 ${additions.length} 步` }
  }

  if (action === 'update') {
    const stepId = cleanText(input.stepId, 40)
    const status = input.status as AgentTaskStepStatus
    const note = cleanText(input.note)
    const stepIndex = current.steps.findIndex((step) => step.id === stepId)
    if (stepIndex < 0 || !stepStatuses.has(status)) return checkpointError('update 需要存在的 stepId 和有效 status')
    const old = current.steps[stepIndex]
    const refs = [...new Set([...old.evidenceRefs, ...refsOf(input.evidenceRefs)])]
    if (refs.some((ref) => !availableEvidence.has(ref))) return checkpointError('evidenceRefs 必须引用本会话里已成功完成的工具结果 callId')
    if (status === 'completed' && refs.length === 0) return checkpointError('步骤完成需要引用至少一个成功工具结果的 callId')
    if (status === 'completed' && old.status !== 'completed') {
      const alreadyUsed = new Set(current.steps.filter((step) => step.id !== stepId && step.status === 'completed').flatMap((step) => step.evidenceRefs))
      if (refs.every((ref) => alreadyUsed.has(ref))) return checkpointError('新完成步骤至少需要一条未被其它已完成步骤使用的成功工具结果；旧证据可补充，不能独自证明新动作')
    }
    if (status === 'blocked' && !note) return checkpointError('blocked 步骤需要在 note 中记录具体阻塞原因')
    const steps = current.steps.map((step, index) => index === stepIndex
      ? { ...step, status, evidenceRefs: refs, notes: addNote(step.notes, note) }
      : step)
    const task: AgentTask = {
      ...current,
      steps,
      status: status === 'blocked' ? 'blocked' : 'active',
      updatedAt: now,
      ...(status === 'blocked' ? { blocker: note } : { blocker: undefined }),
      completionSummary: undefined,
      finalEvidenceRefs: undefined,
      report: undefined,
      reportId: undefined,
      reportFileSaved: undefined,
    }
    return { ok: true, task, message: `已保存「${old.title}」的${status === 'completed' ? '完成状态与关联工具结果（尚未核验因果解释）' : status === 'blocked' ? '阻塞状态' : '进度'}` }
  }

  if (action === 'finish') {
    const incomplete = current.steps.filter((step) => step.status !== 'completed')
    if (incomplete.length) return checkpointError(`仍有 ${incomplete.length} 个步骤未完成，不能结束任务`)
    const summary = cleanText(input.summary, 1_000)
    const report = cleanText(input.report, MAX_REPORT_CHARS)
    const suppliedRefs = refsOf(input.evidenceRefs)
    const finalEvidenceRefs = suppliedRefs.length
      ? suppliedRefs
      : [...new Set(current.steps.flatMap((step) => step.evidenceRefs))].slice(0, 24)
    if (!summary || report.length < 80) return checkpointError('finish 需要 completion summary 和至少 80 字符的 Markdown 实验报告')
    if (finalEvidenceRefs.length === 0 || finalEvidenceRefs.some((ref) => !availableEvidence.has(ref))) {
      return checkpointError('最终报告需要 evidenceRefs，且每个值都必须是本会话中已成功工具结果的 callId')
    }
    const task: AgentTask = {
      ...current,
      status: 'completed',
      updatedAt: now,
      completionSummary: summary,
      finalEvidenceRefs,
      report,
      blocker: undefined,
    }
    return { ok: true, task, message: '任务步骤已完成；实验报告已关联工具结果，科学结论仍以同口径验证为准' }
  }

  return checkpointError('action 必须是 plan、update、replan 或 finish')
}
