import { scaleLinear, scaleBand } from 'd3'

export interface Tick {
  /** 画布内的像素位置 */
  pos: number
  label: string
}

interface LinearScale {
  kind: 'linear'
  domain: [number, number]
  map: (v: number) => number
  ticks: Tick[]
  /** 位置 → 数值，用于 tooltip / 反查 */
  invert: (px: number) => number
}

interface BandScale {
  kind: 'band'
  domain: string[]
  map: (v: string) => number
  bandwidth: number
  ticks: Tick[]
}

export type AnyScale = LinearScale | BandScale

export function makeLinearScale(
  domain: [number, number],
  range: [number, number],
  tickCount = 6,
  formatter: (v: number) => string,
): LinearScale {
  let [d0, d1] = domain
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) {
    d0 = 0
    d1 = 1
  }
  if (d0 === d1) {
    d0 -= 1
    d1 += 1
  }
  const scale = scaleLinear().domain([d0, d1]).range(range).nice()
  const [n0, n1] = scale.domain()
  const ticks: Tick[] = scale.ticks(tickCount).map((t) => ({ pos: scale(t), label: formatter(t) }))
  return {
    kind: 'linear',
    domain: [n0, n1],
    map: (v: number) => scale(v),
    ticks,
    invert: (px: number) => scale.invert(px),
  }
}

export function makeBandScale(
  values: string[],
  range: [number, number],
  padding = 0.25,
  format: (v: string) => string = (v) => v,
  /** 刻度标签过多时抽稀，避免文字糊成一团 */
  maxTicks = Infinity,
): BandScale {
  const scale = scaleBand<string>().domain(values).range(range).paddingInner(padding).paddingOuter(padding / 2)
  const band = scale.bandwidth()
  const step = values.length > maxTicks ? Math.ceil(values.length / maxTicks) : 1
  const ticks: Tick[] = []
  values.forEach((v, i) => {
    if (i % step !== 0) return
    ticks.push({ pos: (scale(v) ?? range[0]) + band / 2, label: format(v) })
  })
  return {
    kind: 'band',
    domain: values,
    map: (v: string) => scale(v) ?? range[0],
    bandwidth: band,
    ticks,
  }
}

/** 线性轴范围：留出 6% 余量，避免点贴在边框上 */
export function padDomain(min: number, max: number, padRatio = 0.06): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) return [min - Math.abs(min || 1) * 0.1, max + Math.abs(max || 1) * 0.1]
  const pad = (max - min) * padRatio
  return [min - pad, max + pad]
}
