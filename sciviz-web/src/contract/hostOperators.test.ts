/**
 * 「宿主专属」这件事有两处事实来源，它们必须对得上：
 *
 * 1. Python 侧 `sciviz-local/sciviz_host/gpu_ops.py` 的 `OPERATORS` —— 宿主**真的能算**哪些；
 * 2. 清单里 `NodeTypeDef.requires.runtime === 'host'` —— 界面据此提前告诉用户"这个要宿主"。
 *
 * 两处对不上的后果都很糟，而且是静默的：
 * - 只有 Python 侧有 → 节点在画布上根本不存在，用户看不见一个明明能算的算子；
 * - 只有清单有 → 用户照着提示起了宿主，然后拿到一句"不认识的算子"。
 *
 * 所以两边都断言。这也是 AGENTS.md R4 那条机检的**另一半**：那个脚本守的是
 * "共享算子不许 import 边界之外的库"，这条守的是"边界之外的算子必须自报家门"。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { allNodeDefs } from '../workflow/nodeRegistry'

const GPU_OPS = fileURLToPath(new URL('../../../sciviz-local/sciviz_host/gpu_ops.py', import.meta.url))

async function hostOperatorTypes(): Promise<string[]> {
  const source = await readFile(GPU_OPS, 'utf8')
  const start = source.indexOf('OPERATORS = {')
  assert.ok(start >= 0, 'gpu_ops.py 里找不到 OPERATORS 表')
  const block = source.slice(start)
  // 两种引号都认：Python 侧怎么写是它的事，这里只认"键: 值"这个形状
  return [...block.matchAll(/^\s*['"]([^'"]+)['"]\s*:/gm)].map((m) => m[1])
}

test('宿主专属算子：Python 侧的清单与前端清单必须一一对上', async () => {
  const declared = allNodeDefs()
    .filter((d) => d.requires?.runtime === 'host')
    .map((d) => d.type)
    .sort()
  const fromPython = (await hostOperatorTypes()).sort()

  assert.deepEqual(
    declared,
    fromPython,
    'gpu_ops.py 的 OPERATORS 与注册表里的 requires.runtime = host 必须完全一致',
  )
  assert.ok(declared.length > 0, '一个宿主专属算子都没有的话，这条测试就没有意义')
})

test('声明了需要宿主的算子：必须是真引擎节点，且把要求与原因写全', () => {
  for (const def of allNodeDefs()) {
    if (def.requires?.runtime !== 'host') continue
    assert.equal(
      def.runtimeClass,
      'engine',
      `${def.type} 声明要宿主却又归模拟适配器 —— 那样它永远不会被送进宿主`,
    )
    assert.ok(def.requires.packages.length > 0, `${def.type} 没说它到底要什么包`)
    assert.ok(def.requires.reason.trim().length > 0, `${def.type} 没说为什么需要宿主`)
  }
})
