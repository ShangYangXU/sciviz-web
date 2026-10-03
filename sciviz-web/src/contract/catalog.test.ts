import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG_VERSION, buildCatalog } from './catalog'

/**
 * 清单是 agent 面 G1 的全部依据，所以它自己的性质也要钉住：
 * 自描述、不重复、端口说实话。
 */

const catalog = () => buildCatalog({})

test('清单非空，且算子 type 不重复', () => {
  const c = catalog()
  assert.ok(c.operatorCount > 0)
  assert.equal(c.operatorCount, c.operators.length)
  const types = c.operators.map((o) => o.type)
  assert.equal(new Set(types).size, types.length, '同一个算子出现了两次 —— 清单有第二处来源')
  assert.equal(c.catalogVersion, CATALOG_VERSION)
})

test('每个算子都带足 agent 需要的字段：类别、描述、runtime、端口、参数', () => {
  for (const op of catalog().operators) {
    assert.ok(op.category, `${op.type} 缺 category`)
    assert.ok(op.description, `${op.type} 缺 description`)
    assert.equal(op.runtime, 'engine', `${op.type} 必须声明真实引擎执行`)
    assert.ok(Array.isArray(op.inputs) && Array.isArray(op.outputs), `${op.type} 缺端口`)
    assert.ok(Array.isArray(op.params), `${op.type} 缺参数`)
  }
})

test('端口随数据或代码变化的算子被标出来，并给出原因', () => {
  const c = catalog()
  // 数据源现在是固定整表端口；代码签名仍会动态改变函数端口。
  const source = c.operators.find((o) => o.type === 'data.source')
  assert.ok(source)
  assert.equal(source.dynamicPorts, false)
  assert.deepEqual(source.outputs.map((p) => p.id), ['__table__'])
  for (const type of ['custom.script']) {
    const op = c.operators.find((o) => o.type === type)
    assert.ok(op, `清单里没有 ${type}`)
    assert.equal(op.dynamicPorts, true, `${type} 的端口是动态的，必须标出来`)
    assert.ok(op.portsNote, `${type} 标了动态却没给原因，agent 只能去读源码`)
  }
  const trainer = c.operators.find((o) => o.type === 'train.function')
  assert.ok(trainer)
  assert.equal(trainer.dynamicPorts, true)
  assert.match(trainer.portsNote ?? '', /fit_model/)
  assert.deepEqual(
    trainer.params.map((param) => param.key),
    ['device', 'code'],
    '通用训练块不能内置标签列、特征列、窗口或 DataLoader 规则',
  )
  assert.equal(trainer.inputs.find((port) => port.id === 'val')?.label, '验证集（早停）')
})

test('绘图块统一要求输入数据，普通图表不再携带独立数据集参数', () => {
  const operators = catalog().operators
  for (const type of ['viz.chart', 'viz.density']) {
    const op = operators.find((candidate) => candidate.type === type)
    assert.ok(op, `清单里没有 ${type}`)
    const dataInputs = op.inputs.filter((port) => port.kind !== 'param')
    assert.deepEqual(dataInputs.map((port) => [port.id, port.type]), [['data', 'table']])
    assert.notEqual(dataInputs[0].optional, true, `${type} 的数据输入必须连接`)
  }

  const chart = operators.find((candidate) => candidate.type === 'viz.chart')!
  assert.equal(chart.params.some((param) => param.key === 'datasetId'), false)

  const customChart = operators.find((candidate) => candidate.type === 'custom.chart')
  assert.ok(customChart)
  assert.equal(customChart.dynamicPorts, true)
  assert.equal(customChart.inputs.find((port) => port.id === 'data')?.optional, false)
  assert.equal(customChart.outputs.find((port) => port.id === 'figure')?.type, 'figure')
  assert.deepEqual(
    customChart.params.map((param) => param.key),
    ['code'],
    '自定义图表的绘图属性全部由 Matplotlib 代码决定，不应重复暴露界面参数',
  )
})

