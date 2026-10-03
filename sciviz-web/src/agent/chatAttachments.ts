import type { ModelContent, ModelImagePart, ModelMessage } from './modelContext'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

export const CHAT_ATTACHMENT_LIMITS = {
  maxAttachments: 10,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
  maxVisualParts: 8,
  maxImageDimension: 1600,
  maxPdfPages: 100,
  maxPdfTextChars: 60_000,
  maxPdfVisualPages: 8,
} as const

export interface ChatAttachmentSummary {
  id: string
  name: string
  kind: 'image' | 'pdf'
  mimeType: string
  size: number
  sha256: string
  width?: number
  height?: number
  pageCount?: number
  renderedPages?: number[]
  omittedVisualPages?: number
  textTruncated?: boolean
}

export interface ChatAttachmentVisual {
  dataUrl: string
  sha256: string
  pageNumber?: number
}

export interface ChatFigureVisualAudit {
  dataUrl: string
  label: string
  sha256: string
  width: number
  height: number
}

export interface ChatAttachment extends ChatAttachmentSummary {
  previewDataUrl: string
  extractedText?: string
  visualParts: ChatAttachmentVisual[]
}

export function summarizeChatAttachment(attachment: ChatAttachment): ChatAttachmentSummary {
  const { id, name, kind, mimeType, size, sha256, width, height, pageCount, renderedPages, omittedVisualPages, textTruncated } = attachment
  return { id, name, kind, mimeType, size, sha256, width, height, pageCount, renderedPages, omittedVisualPages, textTruncated }
}

export function formatAttachmentLabel(attachment: ChatAttachmentSummary): string {
  const size = formatByteSize(attachment.size)
  if (attachment.kind === 'pdf') {
    const pages = attachment.pageCount === undefined ? '页数未知' : `${attachment.pageCount} 页`
    const visual = attachment.renderedPages?.length ? ` · 已附视觉页 ${attachment.renderedPages.join(', ')}` : ''
    const omitted = attachment.omittedVisualPages ? ` · 另有 ${attachment.omittedVisualPages} 页未渲染` : ''
    const text = attachment.textTruncated ? ' · 文字已截到 60,000 字符' : ''
    return `${attachment.name} · PDF · ${pages} · ${size}${visual}${omitted}${text}`
  }
  return `${attachment.name} · 图片 · ${size}`
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileKind(file: File): 'image' | 'pdf' | null {
  const mime = file.type.toLowerCase()
  const extension = file.name.toLowerCase().split('.').pop() ?? ''
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (mime === 'image/svg+xml') return null
  if (mime.startsWith('image/')) return 'image'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff'].includes(extension)) return 'image'
  return null
}

export function chatAttachmentFileKind(file: File): 'image' | 'pdf' | null {
  return fileKind(file)
}

async function sha256(value: ArrayBuffer | Blob): Promise<string> {
  const bytes = value instanceof Blob ? await value.arrayBuffer() : value
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('')
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('浏览器无法读取附件'))
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('附件预览格式无效'))
    reader.readAsDataURL(blob)
  })
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器无法压缩这张图片')), 'image/jpeg', quality)
  })
}

async function compressedImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('图片无法解码；请换成 PNG、JPEG 或 WebP 图片')
  }
  try {
    const scale = Math.min(1, CHAT_ATTACHMENT_LIMITS.maxImageDimension / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法准备图片预览')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)
    const blob = await canvasBlob(canvas, 0.86)
    return { blob, width, height }
  } finally {
    bitmap.close()
  }
}

async function prepareImage(file: File): Promise<ChatAttachment> {
  const source = await file.arrayBuffer()
  const image = await compressedImage(file)
  const dataUrl = await blobToDataUrl(image.blob)
  const sourceHash = await sha256(source)
  const visualHash = await sha256(image.blob)
  return {
    id: `att-${crypto.randomUUID()}`,
    name: file.name,
    kind: 'image',
    mimeType: file.type || 'image/*',
    size: file.size,
    sha256: sourceHash,
    width: image.width,
    height: image.height,
    previewDataUrl: dataUrl,
    visualParts: [{ dataUrl, sha256: visualHash }],
  }
}

