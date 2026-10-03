import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRunManifest } from '../kernel/manifest'
import { renderReport } from './report'
import type { KernelResult } from '../kernel/types'

/**
 * 报告是"汇报"这件事的载体，所以它自己的两条硬性质要钉住：
 * 1. **事实段与叙述段分开**，叙述段不许污染事实；
 * 2. 时间是**本地时间** —— 报告是给人核对"什么时候跑的"用的。
 */

const result = (over: Partial<KernelResult> = {}): KernelResult => ({
  workflow: {
    id: 'wf',
    name: '示例',
    description: '',
    nodes: [
      { id: 'n1', type: 'data.source', label: '数据源', params: {}, position: { x: 0, y: 0 } },
      { id: 'n2', type: 'train.custom', label: '训练', params: {}, position: { x: 1, y: 0 } },
    ],
    edges: [],
  },
  engineInfo: '假引擎',
  runtimes: {
    n1: { status: 'ready', outputVersion: 1, inputsFingerprint: 'data.source\u0001cols=a' },
    n2: { status: 'error', outputVersion: 0, inputsFingerprint: 'train.custom', error: { message: '炸了', traceback: '第 1 行' } },
  },
  refs: {},
  jobs: [
    {
      nodeId: 'n1',
      nodeType: 'data.source',
      runtime: 'engine',
      fingerprint: 'f1',
      status: 'done',
      startedAt: 0,
      finishedAt: 5,
      durationMs: 5,
    },
  ],
  logs: [],
  notComputed: [{ nodeId: 'n9', nodeType: 'train.custom', reason: '上游输入还没有准备好' }],
  cancelled: false,
  startedAt: new Date(2026, 0, 2, 13, 37, 41).getTime(),
  finishedAt: new Date(2026, 0, 2, 13, 37, 41).getTime(),
  ...over,
})

const factsOf = (type: string) => ({
  version: '0.1.0',
  implementationHash: 'abcd1234',
  runtimeClass: 'engine' as const,
  determinism: type === 'train.custom' ? ('stochastic' as const) : ('deterministic' as const),
  execClass: type === 'train.custom' ? ('background' as const) : ('interactive' as const),
  requires: null,
})

const deps = { runId: 'r-1', validation: null, datasets: [], operatorOf: factsOf }

test('清单：状态由节点实际状态推出，partial 表示"有节点没算"', async () => {
  const m = await buildRunManifest(result(), deps)
  assert.equal(m.status, 'failed', '有节点 error 就是 failed')
  assert.equal(m.nodes.find((n) => n.nodeId === 'n1')?.durationMs, 5)
  assert.equal(m.nodes.find((n) => n.nodeId === 'n2')?.error?.message, '炸了')
  assert.equal(m.notComputed.length, 1)

  const clean = await buildRunManifest(
    result({ runtimes: { n1: { status: 'ready', outputVersion: 1, inputsFingerprint: 'x' } }, jobs: [], notComputed: [] }),
    deps,
  )
  assert.equal(clean.status, 'done')

  const partial = await buildRunManifest(
    result({ runtimes: { n1: { status: 'ready', outputVersion: 1, inputsFingerprint: 'x' } }, jobs: [] }),
    deps,
  )
  assert.equal(partial.status, 'partial', '有节点没实现就不能说"全部算完"')
})

test('清单：保留 Matplotlib 图片尺寸，但不把 Base64 图片塞进运行记录', async () => {
  const m = await buildRunManifest(
    result({
      refs: {
        n1: {
          figure: {
            kind: 'figure',
            image: {
              mimeType: 'image/png',
              data: 'very-large-base64-payload',
              width: 240,
              height: 180,
            },
          },
        },
      },
    }),
    deps,
  )
  const output = m.nodes.find((n) => n.nodeId === 'n1')?.outputs.figure

  assert.deepEqual(output, {
    kind: 'figure',
    image: { mimeType: 'image/png', width: 240, height: 180 },
  })
  assert.equal(JSON.stringify(m).includes('very-large-base64-payload'), false)
})

test('清单：图指纹对同一张图稳定，对改动敏感', async () => {
  const a = await buildRunManifest(result(), deps)
  const b = await buildRunManifest(result(), deps)
  assert.equal(a.graphFingerprint, b.graphFingerprint)

  const changed = await buildRunManifest(
    result({
      runtimes: {
        n1: { status: 'ready', outputVersion: 1, inputsFingerprint: 'data.source\u0001cols=ab' },
      },
    }),
    deps,
  )
  assert.notEqual(a.graphFingerprint, changed.graphFingerprint)
})

