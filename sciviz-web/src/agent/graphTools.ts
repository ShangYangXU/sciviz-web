/**
 * 对话栏的两个图写工具（`patch` / `undo`）—— **与界面无关的那一半**。
 *
 * 抽出来的理由只有一条：这段逻辑此前长在 `ChatPanel.tsx` 里，于是它既不能被
 * `node --test` 跑到，也没人发现它有个会把自己锁死的缺陷 ——
 * 补丁因为**别处**的 L1 问题被拒时，`rejections` 是空表，界面就报了个
 * `E_PATCH_BASE_MISMATCH`（"基线不符"）。模型看到"基线不符"，换一版基线重试，
 * 再失败，然后整轮对话都在原地打转，用户看到的就是"AI 改不了块"。
 *
 * 现在这里的规矩是：**拒绝必须说出真的那条理由**，而整图 L1 的问题只报告、不否决
 * （见 `kernel/patch.ts` 的四条设计决定）。
 */

import { explainCode } from '../contract/errorCodes'
import { applyPatch, applyPatchGuarded, type PatchResult } from '../kernel/patch'
import { projectEditFingerprint } from '../kernel/editFingerprint'
import { projectToText, type Project } from '../workflow/project'
import { workflowAtGroupPath, WORKFLOW_GROUP_TYPE } from '../workflow/groups'
import { getNodeTypeDef, hasNodeType } from '../workflow/nodeRegistry'
import type { Workflow, WorkflowNode } from '../workflow/types'
import type { PatchFile, PatchOp } from '../contract/ops'
import type { ClientToolResult } from './clientTools'
import { shouldConfirmWrite, type WriteMode, type WriteRisk } from './writeMode'
import { humanizePatch } from './humanizePatch'

/** 发给模型的 diff 上限：整份工程可以很长，但改动的"看得见"部分只需要一小段 */
const MAX_DIFF_LINES = 160

export interface GraphPatchDeps {
  /** 人确认这次改动。生产环境是 `window.confirm`，测试里注入假的 */
  confirm: (question: string) => boolean
  /** 把落下来的工程写回画布（并记进改动历史）。失败要说得出原因 */
  write: (applied: Project, patch: PatchFile, result: PatchResult) => { ok: boolean; error?: string }
  /**
   * 写入档位（见 `writeMode.ts`）。缺省取**会问**的那一档：
   * 这个函数的默认值只对"忘了传"的调用方负责，保守比静默更安全；
   * 对话栏传的是用户在输入区选的那一档。
   */
  mode?: WriteMode
}

export interface GraphUndoDeps {
  confirm: (question: string) => boolean
  /** 撤销最近一次改动。生产环境是 `store/projectFile.ts` 的 `undoLastPatch` */
  undo: () => Promise<{ ok: boolean; error?: string; changes?: string[]; text?: string }>
  mode?: WriteMode
}

const failed = (
  callId: string,
  tool: string,
  code: string,
  message: string,
  extra: Partial<ClientToolResult> = {},
): ClientToolResult => ({
  toolPayloadVersion: 1,
  callId,
  tool,
  ok: false,
  status: 'failed',
  error: { code, message, explain: explainCode(code) },
  evidence: [],
  ...extra,
})

export function shortDiff(diff: string): string {
  const lines = diff.split('\n')
  if (lines.length <= MAX_DIFF_LINES) return diff
  return `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n…（还有 ${lines.length - MAX_DIFF_LINES} 行没显示；完整内容在改动记录里）`
}

/**
 * 这批 op 属于哪一类写（对话栏设计 §8.6）。
 *
 * 风险来自"会不会丢掉用户已有的表达"，不来自 op 名字看起来是否简单：
 * 删数据集、删带代码的节点、覆盖非默认代码、断开跨组连线、重置参数一律提高一级；
 * 新增 / 移动 / 改名 / 普通参数修改仍是普通写。
 *
 * 判定是纯函数（输入是当前工程与补丁本身），所以"帮我批准"这一档能直接 `node --test`。
 * 判不准的时候**不往危险上靠**：这里只认列出来的那几种，其余的按普通写走 ——
 * 误把普通写判成破坏性，会让中间那档退化成"每次都问"，那是这个开关本来要解决的症状。
 */
export function patchRisk(project: Project, patch: PatchFile): WriteRisk {
  for (const op of patch.ops) {
    if (isDestructiveOp(workflowForOp(project, op), op)) return 'destructive'
  }
  return 'normal'
}

/** op 作用在哪一层子图；路径不存在时退回根图（这一段只是判风险，不负责拒绝） */
function workflowForOp(project: Project, op: PatchOp): Workflow {
  // 不是每条 op 都有 `path`（没有的那些只作用于根图，例如 addDataset），所以这里不能直取
  const path = (op as { path?: string[] }).path
  if (!path || path.length === 0) return project.graph
  try {
    return workflowAtGroupPath(project.graph, path)
  } catch {
    return project.graph
  }
}

