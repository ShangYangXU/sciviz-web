import type { PreviewTable } from './types'

/**
 * 训练节点的"直出曲线"：把引擎吐出来的长表变成能直接画的序列。
 *
 * 引擎给的是**长表**（轮次 / 曲线 / 值），一行一个点。这与界面画图的口径一致
 * （`chartFromTable`：X 一列、Y 一列、颜色分组），所以这里不需要另一套多序列逻辑 ——
 * "训练曲线直出"因此没有在界面侧新开一条画图路径。
 *
 * 做成纯函数（没有 React、store、引擎）是为了能直接单测：`node --test` 就能验
 * "该分几组、点排没排序、脏数据有没有被丢掉"，不必起浏览器加 40MB 的 Pyodide。
 */

export const CURVE_X = '轮次'
export const CURVE_KEY = '曲线'
export const CURVE_Y = '值'

export interface CurvePoint {
  x: number
  y: number
}

export interface CurveSeries {
  name: string
  /** 按 x 升序。折线必须按 x 排，否则画出来是来回跳的锯齿 */
  points: CurvePoint[]
}

/** 长表 → 一条曲线一组的序列。缺列或没有可用的点就返回空表（界面据此不画） */
export function curveSeriesFromTable(table: PreviewTable): CurveSeries[] {
  const xi = table.columns.indexOf(CURVE_X)
  const yi = table.columns.indexOf(CURVE_Y)
  const ki = table.columns.indexOf(CURVE_KEY)
  if (xi < 0 || yi < 0) return []

  const groups = new Map<string, CurvePoint[]>()
  for (const row of table.rows) {
    const xv = row[xi]
    const yv = row[yi]
    // 缺失**不能**当成 0：`Number(null)` 是 0，于是"这一轮没算出来"会画成一个
    // 俯冲到 0 的点 —— 一条看起来很真实的暴跌，而它什么都没说明
    if (xv === null || yv === null || xv === '' || yv === '') continue
    const x = Number(xv)
    const y = Number(yv)
    // 非数值的点直接跳过：NaN 进 SVG 路径会得到一条谁也看不懂的线，而且不报错
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const name = ki >= 0 ? String(row[ki]) : '曲线'
    const bucket = groups.get(name)
    if (bucket) bucket.push({ x, y })
    else groups.set(name, [{ x, y }])
  }

  return [...groups.entries()].map(([name, points]) => ({
    name,
    points: [...points].sort((a, b) => a.x - b.x),
  }))
}

/**
 * 一条曲线自己的取值范围。
 *
 * 小图里**每条曲线各自缩放**：训练损失动辄几百，准确率在 0~1 之间，共用一根轴的话
 * 准确率会压成一条贴底的直线、什么也看不出来。代价是不能比绝对高低 ——
 * 所以图例里带上每条曲线的最后一个值，而"看走势"本来就是这个位置的用途。
 */
export function seriesRange(points: CurvePoint[]): [number, number] {
  if (points.length === 0) return [0, 1]
  let lo = Infinity
  let hi = -Infinity
  for (const p of points) {
    if (p.y < lo) lo = p.y
    if (p.y > hi) hi = p.y
  }
  return [lo, hi]
}
