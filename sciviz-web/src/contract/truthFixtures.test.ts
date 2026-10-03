import test from 'node:test'
import assert from 'node:assert/strict'
import { NAIVE, TRUTH_FIXTURES, naivePeak, type TruthFixture } from './truthFixtures'
import { validateWorkflow } from './validate'
import { projectPortContext } from '../workflow/project'
import { getNodeTypeDef } from '../workflow/nodeRegistry'

/**
 * 真值夹具的"自相矛盾"检查。
 *
 * 注册表里的期望值是**手写的数字**，手写的数字会抄错。所以这里对每一条再做一遍
 * 独立重算：抄错了、算错了、引用了一个不存在的端口，都在 `npm test` 里红 ——
 * 而不是在半年后变成一句"这个数一直是错的"。
 *
 * 三条判据：
 * 1. **每个数都有出处**（`from` 非空），且能被下面这份重算表再算一遍；
 * 2. **夹具本身是一张合法的图**（用工程里的数据集视图过一遍 L1）——
 *    夹具自己接错了线，验出来的"不一致"就与算子无关；
 * 3. 要核对的端口真的在那个节点的输出端口里（否则 `verify` 会静静地什么都不比）。
 */

const secondsOf = (f: TruthFixture): number[] =>
  f.data.rows.map((row) => {
    const at = f.data.header.indexOf(f.data.timeColumn)
    const s = String(row[at])
    const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s)
    assert.ok(parts)
    return new Date(
      Number(parts[1]),
      Number(parts[2]) - 1,
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6]),
    ).getTime() / 1000
  })

const paramsOf = (f: TruthFixture, nodeId: string) =>
  f.graph.nodes.find((n) => n.id === nodeId)?.params ?? {}

/**
 * 每个要核对的数 → 独立重算它。
 *
 * 键是 `<夹具 id>/<节点>/<指标>`。**缺一条就跑不过**：新加夹具时会被逼着
 * 写清"这个数到底怎么来的"，这正是这个文件存在的意义。
 */
const RECOMPUTE: Record<string, (f: TruthFixture) => number> = {
  'viz.chart.upstream/chart/figure/rowCount': (f) => f.data.rows.length,
  'viz.chart.upstream/chart/figure/columns': (f) => f.data.header.length,
  'custom.chart.figure/chart/figure/rowCount': (f) => f.data.rows.length,
  'custom.chart.figure/chart/figure/columns': (f) => f.data.header.length,
  'data.collect.columns/collect/data/rowCount': (f) => f.data.rows.length,
  'data.collect.columns/collect/data/columns': (f) =>
    f.graph.edges.filter((e) => e.target === 'collect').length,
  /*
   * 概率密度图。两个数都是从夹具自己算的：行数是"抽样上限没超就一个不丢"，
   * 列数是"拆列给的就是单列表"。这里刻意不核对曲线的数值 —— KDE 的带宽是估计量，
   * 拿引擎的输出当期望值只能证明"它和上次跑得一样"，那不是真值。
   */
  'viz.density.column/den/figure/rowCount': (f) => f.data.rows.length,
  'viz.density.column/den/figure/columns': () => 1,
  'train.mlp.shape/hist/history/rowCount': (f) => Number(paramsOf(f, 'hist').epochs),
  'train.mlp.shape/hist/metrics/参数量': (f) => {
    // 与夹具的解析解同一条公式，但这里从**夹具自己的数据**推 d：特征列数（标签不算）
    const hidden = Number(paramsOf(f, 'hist').hidden)
    const d = f.data.features.length - 1 // features 里有 x 和 y，y 是标签
    const out = 1 // 回归
    return d * hidden + hidden + hidden * hidden + hidden + hidden * out + out
  },
  'data.columns.perColumn/split/液位/rowCount': (f) => f.data.rows.length,
  'data.columns.perColumn/split/液位/columns': () => 1,
  'data.columns.perColumn/split/流量/rowCount': (f) => f.data.rows.length,
  'eval.score.accuracy/score/metrics/准确率': (f) => {
    // 手算：逐行比两个标签列
    const t = f.data.header.indexOf('真实')
    const p = f.data.header.indexOf('预测')
    const right = f.data.rows.filter((row) => row[t] === row[p]).length
    return right / f.data.rows.length
  },
}

