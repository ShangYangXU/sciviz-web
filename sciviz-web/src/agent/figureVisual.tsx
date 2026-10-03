import { renderToStaticMarkup } from 'react-dom/server'
import { ChartRenderer } from '../charts/ChartRenderer'
import type { NodeChart } from '../store/nodeChart'

const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_DIMENSION = 12_000
const MAX_SOURCE_PIXELS = 40_000_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_DIMENSION = 1600

export interface FigureVisual {
  dataUrl: string
  sha256: string
  width: number
  height: number
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_SOURCE_BYTES * 4 / 3) + 8) throw new Error('图表图片超过 16 MiB，无法安全读取')
  const binary = atob(value)
  if (binary.length > MAX_SOURCE_BYTES) throw new Error('图表图片超过 16 MiB，无法安全读取')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function chartBlob(nodeChart: NodeChart): Blob {
  if (nodeChart.chart.image) {
    const bytes = decodeBase64(nodeChart.chart.image.data)
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
      throw new Error('Matplotlib 图像不是有效的 PNG')
    }
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = header.getUint32(16)
    const height = header.getUint32(20)
    if (width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION || width * height > MAX_SOURCE_PIXELS) {
      throw new Error('Matplotlib 图像尺寸超过读取上限')
    }
    const pngBuffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(pngBuffer).set(bytes)
    return new Blob([pngBuffer], { type: nodeChart.chart.image.mimeType })
  }
  if (!nodeChart.dataset) throw new Error('当前图表没有可读取的数据')
  const markup = renderToStaticMarkup(
    <ChartRenderer chart={nodeChart.chart} dataset={nodeChart.dataset} onHover={() => undefined} mini={false} />,
  )
  if (markup.length > MAX_SOURCE_BYTES) throw new Error('图表 SVG 超过 16 MiB，无法安全读取')
  return new Blob([markup], { type: 'image/svg+xml;charset=utf-8' })
}

async function imageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器无法编码图表图像')), 'image/png')
  })
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** Render the exact chart resolved for the canvas into a bounded PNG for explicit visual inspection. */
export async function renderChartVisual(nodeChart: NodeChart): Promise<FigureVisual> {
  const source = await imageFromBlob(chartBlob(nodeChart))
  const sourceWidth = source.naturalWidth
  const sourceHeight = source.naturalHeight
  if (!sourceWidth || !sourceHeight || sourceWidth > MAX_SOURCE_DIMENSION || sourceHeight > MAX_SOURCE_DIMENSION || sourceWidth * sourceHeight > MAX_SOURCE_PIXELS) {
    throw new Error('图表图片尺寸无效或超过 12,000 像素')
  }
  const scale = Math.min(1, MAX_DIMENSION / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法建立图表画布')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(source, 0, 0, width, height)

  const png = await canvasBlob(canvas)
  if (png.size > MAX_OUTPUT_BYTES) throw new Error('转换后的图表超过 8 MiB，无法发送给模型')
  const bytes = new Uint8Array(await png.arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    dataUrl: `data:image/png;base64,${toBase64(bytes)}`,
    sha256: hash,
    width,
    height,
  }
}
