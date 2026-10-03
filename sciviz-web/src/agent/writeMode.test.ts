import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideWrite,
  DEFAULT_WRITE_MODE,
  rowEgressGranted,
  WRITE_MODE_KEY,
  parseWriteModes,
  readWriteMode,
  serializeWriteModes,
  shouldConfirmWrite,
  shouldConfirmRowEgress,
  withWriteMode,
  writeModeFor,
  writeWriteMode,
  type GrantStore,
} from './writeMode'

/**
 * 写入档位的钉子。它守的是一个用户亲眼看到的现象：
 * "我每一次让 agent 做改动他都会弹出一个窗口让我确认"。
 *
 * 所以判据是三条：**默认档（完全访问权限）不问工程内的写**（否则这条缺陷没修）、
 * **往上切真的能问回来**（否则等于把确认删了、留下一个只会说"已自动"的开关）、
 * 以及**源码写在任何档位都要问**（用户原话："修改别的本地的一些非项目的内容，
 * 或者修改源代码这种不行"）。
 */

const store = (initial: Record<string, string> = {}): GrantStore & { data: Record<string, string> } => {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value },
  }
}

test('默认档不问：没记过的工程直接落', () => {
  assert.equal(DEFAULT_WRITE_MODE, 'full')
  assert.equal(writeModeFor(null, 'wf-1'), 'full')
  assert.equal(shouldConfirmWrite(writeModeFor(null, 'wf-1')), false)
  assert.equal(readWriteMode(undefined, 'wf-1'), 'full', '拿不到存储也必须是默认档，不许退化成"问"')
})

test('切到「请求批准」之后又问回来', () => {
  const raw = withWriteMode(null, 'wf-1', 'ask')
  assert.equal(writeModeFor(raw, 'wf-1'), 'ask')
  assert.equal(shouldConfirmWrite('ask'), true)
  assert.equal(writeModeFor(raw, 'wf-2'), 'full', '一个工程的选择不许串到另一个工程')
})

test('默认档不落盘：切回默认就是删掉这条记录', () => {
  const asked = withWriteMode(null, 'wf-1', 'ask')
  const back = withWriteMode(asked, 'wf-1', 'full')
  assert.equal(parseWriteModes(back).size, 0)
  assert.equal(writeModeFor(back, 'wf-1'), 'full', '删掉之后仍然读得出默认档')
})

test('坏值丢掉而不是整串作废', () => {
  const raw = 'wf-1=smart,坏 id=full,wf-2=看不懂,wf-3=full'
  const modes = parseWriteModes(raw)
  assert.equal(modes.get('wf-1'), 'smart')
  assert.equal(modes.has('坏 id'), false)
  assert.equal(modes.has('wf-2'), false)
  // `wf-3=full` 是合法值，读得进来；但它是默认档，**写回**时会被丢掉 —— 见下一条
  assert.equal(modes.get('wf-3'), 'full')
  assert.equal(serializeWriteModes(modes), 'wf-1=smart')
})

test('2026-09-22 写下的旧值读到即迁移：auto→full、propose→ask', () => {
  const raw = 'wf-1=auto,wf-2=propose'
  assert.equal(writeModeFor(raw, 'wf-1'), 'full')
  assert.equal(writeModeFor(raw, 'wf-2'), 'ask')
  // 迁移只发生在**读**这一侧：没切档之前，磁盘上仍是旧串
  assert.equal(parseWriteModes(raw).size, 2)
  assert.equal(writeModeFor(withWriteMode(raw, 'wf-2', 'ask'), 'wf-2'), 'ask')
})

test('三档 × 三类写：最高档一个 confirm 都不返回', () => {
  assert.deepEqual(
    (['ask', 'smart', 'full'] as const).map((mode) => decideWrite(mode, 'source')),
    ['confirm', 'confirm', 'refuse'],
    '源码写不在最高档放宽的范围里：那一档不问人，于是直接拒绝',
  )
  assert.deepEqual(
    (['ask', 'smart', 'full'] as const).map((mode) => decideWrite(mode, 'destructive')),
    ['confirm', 'confirm', 'apply'],
    '破坏性图写只在完全访问权限档免确认',
  )
  assert.deepEqual(
    (['ask', 'smart', 'full'] as const).map((mode) => decideWrite(mode, 'normal')),
    ['confirm', 'apply', 'apply'],
    '普通图写只有请求批准档会问',
  )
  assert.equal(
    (['ask', 'smart', 'full'] as const).flatMap((mode) => (['normal', 'destructive', 'source'] as const).map((risk) => decideWrite(mode, risk))).includes('confirm')
      && decideWrite('full', 'normal') === 'confirm',
    false,
    '完全访问权限档不许有 confirm',
  )
})

test('行值外发：最高档不问，其余档首次点头后也只在请求批准档继续问', () => {
  assert.equal(shouldConfirmRowEgress('full', false), false, '最高档一点弹窗都不出')
  assert.equal(rowEgressGranted('full', false), true, '最高档下行值随取随给')
  assert.equal(shouldConfirmRowEgress('ask', true), true, '请求批准档的语义就是每次都问')
  assert.equal(shouldConfirmRowEgress('smart', false), true, '没点头之前要问')
  assert.equal(shouldConfirmRowEgress('smart', true), false, '点头之后本工程不再问')
})

test('parse 与 serialize 互为逆运算', () => {
  const raw = withWriteMode(withWriteMode(null, 'wf-b', 'ask'), 'wf-a', 'smart')
  const round = serializeWriteModes(parseWriteModes(raw))
  assert.equal(round, raw)
  assert.equal(round, 'wf-a=smart,wf-b=ask', '顺序稳定，文件之间可比')
})

test('记录条数有上限，且丢掉的是最早的那些', () => {
  let raw = ''
  for (let i = 0; i < 260; i += 1) raw = withWriteMode(raw, `wf-${i}`, 'ask')
  const modes = parseWriteModes(raw)
  assert.equal(modes.size, 200)
  assert.equal(modes.has('wf-0'), false)
  assert.equal(modes.has('wf-259'), true)
})

test('读写走注入的存储，键只有一个', () => {
  const fake = store()
  writeWriteMode(fake, 'wf-9', 'ask')
  assert.deepEqual(Object.keys(fake.data), [WRITE_MODE_KEY])
  assert.equal(readWriteMode(fake, 'wf-9'), 'ask')
  writeWriteMode(fake, 'wf-9', 'smart')
  assert.equal(readWriteMode(fake, 'wf-9'), 'smart')
})

test('存储抛异常时退回默认档，而不是把对话栏一起弄坏', () => {
  const hostile: GrantStore = {
    getItem: () => { throw new Error('隐私模式') },
    setItem: () => { throw new Error('隐私模式') },
  }
  assert.equal(readWriteMode(hostile, 'wf-1'), 'full')
  assert.doesNotThrow(() => writeWriteMode(hostile, 'wf-1', 'ask'))
})
