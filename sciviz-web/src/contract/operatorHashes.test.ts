/**
 * 守三件事，缺一件这条防线就是摆设：
 *
 * 1. **生成物不过期**。改了算子源码却忘了重跑脚本，这里失败 ——
 *    静默过期的哈希比没有哈希更糟：看起来有防线，其实那道线不会动。
 * 2. **哈希对实现敏感**。改函数体会变、改模块常量也会变、只增删 OPERATORS 表不变。
 *    这三条是设计决定（宁可多失效、不可少失效），必须能被直接验证。
 * 3. **哈希真的进了指纹**。否则"改了实现就重算"只是文件里躺着的一堆数字。
 *
 * 这三条合起来才是完整的链：改实现 → 哈希变 → 指纹变 → 下游重算。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { generate, hashOperatorsFromSource, OUTPUT_PATH } from '../../scripts/gen-operator-hashes.mjs'
import { nodeFingerprint } from '../engine/plan'
import { OPERATOR_IMPLEMENTATION_HASHES } from './operatorHashes.generated'
import type { PortContext } from '../workflow/ports'
import type { WorkflowNode } from '../workflow/types'

const HEX64 = /^[0-9a-f]{64}$/

const ctx: PortContext = {
  featuresOf: () => [],
  timeColumnOf: () => null,
}

function node(type: string): WorkflowNode {
  return { id: 'n1', type, label: type, params: {}, position: { x: 0, y: 0 } }
}

/** 一份合成的算子源码，用来单独验证解析与哈希的敏感度 */
function sourceWith(body: string, constant = 'LIMIT = 3', extraEntry = ''): string {
  return [
    'import numpy as np',
    '',
    constant,
    '',
    '',
    'def op_one(env, params, inputs, output_ports):',
    `    ${body}`,
    '',
    '',
    'OPERATORS = {',
    "    'demo.one': op_one,",
    extraEntry,
    '}',
    '',
  ].join('\n')
}

test('生成物是最新的：改了算子实现就必须重跑生成脚本', async () => {
  const expected = await generate()
  const actual = await readFile(OUTPUT_PATH, 'utf8')
  assert.equal(
    actual,
    expected,
    '算子哈希已过期。跑 node scripts/gen-operator-hashes.mjs 重新生成',
  )
})

test('内置算子与宿主专属算子都有 64 位十六进制哈希', () => {
  for (const type of ['data.source', 'data.preview', 'viz.chart', 'viz.density', 'train.mlp']) {
    assert.match(OPERATOR_IMPLEMENTATION_HASHES[type] ?? '', HEX64, `${type} 缺实现哈希`)
  }
})

test('改了函数体，哈希必须变', () => {
  const before = hashOperatorsFromSource(sourceWith('return {"out": data}'))
  const after = hashOperatorsFromSource(sourceWith('return {"out": data * 2}'))
  assert.notEqual(before.hashes['demo.one'], after.hashes['demo.one'])
})

test('改了模块级常量，哈希也必须变（宁可多失效，不可少失效）', () => {
  const before = hashOperatorsFromSource(sourceWith('return {"out": data}'))
  const after = hashOperatorsFromSource(sourceWith('return {"out": data}', 'LIMIT = 4'))
  assert.notEqual(
    before.hashes['demo.one'],
    after.hashes['demo.one'],
    '常量变了但算子哈希没变 —— 那会导致"改了常量却复用旧结果"',
  )
})

test('只增删 OPERATORS 表，已有算子的哈希不变（新增算子不该让全图重算）', () => {
  const one = sourceWith('return {"out": data}')
  const two = sourceWith('return {"out": data}', 'LIMIT = 3', "    'demo.two': op_one,")
  assert.equal(
    hashOperatorsFromSource(one).hashes['demo.one'],
    hashOperatorsFromSource(two).hashes['demo.one'],
  )
})

/*
 * 下面两条是被一个真实的坑逼出来的：解析 OPERATORS 表的正则原先只认 `[\w.]+`，
 * 于是带连字符的节点类型（`feature.scale-apply`）被**静默跳过** —— 那个算子根本没有
 * 实现哈希，改了它的实现指纹不变、下游不重算。整条防线在它要保护的那类键上失效，
 * 而没有任何地方报警。
 */
test('带连字符的节点类型也要有实现哈希（曾经被静默跳过）', () => {
  const src = sourceWith('return {"out": data}', 'LIMIT = 3', "    'demo.scale-apply': op_one,")
  const { hashes } = hashOperatorsFromSource(src)
  assert.match(
    hashes['demo.scale-apply'] ?? '',
    HEX64,
    '连字符的键被跳过了 —— 那等于这个算子没有实现哈希，改实现不会让谁重算',
  )
})

test('OPERATORS 里认不出的条目当场报错，不能静默少一个算子', () => {
  const src = sourceWith('return {"out": data}', 'LIMIT = 3', "    'demo.broken': lambda env: None,")
  assert.throws(
    () => hashOperatorsFromSource(src),
    /认不出来/,
    '认不出来的条目被跳过了 —— 静默少一个算子比生成失败难查得多',
  )
})

test('行尾 CRLF 与行尾空白不算实现变化（Windows 检出不该让全图失效）', () => {
  const lf = sourceWith('return {"out": data}')
  const crlf = lf.replace(/\n/g, '\r\n').replace('LIMIT = 3', 'LIMIT = 3   ')
  assert.equal(hashOperatorsFromSource(lf).hashes['demo.one'], hashOperatorsFromSource(crlf).hashes['demo.one'])
})

test('改注释与空行不算实现变化（总在响的警报等于没有警报）', () => {
  const before = hashOperatorsFromSource(sourceWith('return {"out": data}'))
  const after = hashOperatorsFromSource(
    sourceWith('return {"out": data}').replace('def op_one', '# 一段新说明\n\n\ndef op_one'),
  )
  assert.equal(before.hashes['demo.one'], after.hashes['demo.one'])
})

test('在真实的算子文件里新增一个算子，已有算子的哈希不变', async () => {
  const path = fileURLToPath(new URL('../engine/python/operators.py', import.meta.url))
  const real = await readFile(path, 'utf8')
  const before = hashOperatorsFromSource(real)

  const grown = real
    .replace('OPERATORS = {', '# 新算子\n\n\ndef op_new(env, params, inputs, output_ports):\n    return {}\n\n\nOPERATORS = {')
    .replace("'data.source': op_source,", "'data.source': op_source,\n    'data.new': op_new,")
  const after = hashOperatorsFromSource(grown)

  for (const type of Object.keys(before.hashes)) {
    assert.equal(after.hashes[type], before.hashes[type], `${type} 的哈希被无关改动带变了`)
  }
  assert.ok(after.hashes['data.new'], '新算子应当有自己的哈希')
})

test('实现哈希进了指纹：指纹里必须有 impl=<该算子的哈希>', () => {
  const fingerprint = nodeFingerprint(node('data.preview'), {}, {}, ctx)
  assert.ok(
    fingerprint.includes(`impl=${OPERATOR_IMPLEMENTATION_HASHES['data.preview']}`),
    '指纹里没有实现哈希 —— 改了算子实现，下游不会重算',
  )
})

test('没有实现的节点（函数节点）取空串，不算缺陷', () => {
  const fingerprint = nodeFingerprint(node('custom.script'), {}, {}, ctx)
  assert.ok(fingerprint.includes('impl='), '结构上仍要有这一项，只是值为空')
})
