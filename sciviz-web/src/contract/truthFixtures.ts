/**
 * 注册式真值夹具 —— `sciviz verify` 的唯一数据源。
 *
 * ## 为什么需要它
 *
 * "跑通了"不等于"算对了"：一个算子返回一张形状正确、数值全错的表，谁都不会报警。
 * 所以每个算子都要有一个**独立真值**：一份小小的输入、一个由独立方法算出来的数、
 * 一个容差，以及一句"这个数是怎么来的"。
 *
 * 这条边界是本文件最重要的约定：
 *
 * > **独立真值绝不来自引擎。** 用引擎的输出当期望值，只能证明"它和上次跑得一样"。
 *
 * 所以这里的期望值分两种，都写明了出处：
 * - **解析解**：等差数列的均值就是 `(n-1)/2`，正弦的峰值频率就是它自己的频率 ——
 *   与实现无关，也永远不会过期；
 * - **朴素实现**：在下面用最笨的写法重算一遍（`naiveMean`、`naiveDft`…）。
 *   它们故意慢、故意不优化，好读好核对。
 *
 * `truthFixtures.test.ts` 会核对这两条：注册表里的每个数，要么能对上解析解，
 * 要么能对上朴素实现 —— 手抄错一个数字会在 `npm test` 里红，而不是在半年后
 * 变成一句"这个数一直是错的"。
 *
 * ## 怎么加一条
 *
 * 1. `data` 造一份确定的输入（几行就够，能一眼看出期望值的那种）；
 * 2. `graph` 用这份输入接一个算子；
 * 3. `cells` 写要核对的数：`value` 由解析解或朴素实现给出，`from` 写清出处；
 * 4. 跑 `npm run sciviz -- verify <夹具 id>`（需要本地宿主在跑）。
 */

import type { Workflow, WorkflowEdge, WorkflowNode } from '../workflow/types'

/**
 * 要核对的一个数。
 *
 * 这个数**住在哪儿**由 `where` 决定 —— 它不是一个可以随便试的东西：
 * 摘要里没有数时，"读不到"和"算错了"是两件必须分开的事实（前者是缺陷，
 * 后者是算子的问题），而"先看摘要、没有再去取行"会把它们混成一句话。
 *
 * | where | 取哪里 |
 * |---|---|
 * | `rowCount` / `columns` | 输出摘要里的行数 / 列数 |
 * | `metric`（默认） | 输出摘要 `values` 里的指标（metrics 类端口） |
 * | `row` | 输出表**第一行**里名为 `key` 的那一列（表类端口，按需去引擎取） |
 */
export type TruthWhere = 'rowCount' | 'columns' | 'metric' | 'row'

export interface TruthCell {
  nodeId: string
  /** 默认 `data` */
  portId?: string
  key: string
  value: number
  /** 绝对容差。浮点误差留一点，但也只留一点 */
  tol: number
  /** 默认 `metric` */
  where?: TruthWhere
  /**
   * `where: 'row'` 时读第几行（默认 0，即第一行）。
   *
   * 为什么需要它：有些真值本身就是"第 N 行该等于什么"——比如分帧把每帧**起点那一行**
   * 的标签带过来，那么第 2 帧的标签就必须等于 `起点 × 列步长`。只看第一行的话，
   * "整体错位一帧"这种错会被漏掉（而它会静默地让每一帧的标签都指向前一帧）。
   */
  rowIndex?: number
  /** 这个数**怎么独立算出来的**。空着就等于没有真值 */
  from: string
}

export interface TruthData {
  /** 绑到图里那个数据集的键（与 `data.source` 的 datasetId 一致） */
  key: string
  name: string
  header: string[]
  /** 与 header 等长 */
  rows: (number | string)[][]
  timeColumn: string
  /**
   * 时间列的步长（秒）。
   *
   * **必须是整秒**：CSV 的时间戳按 `YYYY-MM-DD HH:MM:SS` 解析（秒级），
   * 步长写 0.001 会在浮点里散成一堆不同的 delta，采样率就推不准了 ——
   * 而"采样率推不准"会让频率类夹具的判定变成猜。所以夹具统一 1 Hz。
   */
  stepSeconds: number
  /** 进下游计算的列（顺序即端口顺序） */
  features: string[]
}

