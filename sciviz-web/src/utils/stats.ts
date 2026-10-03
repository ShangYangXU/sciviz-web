/** 分位数（线性插值，与 numpy 默认一致）；接受任意有序数组视图 */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface BoxStats {
  min: number
  q1: number
  median: number
  q3: number
  max: number
  /** 须之外的离群点 */
  outliers: number[]
  n: number
  mean: number
}

/** Tukey 箱线图统计：须为 1.5×IQR 内最远的实际数据点 */
export function boxStats(values: number[]): BoxStats {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return { min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN, outliers: [], n: 0, mean: NaN }
  }
  const q1 = quantile(sorted, 0.25)
  const median = quantile(sorted, 0.5)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  const loFence = q1 - 1.5 * iqr
  const hiFence = q3 + 1.5 * iqr

  const inside = sorted.filter((v) => v >= loFence && v <= hiFence)
  const outliers = sorted.filter((v) => v < loFence || v > hiFence)

  return {
    min: inside.length ? inside[0] : sorted[0],
    q1,
    median,
    q3,
    max: inside.length ? inside[inside.length - 1] : sorted[sorted.length - 1],
    outliers,
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  }
}

export function mean(values: number[]): number {
  const v = values.filter(Number.isFinite)
  if (!v.length) return NaN
  return v.reduce((a, b) => a + b, 0) / v.length
}

/** 样本标准差（n-1），用于误差棒 */
function stdDev(values: number[]): number {
  const v = values.filter(Number.isFinite)
  if (v.length < 2) return 0
  const m = mean(v)
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
}

/** 标准误 SEM = s / sqrt(n) */
export function stdError(values: number[]): number {
  const v = values.filter(Number.isFinite)
  if (v.length < 2) return 0
  return stdDev(v) / Math.sqrt(v.length)
}

interface Bin {
  x0: number
  x1: number
  count: number
}

/** Freedman-Diaconis 规则选组距 */
export function histogramBins(values: number[], binCount?: number): Bin[] {
  const v = values.filter(Number.isFinite)
  if (!v.length) return []
  const min = Math.min(...v)
  const max = Math.max(...v)
  if (min === max) return [{ x0: min - 0.5, x1: max + 0.5, count: v.length }]

  let k = binCount
  if (!k) {
    const sorted = [...v].sort((a, b) => a - b)
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25)
    const h = (2 * iqr) / Math.cbrt(v.length)
    k = h > 0 ? Math.ceil((max - min) / h) : Math.ceil(Math.sqrt(v.length))
    // 双峰或长尾数据会让 Freedman-Diaconis 给出过少的分组，
    // 用 sqrt(n) 兜底，保证图上看得出分布形态
    k = Math.max(Math.ceil(Math.sqrt(v.length)), k)
    k = Math.min(60, Math.max(8, k))
  }

  const width = (max - min) / k
  const bins: Bin[] = Array.from({ length: k }, (_, i) => ({
    x0: min + i * width,
    x1: min + (i + 1) * width,
    count: 0,
  }))
  for (const val of v) {
    let idx = Math.floor((val - min) / width)
    if (idx >= k) idx = k - 1
    if (idx < 0) idx = 0
    bins[idx].count++
  }
  return bins
}

interface Regression {
  slope: number
  intercept: number
  r2: number
  predict: (x: number) => number
}

export function linearRegression(pts: [number, number][]): Regression | null {
  const p = pts.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (p.length < 2) return null
  const n = p.length
  const mx = p.reduce((a, [x]) => a + x, 0) / n
  const my = p.reduce((a, [, y]) => a + y, 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const [x, y] of p) {
    sxx += (x - mx) ** 2
    sxy += (x - mx) * (y - my)
    syy += (y - my) ** 2
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { slope, intercept, r2, predict: (x: number) => slope * x + intercept }
}

/** 数值格式化：自动选择有效位数，避免科学计数法刷屏 */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  const abs = Math.abs(v)
  if (abs >= 1e5 || abs < 1e-3) return v.toExponential(2)
  if (abs >= 100) return v.toFixed(1)
  if (abs >= 1) return v.toFixed(2)
  if (abs >= 0.01) return v.toFixed(3)
  // 更小的量（频域特征的峰值频率常见 0.0026 Hz 这种）用三位小数只剩一位有效数字，
  // 等于把值抹掉 —— 两位有效数字至少还看得出数量级与形状
  return v.toPrecision(2)
}

