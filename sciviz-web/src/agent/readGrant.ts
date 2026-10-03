/**
 * 「允许 AI 读取块内代码」这条授权按**工程**记住。
 *
 * 为什么要有这个文件：授权本身是必须的（代码正文属于要用户点头才出本机的东西），
 * 但"每次、每块各弹一次确认"在实测里只产生摩擦 —— 模型被拦下之后只能停下说
 * "我读不到代码"，用户得回输入区勾一次开关再补一句"继续"，两个来回换来的是
 * 他刚刚已经点过头的同一件事。所以授权改成"一次点头、本工程记住"，
 * 撤销入口就是输入区那个开关本身。
 *
 * 纯逻辑、无 IO：localStorage 由调用方以 `GrantStore` 注入（与 `projectFile.ts`
 * 的草稿身份同一套写法），这样这条判定能在 `node --test` 里直接跑。
 */

/** 浏览器 localStorage 里那一个键；只存工程 id，不存任何内容。 */
export const READ_CODE_GRANT_KEY = 'sciviz.chat.readCodeGrant'
/** 只保存显式关闭的工程；空名单表示全工作区读取默认开放。 */
export const BLOCK_CODE_EGRESS_KEY = 'sciviz.chat.blockCodeEgress'

/**
 * 「允许 AI 读取运行结果行值」这条授权，同样**按工程**记住。
 *
 * 与代码那份的区别只有默认值：代码默认开放（关掉才拒），行值默认关闭 ——
 * 数据行出了本机撤不回来，第一次必须由人点头。但"每一页都问一遍"同样只产生摩擦：
 * 模型读一张表的四页，人就点四次头，换来的是同一件事。所以改成"首次点头即在本工程记住"，
 * 撤销入口是输入区那个开关。**「请求批准」档不记**，那一档的语义就是"每次先问我"。
 */
export const ROW_GRANT_KEY = 'sciviz.chat.rowGrant'

export interface GrantStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** 与草稿身份同一套判据：只认长得像工程 id 的串，别的一律当没授权。 */
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** 授权名单的上限。工程开得再多，这条记录也不该无限长。 */
const MAX_GRANTS = 200

/** 解析出已授权的工程 id 名单（去重、排序，坏值直接丢掉而不是整串作废）。 */
export function parseReadCodeGrant(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const item of raw.split(',')) {
    const id = item.trim()
    if (PROJECT_ID.test(id)) seen.add(id)
  }
  return [...seen].sort().slice(-MAX_GRANTS)
}

export function serializeReadCodeGrant(ids: readonly string[]): string {
  return [...new Set(ids.filter((id) => PROJECT_ID.test(id)))].sort().slice(-MAX_GRANTS).join(',')
}

export function hasReadCodeGrant(raw: string | null | undefined, projectId: string): boolean {
  return parseReadCodeGrant(raw).includes(projectId)
}

/** 加一条或去一条授权，返回写回存储的字符串。`allow=false` 就是撤销。 */
export function withReadCodeGrant(raw: string | null | undefined, projectId: string, allow: boolean): string {
  const ids = parseReadCodeGrant(raw)
  const next = allow ? [...ids, projectId] : ids.filter((id) => id !== projectId)
  return serializeReadCodeGrant(next)
}

export function readReadCodeGrant(store: GrantStore | undefined): string {
  if (!store) return ''
  try {
    return store.getItem(READ_CODE_GRANT_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeReadCodeGrant(store: GrantStore | undefined, projectId: string, allow: boolean): void {
  if (!store) return
  try {
    store.setItem(READ_CODE_GRANT_KEY, withReadCodeGrant(readReadCodeGrant(store), projectId, allow))
  } catch {
    // 存储不可用（隐私模式等）：授权仍在本轮内存里生效，只是记不住 —— 不该因此打不开对话栏。
  }
}

export function readBlockedCodeEgress(store: GrantStore | undefined): string {
  if (!store) return ''
  try {
    return store.getItem(BLOCK_CODE_EGRESS_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 代码读取默认开放；只有用户在当前工程显式关闭后才拒绝正文工具。 */
export function codeEgressAllowed(store: GrantStore | undefined, projectId: string): boolean {
  return !parseReadCodeGrant(readBlockedCodeEgress(store)).includes(projectId)
}

export function writeCodeEgressAllowed(store: GrantStore | undefined, projectId: string, allow: boolean): void {
  if (!store) return
  try {
    const ids = parseReadCodeGrant(readBlockedCodeEgress(store))
    const next = allow ? ids.filter((id) => id !== projectId) : [...ids, projectId]
    store.setItem(BLOCK_CODE_EGRESS_KEY, serializeReadCodeGrant(next))
  } catch {
    // localStorage 不可用时沿用当前内存状态，不阻断当前对话。
  }
}

/*
 * 行值授权。两份授权都是"工程 id 的名单"，所以解析/序列化与 `withReadCodeGrant`
 * 共用同一套（名字里带 ReadCode 的那几个）—— 名单语义只有一处实现，另一处只换键。
 */
export function hasRowGrant(raw: string | null | undefined, projectId: string): boolean {
  return hasReadCodeGrant(raw, projectId)
}

/** 加一条或去一条行值授权；`allow=false` 就是撤销。 */
export function withRowGrant(raw: string | null | undefined, projectId: string, allow: boolean): string {
  return withReadCodeGrant(raw, projectId, allow)
}

export function readRowGrant(store: GrantStore | undefined): string {
  if (!store) return ''
  try {
    return store.getItem(ROW_GRANT_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 这个工程有没有行值授权。默认没有 —— 没点头之前，行值不出本机。 */
export function rowEgressAllowed(store: GrantStore | undefined, projectId: string): boolean {
  return hasRowGrant(readRowGrant(store), projectId)
}

export function writeRowEgressAllowed(store: GrantStore | undefined, projectId: string, allow: boolean): void {
  if (!store) return
  try {
    store.setItem(ROW_GRANT_KEY, withRowGrant(readRowGrant(store), projectId, allow))
  } catch {
    // 存储不可用（隐私模式等）：这一轮内存里的点头照样生效，只是记不住。
  }
}
