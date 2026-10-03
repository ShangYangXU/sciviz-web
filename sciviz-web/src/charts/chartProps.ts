import type { MouseEvent } from 'react'
import type { ChartMapping, ChartStyle, Column, Row } from '../types'
import { formatNumber } from '../utils/stats'

/** 悬停时上报的坐标（相对画布容器）与文本行 */
export type HoverHandler = (e: MouseEvent, lines: string[]) => void

export interface ChartProps {
  rows: Row[]
  columns: Column[]
  mapping: ChartMapping
  style: ChartStyle
  onHover: HoverHandler
  /** 缩略档：画在节点框里的预览。六个图把它转交给 `ChartFrame`，画法只有一份 */
  mini?: boolean
}

interface Point {
  x: number
  y: number
  color: string | null
  colorValue: string | null
  raw: Row
}

/** 把映射到的列抽成数值点，顺带过滤掉缺失值 */
export function extractPoints(
  rows: Row[],
  mapping: ChartMapping,
  colorOf: (v: string | null) => string,
): Point[] {
  if (!mapping.x || !mapping.y) return []
  const pts: Point[] = []
  for (const r of rows) {
    const x = Number(r[mapping.x])
    const y = Number(r[mapping.y])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const cv = mapping.color ? String(r[mapping.color]) : null
    pts.push({ x, y, color: cv === null ? null : colorOf(cv), colorValue: cv, raw: r })
  }
  return pts
}

function unitSuffix(col: Column | undefined): string {
  return col?.unit ? ` (${col.unit})` : ''
}

export function axisLabel(col: Column | undefined, fallback: string): string {
  if (!col) return fallback
  return `${col.name}${unitSuffix(col)}`
}

/**
 * 轴刻度格式化。
 *
 * 时间列存的是 epoch 秒，若按普通数字格式化，刻度会变成 "1.74e+9" —— 这是实测踩过的坑。
 * 按跨度自动选日期格式：秒级 / 时分 / 月日时分 / 年月日。
 */
export function axisFormatter(col: Column | undefined, domain: [number, number]): (v: number) => string {
  if (col?.role !== 'time') return formatNumber

  const span = Math.abs(domain[1] - domain[0])
  if (span < 3600) {
    return (v) => new Date(v * 1000).toLocaleTimeString('zh-CN', { hour12: false })
  }
  if (span < 86400) {
    return (v) => new Date(v * 1000).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (span < 86400 * 60) {
    return (v) =>
      new Date(v * 1000).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
  }
  return (v) => {
    const d = new Date(v * 1000)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
}

/** 悬停提示里的数值展示：时间列转成可读时间，其余走通用数字格式 */
export function hoverValue(col: Column | undefined, v: number): string {
  if (col?.role === 'time') return new Date(v * 1000).toLocaleString('zh-CN', { hour12: false })
  return formatNumber(v)
}
