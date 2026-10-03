import test from 'node:test'
import assert from 'node:assert/strict'
import { compareManifests } from './drift'
import type { RunManifest, RunManifestNode } from './manifest'

/**
 * 跨运行对比的钉子。
 *
 * 它守的是"可复现"这个主张：**同一张图跑两遍，数值应当一致。**
 * 所以最要紧的一条判据是 —— 图没变而值变了，必须报出来（那不是抖动，那是不可复现）。
 */

const node = (over: Partial<RunManifestNode> = {}): RunManifestNode => ({
  nodeId: 'n1',
  nodeType: 'data.source',
  label: '数据源',
  runtime: 'engine',
  status: 'ready',
  outputVersion: 1,
  fingerprint: 'f1',
  fingerprintShort: 'aaaa1111',
  durationMs: 10,
  operator: {
    version: '0.1.0',
    implementationHash: 'bbbb2222',
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
  },
  outputs: { out: { kind: 'table', rowCount: 100, columns: ['a', 'b'] } },
  ...over,
})

const manifest = (over: Partial<RunManifest> = {}): RunManifest => ({
  manifestVersion: 1,
  runId: 'r1',
  startedAt: 0,
  finishedAt: 100,
  durationMs: 100,
  status: 'done',
  workflow: { name: 'w', description: '', nodeCount: 1, edgeCount: 0 },
  graphFingerprint: 'sha256:same',
  engine: { info: '假引擎' },
  environment: null,
  datasets: [],
  nodes: [node()],
  operatorVersions: [{ type: 'data.source', version: '0.1.0', implementationHash: 'bbbb2222' }],
  unreproducible: [],
  notComputed: [],
  contract: null,
  gaps: [],
  ...over,
})

test('同一张图、数值一致：结论就是"没有变化"，并点明这是可复现的证据', () => {
  const d = compareManifests(manifest(), manifest({ runId: 'r2' }))
  assert.equal(d.sameGraph, true)
  assert.equal(d.changes.length, 0)
  assert.match(d.summary[0], /没有变化/)
  assert.match(d.summary[0], /可复现/)
})

test('同一张图但指标变了：这才是最该被看见的一类', () => {
  const before = manifest({
    nodes: [node({ nodeId: 'n9', nodeType: 'model.train', outputs: { metrics: { kind: 'metrics', values: { acc: 0.91, loss: 0.2 } } } })],
  })
  const after = manifest({
    runId: 'r2',
    nodes: [node({ nodeId: 'n9', nodeType: 'model.train', outputs: { metrics: { kind: 'metrics', values: { acc: 0.87, loss: 0.2 } } } })],
  })
  const d = compareManifests(before, after)
  assert.equal(d.sameGraph, true)
  const acc = d.changes.find((c) => c.metric === 'acc')
  assert.ok(acc, JSON.stringify(d.changes))
  assert.equal(acc.from, 0.91)
  assert.equal(acc.to, 0.87)
  assert.ok(Math.abs((acc.relDelta ?? 0) + 0.0439) < 0.001, `relDelta=${acc.relDelta}`)
  assert.ok(d.summary.some((s) => s.includes('对不上')), d.summary.join('|'))
})

test('图指纹不同：数值差异要明确标注"未必可比"', () => {
  const d = compareManifests(manifest(), manifest({ runId: 'r2', graphFingerprint: 'sha256:other' }))
  assert.equal(d.sameGraph, false)
  assert.ok(d.summary.some((s) => s.includes('图指纹不同')), d.summary.join('|'))
})

test('图改了、节点也变了：结论文案要提醒"未必可比"', () => {
  const before = manifest()
  const after = manifest({
    runId: 'r2',
    graphFingerprint: 'sha256:other',
    nodes: [node(), node({ nodeId: 'n2', label: '新加的' })],
  })
  const d = compareManifests(before, after)
  assert.equal(d.sameGraph, false)
  assert.ok(d.summary.some((s) => s.includes('不是同一张图')), d.summary.join('|'))
})

test('节点新增 / 消失 / 状态变化 / 耗时变化都认得出', () => {
  const before = manifest({
    nodes: [
      node(),
      node({ nodeId: 'n2', label: '分帧', status: 'ready', durationMs: 10 }),
      node({ nodeId: 'n3', label: '要消失的' }),
    ],
  })
  const after = manifest({
    runId: 'r2',
    nodes: [
      node(),
      node({ nodeId: 'n2', label: '分帧', status: 'error', durationMs: 100, error: { message: '炸了', traceback: '' } }),
      node({ nodeId: 'n4', label: '新增的' }),
    ],
  })
  const kinds = new Set(compareManifests(before, after).changes.map((c) => c.kind))
  assert.ok(kinds.has('added'), '新节点')
  assert.ok(kinds.has('removed'), '消失的节点')
  assert.ok(kinds.has('status'), '状态变化')
  assert.ok(kinds.has('duration'), '耗时变化')
})

test('耗时的小抖动不报：毫秒级差异没有信息量', () => {
  const before = manifest({ nodes: [node({ durationMs: 100 })] })
  const after = manifest({ runId: 'r2', nodes: [node({ durationMs: 110 })] })
  assert.equal(compareManifests(before, after).changes.length, 0)
})

test('耗时的大变化要报：3 秒变成 8 秒是有信息量的', () => {
  const before = manifest({ nodes: [node({ durationMs: 3000 })] })
  const after = manifest({ runId: 'r2', nodes: [node({ durationMs: 8000 })] })
  const d = compareManifests(before, after)
  assert.ok(d.changes.some((c) => c.kind === 'duration'), JSON.stringify(d.changes))
})

test('行数变化算数值变化（不是"输出结构变化"）', () => {
  const before = manifest({ nodes: [node({ outputs: { out: { kind: 'table', rowCount: 100, columns: ['a'] } } })] })
  const after = manifest({
    runId: 'r2',
    nodes: [node({ outputs: { out: { kind: 'table', rowCount: 1022, columns: ['a'] } } })],
  })
  const d = compareManifests(before, after)
  const row = d.changes.find((c) => c.metric === '行数')
  assert.ok(row, JSON.stringify(d.changes))
  assert.equal(row.from, 100)
  assert.equal(row.to, 1022)
})
