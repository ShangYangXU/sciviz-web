/** 画布上的文本输入控件：这些控件里的粘贴、快捷键和中文输入法必须由控件自己处理。 */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  const el = typeof HTMLElement !== 'undefined' && target instanceof HTMLElement ? target : null
  if (!el) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

/** IME 组合输入期间不要拦截 keydown；部分浏览器会用 keyCode 229 表示这一状态。 */
export function isImeKey(event: KeyboardEvent | { isComposing: boolean; keyCode?: number }): boolean {
  return event.isComposing || event.keyCode === 229
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('无法读取剪贴板图片'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('无法读取剪贴板图片'))
    reader.readAsDataURL(blob)
  })
}

/** 从 SVG 节点生成独立的 data URL，保存后不依赖图表节点或数据集。 */
export function svgToDataUrl(svg: SVGElement): string {
  const copy = svg.cloneNode(true) as SVGElement
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  copy.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  const xml = new XMLSerializer().serializeToString(copy)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
}

export function svgSize(svg: SVGElement): { width: number; height: number } {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? []
  const width = Number(svg.getAttribute('width'))
  const height = Number(svg.getAttribute('height'))
  const w = Number.isFinite(width) && width > 0 ? width : viewBox[2]
  const h = Number.isFinite(height) && height > 0 ? height : viewBox[3]
  return {
    width: Number.isFinite(w) && w > 0 ? w : 800,
    height: Number.isFinite(h) && h > 0 ? h : 520,
  }
}

export function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || 640, height: image.naturalHeight || 420 })
    image.onerror = () => resolve({ width: 640, height: 420 })
    image.src = src
  })
}

/** 将原图限制在画布友好的尺寸内，同时保持比例。 */
export function fitImageSize(width: number, height: number): { width: number; height: number } {
  const max = 720
  const scale = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(80, Math.round(width * scale)), height: Math.max(80, Math.round(height * scale)) }
}

/**
 * 笔记里的图片：超长边压到 `maxEdge` 再内嵌。
 *
 * 为什么必须压：图片是**内嵌进 `.sciviz`** 的（浏览器里拿不到"工程旁边的目录"），
 * 一张手机截图 4000×3000 直接塞进去就是几 MB，工程文件会从"能 diff 的文本"变成
 * "打不开的大文件"。压到 1600 长边对看谱图、看界面截图都够用。
 */
export function compressImageForNotebook(blob: Blob, maxEdge = 1600): Promise<string> {
  return blobToDataUrl(blob).then(
    (raw) =>
      new Promise<string>((resolve) => {
        const probe = new Image()
        probe.onload = () => {
          const longest = Math.max(probe.naturalWidth, probe.naturalHeight)
          if (longest <= maxEdge) {
            resolve(raw)
            return
          }
          const scale = maxEdge / longest
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(probe.naturalWidth * scale))
          canvas.height = Math.max(1, Math.round(probe.naturalHeight * scale))
          const context = canvas.getContext('2d')
          if (!context) {
            resolve(raw)
            return
          }
          context.drawImage(probe, 0, 0, canvas.width, canvas.height)
          resolve(canvas.toDataURL('image/png'))
        }
        probe.onerror = () => resolve(raw)
        probe.src = raw
      }),
  )
}