function isDestructiveOp(workflow: Workflow, op: PatchOp): boolean {
  switch (op.op) {
    case 'removeDataset':
      return true
    case 'resetParams':
      return true
    case 'removeNode': {
      const node = workflow.nodes.find((item) => item.id === op.id)
      return node ? hasCustomCode(node) : false
    }
    case 'setParam': {
      if (op.key !== 'code') return false
      const node = workflow.nodes.find((item) => item.id === op.id)
      return node ? hasCustomCode(node) : false
    }
    case 'disconnect': {
      const edge = workflow.edges.find((item) => item.id === op.edgeId)
      if (!edge) return false
      return [edge.source, edge.target].some((id) => workflow.nodes.find((item) => item.id === id)?.type === WORKFLOW_GROUP_TYPE)
    }
    default:
      return false
  }
}

/** 块里的代码还是不是出厂那一份 —— 不是的话，删掉它就是丢掉人写的东西 */
function hasCustomCode(node: WorkflowNode): boolean {
  const current = node.params.code
  if (typeof current !== 'string' || !current.trim()) return false
  if (!hasNodeType(node.type)) return true
  const spec = getNodeTypeDef(node.type).params.find((param) => param.key === 'code')
  const fallback = typeof spec?.default === 'string' ? spec.default : ''
  return current !== fallback
}

/**
 * 补丁落盘前后的公共部分：算基线 → 复核 → 应用 → 人确认 → 写回。
 *
 * 顺序刻意不换：**先算基线、再确认**，确认框里写的才是马上就要落的那些改动，
 * 而不是"确认完之后又会变一次"的东西。
 */
export async function runGraphPatch(
  project: Project,
  args: unknown,
  callId: string,
  deps: GraphPatchDeps,
): Promise<ClientToolResult> {
  // 档位在整个函数里只取一次：中途变化会让"确认框上写的那几条改动"和真正落盘的不是同一份。
  const mode = deps.mode ?? 'ask'
  const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const nested = input.patch && typeof input.patch === 'object'
    ? input.patch as Record<string, unknown>
    : null
  const patch: PatchFile | null = nested
    ? {
        ...nested,
        ...(nested.baseFingerprint === undefined && input.baseFingerprint !== undefined
          ? { baseFingerprint: input.baseFingerprint }
          : {}),
        ...(nested.reason === undefined && input.reason !== undefined ? { reason: input.reason } : {}),
      } as PatchFile
    : Array.isArray(input.ops)
      ? {
          ...(input.baseFingerprint === undefined ? {} : { baseFingerprint: input.baseFingerprint as string }),
          ...(input.reason === undefined ? {} : { reason: input.reason as string }),
          ops: input.ops as PatchFile['ops'],
        }
      : null
  if (!patch || !Array.isArray(patch.ops) || patch.ops.length === 0) {
    return failed(callId, 'patch', 'E_PARAM_INVALID', 'patch 必须包含非空的 ops 数组（放在 patch.ops 里）')
  }
  if (typeof patch.baseFingerprint !== 'string') {
    return failed(
      callId,
      'patch',
      'E_PARAM_INVALID',
      'patch 必须带 baseFingerprint：它应当等于本轮上下文里 project.editFingerprint',
    )
  }

  const actual = await projectEditFingerprint(project)
  if (patch.baseFingerprint !== actual) {
    return failed(
      callId,
      'patch',
      'E_PATCH_BASE_MISMATCH',
      `补丁基线不匹配：当前工程是 ${actual}，补丁写的是 ${patch.baseFingerprint}。请重新读取当前工程再改`,
      { evidence: [{ kind: 'project', ref: project.projectId ?? 'unsaved' }] },
    )
  }

  // 预演与写入共用同一补丁核，但 dry-run 永远停在内存结果，不进入确认或写回。
  const dryRun = input.dryRun === true
  const result = dryRun ? applyPatch(project, patch) : await applyPatchGuarded(project, patch)
  if (!result.ok) {
    /*
     * 这里只有一种可能：**某条 op 自己落不下去**（引用不存在、端口不存在、类型不兼容、
     * 成环、参数非法、子空间路径不存在）。整图 L1 的问题不再走这条路 ——
     * 它们进 data.l1Issues，作为"现状"交给模型，而不是当成"这次改动失败了"。
     */
    const first = result.rejections[0]
    return failed(callId, 'patch', first?.code ?? 'E_PARAM_INVALID', first?.message ?? '补丁被拒绝', {
      data: { rejections: result.rejections, changes: result.changes },
      evidence: [{ kind: 'project', ref: project.projectId ?? 'unsaved' }],
    })
  }

  const displayChanges = humanizePatch(project, patch, result.project)
  const l1 = (result.validation?.errors ?? []).map((issue) => ({ code: issue.code, message: issue.message, nodeId: issue.nodeId }))
  const warnings = (result.validation?.warnings ?? []).map((issue) => ({ code: issue.code, message: issue.message, nodeId: issue.nodeId }))
  if (dryRun) {
    return {
      toolPayloadVersion: 1,
      callId,
      tool: 'patch',
      ok: true,
      status: 'done',
      data: {
        changes: displayChanges,
        diff: shortDiff(result.diff),
        l1Issues: l1,
        l1Warnings: warnings,
        incomplete: result.incomplete,
        dryRun: true,
        note: '这是内存预演结果；没有弹出确认，也没有写回工程。',
      },
      evidence: [{ kind: 'diff', ref: `patch:${callId}` }, { kind: 'project', ref: project.projectId ?? 'unsaved' }],
    }
  }
  const summary = displayChanges.join('；') || '没有结构变化'
  const risk = patchRisk(project, patch)
  const question = [
    `AI 想修改当前工程：${summary}`,
    ...(risk === 'destructive' ? ['这一步会动到已有的表达（删块/删数据集/覆盖代码/断开跨组连线）。'] : []),
    '',
    '确认后会写回画布；取消则只保留提案。',
  ].join('\n')
  /*
   * 确认只由 `shouldConfirmWrite` 一处说了算：`ask` 每次都问，`smart` 只问破坏性动作，
   * `full` 在这里**一个弹窗都不弹**。放进来的改动仍然算数：基线在上一段已经复核过，
   * 落下去的每一笔都进 `patches:` 反向动作，消息卡上还有"撤销此次改动"。
   * 源码写不出现在这条路上 —— 它在 `ChatPanel` 的 `sciviz_code` 分支里，永远要人点头。
   */
  if (shouldConfirmWrite(mode, risk) && !deps.confirm(question)) {
    return {
      toolPayloadVersion: 1,
      callId,
      tool: 'patch',
      ok: false,
      status: 'rejected',
      error: { code: 'E_PARAM_INVALID', message: '用户取消应用补丁' },
      data: { changes: displayChanges, diff: shortDiff(result.diff) },
      evidence: [{ kind: 'diff', ref: `patch:${callId}` }],
    }
  }

  const written = deps.write(result.project, patch, result)
  if (!written.ok) {
    return failed(callId, 'patch', 'E_EXECUTION_FAILED', written.error ?? '补丁写回画布失败')
  }

  return {
    toolPayloadVersion: 1,
    callId,
    tool: 'patch',
    ok: true,
    status: 'done',
    data: {
      changes: displayChanges,
      diff: shortDiff(result.diff),
      // 现状，不是这次改动的失败原因：用户会把半截实验与子空间留在画布上
      l1Issues: l1,
      l1Warnings: warnings,
      incomplete: result.incomplete,
      // 这一笔是怎么落下去的：人点过头，还是按档位直接落。汇报里要能分辨这两件事。
      appliedWith: shouldConfirmWrite(mode, risk) ? 'user-confirm' : 'auto',
      note:
        l1.length > 0
          ? '上面这些是改完之后**仍然存在**的静态校验问题，不阻断本次改动；要处理它们请另开一批 op'
          : undefined,
    },
    evidence: [{ kind: 'diff', ref: `patch:${callId}` }, { kind: 'project', ref: result.project.projectId ?? 'unsaved' }],
  }
}

