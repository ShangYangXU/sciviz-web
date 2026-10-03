import assert from 'node:assert/strict'
import test from 'node:test'

import { curveSeriesFromTable, seriesRange } from './trainingCurve'
import type { PreviewTable } from './types'

const table = (columns: string[], rows: (string | number | null)[][]): PreviewTable => ({
  columns,
  rows,
  totalRows: rows.length,
  timeColumn: null,
})

test('长表按曲线名分组，并且每条按轮次排序', () => {
  // 故意把行打乱：折线必须按 x 排，否则画出来是来回跳的锯齿
  const series = curveSeriesFromTable(
    table(['轮次', '曲线', '值'], [
      [2, '训练损失', 0.4],
      [1, '训练损失', 0.9],
      [2, '验证损失', 0.5],
      [1, '验证损失', 1.1],
    ]),
  )
  assert.deepEqual(
    series.map((s) => s.name),
    ['训练损失', '验证损失'],
  )
  assert.deepEqual(
    series[0].points.map((p) => p.x),
    [1, 2],
  )
  assert.deepEqual(series[1].points, [
    { x: 1, y: 1.1 },
    { x: 2, y: 0.5 },
  ])
})

test('没有曲线列时当成单条曲线：缺列不该让整张图消失', () => {
  const series = curveSeriesFromTable(
    table(['轮次', '值'], [
      [1, 0.9],
      [2, 0.4],
    ]),
  )
  assert.equal(series.length, 1)
  assert.equal(series[0].points.length, 2)
})

test('非数值的点直接丢掉：NaN 进路径会画出一条谁也看不懂的线，而且不报错', () => {
  const series = curveSeriesFromTable(
    table(['轮次', '曲线', '值'], [
      [1, 'loss', 0.9],
      [2, 'loss', null],
      ['轮次', 'loss', 0.5],
      [3, 'loss', 0.4],
    ]),
  )
  assert.deepEqual(
    series[0].points.map((p) => p.x),
    [1, 3],
  )
})

test('缺列（不是训练曲线的表）→ 空表，界面据此什么都不画', () => {
  assert.deepEqual(curveSeriesFromTable(table(['a', 'b'], [[1, 2]])), [])
  assert.deepEqual(curveSeriesFromTable(table(['轮次', '曲线'], [[1, 'loss']])), [])
})

test('每条曲线各自取范围：损失几百、准确率 0~1，共用一根轴会把准确率压成一条直线', () => {
  assert.deepEqual(seriesRange([{ x: 1, y: 5 }, { x: 2, y: -3 }, { x: 3, y: 2 }]), [-3, 5])
  assert.deepEqual(seriesRange([]), [0, 1], '空序列给一个安全的范围，免得除零')
})