test('旧训练类型留在 catalog 供工程兼容，但标为 legacy', () => {
  const operators = catalog().operators
  assert.equal(operators.find((o) => o.type === 'train.function')?.lifecycle, 'current')
  for (const type of ['train.mlp', 'train.cnn1d', 'train.custom']) {
    assert.equal(operators.find((o) => o.type === type)?.lifecycle, 'legacy', `${type} 应仅用于旧工程`)
  }
})

/*
 * 列拼表的新形状（契约规格 R13）：一个入口、能吃任意多根线、没有「列数」参数。
 *
 * 这件事必须从清单里读得出来 —— agent 只有清单。它看不见 `multiple` 的话，就会以为
 * 接第二路要先 disconnect（要么白绕一圈，要么被 E_PORT_OCCUPIED 挡在门外）。
 */
test('列拼表在清单里说清自己是多入端口：一个入口、零参数', () => {
  const op = catalog().operators.find((o) => o.type === 'data.collect')
  assert.ok(op, '清单里没有 data.collect')
  assert.equal(op.dynamicPorts, false, '端口不再随参数变化')
  assert.equal(op.params.length, 0, '「列数」这个参数不该存在：接几路拼几列')
  assert.equal(op.inputs.length, 1, '画布上只有一个连接点')
  assert.equal(op.inputs[0].multiple, true, '多入这件事要能从清单里读到')
  assert.equal(op.inputs[0].optional, true, '一根都没接时不该在 L1 报红叉')
  assert.equal(op.outputs.length, 1)
  assert.equal(op.outputs[0].id, 'data')
})

/*
 * 画布批注（便签 / 表格 / 思维图 / 图片）**不进这张清单**。
 *
 * 这条边界值得钉住，因为它旁边就摆着一个很省事的错做法：把它们当"节点类型"注册进
 * `nodeRegistry` —— 那样左栏、画布、撤销全都白拿，看起来省了两百行。代价是 agent
 * 在清单里读到一个叫「表格」的算子，以为它能跑、能接端口，然后花一整轮去试一个
 * 只用来记字的东西。清单是"人与 agent 共用的动作词汇表"，不该有第三种含义。
 */
test('算子清单里没有批注那三种：它们不是能跑的东西', () => {
  const types = catalog().operators.map((o) => o.type)
  for (const kind of ['note', 'table', 'mindmap', 'annotation']) {
    assert.equal(types.includes(kind), false, `${kind} 出现在算子清单里 —— agent 会以为它可求值`)
  }
})

test('项目清单不再提供隐式数据准备与特征工程节点', () => {
  const types = catalog().operators.map((o) => o.type)
  for (const type of [
    'data.window',
    'data.split',
    'data.augment',
    'feature.time',
    'feature.freq',
    'feature.timefreq',
    'feature.select',
    'feature.scale-fit',
    'feature.scale-apply',
  ]) {
    assert.equal(types.includes(type), false, `${type} 不应再出现在 SciViz 算子清单`)
  }
})

test('预设算子的端口是静态的：不该被误标成动态', () => {
  const op = catalog().operators.find((o) => o.type === 'data.preview')
  assert.ok(op)
  assert.equal(op.dynamicPorts, false)
  assert.ok(op.inputs.some((p) => p.id === 'data'))
})

test('参数带上"能不能被上游驱动"，这是接超参线的判据', () => {
  const train = catalog().operators.find((o) => o.type === 'train.custom')
  assert.ok(train)
  const lr = train.params.find((p) => p.key === 'lr')
  assert.ok(lr, 'train.custom 应当有 lr 参数')
  assert.equal(lr.portable, false)
})

test('runtime 来自算子清单自己声明的 runtimeClass，不再由调用方注入', () => {
  const c = catalog()
  // 清单说了算：所有当前注册的算子都由真实引擎执行
  assert.equal(c.operators.find((o) => o.type === 'data.source')?.runtime, 'engine')
  assert.equal(c.operators.find((o) => o.type === 'custom.model')?.runtime, 'engine')
  assert.equal(c.operators.find((o) => o.type === 'train.custom')?.runtime, 'engine')
  assert.ok(c.operators.some((o) => o.runtime === 'engine'))
})