async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  return pdfjs
}

async function preparePdf(file: File, visualPageBudget: number): Promise<ChatAttachment> {
  const source = await file.arrayBuffer()
  const sourceHash = await sha256(source)
  const pdfjs = await loadPdfJs()
  let documentProxy: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | null = null
  try {
    documentProxy = await pdfjs.getDocument({ data: new Uint8Array(source) }).promise
  } catch (error) {
    const message = error instanceof Error && /password|encrypt/i.test(error.message)
      ? 'PDF 已加密；请先移除密码后再附加'
      : 'PDF 无法读取；请确认文件完整且未损坏'
    throw new Error(message)
  }

  try {
    const pageCount = documentProxy.numPages
    if (!pageCount) throw new Error('PDF 没有可读取的页面')
    if (pageCount > CHAT_ATTACHMENT_LIMITS.maxPdfPages) {
      throw new Error(`PDF 共 ${pageCount} 页，当前上限为 ${CHAT_ATTACHMENT_LIMITS.maxPdfPages} 页`)
    }

    const textPages: string[] = []
    const visualParts: ChatAttachmentVisual[] = []
    let textLength = 0
    let textTruncated = false
    let hasExtractableText = false
    const renderCount = Math.min(
      pageCount,
      CHAT_ATTACHMENT_LIMITS.maxPdfVisualPages,
      Math.max(0, visualPageBudget),
    )
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await documentProxy.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const pageText = textContent.items
        .map((item) => 'str' in item ? item.str : '')
        .filter(Boolean)
        .join(' ')
      const pagePrefix = `\n[第 ${pageNumber} 页]\n`
      if (pageText.trim()) hasExtractableText = true
      const available = CHAT_ATTACHMENT_LIMITS.maxPdfTextChars - textLength
      if (available > pagePrefix.length) {
        const excerpt = pageText.slice(0, Math.max(0, available - pagePrefix.length))
        if (excerpt.length < pageText.length) textTruncated = true
        textPages.push(`${pagePrefix}${excerpt}`)
        textLength += pagePrefix.length + excerpt.length
      } else if (textLength < CHAT_ATTACHMENT_LIMITS.maxPdfTextChars) {
        textTruncated = true
      }

      if (pageNumber <= renderCount) {
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = Math.min(1.4, CHAT_ATTACHMENT_LIMITS.maxImageDimension / Math.max(baseViewport.width, baseViewport.height))
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(viewport.width))
        canvas.height = Math.max(1, Math.ceil(viewport.height))
        const context = canvas.getContext('2d')
        if (!context) throw new Error('浏览器无法渲染 PDF 页面')
        context.fillStyle = '#fff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvasContext: context, viewport }).promise
        const blob = await canvasBlob(canvas, 0.84)
        visualParts.push({ dataUrl: await blobToDataUrl(blob), sha256: await sha256(blob), pageNumber })
        canvas.width = 0
        canvas.height = 0
      }
      page.cleanup()
      if (textLength >= CHAT_ATTACHMENT_LIMITS.maxPdfTextChars) {
        if (pageNumber < pageCount) textTruncated = true
        if (pageNumber >= renderCount) break
      }
    }

    const extractedText = hasExtractableText ? textPages.join('') : ''
    return {
      id: `att-${crypto.randomUUID()}`,
      name: file.name,
      kind: 'pdf',
      mimeType: 'application/pdf',
      size: file.size,
      sha256: sourceHash,
      pageCount,
      renderedPages: visualParts.flatMap((part) => part.pageNumber === undefined ? [] : [part.pageNumber]),
      omittedVisualPages: Math.max(0, pageCount - visualParts.length),
      textTruncated,
      extractedText,
      previewDataUrl: visualParts[0]?.dataUrl ?? '',
      visualParts,
    }
  } finally {
    await documentProxy.destroy()
  }
}

