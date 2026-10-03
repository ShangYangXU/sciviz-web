import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  findLatestManifest,
  inspectablePorts,
  selectResultNodes,
  selectRowPort,
} from './inspection'

test('结果发现列出真实端口，并只把 table 标成可读取行值', () => {
  assert.deepEqual(
    inspectablePorts({
      head: { kind: 'table', columns: ['x'], rowCount: 2 },
      metrics: { kind: 'metrics', values: { acc: 1 } },
    }),
    [
      { portId: 'head', kind: 'table', rows: true, columns: ['x'], rowCount: 2 },
      { portId: 'metrics', kind: 'metrics', rows: false },
    ],
  )
})

test('省略端口时选择唯一 table，而不是硬编码 data', () => {
  const selected = selectRowPort({ head: { kind: 'table', rowCount: 3 } })
  assert.equal(selected.ok, true)
  if (selected.ok) assert.equal(selected.portId, 'head')
})

test('结果发现保留摘要统计、身份与上游血缘，但不带行值', () => {
  const ports = inspectablePorts({
    output: {
      kind: 'table',
      columns: ['x'],
      rowCount: 10,
      timeColumn: null,
      stats: { x: { count: 10, min: 1, max: 5, mean: 3, std: 1.2 } },
      identity: 'sha256:node',
      lineage: ['source:table'],
    },
  })
  assert.deepEqual(ports[0], {
    portId: 'output',
    kind: 'table',
    rows: true,
    columns: ['x'],
    rowCount: 10,
    timeColumn: null,
    stats: { x: { count: 10, min: 1, max: 5, mean: 3, std: 1.2 } },
    identity: 'sha256:node',
    lineage: ['source:table'],
  })
})

test('模型侧结果发现可以明确隐藏含代码的完整内部指纹', () => {
  const ports = inspectablePorts({ output: { kind: 'table', identity: `code=${'x'.repeat(100_000)}` } }, { includeIdentity: false })
  assert.equal('identity' in ports[0], false)
})

test('多个 table 端口时拒绝猜测并返回候选', () => {
  const selected = selectRowPort({
    train: { kind: 'table', rowCount: 3 },
    test: { kind: 'table', rowCount: 2 },
    scaler: { kind: 'scaler' },
  })
  assert.equal(selected.ok, false)
  if (!selected.ok) {
    assert.match(selected.message, /--port/)
    assert.deepEqual(
      selected.availablePorts.filter((port) => port.rows).map((port) => port.portId),
      ['train', 'test'],
    )
  }
})

test('节点选择支持 id 与唯一标签，重名标签拒绝猜测', () => {
  const nodes = [
    { nodeId: 'n1', label: '预览', outputs: {} },
    { nodeId: 'n2', label: '预览', outputs: {} },
    { nodeId: 'n3', label: '指标', outputs: {} },
  ]
  assert.equal(selectResultNodes(nodes, 'n1').ok, true)
  assert.equal(selectResultNodes(nodes, '指标').ok, true)
  const duplicate = selectResultNodes(nodes, '预览')
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.match(duplicate.message, /不唯一/)
})

test('--from latest 只取最近一次同名工程，不误读别的工程', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sciviz-inspect-'))
  const runs = path.join(root, 'runs')
  fs.mkdirSync(path.join(runs, 'mine-old'), { recursive: true })
  fs.mkdirSync(path.join(runs, 'other-new'), { recursive: true })
  fs.writeFileSync(path.join(runs, 'mine-old', 'run.json'), '{}')
  fs.writeFileSync(path.join(runs, 'other-new', 'run.json'), '{}')
  fs.writeFileSync(
    path.join(runs, 'index.json'),
    JSON.stringify([
      { runId: 'mine-old', workflow: '我的工程' },
      { runId: 'other-new', workflow: '别的工程' },
    ]),
  )

  const hit = findLatestManifest({
    projectPath: path.join(root, 'project.sciviz'),
    workflowName: '我的工程',
    outDir: runs,
    defaultOutDir: runs,
  })
  assert.equal(hit.ok, true)
  if (hit.ok) assert.equal(hit.runId, 'mine-old')
})
