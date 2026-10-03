import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, toStoredDataset, uniqueNames, type CsvSource } from './csvParse'

/**
 * CSV 解析是**界面与无头 CLI 共用的那一份**，所以它的行为要被单独钉住。
 *
 * 这里最要紧的一条是"结尾没有换行符的最后一行为什么不能丢"：
 * 丢一行不会报错，只会让下游的帧数、划分比例、统计量全部偏一点。
 */

function sourceOf(text: string): CsvSource {
  const bytes = new TextEncoder().encode(text)
  return {
    size: bytes.byteLength,
    slice: async (start, end) => bytes.slice(start, end).buffer as ArrayBuffer,
  }
}

test('结尾有换行符：四行数据就是四行', async () => {
  const parsed = await parseCsv(sourceOf('液位,流量\n1,2\n3,4\n5,6\n7,8\n'))
  assert.equal(parsed.rowCount, 4)
  assert.deepEqual([...parsed.data['液位']], [1, 3, 5, 7])
})

test('结尾没有换行符：最后一行不能丢', async () => {
  const parsed = await parseCsv(sourceOf('液位,流量\n1,2\n3,4\n5,6\n7,8'))
  assert.equal(parsed.rowCount, 4, '少了最后一行 —— 这类错不会报错，只会让结果偏一点')
  assert.deepEqual([...parsed.data['液位']], [1, 3, 5, 7])
  assert.deepEqual([...parsed.data['流量']], [2, 4, 6, 8])
})

/**
 * 表头重名：**后一列会把前一列覆盖掉**，而且不报错。
 *
 * 这条不是假想 —— 实测过：表头 `t,x,x,y` 解析出来 `columns` 里有两个 x，
 * 而数值字典里只有一份 x 的数据（后一份），也就是**整整一列数据消失了**。
 * 往下的每一层都拿列名当身份（端口名、拆列、函数形参、训练的特征列），
 * 重名意味着这些身份是错的。
 */
test('表头重名：改名而不是丢一列', async () => {
  assert.deepEqual(uniqueNames(['x', 'x', 'y', 'x']), ['x', 'x (2)', 'y', 'x (3)'])
  assert.deepEqual(uniqueNames([' x ', 'x']), ['x', 'x (2)'], '先去空白再判重')

  const parsed = await parseCsv(sourceOf('t,x,x,y\n0,1,2,3\n1,4,5,6\n'))
  assert.deepEqual(
    parsed.columns.map((c) => c.name),
    ['t', 'x', 'x (2)', 'y'],
    '第一个 x 原样保留，第二个改名 —— 两列都还在',
  )
  // 两列各自的数都得在：这正是"覆盖"会毁掉的东西
  assert.deepEqual([...parsed.data['x']], [1, 4])
  assert.deepEqual([...parsed.data['x (2)']], [2, 5])
  assert.deepEqual([...parsed.data['y']], [3, 6])
})

test('时间列被识别出来，并推出采样步长', async () => {
  const csv = [
    '时间,液位',
    '2026-01-01 00:00:00,1',
    '2026-01-01 00:00:01,2',
    '2026-01-01 00:00:02,3',
  ].join('\n')
  const parsed = await parseCsv(sourceOf(csv))
  assert.equal(parsed.timeColumn, '时间')
  assert.equal(parsed.stepSeconds, 1)
  assert.equal(parsed.regular, true)
  assert.equal(parsed.rowCount, 3)
  // 时间列不该混进数值列
  assert.equal('时间' in parsed.data, false)
})

test('非法数值与空单元格记成 NaN，并且被计入统计', async () => {
  const parsed = await parseCsv(sourceOf('液位,流量\n1,2\n,4\n3,6\n4,8\n5,10\n6,12\n'))
  assert.equal(parsed.rowCount, 6)
  const level = parsed.columns.find((c) => c.name === '液位')!
  assert.equal(level.stats.missing, 1)
  assert.ok(Number.isNaN(parsed.data['液位'][1]))
  assert.equal(parsed.data['液位'][2], 3)
})

test('非数值占多数的列被判成分类列，不进数值列', async () => {
  // 一列里多数值都解析不成数字 → 它是分类列，不该被当成特征喂给下游
  const parsed = await parseCsv(sourceOf('状态,液位\n好,1\n坏,2\n坏,3\n坏,4\n'))
  const status = parsed.columns.find((c) => c.name === '状态')!
  assert.equal(status.type, 'string')
  assert.equal(status.role, 'categorical')
  assert.equal('状态' in parsed.data, false)
  assert.equal(status.stats.nonNumeric, 4)
})

test('带引号的字段按 RFC4180 拆', async () => {
  const parsed = await parseCsv(sourceOf('液位,流量\n"1,5",2\n"3""4",6\n'))
  assert.equal(parsed.rowCount, 2)
  // 引号内的逗号不该被当分隔符：解析不出来的会记成 nonNumeric
  const flow = parsed.columns.find((c) => c.name === '流量')!
  assert.equal(flow.stats.nonNumeric, 0)
})

test('完全没有数据行时报错，而不是给一份空数据集', async () => {
  await assert.rejects(() => parseCsv(sourceOf('液位,流量\n')), /没有解析到任何数据行/)
})

test('转成数据集：特征列默认启用，时间列默认关闭', async () => {
  const parsed = await parseCsv(sourceOf('时间,液位\n2026-01-01 00:00:00,1\n2026-01-01 00:00:01,2\n'))
  const ds = toStoredDataset(parsed, { id: 'ds-1', name: 'x', source: 'x.csv' })
  assert.equal(ds.columns.find((c) => c.name === '时间')!.enabled, false)
  assert.equal(ds.columns.find((c) => c.name === '液位')!.enabled, true)
  assert.equal(ds.timeColumn, '时间')
  assert.equal(ds.rowCount, 2)
})