test('每条夹具的每个数都能被独立重算一遍（手抄错数字会红）', () => {
  const seen = new Set<string>()
  for (const f of TRUTH_FIXTURES) {
    for (const cell of f.cells) {
      // 端口也进键：同一个节点可能有多个端口要核对（数据划分的 train/val/test 就是），
      // 不带端口的话三条会撞成一个键，而"撞键"在下面那条唯一性断言里会被发现
      // 行号也进键：同一个端口上的两个数可能只在"读第几行"上不同（分帧的标签就是）
      const id =
        `${f.id}/${cell.nodeId}/${cell.portId ?? 'data'}/${cell.key}` +
        // 显式写了行号就带上（哪怕写的是 0）——"第 0 行"与"默认第一行"是同一个口径，
        // 但键要保持与重算表一致，别让 0 悄悄消失
        (cell.rowIndex !== undefined ? `@${cell.rowIndex}` : '')
      assert.ok(seen.add(id), `${id} 出现了两次`)
      assert.ok(cell.from.trim().length >= 8, `${id}：没写清这个数是怎么来的`)
      const recompute = RECOMPUTE[id]
      assert.ok(
        recompute,
        `${id}：没有独立重算 —— 手写的期望值必须能被再算一遍，否则它只是另一处猜测`,
      )
      const again = recompute(f)
      assert.ok(
        Math.abs(again - cell.value) <= cell.tol,
        `${id}：期望值 ${cell.value} 与独立重算 ${again} 对不上（容差 ${cell.tol}）`,
      )
    }
  }
})

test('每条夹具自己是一张合法的图，且要核对的端口真的存在', () => {
  for (const f of TRUTH_FIXTURES) {
    // 时间列必须是整秒步长：采样率从它推出来，浮点噪声会污染频率类判定
    const t = secondsOf(f)
    for (let i = 1; i < t.length; i += 1) {
      assert.equal(
        t[i] - t[i - 1],
        f.data.stepSeconds,
        `${f.id}：时间列第 ${i} 行的步长不是 ${f.data.stepSeconds} 秒 —— 采样率会推不准`,
      )
    }

    const project = {
      version: 1,
      name: f.graph.name,
      description: '',
      graph: f.graph,
      annotations: [],
      notebook: '',
      reports: [],
      datasets: [
        {
          id: f.data.key,
          name: f.data.name,
          timeColumn: f.data.timeColumn ?? null,
          columns: f.data.features.map((name) => ({
            name,
            type: 'number' as const,
            role: 'continuous' as const,
            enabled: true,
          })),
        },
      ],
      environment: {},
      runs: {},
      modelArtifacts: [],
      patches: [],
    }
    const result = validateWorkflow(f.graph, projectPortContext(project))
    assert.deepEqual(
      result.errors.map((e) => `${e.code} ${e.message}`),
      [],
      `${f.id}：夹具本身接错了线`,
    )

    /*
     * 夹具只能压**引擎算得出的**算子。
     *
     * 归模拟适配器的算子（如 `feature.scale-fit`：真算法在界面侧的 `scaler.ts` 里）
     * 在无头侧不产出任何数值，夹具压在它身上只会"永远没有被核对的数" ——
     * 一条看着在验、实际什么都没验的用例，比没有还糟。
     */
    for (const n of f.graph.nodes) {
      assert.equal(
        getNodeTypeDef(n.type).runtimeClass,
        'engine',
        `${f.id}：节点「${n.label}」归 ${getNodeTypeDef(n.type).runtimeClass} 实现，无头侧验不了它`,
      )
    }

    for (const cell of f.cells) {
      const def = getNodeTypeDef(
        f.graph.nodes.find((n) => n.id === cell.nodeId)?.type ?? '',
      )
      const portId = cell.portId ?? 'data'
      // 端口可能来自上游（如拆列），所以这里只要求"算得出端口时它必须在里面"
      const declared = def.outputs.map((p) => p.id)
      if (declared.length > 0 && !declared.includes(portId)) {
        assert.ok(
          declared.some((id) => id === portId) ||
            // 动态端口（data.columns）：端口由上游的列决定，静态清单里没有
            def.type === 'data.columns',
          `${f.id}：节点 ${cell.nodeId} 上没有输出端口「${portId}」（有：${declared.join(', ')}）`,
        )
      }
    }
  }
})

test('朴素实现本身对得上解析解（"独立真值"不能是另一处猜测）', () => {
  const ramp = Array.from({ length: 512 }, (_, i) => i)
  const n = ramp.length
  assert.equal(NAIVE.naiveMean(ramp), (n - 1) / 2)
  assert.ok(Math.abs(NAIVE.naiveRms(ramp) - Math.sqrt((n * (n - 1) * (2 * n - 1)) / 6 / n)) < 1e-12)

  // 125 Hz、1000 Hz 采样、2048 点：整数个周期，峰值必须精确落在 125 Hz
  const fs = 1000
  const signal = Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * 125 * i) / fs))
  assert.ok(Math.abs(naivePeak(signal, 2048, fs).hz - 125) < 1e-9)
  // 幅值：整周期正弦在它自己那根谱线上的 |X| = A·N/2
  assert.ok(Math.abs(naivePeak(signal, 2048, fs).amp - 1024) < 1e-6)
})