/* ------------------------------------------------------------------ */
/* 核密度估计                                                          */
/* ------------------------------------------------------------------ */

interface DensityPoint {
  x: number
  y: number
}

interface DensityResult {
  points: DensityPoint[]
  /** 实际使用的带宽 */
  bandwidth: number
  /** 带宽是自动选的还是调用方指定的 */
  autoBandwidth: boolean
  mean: number
  median: number
  std: number
  n: number
  /** 曲线峰值，用于纵轴定位 */
  peak: number
}

interface DensityOptions {
  gridSize?: number
  /** 大于 0 时用指定带宽，否则按 Silverman 经验法则自动选 */
  bandwidth?: number
}

/**
 * 高斯核密度估计。
 *
 * 带宽用 Silverman 经验法则：h = 1.06 · min(σ, IQR/1.34) · n^(-1/5)
 * 用 min(σ, IQR/1.34) 而不是直接用 σ —— 有离群点时 σ 会被撑大、曲线过度平滑。
 *
 * 大样本不逐点求和，而是先装进细箱再对网格做卷积：
 * 100 万行直接算是 2.5 亿次运算（秒级），分箱后是几十万次（毫秒级）。
 * 细箱取 2 倍网格数时，这个近似的误差肉眼不可见。
 */
export function kernelDensity(values: number[], opts: DensityOptions = {}): DensityResult | null {
  const v = values.filter(Number.isFinite)
  const n = v.length
  if (n < 2) return null

  const gridSize = opts.gridSize ?? 256
  const sorted = [...v].sort((a, b) => a - b)
  const mean = v.reduce((a, b) => a + b, 0) / n
  const median = quantile(sorted, 0.5)

  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  const std = Math.sqrt(variance)

  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25)
  const robustSigma = iqr > 0 ? iqr / 1.34 : std
  const sigma = Math.min(std || robustSigma, robustSigma || std) || 1

  const autoBandwidth = !(opts.bandwidth && opts.bandwidth > 0)
  const bandwidth = autoBandwidth ? 1.06 * sigma * Math.pow(n, -0.2) : opts.bandwidth!

  const lo = sorted[0]
  const hi = sorted[n - 1]
  const x0 = lo - 3 * bandwidth
  const x1 = hi + 3 * bandwidth
  const span = x1 - x0 || 1

  // 细箱：2 倍网格数，且与样本量挂钩
  const nbins = Math.max(64, Math.min(1024, Math.round(Math.sqrt(n) * 8)))
  const counts = new Float64Array(nbins)
  const binW = (hi - lo) / nbins || 1
  for (let i = 0; i < n; i++) {
    let b = Math.floor((v[i] - lo) / binW)
    if (b >= nbins) b = nbins - 1
    else if (b < 0) b = 0
    counts[b]++
  }

  const points: DensityPoint[] = new Array(gridSize)
  const norm = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI))
  const gaussCut = 4 * bandwidth
  let peak = 0

  for (let g = 0; g < gridSize; g++) {
    const x = x0 + (g / (gridSize - 1)) * span
    let acc = 0
    for (let b = 0; b < nbins; b++) {
      const c = counts[b]
      if (c === 0) continue
      const center = lo + (b + 0.5) * binW
      const d = x - center
      // 核在 4 倍带宽外几乎为 0，跳过能省掉绝大部分计算
      if (d > gaussCut || d < -gaussCut) continue
      const u = d / bandwidth
      acc += c * Math.exp(-0.5 * u * u)
    }
    const y = acc * norm
    if (y > peak) peak = y
    points[g] = { x, y }
  }

  return { points, bandwidth, autoBandwidth, mean, median, std, n, peak }
}