test('报告：事实段与叙述段分开，且时间是本地时间', async () => {
  const m = await buildRunManifest(result(), deps)
  const text = renderReport(m)

  assert.match(text, /## 事实/)
  assert.match(text, /## 叙述/)
  assert.ok(text.indexOf('## 事实') < text.indexOf('## 叙述'))

  // 本地时间：构造时用的是本机时间 13:37:41，报告里就该是 13:37:41 而不是 UTC 的 05:37:41
  assert.match(text, /2026-01-02 13:37:41/)
  assert.equal(text.includes('05:37:41'), false)

  assert.match(text, /炸了/)
  assert.match(text, /第 1 行/)
  assert.match(text, /上游输入还没有准备好/)
  assert.match(text, /本报告不包含它们的结论/)
})

test('清单与报告都带上算子事实：版本 / 实现哈希 / 确定性 / 执行等级', async () => {
  const m = await buildRunManifest(result(), deps)
  const n1 = m.nodes.find((n) => n.nodeId === 'n1')
  assert.equal(n1?.operator?.version, '0.1.0')
  assert.equal(n1?.operator?.implementationHash, 'abcd1234')
  assert.equal(n1?.operator?.execClass, 'interactive')
  assert.equal(n1?.operator?.runtimeClass, 'engine')

  // 算子版本集合按类型去重（R6.3 的"算子版本集合"）
  assert.deepEqual(
    m.operatorVersions.map((o) => o.type),
    ['data.source', 'train.custom'],
  )

  const text = renderReport(m)
  assert.match(text, /### 可复现性/)
  assert.match(text, /这次用到的算子是哪一版实现/)
})

test('determinism = stochastic 且真算出东西的节点，必须进"不可复现贡献项"（R6）', async () => {
  const computed = await buildRunManifest(
    result({
      runtimes: {
        n1: { status: 'ready', outputVersion: 1, inputsFingerprint: 'a' },
        n2: { status: 'ready', outputVersion: 1, inputsFingerprint: 'b' },
      },
      jobs: [],
    }),
    deps,
  )
  assert.equal(computed.unreproducible.length, 1)
  assert.equal(computed.unreproducible[0].nodeType, 'train.custom')
  assert.match(computed.unreproducible[0].reason, /stochastic/)
  assert.match(renderReport(computed), /不可复现贡献项/)

  // 没算出来的 stochastic 节点不算贡献项：没有产物，就没有东西可担保
  const failed = await buildRunManifest(result(), deps)
  assert.equal(failed.unreproducible.length, 0)
  assert.match(renderReport(failed), /没有\*\*已知的\*\*不可复现来源/)
})

test('运行清单带上环境：换台机器重跑对不上时，只有这几项能做差（R6.3）', async () => {
  const m = await buildRunManifest(result(), {
    ...deps,
    environment: {
      python: '3.12.8',
      numpy: '2.3.3',
      pandas: '2.3.3',
      scipy: '1.18.0',
      torch: '2.13.0+cu126',
      cuda: '12.6',
      gpuNames: ['NVIDIA GeForce RTX 3050 Laptop GPU'],
      totalMemoryMb: 4095,
      device: 'cuda',
    },
  })
  assert.equal(m.environment?.torch, '2.13.0+cu126')
  const text = renderReport(m)
  assert.match(text, /### 环境/)
  assert.match(text, /torch 2\.13\.0\+cu126 · CUDA 12\.6/)
  assert.match(text, /RTX 3050/)
  assert.ok(
    !m.gaps.some((g) => g.includes('环境信息')),
    '环境既然记进来了，就不该还挂在"本次没有承诺的东西"里',
  )

  // 没问到环境时不许编：记 null，并在报告里说清"没问到 ≠ 这台机器什么都没有"
  const unknown = await buildRunManifest(result(), deps)
  assert.equal(unknown.environment, null)
  assert.match(renderReport(unknown), /没问到宿主的环境/)
})

test('训练产物也进清单与报告：路径 + 指纹（T8）', async () => {
  const m = await buildRunManifest(
    result({
      runtimes: {
        n1: { status: 'ready', outputVersion: 1, inputsFingerprint: 'a' },
        n2: {
          status: 'ready',
          outputVersion: 1,
          inputsFingerprint: 'b',
          artifacts: [
            {
              kind: 'model',
              path: 'E:\\科研数据图帮助\\.artifacts\\0123456789abcdef\\model.pt',
              bytes: 3456,
              fingerprint: 'model.train\u0001...',
            },
          ],
        },
      },
      jobs: [],
    }),
    deps,
  )

  const node = m.nodes.find((n) => n.nodeId === 'n2')
  assert.equal(node?.artifacts?.[0].kind, 'model')
  assert.equal(node?.artifacts?.[0].bytes, 3456)

  const text = renderReport(m)
  assert.match(text, /产物/)
  assert.match(text, /model\.pt/)
  assert.match(text, /3\.4 kB/, '报告里要能看到它有多大')
})

test('节点自报的元信息进清单与报告：设备与版本（T11）', async () => {
  const m = await buildRunManifest(
    result({
      runtimes: {
        n1: { status: 'ready', outputVersion: 1, inputsFingerprint: 'a' },
        n2: {
          status: 'ready',
          outputVersion: 1,
          inputsFingerprint: 'b',
          meta: { 设备: 'cuda', GPU: 'RTX 3050 Laptop', torch: '2.13.0+cu126' },
        },
      },
      jobs: [],
    }),
    deps,
  )

  assert.equal(m.nodes.find((n) => n.nodeId === 'n2')?.meta?.设备, 'cuda')
  assert.equal(m.nodes.find((n) => n.nodeId === 'n1')?.meta, undefined)

  const text = renderReport(m)
  assert.match(text, /### 节点自报的元信息/)
  assert.match(text, /设备 cuda · GPU RTX 3050 Laptop · torch 2\.13\.0\+cu126/)
})