test('每个算子都带上版本、确定性等级与执行等级（R7 / R6 / R6.1）', () => {
  for (const op of catalog().operators) {
    assert.match(op.version, /^\d+\.\d+\.\d+$/, `${op.type} 的 version 不是语义化版本`)
    assert.ok(
      ['deterministic', 'seeded', 'stochastic'].includes(op.determinism),
      `${op.type} 的 determinism 取值不在三级之内`,
    )
    assert.ok(
      ['interactive', 'background', 'batch'].includes(op.execClass),
      `${op.type} 的 execClass 取值不在三级之内`,
    )
  }
  // 三档都得有真实用户，否则"三级声明"是摆设：长任务必须是 background，
  // 用户代码必须承认自己不可承诺
  assert.equal(catalog().operators.find((o) => o.type === 'train.custom')?.execClass, 'background')
  assert.equal(catalog().operators.find((o) => o.type === 'custom.script')?.determinism, 'stochastic')
})

test('能力声明进清单：只有宿主能跑的算子必须自报家门（R4 / T12）', () => {
  const c = catalog()
  const train = c.operators.find((o) => o.type === 'train.mlp')
  assert.ok(train, '真训练算子应当出现在清单里 —— agent 与界面都靠它知道有这张牌')
  assert.equal(train.requires?.runtime, 'host')
  assert.deepEqual(train.requires?.packages, ['torch'])
  assert.ok((train.requires?.reason ?? '').length > 0, '要说清为什么需要宿主')
  assert.equal(train.execClass, 'background', '训练是长任务，不该按实时算子的规格要求它')

  // 边界之内的算子写 null：那是一个明确的声明（"两个执行面都能跑"），不是"忘了写"
  assert.equal(c.operators.find((o) => o.type === 'data.preview')?.requires, null)
})

test('评估打分是共享算子：两个执行面都能跑，指标口径交给 scikit-learn', () => {
  const c = catalog()
  const score = c.operators.find((o) => o.type === 'eval.score')
  assert.ok(score, '评估算子应当出现在清单里')
  assert.equal(score.runtime, 'engine')
  assert.equal(score.requires, null, 'scikit-learn 在 Pyodide 的包表里，所以它不需要宿主')
  assert.equal(score.determinism, 'deterministic', '同一个输入两次应当给同一份指标')
  assert.deepEqual(
    score.outputs.map((p) => p.id),
    ['metrics', 'matrix', 'per_class'],
  )
  assert.deepEqual(
    score.inputs.map((p) => p.id),
    ['data'],
    '评估吃的是"带真实列与预测列的表"，不是模型 —— 模型是宿主侧的权重',
  )
})

test('错误码表随清单一并给出，agent 不必另找入口', () => {
  const c = catalog()
  assert.ok(c.errorCodes.length > 0)
  for (const d of c.errorCodes) {
    assert.ok(d.code && d.trigger && d.action, `${d.code} 的说明不完整`)
    assert.ok(Array.isArray(d.fixes), `${d.code} 缺 fixes`)
  }
})

/**
 * 清单里的"名字"必须真的能当身份用。
 *
 * 拿名字当身份是这个项目的通用做法（列名是数据源端口名、也是拆列端口名；
 * 端口 id 是连线两端、也是引擎产出的 key；参数键是 YAML 里的键）。**名字重了，
 * 身份就没了**，而症状通常是静默的：Map 一建、后一个把前一个覆盖掉，端口少一个、
 * 参数少一个，谁都不会报错（列名重名那个 bug 就是这么丢了一整列数据）。
 *
 * 所以这里逐个检查三类名字各自唯一。**输入与输出用同一个 id 不算重复** ——
 * 那是两个名字空间（`data.window` 的输入与输出都叫 data，界面上是两个把手）。
 */
test('三类名字各自唯一：算子 type、端口 id、参数键', () => {
  const dup = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]

  for (const op of catalog().operators) {
    assert.equal(dup(op.inputs.map((p) => p.id)).length, 0, `${op.type} 的输入端口 id 重复了`)
    assert.equal(dup(op.outputs.map((p) => p.id)).length, 0, `${op.type} 的输出端口 id 重复了`)
    assert.equal(dup(op.params.map((p) => p.key)).length, 0, `${op.type} 的参数键重复了`)
  }
})