export interface TruthFixture {
  id: string
  /** 一句话说清这条夹具在验什么 */
  what: string
  /**
   * 这条夹具需要宿主侧有什么才能跑。
   *
   * `'torch'` = 它压的是宿主专属算子（真训练）。**没有 torch 的宿主上必须跳过而不是失败**
   * —— CI 里那个 `agent-face` job 就是故意不装 torch 的（4GB 的 CUDA 构建只在开发机上有意义），
   * 跳过并写明原因，比让它红着、再让人去猜"是不是我们改坏了"好得多。
   */
  requires?: 'torch'
  data: TruthData
  graph: Workflow
  cells: TruthCell[]
}

/* ------------------------------------------------------------------ */
/* 朴素实现：故意笨，好核对                                            */
/* ------------------------------------------------------------------ */

export const naiveMean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length

/** 总体标准差（ddof=0）—— 与算子声明的口径一致（契约规格 §4.2） */
export const naiveStd = (xs: number[]): number => {
  const m = naiveMean(xs)
  return Math.sqrt(naiveMean(xs.map((x) => (x - m) ** 2)))
}

export const naiveRms = (xs: number[]): number => Math.sqrt(naiveMean(xs.map((x) => x * x)))

/**
 * 最笨的 DFT：对每个频点直接累加。O(n²) 也没关系 —— 夹具只有几百个点。
 *
 * 返回**单边**谱的峰值频点下标与峰值的幅值（不做任何归一化）。
 */
export function naivePeak(signal: number[], nfft: number, fs: number): { hz: number; amp: number } {
  const n = signal.length
  const m = naiveMean(signal)
  const centered = signal.map((x) => x - m)
  let bestBin = 0
  let bestAmp = -1
  for (let k = 0; k <= nfft / 2; k += 1) {
    let re = 0
    let im = 0
    for (let t = 0; t < nfft; t += 1) {
      const angle = (2 * Math.PI * k * t) / nfft
      const x = t < n ? centered[t] : 0
      re += x * Math.cos(angle)
      im -= x * Math.sin(angle)
    }
    const amp = Math.hypot(re, im)
    if (amp > bestAmp) {
      bestAmp = amp
      bestBin = k
    }
  }
  return { hz: (bestBin * fs) / nfft, amp: bestAmp }
}

/* ------------------------------------------------------------------ */
/* 造数据的小工具                                                      */
/* ------------------------------------------------------------------ */

const node = (
  id: string,
  type: string,
  label: string,
  params: Record<string, string | number | boolean> = {},
): WorkflowNode => ({ id, type, label, params, position: { x: 0, y: 0 } })

