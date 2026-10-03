import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoMapColumns,
  chartFromTable,
  columnsFromNames,
  mergeMapping,
  rowsOfTable,
} from './chartFromTable'
import type { PreviewTable, WorkflowNode } from './types'

/**
 * 图表接上游表这条路的纯逻辑：挑哪两列、行怎么摆、图配置长什么样。
 * 抽稀本身在 Python 侧（见 operators.op_chart），这里不管抽样率，只管"画哪一列"。
 */

const node = (
  params: Record<string, string | number | boolean>,
  type: WorkflowNode['type'] = 'viz.chart',
): WorkflowNode => ({
  id: 'c1',
  type,
  label: '图表',
  params,
  position: { x: 0, y: 0 },
})

const table: PreviewTable = {
  columns: ['时间', '液位', '蒸汽压力'],
  timeColumn: '时间',
  totalRows: 145377,
  rows: [
    [1735700000, 67, 11.54],
    [1735700010, 68, 11.6],
    [1735700020, 69, 11.7],
  ],
}

test('列语义：时间列认出来，其余是连续量', () => {
  const cols = columnsFromNames(['时间', '液位'], '时间')
  assert.deepEqual(
    cols.map((c) => [c.name, c.role]),
    [
      ['时间', 'time'],
      ['液位', 'continuous'],
    ],
  )
})

test('行优先的二维值摆成按列名索引的行对象，缺值给 null 而不是 undefined', () => {
  const rows = rowsOfTable({ ...table, columns: ['时间', '液位'], rows: [[1], [2, 3]] }, columnsFromNames(['时间', '液位'], '时间'))
  assert.deepEqual(rows, [
    { 时间: 1, 液位: null },
    { 时间: 2, 液位: 3 },
  ])
})

test('默认映射：折线横着铺时间，直方图只吃一列，柱状图没有分类轴就留空', () => {
  const cols = columnsFromNames(['时间', '液位', '蒸汽压力'], '时间')
  assert.deepEqual(autoMapColumns(cols, 'line'), { x: '时间', y: '液位', color: '' })
  assert.deepEqual(autoMapColumns(cols, 'histogram'), { x: '液位', y: '', color: '' })
  assert.deepEqual(autoMapColumns(cols, 'density'), { x: '液位', y: '', color: '' })
  // 上游是数值表时没有分类列，柱状图宁可不画 X，也不要拿几千个连续值当分类
  assert.deepEqual(autoMapColumns(cols, 'bar'), { x: '', y: '液位', color: '' })
})

test('没有时间列时折线退到第二个测量列当 X', () => {
  const cols = columnsFromNames(['液位', '蒸汽压力'], null)
  assert.deepEqual(autoMapColumns(cols, 'scatter'), { x: '蒸汽压力', y: '液位', color: '' })
})

test('上游只有一列又没有时间列时，折线/散点不硬画一条自己对自己的对角线', () => {
  const one = columnsFromNames(['液位'], null)
  assert.deepEqual(autoMapColumns(one, 'line'), { x: '', y: '液位', color: '' })
  // 直方图/密度图正好相反：一列就是它的全部输入
  assert.deepEqual(autoMapColumns(one, 'histogram'), { x: '液位', y: '', color: '' })
})

test('映射：用户选的列还在就用用户的，列没了才回到自动挑 —— 不把失效列名原样传下去', () => {
  const cols = columnsFromNames(['时间', '液位', '蒸汽压力'], '时间')
  assert.deepEqual(
    mergeMapping({ x: '液位', y: '蒸汽压力', color: '' }, cols, 'scatter'),
    { x: '液位', y: '蒸汽压力', color: '' },
  )
  // 换了上游之后 液位 这列没了：不能把 '液位' 原样留着，否则图上只是一片空白
  assert.deepEqual(
    mergeMapping({ x: '液位', y: '蒸汽压力', color: '' }, cols, 'scatter'),
    { x: '液位', y: '蒸汽压力', color: '' },
  )
  assert.deepEqual(mergeMapping({ x: '没有列', y: '也没有' }, cols, 'line'), {
    x: '时间',
    y: '液位',
    color: '',
  })
})

test('直方图/密度图不映射 Y：一列对自身画出来的东西没有意义', () => {
  const cols = columnsFromNames(['时间', '液位'], '时间')
  assert.deepEqual(mergeMapping({ x: '液位', y: '液位' }, cols, 'density'), {
    x: '液位',
    y: '',
    color: '',
  })
})

test('组装出来的图表带 inline 数据，不指向任何数据集', () => {
  const chart = chartFromTable(node({ chartType: 'line', title: '工作数据' }), table, {
    totalRows: 145377,
    chartId: 'a1',
  })
  assert.equal(chart.type, 'line')
  assert.equal(chart.name, '工作数据')
  assert.equal(chart.datasetId, 'engine:c1')
  assert.equal(chart.inline?.rows.length, 3)
  assert.equal(chart.inline?.columns.find((c) => c.name === '时间')?.role, 'time')
  assert.deepEqual(chart.mapping, { x: '时间', y: '液位', color: '' })
  // 样式取自节点参数，与"选数据集"那条路同一个口径
  assert.equal(chart.style.showGrid, true)
  assert.equal(chart.style.palette, 'okabe-ito')
})

test('样式参数被尊重：关网格、换配色、改元素大小都要生效', () => {
  const chart = chartFromTable(
    node({ chartType: 'scatter', showGrid: false, palette: 'viridis', pointSize: 6 }),
    table,
    { totalRows: 3, chartId: 'a2' },
  )
  assert.equal(chart.style.showGrid, false)
  assert.equal(chart.style.palette, 'viridis')
  assert.equal(chart.style.pointSize, 6)
})

test('自定义图表忽略旧的手动字段映射，按函数返回表自动选轴', () => {
  const custom = node(
    { chartType: 'line', x: '蒸汽压力', y: '液位', color: '液位' },
    'custom.chart',
  )
  const chart = chartFromTable(custom, table, { totalRows: 3, chartId: 'custom-auto-map' })
  assert.deepEqual(chart.mapping, { x: '时间', y: '液位', color: '' })
})

test('普通图表仍尊重手动字段映射', () => {
  const chart = chartFromTable(
    node({ chartType: 'scatter', x: '液位', y: '蒸汽压力' }),
    table,
    { totalRows: 3, chartId: 'viz-manual-map' },
  )
  assert.deepEqual(chart.mapping, { x: '液位', y: '蒸汽压力', color: '' })
})
