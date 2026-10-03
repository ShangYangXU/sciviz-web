import { buildCatalog } from '../contract/catalog'
import { explainCode, getErrorCode } from '../contract/errorCodes'
import { applyPatch, type PatchResult } from '../kernel/patch'
import { projectPortContext, type Project } from '../workflow/project'
import { validateWorkflow } from '../contract/validate'
import type { ToolName } from './tools'
import { humanizePatch } from './humanizePatch'

export interface ClientToolResult {
  toolPayloadVersion: 1
  callId: string
  tool: string
  ok: boolean
  status: 'done' | 'partial' | 'failed' | 'rejected'
  data?: unknown
  error?: { code: string; message: string; explain?: string }
  evidence: Array<{ kind: string; ref: string; digest?: string }>
}

function done(callId: string, tool: string, data: unknown, evidence: ClientToolResult['evidence'] = []): ClientToolResult {
  return { toolPayloadVersion: 1, callId, tool, ok: true, status: 'done', data, evidence }
}

function failed(callId: string, tool: string, code: string, message: string): ClientToolResult {
  return { toolPayloadVersion: 1, callId, tool, ok: false, status: 'failed', error: { code, message, explain: explainCode(code) }, evidence: [] }
}

/**
 * 这里只做**不需要确认**的那几个工具。写工具（`patch` / `undo`）不在这条路上：
 * 它们要算基线、要人点确认、要写回画布并记账，判定在 `./graphTools.ts` 里，
 * 由 `ChatPanel` 注入"人确认 / 写回 / 记账"三件事之后调用。
 */
const READ_ONLY_TOOLS = new Set<ToolName>(['catalog', 'validate', 'explain', 'plan', 'inspect'])

export function executeClientTool(name: ToolName, args: unknown, project: Project, callId: string): ClientToolResult {
  if (!READ_ONLY_TOOLS.has(name)) {
    return failed(callId, name, 'E_PARAM_INVALID', `工具「${name}」要人确认，得从 graphTools 那条路走，不能直接落到这里`)
  }
  try {
    const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    if (name === 'catalog') return done(callId, name, buildCatalog({}), [{ kind: 'catalog', ref: 'catalog:v2' }])
    if (name === 'validate') return done(callId, name, validateWorkflow(project.graph, projectPortContext(project)), [{ kind: 'project', ref: project.projectId ?? 'unsaved' }])
    if (name === 'explain') {
      const code = typeof input.code === 'string' ? input.code : ''
      if (!getErrorCode(code)) return failed(callId, name, 'E_PARAM_INVALID', `未知错误码「${code}」`)
      return done(callId, name, explainCode(code), [{ kind: 'error-code', ref: code }])
    }
    if (name === 'plan') {
      const patch = input.patch as Parameters<typeof applyPatch>[1] | undefined
      if (!patch || !Array.isArray(patch.ops)) return failed(callId, name, 'E_PARAM_INVALID', 'plan.patch 必须包含 ops 数组')
      const result: PatchResult = applyPatch(project, patch)
      return done(callId, name, { ok: result.ok, changes: humanizePatch(project, patch, result.project), diff: result.diff, validation: result.validation, incomplete: result.incomplete, rejections: result.rejections }, [{ kind: 'diff', ref: `patch:${callId}` }])
    }
    return done(callId, name, { message: '当前运行摘要需要先由 run 产生；本轮没有自动读取行值' })
  } catch (error: unknown) {
    return failed(callId, name, 'E_EXECUTION_FAILED', error instanceof Error ? error.message : String(error))
  }
}
