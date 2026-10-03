import type { ProjectReport, ProjectReportFigure } from './project'

export const MAX_PROJECT_REPORTS = 100
export const MAX_REPORT_TEXT_BYTES = 1024 * 1024
export const MAX_REPORT_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_REPORT_IMAGE_COUNT = 20
export const MAX_REPORT_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024
export const MAX_PROJECT_REPORT_TOTAL_BYTES = 64 * 1024 * 1024

/** The figure capture layer supplies the pixels and provenance; this module only composes the report. */
export interface ReportImage {
  dataUrl: string
  sha256: string
  sourceFingerprintSha256?: string
  width: number
  height: number
  nodeId: string
  groupPath: readonly string[]
  label: string
  runtimeId: string
  portId: string
}

export interface StagedReportImage {
  figure: ReportImage
  caption: string
}

const encoder = new TextEncoder()
const byteLength = (value: string): number => encoder.encode(value).length
const imageDataUrl = /data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+/gi

function imageBytes(dataUrl: string): number {
  if (!/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl)) {
    throw new Error('报告图片必须是内嵌的 PNG、JPEG、GIF 或 WebP')
  }
  return Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4)
}

export function validateReportImages(images: readonly StagedReportImage[]): void {
  if (images.length > MAX_REPORT_IMAGE_COUNT) throw new Error(`每份报告最多保存 ${MAX_REPORT_IMAGE_COUNT} 张图`)
  let total = 0
  for (const { figure } of images) {
    const size = imageBytes(figure.dataUrl)
    if (size > MAX_REPORT_IMAGE_BYTES) throw new Error(`单张报告图片不能超过 ${MAX_REPORT_IMAGE_BYTES / 1024 / 1024} MiB`)
    total += size
  }
  if (total > MAX_REPORT_IMAGE_TOTAL_BYTES) {
    throw new Error(`报告图片总量不能超过 ${MAX_REPORT_IMAGE_TOTAL_BYTES / 1024 / 1024} MiB`)
  }
}

export function validateReportMarkdown(markdown: string): void {
  const images = [...markdown.matchAll(imageDataUrl)].map((match) => match[0])
  if (images.length > MAX_REPORT_IMAGE_COUNT) throw new Error(`每份报告最多保存 ${MAX_REPORT_IMAGE_COUNT} 张内嵌图片`)
  const plain = markdown.replace(imageDataUrl, '')
  if (byteLength(plain) > MAX_REPORT_TEXT_BYTES) throw new Error('报告文字不能超过 1 MiB')
  let total = 0
  for (const image of images) {
    const size = imageBytes(image)
    if (size > MAX_REPORT_IMAGE_BYTES) throw new Error('单张报告图片不能超过 8 MiB')
    total += size
  }
  if (total > MAX_REPORT_IMAGE_TOTAL_BYTES) throw new Error('报告图片总量不能超过 24 MiB')
  if (/report-figure:[0-9a-f]{64}/i.test(markdown)) {
    throw new Error('报告仍有未解析的图像引用，请先采集对应画布图像')
  }
}

export function validateProjectReports(reports: readonly ProjectReport[]): void {
  if (reports.length > MAX_PROJECT_REPORTS) throw new Error(`每份工程最多保存 ${MAX_PROJECT_REPORTS} 份报告`)
  const ids = new Set<string>()
  let total = 0
  for (const report of reports) {
    if (!report.id || ids.has(report.id)) throw new Error('报告 ID 为空或重复')
    ids.add(report.id)
    if (!report.title.trim()) throw new Error('报告标题不能为空')
    validateReportMarkdown(report.markdown)
    total += byteLength(report.markdown) + byteLength(JSON.stringify(report.figures))
  }
  if (total > MAX_PROJECT_REPORT_TOTAL_BYTES) throw new Error('工程内报告总量不能超过 64 MiB')
}

function safeCaption(caption: string): string {
  return caption.replace(/[\r\n\[\]()]/g, ' ').trim().slice(0, 160)
}

export function reportFigureReference(figure: ReportImage, caption = figure.label): string {
  if (!/^[0-9a-f]{64}$/i.test(figure.sha256)) throw new Error('报告图片缺少有效的 SHA-256')
  return `![${safeCaption(caption) || '画布图像'}](report-figure:${figure.sha256.toLowerCase()})`
}

function sourceLine(figure: ReportImage): string {
  const path = figure.groupPath.length > 0 ? figure.groupPath.join(' / ') : '主画布'
  return `*图源：${safeCaption(figure.label) || figure.nodeId}；节点 \`${figure.nodeId}\`；画布路径 \`${path}\`；端口 \`${figure.portId}\`；SHA-256 \`${figure.sha256}\`。*`
}

/** Expand model-visible figure references into portable images, then attach unused captured figures. */
export function materializeReportFigures(
  markdown: string,
  staged: readonly StagedReportImage[],
): { markdown: string; figures: ProjectReportFigure[] } {
  validateReportImages(staged)
  const byHash = new Map(staged.map((item) => [item.figure.sha256.toLowerCase(), item]))
  const used = new Set<string>()
  const explicit = markdown.replace(/!\[([^\]]*)\]\(report-figure:([0-9a-f]{64})\)/gi, (_match, alt: string, hash: string) => {
    const item = byHash.get(hash.toLowerCase())
    if (!item) throw new Error(`报告引用的图像 ${hash.slice(0, 12)} 尚未采集`)
    used.add(hash.toLowerCase())
    return `![${safeCaption(alt) || safeCaption(item.caption) || '画布图像'}](${item.figure.dataUrl})\n\n${sourceLine(item.figure)}`
  })
  const leftovers = staged.filter((item) => !used.has(item.figure.sha256.toLowerCase()))
  const appendix = leftovers.length === 0 ? '' : `\n\n## 图像证据\n\n${leftovers.map((item) => (
    `### ${safeCaption(item.caption) || safeCaption(item.figure.label) || '画布图像'}\n\n` +
    `![${safeCaption(item.caption) || '画布图像'}](${item.figure.dataUrl})\n\n` +
    sourceLine(item.figure)
  )).join('\n\n')}`
  const finalMarkdown = explicit + appendix
  validateReportMarkdown(finalMarkdown)
  return {
    markdown: finalMarkdown,
    figures: staged.map(({ figure, caption }) => ({
      id: figure.sha256.toLowerCase(),
      nodeId: figure.nodeId,
      groupPath: [...figure.groupPath],
      runtimeId: figure.runtimeId,
      portId: figure.portId,
      label: figure.label,
      caption,
      sha256: figure.sha256.toLowerCase(),
      ...(figure.sourceFingerprintSha256 ? { sourceFingerprintSha256: figure.sourceFingerprintSha256 } : {}),
      width: figure.width,
      height: figure.height,
    })),
  }
}
