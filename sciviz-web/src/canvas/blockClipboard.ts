import type { ClipboardPayload } from '../workflow/clipboard'

/**
 * 画布块的剪贴板：**传输**那一层。
 *
 * 载荷怎么算（哪些块、哪些连线、批注挂到哪一层）全在 `workflow/clipboard.ts`，那里是纯逻辑、
 * `node --test` 直接跑。这里只回答一个 DOM 侧的问题：**怎么把它放上系统剪贴板、怎么取回来**。
 *
 * 载荷以 JSON 文本走系统剪贴板，因此"在一个标签页里复制、在另一个标签页里粘"天然成立，
 * 界面也不必去猜剪贴板里这堆字是不是我们的（认 marker）。
 *
 * ## 为什么还要留一份内存副本
 *
 * 两种情况写不进系统剪贴板：内容太大（见 `CLIPBOARD_TEXT_LIMIT`），或者浏览器不给写
 * （非安全上下文、权限被拒）。这时候如果什么都不做，用户按下 Ctrl+C 会看到"复制成功"
 * 却粘不出来 —— 那比明说"复制不了"更糟。所以在内存里留一份，`memoryOnly` 标记它。
 *
 * 标记而不是"总是用内存"是有意的：拿内存兜底一切，就会出现"我刚才复制的明明是别的文字，
 * 怎么粘出来一堆块"。只有这条路径是明确的例外。
 */

interface RememberedPayload {
  payload: ClipboardPayload
  /** true = 上一次复制**没有**进系统剪贴板，粘贴时应当优先用这份内存副本 */
  memoryOnly: boolean
}

let remembered: RememberedPayload | null = null

export function rememberClipboardPayload(payload: ClipboardPayload, memoryOnly: boolean): void {
  remembered = { payload, memoryOnly }
}

/** 上一次复制留下的载荷；跨标签页、跨会话时这里会是 null（那时只能靠剪贴板文本） */
export function memoryClipboardPayload(): RememberedPayload | null {
  return remembered
}

/** 写系统剪贴板。写不进去返回 false —— 调用方据此把内存副本标成 `memoryOnly`。 */
export async function writeSystemClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 读系统剪贴板文本。读不到（权限、非安全上下文、里面不是文本）返回 null。 */
export async function readSystemClipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}
