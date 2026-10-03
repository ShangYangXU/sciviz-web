/**
 * 数据变换算子的独立真值。
 *
 * e2e 里断言的那几个数字（首帧均值 67.2559、峰值频率 25.87890625 Hz…）不是从引擎抄的，
 * 是这份脚本独立扫全量 CSV、独立做 DFT 算出来的。引擎的断言一旦对不上，这里就是判据。
 *
 * 用法：node scripts/verify-operator-truth.mjs
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import readline from 'node:readline'

// 仓库里存的是 gzip（58.7MB → 5.6MB，见 src/data/samples.ts）。Node 直接解，
// 不需要先手工解压出一份 .csv —— 独立真值的脚本越少前置步骤，越可能被真的跑一遍
const FILE = 'public/samples/boiler2-full.csv.gzip'
const COLUMN = '二号锅炉液位'
const TIME_COLUMN = '时间'
const WINDOW = 2048
const OVERLAP = 0.5
const NFFT = 2048

const rl = readline.createInterface({
  input: fs.createReadStream(FILE).pipe(zlib.createGunzip()),
  crlfDelay: Infinity,
})
let index = -1
let timeIndex = -1
let time0 = null
let time1 = null
const column = []
let n = 0

for await (const line of rl) {
  if (index < 0) {
    // 第一行可能带 BOM —— 不剥掉的话首列名会是「\uFEFF时间」，indexOf 找不到
    const head = line.replace(/^\uFEFF/, '').split(',')
    index = head.indexOf(COLUMN)
    timeIndex = head.indexOf(TIME_COLUMN)
    if (index < 0) throw new Error('列不存在：' + COLUMN)
    if (timeIndex < 0) throw new Error('列不存在：' + TIME_COLUMN)
    continue
  }
  if (!line) continue
  // 采样率不是常量，是**数据的属性**（契约规格 R3.4）：从时间列的步长独立算出来。
  // 以前这里写死 FS = 1000，于是"独立真值"其实跟着节点参数走 —— 那不算独立
  if (timeIndex >= 0) {
    const t = Date.parse(line.split(',')[timeIndex])
    if (time0 === null) time0 = t
    else if (time1 === null) time1 = t
  }
  n += 1
  column.push(Number(line.split(',')[index]))
}

const stepSeconds = time0 !== null && time1 !== null ? (time1 - time0) / 1000 : null
if (stepSeconds === null || !(stepSeconds > 0)) throw new Error('时间列读不出步长，没法推采样率')
const FS = 1 / stepSeconds

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
const stats = (a) => {
  const m = mean(a)
  const center = a.map((v) => v - m)
  const std = Math.sqrt(mean(center.map((v) => v * v)))
  const rms = Math.sqrt(mean(a.map((v) => v * v)))
  let peak = 0
  for (const v of a) if (Math.abs(v) > peak) peak = Math.abs(v)
  const skew = mean(center.map((v) => (v / std) ** 3))
  const kurt = mean(center.map((v) => (v / std) ** 4))
  return { m, std, rms, peak, skew, kurt }
}

const frameStats = stats(column.slice(0, WINDOW))
const hop = Math.round(WINDOW * (1 - OVERLAP))
const frames = Math.floor((n - WINDOW) / hop) + 1

// 第一帧的 DFT：峰值频率 / 峰值幅值（去直流，nfft = 2048）
const frame = column.slice(0, WINDOW)
const fm = mean(frame)
const centered = frame.map((v) => v - fm)
const half = NFFT / 2 + 1
let peakBin = 0
let peakAmp = -1
for (let k = 0; k < half; k += 1) {
  let re = 0
  let im = 0
  for (let t = 0; t < NFFT; t += 1) {
    const angle = (2 * Math.PI * k * t) / NFFT
    re += centered[t] * Math.cos(angle)
    im -= centered[t] * Math.sin(angle)
  }
  const amp = Math.hypot(re, im)
  if (amp > peakAmp) {
    peakAmp = amp
    peakBin = k
  }
}

const whole = stats(column)
console.log(JSON.stringify({
  行数: n,
  整列: {
    均值: whole.m,
    标准差: whole.std,
    RMS: whole.rms,
    峰值: whole.peak,
    偏度: whole.skew,
    峭度: whole.kurt,
  },
  分帧: {
    帧数: frames,
    第一帧: frameStats,
    采样率Hz: FS,
    峰值频率Hz: (peakBin * FS) / NFFT,
    峰值幅值: peakAmp,
  },
  划分: {
    训练: Math.floor(n * 0.7),
    验证: Math.floor(n * 0.15),
    测试: n - Math.floor(n * 0.7) - Math.floor(n * 0.15),
  },
}, null, 2))