export async function prepareChatAttachment(file: File, visualPageBudget: number = CHAT_ATTACHMENT_LIMITS.maxPdfVisualPages): Promise<ChatAttachment> {
  if (file.size <= 0) throw new Error('文件为空')
  if (file.size > CHAT_ATTACHMENT_LIMITS.maxFileBytes) throw new Error(`单个附件不能超过 ${formatByteSize(CHAT_ATTACHMENT_LIMITS.maxFileBytes)}`)
  const kind = fileKind(file)
  if (!kind) throw new Error('只支持常见图片与 PDF 文件')
  return kind === 'pdf' ? preparePdf(file, visualPageBudget) : prepareImage(file)
}

export function attachmentModelContent(prompt: string, attachments: readonly ChatAttachment[]): ModelContent {
  const parts: Array<{ type: 'text'; text: string } | ModelImagePart> = []
  if (prompt) parts.push({ type: 'text', text: prompt })
  let visualCount = 0
  for (const attachment of attachments) {
    const metadata = formatAttachmentLabel(summarizeChatAttachment(attachment))
    if (attachment.kind === 'image') {
      parts.push({ type: 'text', text: `[图片附件：${metadata}；SHA-256 ${attachment.sha256}]` })
    } else {
      const noText = attachment.visualParts.length
        ? '\n未能提取到可搜索文字；请查看已附带的页面图像。'
        : '\n未能提取到可搜索文字，且本轮没有可附带的页面图像。'
      parts.push({ type: 'text', text: `[PDF 附件：${metadata}；SHA-256 ${attachment.sha256}]${attachment.extractedText ? `\n${attachment.extractedText}` : noText}` })
    }
    for (const visual of attachment.visualParts) {
      if (visualCount >= CHAT_ATTACHMENT_LIMITS.maxVisualParts) break
      const label = attachment.kind === 'pdf' ? `${attachment.name} 第 ${visual.pageNumber} 页` : attachment.name
      parts.push({ type: 'text', text: `[视觉附件：${label}；SHA-256 ${visual.sha256}]` })
      parts.push({ type: 'image_url', image_url: { url: visual.dataUrl, detail: 'high' } })
      visualCount += 1
    }
  }
  return parts
}

export function auditModelMessages(
  messages: readonly ModelMessage[],
  attachments: readonly ChatAttachment[],
  figureVisuals: readonly ChatFigureVisualAudit[] = [],
): ModelMessage[] {
  const visualByDataUrl = new Map<string, { attachment: ChatAttachment; visual: ChatAttachmentVisual }>()
  for (const attachment of attachments) {
    for (const visual of attachment.visualParts) visualByDataUrl.set(visual.dataUrl, { attachment, visual })
  }
  const figureByDataUrl = new Map(figureVisuals.map((visual) => [visual.dataUrl, visual]))
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    const content = message.content.flatMap((part) => {
      if (part.type !== 'image_url') return [part]
      const figure = figureByDataUrl.get(part.image_url.url)
      if (figure) return [{
        type: 'text' as const,
        text: `[块图像审计标记：${figure.label}；${figure.width}×${figure.height}；SHA-256 ${figure.sha256}]`,
      }]
      const match = visualByDataUrl.get(part.image_url.url)
      if (!match) return [{ type: 'text' as const, text: '[图像附件已省略；SHA-256 未知]' }]
      const { attachment, visual } = match
      const page = visual.pageNumber === undefined ? '' : `，PDF 第 ${visual.pageNumber} 页`
      return [{
        type: 'text' as const,
        text: `[图像附件审计标记：${attachment.name}${page}；源文件 SHA-256 ${attachment.sha256}；传输图像 SHA-256 ${visual.sha256}]`,
      }]
    })
    return { ...message, content }
  })
}