/** 撤销最近一次有记录的改动。同样先复核基线 —— 撤销也是一次写入 */
export async function runGraphUndo(
  project: Project,
  args: unknown,
  callId: string,
  deps: GraphUndoDeps,
): Promise<ClientToolResult> {
  const mode = deps.mode ?? 'ask'
  const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  if (typeof input.baseFingerprint !== 'string') {
    return failed(callId, 'undo', 'E_PARAM_INVALID', 'undo 必须带当前 editFingerprint 基线')
  }
  const actual = await projectEditFingerprint(project)
  if (input.baseFingerprint !== actual) {
    return failed(callId, 'undo', 'E_PATCH_BASE_MISMATCH', `撤销前工程已经变化（当前 ${actual}），请重新读取当前工程`)
  }
  if (shouldConfirmWrite(mode) && !deps.confirm('AI 请求撤销最近一次工程改动，是否继续？')) {
    return {
      toolPayloadVersion: 1,
      callId,
      tool: 'undo',
      ok: false,
      status: 'rejected',
      error: { code: 'E_PARAM_INVALID', message: '用户取消撤销' },
      evidence: [],
    }
  }
  const result = await deps.undo()
  if (!result.ok) return failed(callId, 'undo', 'E_EXECUTION_FAILED', result.error ?? '撤销失败')
  return {
    toolPayloadVersion: 1,
    callId,
    tool: 'undo',
    ok: true,
    status: 'done',
    data: { changes: result.changes ?? [] },
    evidence: [{ kind: 'project', ref: project.projectId ?? 'unsaved' }],
  }
}

/** 写回用的工程文本。放在这里，是为了让"补丁 → 文本"这一步在测试里也走同一段 */
export function projectTextAfterPatch(project: Project): string {
  return projectToText(project)
}
