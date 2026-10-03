import test from 'node:test'
import assert from 'node:assert/strict'
import { hasReadCodeGrant, parseReadCodeGrant, readReadCodeGrant, rowEgressAllowed, serializeReadCodeGrant, withReadCodeGrant, writeReadCodeGrant, writeRowEgressAllowed, READ_CODE_GRANT_KEY, ROW_GRANT_KEY, type GrantStore } from './readGrant'

/** 内存版 localStorage：这条判定要能在 node --test 里直接跑，所以存储是注入的。 */
function memoryStore(seed: Record<string, string> = {}): GrantStore & { readonly data: Record<string, string> } {
  const data: Record<string, string> = { ...seed }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value },
  }
}

test('授权按工程记：一个工程点头不代表另一个工程也点头', () => {
  const granted = withReadCodeGrant('', 'proj-a', true)
  assert.equal(hasReadCodeGrant(granted, 'proj-a'), true)
  assert.equal(hasReadCodeGrant(granted, 'proj-b'), false)
})

test('撤销只去掉那一个工程', () => {
  const both = withReadCodeGrant(withReadCodeGrant('', 'proj-a', true), 'proj-b', true)
  assert.deepEqual(parseReadCodeGrant(both), ['proj-a', 'proj-b'])
  const onlyB = withReadCodeGrant(both, 'proj-a', false)
  assert.deepEqual(parseReadCodeGrant(onlyB), ['proj-b'])
})

test('坏值丢掉而不是整串作废，重复项去重', () => {
  assert.deepEqual(parseReadCodeGrant('proj-a, ,proj-a,../../etc/passwd,proj-b'), ['proj-a', 'proj-b'])
  assert.deepEqual(parseReadCodeGrant(null), [])
  assert.equal(serializeReadCodeGrant(['b', 'a', 'b']), 'a,b')
})

test('存储不可用或写入抛错时不抛出去，只是记不住', () => {
  assert.equal(readReadCodeGrant(undefined), '')
  writeReadCodeGrant(undefined, 'proj-a', true)
  const hostile: GrantStore = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
  }
  assert.equal(readReadCodeGrant(hostile), '')
  writeReadCodeGrant(hostile, 'proj-a', true)
})

test('点头一次就落地：写进去之后下一个工程 id 仍然读得到自己那一份', () => {
  const store = memoryStore()
  writeReadCodeGrant(store, 'proj-a', true)
  assert.equal(store.data[READ_CODE_GRANT_KEY], 'proj-a')
  assert.equal(hasReadCodeGrant(readReadCodeGrant(store), 'proj-a'), true)
  writeReadCodeGrant(store, 'proj-a', false)
  assert.equal(hasReadCodeGrant(readReadCodeGrant(store), 'proj-a'), false)
})

/**
 * 行值那份授权守的是用户亲眼看到的现象：「还是会有这种弹窗啊」——
 * 最高权限档下，模型每翻一页运行结果都要人手点一下确认。
 *
 * 判据两条：**没点头之前一律没有授权**（数据行不能因为改了档位就静默出本机），
 * 以及**点头一次之后本工程就不再问**（撤销入口是输入区那个开关）。
 */
test('行值默认没有授权：没点头的工程一律不出本机', () => {
  const store = memoryStore()
  assert.equal(rowEgressAllowed(store, 'proj-a'), false)
  assert.equal(rowEgressAllowed(undefined, 'proj-a'), false, '拿不到存储必须当成没授权')
})

test('行值点头一次即在本工程记住，撤销后立刻回到逐次确认', () => {
  const store = memoryStore()
  writeRowEgressAllowed(store, 'proj-a', true)
  assert.equal(store.data[ROW_GRANT_KEY], 'proj-a')
  assert.equal(rowEgressAllowed(store, 'proj-a'), true)
  assert.equal(rowEgressAllowed(store, 'proj-b'), false, '一个工程的点头不许串到另一个工程')

  writeRowEgressAllowed(store, 'proj-a', false)
  assert.equal(rowEgressAllowed(store, 'proj-a'), false)
})

test('两份授权各占一个键，互不影响', () => {
  const store = memoryStore()
  writeReadCodeGrant(store, 'proj-a', false)
  writeRowEgressAllowed(store, 'proj-a', true)
  assert.equal(hasReadCodeGrant(readReadCodeGrant(store), 'proj-a'), false)
  assert.equal(rowEgressAllowed(store, 'proj-a'), true)
  assert.deepEqual(Object.keys(store.data).sort(), [READ_CODE_GRANT_KEY, ROW_GRANT_KEY].sort())
})
