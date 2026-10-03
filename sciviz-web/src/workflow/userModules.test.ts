import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUserModule,
  checkUserModuleDraft,
  isUserModuleType,
  moduleTypeId,
  previewPorts,
  sanitizeStoredModules,
  DEFAULT_MODULE_CODE,
  USER_MODULE_PREFIX,
  type UserModuleDraft,
} from './userModules'
import { getNodeTypeDef, hasNodeType } from './nodeRegistry'
import { resolvePorts, type PortContext } from './ports'
import { isEngineNode, needsUserFn } from '../engine/plan'
import { useModuleStore } from '../store/useModuleStore'

const draft = (over: Partial<UserModuleDraft> = {}): UserModuleDraft => ({
  label: '带通滤波',
  category: 'feature',
  description: '按截止频率做带通滤波',
  code: 'def bandpass(signal, low=0.05, high=0.4):\n    return {"filtered": signal}\n',
  ...over,
})

test('type 生成：前缀固定、同一个名字不撞车、不产生重名', () => {
  const id = moduleTypeId('带通滤波', [])
  assert.ok(id.startsWith(USER_MODULE_PREFIX))
  assert.ok(isUserModuleType(id))

  // 中文名推不出拼音，退到 mod 前缀是预期的，不是缺陷
  assert.match(id, /^custom\.user\.mod_/)

  const ascii = moduleTypeId('Band Pass', [])
  assert.match(ascii, /^custom\.user\.band_pass_/)

  // 连续生成（把已生成的都算作已占用）不能出现重复
  const taken = new Set<string>([id])
  for (let i = 0; i < 50; i++) {
    const next = moduleTypeId('带通滤波', taken)
    assert.ok(!taken.has(next), `第 ${i + 1} 次生成的 type 撞车了：${next}`)
    taken.add(next)
  }
  assert.equal(taken.size, 51)
})

test('草稿校验：名称、分类、代码逐条拦下', () => {
  assert.equal(checkUserModuleDraft(draft()).error, undefined)
  assert.match(checkUserModuleDraft(draft({ label: '   ' })).error ?? '', /名称/)
  assert.match(
    checkUserModuleDraft(draft({ category: 'nope' as unknown as UserModuleDraft['category'] })).error ?? '',
    /分类/,
  )
  assert.match(checkUserModuleDraft(draft({ code: '' })).error ?? '', /代码不能为空/)
  assert.match(checkUserModuleDraft(draft({ code: 'x = 1\n' })).error ?? '', /解析失败/)
})

test('草稿 → 定义：端口留空由签名解析，代码进 params', () => {
  const def = buildUserModule(draft(), 'custom.user.demo_0001')
  assert.equal(def.type, 'custom.user.demo_0001')
  assert.equal(def.label, '带通滤波')
  assert.equal(def.category, 'feature')
  assert.deepEqual(def.inputs, [])
  assert.deepEqual(def.outputs, [])
  assert.equal(def.params.length, 1)
  assert.equal(def.params[0].key, 'code')
  assert.match(String(def.params[0].default), /def bandpass/)
})

test('端口预览：无默认值的必接，有默认值的可选', () => {
  const p = previewPorts('def f(a, b=2):\n    return {"out": a, "n": b}\n')
  assert.deepEqual(p.inputs, [
    { name: 'a', optional: false },
    { name: 'b', optional: true },
  ])
  assert.deepEqual(p.outputs, ['out', 'n'])
  assert.ok(previewPorts('def broken(').error)
})

test('本地存储读回来的东西：坏的丢掉，好的留下，重复的只留一条', () => {
  const good = buildUserModule(draft(), 'custom.user.keep_0001')
  const kept = sanitizeStoredModules([
    good,
    { type: 'viz.chart', label: '内置的不该混进来', params: { code: 'x' } },
    { type: 'custom.user.bad_0002', label: '', params: { code: 'x' } },
    { type: 'custom.user.nocode_0003', label: '没有代码', params: {} },
    'not an object',
    { ...good, label: '重复的同一个 type' },
  ])
  assert.equal(kept.length, 1)
  assert.equal(kept[0].type, 'custom.user.keep_0001')
  assert.match(String(kept[0].params[0].default), /def bandpass/)
  assert.deepEqual(sanitizeStoredModules('nope'), [])
})

test('存起来的自建模块能进注册表、解析出端口、并走引擎真算', () => {
  const type = 'custom.user.itest_0001'
  const res = useModuleStore.getState().saveModule(type, draft(), false)
  assert.equal(res.ok, true)

  assert.ok(hasNodeType(type))
  assert.equal(getNodeTypeDef(type).label, '带通滤波')

  const node = { id: 'n1', type, label: '带通滤波', params: { code: draft().code }, position: { x: 0, y: 0 } }
  const ctx: PortContext = { featuresOf: () => [], timeColumnOf: () => null }
  const ports = resolvePorts(node, ctx)
  assert.deepEqual(
    ports.inputs.map((p) => p.id),
    ['signal', 'low', 'high'],
  )
  assert.deepEqual(
    ports.outputs.map((p) => p.id),
    ['filtered'],
  )

  // 自建模块是"用户写的函数"，和 custom.script 同一条引擎路径
  assert.equal(isEngineNode(type), true)
  assert.equal(needsUserFn(type), true)

  // 清理：别把测试数据留在这个进程的 store 里
  useModuleStore.getState().removeModule(type)
  assert.equal(hasNodeType(type), false)
})

test('默认示例代码本身是合法的', () => {
  assert.equal(checkUserModuleDraft(draft({ code: DEFAULT_MODULE_CODE })).error, undefined)
})
