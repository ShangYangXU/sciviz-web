/**
 * 对话栏的**写入档位**：按工程记住"AI 在工程里改东西要不要先问我"。
 *
 * 为什么要有这个文件：用户的原话是"我每一次让 agent 做改动他都会弹出一个窗口让我确认"。
 * 那是 `window.confirm` —— 每一次图补丁都要点一下。可是这个工作台最正常的用法恰恰是
 * "和 AI 来回改十几次图"，于是十几次弹窗把一次对话切成十几个表单；
 * 模型的节奏也被打断：它每改一次就得停下来等人点头，人不在就整轮卡住。
 *
 * 三档（2026-09-27）：`ask` 每次写都问；`smart` 只问**破坏性图写与源码写**；
 * `full` 工程内的图写与 Markdown 文档写直接落。分界线仍然画在**外发**上，不画在"哪条 op 更危险"上：
 * - **写**（改图）发生在本地，走的是同一条有界动作路径（基线复核 + 反向动作 +
 *   审计 + 固定闸门），所以它可以按档位自动；
 * - **外发**（把块内代码正文、数据行值送给模型）出本机，与档位无关，仍然单独点头
 *   （`readGrant.ts` 与对话栏设计 §3.2 / §6.1）。
 * 把这两件事混在一个开关里，就会出现"为了少点几下，连代码外发也一起默认开了"。
 *
 * **两条基线不随档位放宽**（用户原话："一开始定义的一些很基本的 … 修改别的本地的一些
 * 非项目的内容，或者修改源代码这种不行"）：
 * 1. 源码写在最高档拒绝，在较低两档逐次确认；工作区内纯 `.md` 文档单独归类；
 * 2. 工程之外的路径由围栏拒绝（`E_CODE_PATH_OUTSIDE`），档位不提供"越过围栏"这一项。
 *
 * 与 `readGrant.ts` 同一套写法：纯逻辑、无 IO，localStorage 由调用方注入，
 * 因此这条判定能直接在 `node --test` 里跑。
 */

import type { GrantStore } from './readGrant'

export type { GrantStore }

/** 浏览器 localStorage 里那一个键；只存"工程 id = 档位"，不存任何工程内容。 */
export const WRITE_MODE_KEY = 'sciviz.chat.writeMode'

/**
 * `ask` 每次写都先问；`smart` 只问破坏性图写与源码写；`full` 工程内的图写与 Markdown 文档写直接落
 * （审计、反向动作与闸门照旧，源码写仍拒绝）。
 */
export type WriteMode = 'ask' | 'smart' | 'full'

/**
 * 这一次要落的是哪一类写。判定它的是纯函数（图写在 `agent/graphTools.ts`，
 * 文档/源码写按 CLI-11 计划路径分类），档位只决定"这类写要不要问"。
 */
export type WriteRisk = 'normal' | 'destructive' | 'documentation' | 'source'

/**
 * 默认 `full`。这是产品判断，不是实现细节：
 * 一次"让 AI 把这张图搭起来"的对话不该需要人守在旁边点十几次确认。
 * 想要更保守的工程，在输入区往上切一档即可，选择按工程记住。
 */
export const DEFAULT_WRITE_MODE: WriteMode = 'full'

export const WRITE_MODES: readonly WriteMode[] = ['full', 'smart', 'ask']

/**
 * 2026-09-22 那两档写进过用户机器的 localStorage（`auto` / `propose`），
 * 读到就按当时的含义认：`auto` 是"不问"，`propose` 是"每次都问"。
 */
const LEGACY_WRITE_MODES: Readonly<Record<string, WriteMode>> = { auto: 'full', propose: 'ask' }

/** 与草稿身份同一套判据：只认长得像工程 id 的串，别的一律当没记过。 */
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** 记录条数的上限。工程开得再多，这条也不该无限长。 */
const MAX_ENTRIES = 200

/** 解析 `id=mode,id=mode`。坏条目直接丢掉，不让一条坏值把整串作废。 */
export function parseWriteModes(raw: string | null | undefined): Map<string, WriteMode> {
  const modes = new Map<string, WriteMode>()
  if (!raw) return modes
  for (const item of raw.split(',')) {
    const [id, mode] = item.split('=')
    const key = (id ?? '').trim()
    const value = normalizeWriteMode((mode ?? '').trim())
    if (!PROJECT_ID.test(key)) continue
    if (!value) continue
    modes.set(key, value)
  }
  // 超上限时丢最早的那些（Map 保持插入顺序）
  while (modes.size > MAX_ENTRIES) {
    const oldest = modes.keys().next()
    if (oldest.done) break
    modes.delete(oldest.value)
  }
  return modes
}

/** 档位的唯一解析处：新值直接认，旧值按 2026-09-22 的含义迁移，别的当没写。 */
function normalizeWriteMode(raw: string): WriteMode | null {
  if (raw === 'ask' || raw === 'smart' || raw === 'full') return raw
  return LEGACY_WRITE_MODES[raw] ?? null
}

