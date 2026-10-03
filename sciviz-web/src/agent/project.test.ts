import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadProject } from './project'

/**
 * 无头装载器的钉子。
 *
 * 守的是"工程文件 × 手上的 CSV"怎么对上：按名字、按 id、对不上时怎么说、
 * 行数不一致要不要提醒。这几件事错了，agent 会在用错数据的情况下跑到底，
 * 而且得不到任何提示 —— 那是这个项目最不能出的错。
 */

const CSV = [
  '时间,液位,流量',
  '2026-01-01 00:00:00,1,2',
  '2026-01-01 00:00:01,3,4',
  '2026-01-01 00:00:02,5,6',
  '2026-01-01 00:00:03,7,8',
].join('\n')

const YAML = `
name: 装载测试
nodes:
  - id: n1
    type: data.source
    label: 数据源
    params: { datasetId: ds-1-zzzz }
    dataset: { name: 锅炉数据, rowCount: 4 }
    position: { x: 0, y: 0 }
  - id: n2
    type: data.preview
    label: 预览
    params: {}
    position: { x: 200, y: 0 }
edges:
  - { source: n1, sourcePort: __table__, target: n2, targetPort: data }
`

function sandbox(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sciviz-proj-'))
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8')
  }
  return dir
}

test('按导出时记下的名字绑定数据集：端口因此能算出来', async () => {
  const dir = sandbox({ 'w.yaml': YAML, 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'w.yaml'), [
    { key: '锅炉数据', path: path.join(dir, 'd.csv') },
  ])

  assert.ok(project.workflow)
  assert.equal(project.bound.length, 1)
  assert.equal(project.bound[0].datasetId, 'ds-1-zzzz', '装载后要注册在节点真正引用的 id 上')
  assert.equal(project.bound[0].rowCount, 4)
  assert.equal(project.bound[0].rowCountMismatch, false)
  assert.equal(project.unbound.length, 0)
  assert.match(project.datasets[0].contentHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(project.catalog.featuresOf('ds-1-zzzz').join(','), '液位,流量')
  assert.equal(project.validation?.ok, true, '端口能算出来之后，校验才真正检查连线')
})

test('按数据集 id 绑定也可以 —— 两种键都认', async () => {
  const dir = sandbox({ 'w.yaml': YAML, 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'w.yaml'), [
    { key: 'ds-1-zzzz', path: path.join(dir, 'd.csv') },
  ])
  assert.equal(project.bound.length, 1)
  assert.equal(project.unbound.length, 0)
})

test('没有绑定时：工程照样装载、连线原样保留，并说清怎么绑', async () => {
  const dir = sandbox({ 'w.yaml': YAML })
  const project = await loadProject(path.join(dir, 'w.yaml'), [])

  assert.ok(project.workflow, '缺数据不该让工程读不了 —— 那会把"还没绑"误判成"文件坏了"')
  assert.equal(project.workflow.edges.length, 1, '连线必须留着')
  assert.equal(project.unbound.length, 1)
  assert.equal(project.unbound[0].name, '锅炉数据')
  assert.ok(
    project.importWarnings.some((w) => w.includes('--data')),
    '要告诉调用方怎么绑，而不是只说"少数据"',
  )
})

test('行数与导出时不一致：提请核对，但不阻断', async () => {
  const short = '时间,液位\n2026-01-01 00:00:00,1\n2026-01-01 00:00:01,2\n'
  const dir = sandbox({ 'w.yaml': YAML, 'd.csv': short })
  const project = await loadProject(path.join(dir, 'w.yaml'), [
    { key: '锅炉数据', path: path.join(dir, 'd.csv') },
  ])

  assert.equal(project.bound[0].rowCountMismatch, true)
  assert.equal(project.bound[0].declaredRowCount, 4)
  assert.equal(project.bound[0].rowCount, 2)
  assert.ok(project.importWarnings.some((w) => w.includes('行')))
})

test('绑了一个图里没引用的键：说出来，别默默忽略', async () => {
  const dir = sandbox({ 'w.yaml': YAML, 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'w.yaml'), [
    { key: '查无此数据', path: path.join(dir, 'd.csv') },
  ])
  assert.ok(project.usageErrors.some((e) => e.includes('查无此数据')))
  assert.equal(project.bound.length, 0)
})

test('CSV 路径不存在 / 工程文件不存在：都算用法错误', async () => {
  const dir = sandbox({ 'w.yaml': YAML })
  const missingCsv = await loadProject(path.join(dir, 'w.yaml'), [
    { key: '锅炉数据', path: path.join(dir, 'nope.csv') },
  ])
  assert.ok(missingCsv.usageErrors.some((e) => e.includes('nope.csv')))

  const missingYaml = await loadProject(path.join(dir, 'nope.yaml'), [])
  assert.ok(missingYaml.usageErrors.some((e) => e.includes('工程文件不存在')))
  assert.equal(missingYaml.workflow, null)
})

test('两个数据集 id 指向同一份 CSV：都能用，身份也一样', async () => {
  const two = YAML.replace(
    '  - id: n2',
    [
      '  - id: n1b',
      '    type: data.source',
      '    label: 数据源乙',
      '    params: { datasetId: ds-2-yyyy }',
      '    dataset: { name: 同一份, rowCount: 4 }',
      '    position: { x: 0, y: 200 }',
      '  - id: n2',
    ].join('\n'),
  )
  const dir = sandbox({ 'w.yaml': two, 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'w.yaml'), [
    { key: '锅炉数据', path: path.join(dir, 'd.csv') },
    { key: '同一份', path: path.join(dir, 'd.csv') },
  ])
  assert.equal(project.bound.length, 2)
  assert.equal(project.datasets.length, 2)
  assert.equal(
    project.datasets[0].contentHash,
    project.datasets[1].contentHash,
    '内容一样就是同一个身份 —— 身份是内容，不是 id',
  )
})

/* ------------------------------------------------------------------ */
/* .sciviz 工程文件：人机轮流共用那一份状态                             */
/* ------------------------------------------------------------------ */

const PROJECT_YAML = (opts: { hash?: string; columns?: string; path?: string } = {}) => `
version: 1
name: 人机轮流示例
description: 人搭了一半，agent 接手
graph:
  nodes:
    - id: n1
      type: data.source
      label: 数据源
      params: { datasetId: ds-1-zzzz }
      position: { x: 0, y: 0 }
    - id: n2
      type: data.preview
      label: 预览
      params: {}
      position: { x: 200, y: 0 }
  edges:
    - { source: n1, sourcePort: __table__, target: n2, targetPort: data }
datasets:
  - id: ds-1-zzzz
    name: 锅炉数据
    path: ${opts.path ?? 'd.csv'}
    ${opts.hash ? `contentHash: ${opts.hash}` : ''}
    timeColumn: 时间
    columns:
${opts.columns ?? '      - { name: 液位, type: number, role: continuous, enabled: true }\n      - { name: 流量, type: number, role: continuous, enabled: true }'}
`

test('.sciviz：数据路径记在工程里，--data 可以省掉', async () => {
  const dir = sandbox({ 'p.sciviz': PROJECT_YAML(), 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'p.sciviz'), [])

  assert.ok(project.workflow)
  assert.equal(project.bound.length, 1)
  assert.equal(project.bound[0].boundBy, 'path')
  assert.equal(project.unbound.length, 0)
  assert.equal(project.usageErrors.length, 0)
  assert.equal(project.project?.name, '人机轮流示例')
})

test('.sciviz：人在界面上关掉的列，agent 接手时也必须关着', async () => {
  // 只启用「液位」——这是人在数据面板上做的决定
  const view = '      - { name: 液位, type: number, role: continuous, enabled: true }\n      - { name: 流量, type: number, role: continuous, enabled: false }'
  const dir = sandbox({ 'p.sciviz': PROJECT_YAML({ columns: view }), 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'p.sciviz'), [])

  assert.deepEqual(
    project.catalog.featuresOf('ds-1-zzzz'),
    ['液位'],
    '视图没生效的话，同一份数据人跑出来和 agent 跑出来会不一样 —— 而且两边都不报错',
  )
})

test('.sciviz：内容哈希对不上时出声 —— 这几乎肯定是换了一份数据', async () => {
  const wrong = 'sha256:' + 'b'.repeat(64)
  const dir = sandbox({ 'p.sciviz': PROJECT_YAML({ hash: wrong }), 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'p.sciviz'), [])

  assert.equal(project.bound[0].contentHashMismatch, true)
  assert.ok(project.importWarnings.some((w) => w.includes('不是同一份')))
})

test('.sciviz：记的路径找不到文件时，说清去哪儿找', async () => {
  const dir = sandbox({ 'p.sciviz': PROJECT_YAML({ path: 'data/nope.csv' }) })
  const project = await loadProject(path.join(dir, 'p.sciviz'), [])

  assert.ok(project.workflow, '数据不在不该让工程读不了')
  assert.equal(project.unbound.length, 1)
  assert.ok(project.unbound[0].missingPath?.endsWith('nope.csv'))
  assert.ok(project.importWarnings.some((w) => w.includes('找不到文件')))
})

test('.sciviz：工程里启用了数据里没有的列 —— 提请核对，别默默算', async () => {
  const view = '      - { name: 不存在的列, type: number, role: continuous, enabled: true }'
  const dir = sandbox({ 'p.sciviz': PROJECT_YAML({ columns: view }), 'd.csv': CSV })
  const project = await loadProject(path.join(dir, 'p.sciviz'), [])
  assert.ok(project.importWarnings.some((w) => w.includes('不存在的列')))
})
