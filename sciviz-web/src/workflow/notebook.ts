/**
 * 实验笔记：一份 Markdown 正文 + 从标题生成的大纲 + 一个够用的渲染器。
 *
 * ## 为什么记录不放在画布上
 *
 * 便签曾经是画布上的第四种批注。用起来之后病根很清楚：**画布是二维且会被占满的，
 * 而记录是一维的** —— 便签一多，画布就被文字占满，于是"缩小看不清内容、放大看不全结构"。
 * 记录回到它该在的地方（一列可搜索、可折叠、可复制的文本），画布只留结构与大件。
 *
 * ## 为什么自己写渲染器而不引一个库
 *
 * 要的就那么几样：标题、段落、列表、代码块、强调、链接、图片、节点引用。引一个完整
 * Markdown 库会带来一堆用不到的语法（表格、脚注、HTML 内联…），而**内联 HTML 恰恰是
 * 工程文件里最不该执行的东西**（笔记内容会跟着 `.sciviz` 在人与人之间传递）。
 * 这里的渲染器只认白名单，且**一切文本都先转义**。
 *
 * 节点引用写成 `@[显示名](node:节点id)`：点它，画布就聚焦到那个块。节点被删了也不报错，
 * 只是显示成灰色 —— 笔记是历史记录，不该因为图改了就读不出来。
 */

export interface OutlineItem {
  level: number
  title: string
  /** 在原文里的字符下标：点大纲跳过去要用它 */
  offset: number
}

/** 从标题生成大纲（在代码块里的 # 不算标题） */
export function notebookOutline(markdown: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let offset = 0
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const trimmed = line.trimStart()
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (trimmed.startsWith(fence)) fence = null
      offset += line.length + 1
      continue
    }
    if (fence === null) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
      if (heading) items.push({ level: heading[1].length, title: heading[2].trim(), offset })
    }
    offset += line.length + 1
  }
  return items
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 只放行看得懂的地址：图片允许 data:/http(s)，链接与引用只允许 http(s) 与 node: */
function safeUrl(url: string, allowImage: boolean): string | null {
  const value = url.trim()
  if (allowImage && /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/i.test(value)) return value
  if (/^https?:\/\//i.test(value)) return value
  if (!allowImage && /^node:/i.test(value)) return value
  return null
}

/**
 * 行内格式。顺序要紧：**先转义再替换标记**，否则 `&lt;` 里的 `&` 会被第二次处理。
 * 代码段（`x`）先抽出来占位，避免里面的 `*` 被当成强调。
 */
function inline(text: string, nodeLabel: (id: string) => string | null): string {
  const codes: string[] = []
  let work = escapeHtml(text).replace(/`([^`]+)`/g, (_all, code: string) => {
    codes.push(code)
    return `\u0000code${codes.length - 1}\u0000`
  })

  // 图片：![alt](src)
  work = work.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt: string, url: string) => {
    const href = safeUrl(url, true)
    return href ? `<img class="nb-img" src="${href}" alt="${alt}" />` : all
  })
  // 节点引用：@[名字](node:id)
  work = work.replace(/@\[([^\]]*)\]\(node:([^)\s]+)\)/g, (_all, label: string, id: string) => {
    const alive = nodeLabel(id)
    const name = label || alive || id
    return alive === null
      ? `<span class="nb-node gone" title="这个块已经不在图里了">${name}</span>`
      : `<button type="button" class="nb-node" data-node="${id}">${name}</button>`
  })
  // 普通链接
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label: string, url: string) => {
    const href = safeUrl(url, false)
    return href ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>` : all
  })
  work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  work = work.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  work = work.replace(/~~([^~]+)~~/g, '<del>$1</del>')

  return work.replace(/\u0000code(\d+)\u0000/g, (_all, index: string) => `<code>${codes[Number(index)]}</code>`)
}