const edge = (
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
): WorkflowEdge => ({
  id: `${source}|${sourcePort}|${target}|${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
})

const flow = (name: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): Workflow => ({
  id: `fixture-${name}`,
  name,
  description: '',
  nodes,
  edges,
})

/**
 * 时间列：`YYYY-MM-DD HH:MM:SS`，自 2024-01-01 00:00:00 起每 stepSeconds 一个点。
 *
 * 用本地时间构造、也按本地时间格式化 —— 解析那边就是这么读的（见 `csvParse.parseTimestamp`），
 * 两边一致才不会平白差出一个时区。
 */
const stamps = (n: number, stepSeconds: number): string[] => {
  const base = new Date(2024, 0, 1, 0, 0, 0).getTime()
  const pad = (v: number): string => String(v).padStart(2, '0')
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base + i * stepSeconds * 1000)
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    )
  })
}

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

/*
 * 夹具统一 **1 Hz**：CSV 的时间戳是秒级的，采 1 Hz 才能让步长精确（见 TruthData.stepSeconds）。
 * 采样率低不是问题 —— 频率类夹具的谱线按"整周期对齐"挑，峰值仍落在解析解上。
 */
const FS = 1

/** 直线：0 → 100 */
const FLAT_N = 256
const line = Array.from({ length: FLAT_N }, (_, i) => (i * 100) / (FLAT_N - 1))

/* 训练夹具：200 行的小表。标签 y = 2x + 1 是连续值（取值数远超分类阈值 → 走回归）。 */
const TRAIN_N = 200
const trainX = Array.from({ length: TRAIN_N }, (_, i) => i / 10)
const trainY = trainX.map((x) => 2 * x + 1)

/** 夹具的时间列（都是 1 Hz、秒级，见 TruthData.stepSeconds） */
const lineTime = stamps(FLAT_N, FS)

export const TRUTH_FIXTURES: TruthFixture[] = [
  {
    id: 'viz.chart.upstream',
    what: '普通图表：figure 由接入的上游整表生成，不依赖节点自选数据集',
    data: {
      key: 'fixture',
      name: '两列',
      header: ['时间', '液位', '流量'],
      timeColumn: '时间',
      stepSeconds: FS,
      features: ['液位', '流量'],
      rows: line.map((v, i) => [lineTime[i], v, 100 - v]),
    },
    graph: flow(
      '图表 · 上游整表',
      [
        node('src', 'data.source', '数据', { datasetId: 'fixture' }),
        node('chart', 'viz.chart', '图表', { chartType: 'scatter' }),
      ],
      [edge('src', '__table__', 'chart', 'data')],
    ),
    cells: [
      {
        nodeId: 'chart',
        portId: 'figure',
        key: 'rowCount',
        where: 'rowCount',
        value: FLAT_N,
        tol: 0,
        from: '解析解：256 行小于 6000 点抽稀上限，因此输入行数全部保留',
      },
      {
        nodeId: 'chart',
        portId: 'figure',
        key: 'columns',
        where: 'columns',
        value: 3,
        tol: 0,
        from: '解析解：图表保留输入整表的时间列与两列测量值，共三列',
      },
    ],
  },
  {
    id: 'custom.chart.figure',
    what: '自定义图表：先加载用户绘图函数，再把其 figure 输出用于统一预览',
    data: {
      key: 'fixture',
      name: '两列',
      header: ['时间', '液位', '流量'],
      timeColumn: '时间',
      stepSeconds: FS,
      features: ['液位', '流量'],
      rows: line.map((v, i) => [lineTime[i], v, 100 - v]),
    },
    graph: flow(
      '自定义图表 · 返回输入表',
      [
        node('src', 'data.source', '数据', { datasetId: 'fixture' }),
        node('chart', 'custom.chart', '自定义图表', {
          code: 'def plot(data, bins=30):\n    return {"figure": data}\n',
        }),
      ],
      [edge('src', '__table__', 'chart', 'data')],
    ),
    cells: [
      {
        nodeId: 'chart',
        portId: 'figure',
        key: 'rowCount',
        where: 'rowCount',
        value: FLAT_N,
        tol: 0,
        from: '解析解：夹具函数原样返回输入表，输出行数等于输入的 256 行',
      },
      {
        nodeId: 'chart',
        portId: 'figure',
        key: 'columns',
        where: 'columns',
        value: 3,
        tol: 0,
        from: '解析解：夹具函数原样返回输入表，时间列与两列测量值均保留',
      },
    ],
  },
  {
    id: 'data.columns.perColumn',
    what: '拆列：一列一个端口，且每个端口都是一张单列表',
    data: {
      key: 'fixture',
      name: '两列',
      header: ['时间', '液位', '流量'],
      timeColumn: '时间',
      stepSeconds: FS,
      features: ['液位', '流量'],
      rows: line.map((v, i) => [lineTime[i], v, 100 - v]),
    },
    graph: flow(
      '拆列 · 单列表',
      [
        node('src', 'data.source', '数据', { datasetId: 'fixture' }),
        node('split', 'data.columns', '拆列', {}),
      ],
      // 拆列的端口按上游实际的列长出来，名字就是列名
      [edge('src', '__table__', 'split', 'data')],
    ),
    cells: [
      {
        nodeId: 'split',
        portId: '液位',
        key: 'rowCount',
        where: 'rowCount',
        value: FLAT_N,
        tol: 0,
        from: '解析解：拆列不改行数，一列一张表 —— 行数必须仍是输入的行数',
      },
      {
        nodeId: 'split',
        portId: '液位',
        key: 'columns',
        where: 'columns',
        value: 1,
        tol: 0,
        from: '契约：拆列的输出端口是**单列表**（不是把整表挂在每一列上）',
      },
      {
        nodeId: 'split',
        portId: '流量',
        key: 'rowCount',
        where: 'rowCount',
        value: FLAT_N,
        tol: 0,
        from: '解析解：同上，第二列也一样',
      },
    ],
  },
  {
    id: 'data.collect.columns',
    what: '列拼表把两列并排拼回一张表：行数不变，列数等于接进来的列数',
    data: {
      key: 'fixture',
      name: '两列',
      header: ['时间', '液位', '流量'],
      timeColumn: '时间',
      stepSeconds: FS,
      features: ['液位', '流量'],
      rows: line.map((v, i) => [lineTime[i], v, 100 - v]),
    },
    graph: flow(
      '列拼表 · 拼回两列',
      [
        node('src', 'data.source', '数据', { datasetId: 'fixture' }),
        node('cols', 'data.columns', '拆列', {}),
        node('collect', 'data.collect', '列拼表', {}),
      ],
      [
        edge('src', '__table__', 'cols', 'data'),
        // 拆列的端口就是列名（与数据源一个约定）；拼表那一个是多入端口（R13），
        // 两根线都接在同一个入口上，顺序 = 连线先后 = 拼出来的列序
        edge('cols', '液位', 'collect', 'in'),
        edge('cols', '流量', 'collect', 'in'),
      ],
    ),
    cells: [
      {
        nodeId: 'collect',
        key: 'rowCount',
        where: 'rowCount',
        value: FLAT_N,
        tol: 0,
        from: '解析解：拼表是横向拼接，行数等于输入的行数（不改行）',
      },
      {
        nodeId: 'collect',
        key: 'columns',
        where: 'columns',
        value: 2,
        tol: 0,
        from: '解析解：接进来两列，输出的表就两列 —— 少一列说明有一路没接上，多一列说明串了',
      },
    ],
  },
  {
    id: 'viz.density.column',
    what: '概率密度图：画的是**连进来那一列**的实际值，隔着一个拆列节点也算得出',
    data: {
      key: 'fixture',
      name: '两列',
      header: ['时间', '液位', '流量'],
      timeColumn: '时间',
      stepSeconds: FS,
      features: ['液位', '流量'],
      rows: line.map((v, i) => [lineTime[i], v, 100 - v]),
    },
    graph: flow(
      '概率密度图 · 拆出来的一列',
      [
        node('src', 'data.source', '数据', { datasetId: 'fixture' }),
        node('cols', 'data.columns', '拆列', {}),
        node('den', 'viz.density', '密度图', {}),
      ],
      [
        edge('src', '__table__', 'cols', 'data'),
        /*
         * 用户的真实形状：密度图接的是**拆列**拆出来的一列，不是数据源的特征端口。
         * 旧实现拿连线反查数据集 id，而那个反查只认"上游直接是数据源"—— 隔着拆列就查不到，
         * 于是点了运行也什么都不出。这条夹具就是那个 bug 的反例：它必须算得出数。
         */
        edge('cols', '液位', 'den', 'data'),
      ],
    ),
    cells: [
      {
        nodeId: 'den',
        portId: 'figure',
        key: 'rowCount',
        where: 'rowCount',
        value: FLAT_N,
        tol: 0,
        from: '解析解：256 行没超过抽样上限 6000，等距抽样一个点都不该丢',
      },
      {
        nodeId: 'den',
        portId: 'figure',
        key: 'columns',
        where: 'columns',
        value: 1,
        tol: 0,
        from: '契约：拆列给的是单列表。多出一列说明抽样顺手把时间列或别的列塞了进来',
      },
    ],
  },
  {
    id: 'train.mlp.shape',
    what: '训练算子：逐轮曲线一行一轮、参数量按网络结构算得出来（真训练只在这些"数得出来"的地方有真值）',
    // 真训练要 torch。没装的宿主上它是**跳过**，不是失败 —— CI 那个 job 就是故意不装 torch 的
    requires: 'torch',
    data: {
      key: 'fixture',
      name: '训练小表',
      header: ['时间', 'x', 'y'],
      timeColumn: '时间',
      stepSeconds: FS,
      features: ['x', 'y'],
      rows: trainX.map((x, i) => [lineTime[i % FLAT_N], x, trainY[i]]),
    },
    graph: flow(
      '训练 · 形状',
      [
        node('src', 'data.source', '数据', { datasetId: 'fixture' }),
        node('hist', 'train.mlp', '训练', {
          label: 'y',
          task: 'auto',
          epochs: 3,
          hidden: 4,
          lr: 0.01,
          batch: 32,
          seed: 1,
        }),
      ],
      [edge('src', '__table__', 'hist', 'train')],
    ),
    cells: [
      {
        nodeId: 'hist',
        portId: 'history',
        key: 'rowCount',
        where: 'rowCount',
        value: 3,
        tol: 0,
        from: '解析解：逐轮曲线每个 epoch 一行 → 行数 = 轮数（这里设了 3 轮）',
      },
      {
        nodeId: 'hist',
        portId: 'metrics',
        key: '参数量',
        where: 'metric',
        // 网络是 Linear(d,h) → ReLU → Linear(h,h) → ReLU → Linear(h,out)，
        // 每层都带偏置：d·h+h + h·h+h + h·out+out。这里 d=1（只有 x 一个特征，标签与时间列都不算）、h=4、out=1（回归）
        value: (1 * 4 + 4) + (4 * 4 + 4) + (4 * 1 + 1),
        tol: 0,
        from: '解析解：参数量 = (d·h+h) + (h·h+h) + (h·out+out)；d=1、h=4、out=1（回归） → 33',
      },
    ],
  },
  {
    id: 'eval.score.accuracy',
    what: '评估算子的准确率与混淆矩阵能用手算的真值对上',
    data: {
      key: 'fixture',
      name: '真值与预测',
      header: ['时间', '真实', '预测'],
      rows: [
        [lineTime[0], 0, 0],
        [lineTime[1], 1, 1],
        [lineTime[2], 2, 2],
        [lineTime[3], 0, 1],
        [lineTime[4], 1, 1],
        [lineTime[5], 2, 0],
      ],
      timeColumn: '时间',
      stepSeconds: FS,
      features: ['真实', '预测'],
    },
    graph: flow(
      '评估 · 手算准确率',
      [
        node('src', 'data.source', '数据', { datasetId: 'fixture' }),
        node('score', 'eval.score', '评估', { y_true: '真实', y_pred: '预测' }),
      ],
      [edge('src', '__table__', 'score', 'data')],
    ),
    cells: [
      {
        nodeId: 'score',
        portId: 'metrics',
        key: '准确率',
        value: 4 / 6,
        tol: 1e-12,
        from: '手算：6 个样本里 4 个预测对（第 4 行 0→1、第 6 行 2→0 是错的），4/6',
      },
    ],
  },
]

export const fixtureById = (id: string): TruthFixture | undefined =>
  TRUTH_FIXTURES.find((f) => f.id === id)

/**
 * 夹具真值里用到的朴素重算 —— `truthFixtures.test.ts` 与 `verify` 共用。
 *
 * 单独导出是为了让"这个数是怎么来的"可被机器再算一遍：注册表里写死的数字
 * 与这里算出来的对不上就是缺陷（手抄错一个数字不该等到半年后才发现）。
 */
export const NAIVE = { naiveMean, naiveStd, naiveRms, naivePeak }