/** 与 `parseWriteModes` 互为逆运算；默认档不落盘，让"没记过"和"记成默认"是同一种状态。 */
export function serializeWriteModes(modes: ReadonlyMap<string, WriteMode>): string {
  return [...modes.entries()]
    .filter(([id, mode]) => PROJECT_ID.test(id) && mode !== DEFAULT_WRITE_MODE)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-MAX_ENTRIES)
    .map(([id, mode]) => `${id}=${mode}`)
    .join(',')
}

/** 这个工程该用哪一档。没记过就是默认档 —— 调用方不该自己再判一次默认值。 */
export function writeModeFor(raw: string | null | undefined, projectId: string): WriteMode {
  return parseWriteModes(raw).get(projectId) ?? DEFAULT_WRITE_MODE
}

/** 改一个工程的档位，返回写回存储的字符串。切回默认档就是删掉这条记录。 */
export function withWriteMode(
  raw: string | null | undefined,
  projectId: string,
  mode: WriteMode,
): string {
  const modes = parseWriteModes(raw)
  if (!PROJECT_ID.test(projectId)) return serializeWriteModes(modes)
  if (mode === DEFAULT_WRITE_MODE) modes.delete(projectId)
  else modes.set(projectId, mode)
  return serializeWriteModes(modes)
}

/**
 * 这一档要不要在写之前弹确认。
 *
 * 单独抽成函数，是为了让"要不要问"这件事只有一个判据：散在组件里各写一遍，
 * 早晚会有一处写反，而写反的表现是**静默地不问**。
 *
 * 判定只有一处（`decideWrite`）：**完全没有"该问却没人可问"的档位** ——
 * 「完全访问权限」下源码写是**拒绝**（不是弹窗），因为它不在这一档放宽的范围内。
 */
export type WriteDecision = 'apply' | 'confirm' | 'refuse'

/**
 * (档位, 动作类型) → 落 / 问 / 拒，唯一判定处。
 *
 * 「完全访问权限」的含义是**不再问人**，所以它不可能对任何东西返回 `confirm`：
 * 工程内的图写与 Markdown 文档写直接落；源码写越出了这一档的范围，于是 `refuse`（模型会收到一条明确的拒绝，
 * 由它去请人换档），工程之外的路径由围栏拒绝。
 */
export function decideWrite(mode: WriteMode, risk: WriteRisk = 'normal'): WriteDecision {
  if (risk === 'source') return mode === 'full' ? 'refuse' : 'confirm'
  if (mode === 'ask') return 'confirm'
  if (mode === 'smart') return risk === 'destructive' ? 'confirm' : 'apply'
  return 'apply'
}

/** 仅当计划内的每个写操作都是同路径的工作区相对 `.md` 文件时才归为文档写。 */
export function isMarkdownOnlyCodePlan(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const plan = value as { operations?: unknown; files?: unknown }
  if (!Array.isArray(plan.operations) || !Array.isArray(plan.files) || plan.operations.length === 0 || plan.operations.length !== plan.files.length) return false
  const safeMarkdownPath = (candidate: unknown): string | null => {
    if (typeof candidate !== 'string' || !candidate.trim()) return null
    const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '')
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
    const segments = normalized.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
    return normalized.toLowerCase().endsWith('.md') ? normalized : null
  }
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index]
    const file = plan.files[index]
    if (!operation || typeof operation !== 'object' || !file || typeof file !== 'object') return false
    const operationPath = safeMarkdownPath((operation as { path?: unknown }).path)
    const filePath = safeMarkdownPath((file as { path?: unknown }).path)
    if (!operationPath || operationPath !== filePath) return false
  }
  return true
}

export function shouldConfirmWrite(mode: WriteMode, risk: WriteRisk = 'normal'): boolean {
  return decideWrite(mode, risk) === 'confirm'
}

/**
 * 行值外发要不要弹确认。
 *
 * 最高档同样**不问**（"一点弹窗都出不来"），行值按开关算；其余档沿用"首次点头、本工程记住"，
 * 「请求批准」档每次都问。
 */
export function shouldConfirmRowEgress(mode: WriteMode, granted: boolean): boolean {
  if (mode === 'full') return false
  return !granted || mode === 'ask'
}

/** 这一档下行值到底允不允许：最高档默认允许，其余档要**点头过**才算。 */
export function rowEgressGranted(mode: WriteMode, granted: boolean): boolean {
  return mode === 'full' || granted
}

export function readWriteMode(store: GrantStore | undefined, projectId: string): WriteMode {
  if (!store) return DEFAULT_WRITE_MODE
  try {
    return writeModeFor(store.getItem(WRITE_MODE_KEY), projectId)
  } catch {
    return DEFAULT_WRITE_MODE
  }
}

export function writeWriteMode(store: GrantStore | undefined, projectId: string, mode: WriteMode): void {
  if (!store) return
  try {
    store.setItem(WRITE_MODE_KEY, withWriteMode(store.getItem(WRITE_MODE_KEY), projectId, mode))
  } catch {
    // 存储不可用（隐私模式等）：这一轮内存里的选择照样生效，只是记不住 —— 不该因此打不开对话栏。
  }
}