/**
 * 渲染成 HTML。`nodeLabel` 用来判断引用的块还在不在（返回 null = 已经删了）。
 *
 * 输出是**受控 HTML**：文本全部转义，只生成白名单里的标签，属性只有 src/href/data-node/alt。
 * 调用方直接 dangerouslySetInnerHTML 是安全的 —— 但调用方不该自己再拼任何东西进来。
 */
export function renderNotebook(markdown: string, nodeLabel: (id: string) => string | null): string {
  const lines = markdown.split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let fence: string | null = null
  let code: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    html.push(`<p>${paragraph.map((line) => inline(line, nodeLabel)).join('<br />')}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (!list) return
    const tag = list.ordered ? 'ol' : 'ul'
    html.push(`<${tag}>${list.items.map((item) => `<li>${inline(item, nodeLabel)}</li>`).join('')}</${tag}>`)
    list = null
  }

  const tableCells = (line: string): string[] => {
    const trimmed = line.trim()
    const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
    const withoutTail = body.endsWith('|') ? body.slice(0, -1) : body
    return withoutTail.split('|').map((cell) => cell.trim())
  }

  const isTableSeparator = (line: string): boolean => {
    const cells = tableCells(line)
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  }

  const isTableRow = (line: string): boolean => line.includes('|')

  const renderTable = (header: string, rows: string[]): string => {
    const headings = tableCells(header)
    const body = rows.map((row) => tableCells(row))
    const width = headings.length
    const normalized = body.map((cells) => [...cells.slice(0, width), ...Array.from({ length: Math.max(0, width - cells.length) }, () => '')])
    return `<table class="nb-table"><thead><tr>${headings.map((cell) => `<th>${inline(cell, nodeLabel)}</th>`).join('')}</tr></thead><tbody>${normalized.map((cells) => `<tr>${cells.map((cell) => `<td>${inline(cell, nodeLabel)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      if (fence === null) {
        flushParagraph()
        flushList()
        fence = fenceMatch[1][0]
        code = []
      } else {
        html.push(`<pre class="nb-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`)
        fence = null
      }
      continue
    }
    if (fence !== null) {
      code.push(line)
      continue
    }

    const trimmed = line.trim()
    if (trimmed === '') {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length
      html.push(`<h${level}>${inline(heading[2], nodeLabel)}</h${level}>`)
      continue
    }
    if (lineIndex + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[lineIndex + 1])) {
      flushParagraph()
      flushList()
      const rows: string[] = []
      lineIndex += 2
      while (lineIndex < lines.length && isTableRow(lines[lineIndex]) && lines[lineIndex].trim() !== '') {
        rows.push(lines[lineIndex])
        lineIndex += 1
      }
      html.push(renderTable(line, rows))
      lineIndex -= 1
      continue
    }
    if (/^>\s?/.test(trimmed)) {
      flushParagraph()
      flushList()
      const quote: string[] = []
      while (lineIndex < lines.length) {
        const current = lines[lineIndex].trim()
        if (!/^>\s?/.test(current)) break
        quote.push(current.replace(/^>\s?/, ''))
        lineIndex += 1
      }
      html.push(`<blockquote><p>${quote.map((item) => inline(item, nodeLabel)).join('<br />')}</p></blockquote>`)
      lineIndex -= 1
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph()
      flushList()
      html.push('<hr />')
      continue
    }
    const bullet = /^([-*+])\s+(.*)$/.exec(trimmed)
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = Boolean(numbered)
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push((bullet ? bullet[2] : numbered![2]).trim())
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }
  if (fence !== null) html.push(`<pre class="nb-code"><code>${escapeHtml(code.join('\n'))}</code></pre>`)
  flushParagraph()
  flushList()
  return html.join('\n')
}

/** 插入节点引用时要写的那一段文本（笔记里唯一一种"人和机器都认"的写法） */
export function nodeReference(nodeId: string, label: string): string {
  return `@[${label || nodeId}](node:${nodeId})`
}

/** 字数：按去空白后的字符数算。中文一个字符一个字，比按空格切词靠谱 */
export function notebookLength(markdown: string): number {
  return markdown.replace(/\s+/g, '').length
}
