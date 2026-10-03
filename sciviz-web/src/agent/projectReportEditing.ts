import type { ProjectReport } from '../workflow/project'

const EMBEDDED_IMAGE_URL = /data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+/gi
const REPORT_IMAGE_REFERENCE = /report-figure:([0-9a-f]{64})/gi

async function sha256DataUrl(dataUrl: string): Promise<string> {
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || typeof globalThis.atob !== 'function' || !globalThis.crypto?.subtle) {
    throw new Error('当前环境无法安全读取报告图片；未修改原报告')
  }
  const binary = globalThis.atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function imageMap(markdown: string): Promise<Map<string, string>> {
  const images = [...markdown.matchAll(EMBEDDED_IMAGE_URL)].map((match) => match[0])
  const result = new Map<string, string>()
  for (const dataUrl of images) result.set(await sha256DataUrl(dataUrl), dataUrl)
  return result
}

/** Replace image pixels with stable references before a project report is sent to a model. */
export async function projectReportMarkdownForModel(markdown: string): Promise<string> {
  const images = await imageMap(markdown)
  return markdown.replace(EMBEDDED_IMAGE_URL, (dataUrl) => {
    for (const [sha256, original] of images) {
      if (original === dataUrl) return `report-figure:${sha256}`
    }
    return dataUrl
  })
}

/** Restore only images that already belong to this report; unknown image refs fail closed. */
export async function materializeExistingProjectReportImages(
  report: ProjectReport,
  markdown: string,
): Promise<{ markdown: string; figures: ProjectReport['figures'] }> {
  const images = await imageMap(report.markdown)
  const references = [...markdown.matchAll(REPORT_IMAGE_REFERENCE)].map((match) => match[1].toLowerCase())
  const referenced = new Set(references)
  for (const sha256 of referenced) {
    if (!images.has(sha256)) {
      throw new Error(`报告图像 ${sha256.slice(0, 12)} 不属于当前报告；为避免丢图，本次没有写回。`)
    }
  }
  const originalReferences = new Set(images.keys())
  const referencesToKeep = new Set([...referenced, ...originalReferences])
  const restored = markdown.replace(REPORT_IMAGE_REFERENCE, (_reference, sha256: string) => images.get(sha256.toLowerCase())!)
  const markdownWithoutOrphanSources = restored.split('\n').filter((line) => {
    const source = line.match(/^\*图源：.*SHA-256 `([0-9a-f]{64})`。?\*$/i)
    return !source || referencesToKeep.has(source[1].toLowerCase())
  }).join('\n')
  const omittedImages = [...originalReferences].filter((sha256) => !referenced.has(sha256))
  const preservedImageSection = omittedImages.map((sha256) => {
    const sourceLine = report.markdown.split('\n').find((line) => line.includes(`SHA-256 \`${sha256}\``))
    const caption = report.figures.find((figure) => figure.sha256.toLowerCase() === sha256)?.caption || '原报告图片'
    return [`![${caption}](${images.get(sha256)})`, ...(sourceLine && !markdownWithoutOrphanSources.includes(sourceLine) ? [sourceLine] : [])].join('\n')
  }).join('\n\n')
  const withPreservedImages = preservedImageSection
    ? `${markdownWithoutOrphanSources.trimEnd()}\n\n## 原报告图片\n\n${preservedImageSection}\n`
    : markdownWithoutOrphanSources
  return {
    markdown: withPreservedImages,
    figures: report.figures,
  }
}

/** A request to rewrite a named Markdown/report target means update-in-place by default. */
export function isExistingMarkdownEditRequest(text: string): boolean {
  const positiveEditText = text.replace(/(?:不要|别|不能|不必|不需要|无需|禁止|拒绝|并非|不是|不应(?:该)?)\s*(?:再)?\s*(?:重写|改写|修改|修订|润色|精简|改短|压缩|更新|替换|覆盖|rewrite|revise|edit|polish|shorten|update)(?:[^，,。；;\n]{0,18})/gi, '')
  const target = /报告|文档|文件|markdown|\.md\b|report|document|file|原文|原来|现有|已有|这份|这篇|上面|之前|它/i.test(text)
  const directEdit = /(?:修改|更新|替换|覆盖|edit|update).{0,4}(?:报告|文档|文件|markdown|\.md\b|原文|原来|现有|已有|这份|这篇|它)|(?:报告|文档|文件|markdown|\.md\b|原文|原来|现有|已有|这份|这篇|它).{0,4}(?:修改|更新|替换|覆盖|edit|update)/i.test(positiveEditText)
  const strongEdit = /重写|改写|修订|润色|精简|改短|压缩|rewrite|revise|polish|shorten/i.test(positiveEditText)
  const edits = directEdit || strongEdit
  const positiveCreationText = text.replace(/(?:不要|别|不能|不必|不需要|无需|禁止|拒绝|并非|不是|不应(?:该)?)\s*(?:再)?\s*(?:新建|创建|另建|另写|另存为|create)(?:[^，,。；;\n]{0,18})/gi, '')
  const explicitCreate = /另存为|另写(?:一份|一个)?(?:新)?(?:报告|文档|文件)|(?:新建|创建|另建)(?:一份|一个)?(?:新的)?(?:项目|实验)?(?:报告|文档|文件|markdown|md\s*(?:文件|文档)?|\.md)|create\s+(?:a\s+)?new\s+(?:report|document|file|markdown)/i.test(positiveCreationText)
  return edits && target && !explicitCreate
}
