import type { NodeTypeDef, ParamSpec, WorkflowNode } from './types'
import { parseSignature, parseTrainingSignature } from './functionSignature'
import { parseModelParams } from './modelParams'

let customModuleProvider: () => readonly NodeTypeDef[] = () => []

/** The browser injects its live module snapshot; the registry never imports a UI store. */
export function registerCustomModuleProvider(provider: () => readonly NodeTypeDef[]): void {
  customModuleProvider = provider
}

const customModuleDefs = () => customModuleProvider()

/** `data.source` 的唯一、固定输出端口；动态列选择由 `data.columns` 承担。 */
export const WHOLE_TABLE_PORT = '__table__'

const sel = (key: string, label: string, options: string[], def: string, hint?: string): ParamSpec => ({
  key,
  label,
  type: 'select',
  default: def,
  options: options.map((o) => ({ value: o, label: o })),
  hint,
})

const num = (
  key: string,
  label: string,
  def: number,
  opts: {
    min?: number
    max?: number
    step?: number
    unit?: string
    hint?: string
    /** 设 false 表示这个参数不长成可接线端口 */
    portable?: boolean
  } = {},
): ParamSpec => ({ key, label, type: 'number', default: def, ...opts })

const bool = (key: string, label: string, def: boolean, hint?: string): ParamSpec => ({
  key,
  label,
  type: 'boolean',
  default: def,
  hint,
})

const txt = (key: string, label: string, def: string, hint?: string): ParamSpec => ({
  key,
  label,
  type: 'text',
  default: def,
  hint,
})

/**
 * 训练控制项：优化器 / 学习率调度 / 精度 / 梯度累积。
 *
 * 三个训练节点（`train.mlp`、`train.cnn1d`、`train.custom`）**共用这三份声明**，因为
 * 宿主侧也只有一个训练循环（`sciviz_host/gpu_ops.py` 的 `_run_training`）。一处实现、
 * 一处声明、一处文档 —— 复制成三份之后，漏改的那一份不会报错，只会让那个节点少了
 * 别的节点有的选项（AGENTS.md R1）。
 *
 * 数字参数一律 `portable: false`：它们在右侧栏直接改，再各长一个连线点，看上去就像
 * "这里得接点什么"。下拉与布尔本来就不长端口（见 `isPortableParam`）。
 */
const TRAINING_OPTIMIZER_PARAMS: ParamSpec[] = [
  sel(
    'optimizer',
    '优化器',
    ['Adam', 'SGD', 'AdamW'],
    'Adam',
    '真训练要它。三个训练节点用的是同一份实现，选哪个都不改变别的口径',
  ),
  num('momentum', '动量（SGD）', 0, {
    min: 0,
    max: 0.99,
    step: 0.05,
    portable: false,
    hint: '只对 SGD 生效；Adam / AdamW 忽略它',
  }),
]

const TRAINING_SCHEDULE_PARAMS: ParamSpec[] = [
  sel(
    'scheduler',
    '学习率调度',
    ['无', '余弦退火', '阶梯衰减', '平台衰减'],
    '无',
    '默认「无」：加一个选项不该让已有工程的训练结果悄悄变了。平台衰减与早停盯同一个量',
  ),
  num('schedulerStep', '调度步长', 10, {
    min: 1,
    max: 200,
    step: 1,
    portable: false,
    hint: '阶梯衰减：每多少轮乘一次倍率；平台衰减：容忍多少轮不改善',
  }),
  num('schedulerGamma', '衰减倍率', 0.1, {
    min: 0.01,
    max: 0.99,
    step: 0.01,
    portable: false,
    hint: '阶梯衰减每到步长就乘它；平台衰减在没进步时乘它',
  }),
  num('minLr', '学习率下限', 0, {
    min: 0,
    max: 1,
    step: 0.00001,
    portable: false,
    hint: '任何调度器都不会把学习率降到它以下；余弦退火就是降到它',
  }),
]

const TRAINING_PERFORMANCE_PARAMS: ParamSpec[] = [
  num('accumulate', '梯度累积', 1, {
    min: 1,
    max: 64,
    step: 1,
    portable: false,
    hint: '每积累这么多批才更新一次参数：等效批大小 = 批大小 × 它（显存装不下大 batch 时用它）',
  }),
  sel(
    'precision',
    '精度',
    ['fp32', 'bf16', 'fp16'],
    'fp32',
    '默认 fp32：混合精度是另一套数值，不是"更快的 fp32"，所以它必须由你显式选。' +
      '有 CUDA 想更快就选 bf16（不需要梯度缩放）；fp16 也只在 CUDA 上成立',
  ),
]

/* ------------------------------------------------------------------ */
/* 节点注册表（对应 V2 §4.1）                                           */
/* ------------------------------------------------------------------ */

/**
 * 每个算子必须自己声明的四件事：`version`（R7）、`runtimeClass`（R6.2）、
 * `determinism`（R6）、`execClass`（R6.1）。全部**必填** —— 忘了写编译不过，
 * 而不是静静地按某一种默认行为跑下去。
 *
 * `version` 一律 `0.1.0`：版本号从这一天开始有，此前没有任何算子有版本可比。
 * 往后只有**行为口径变了**才升它（改注释、改实现细节走 `implementationHash`）。
 */
export const nodeTypeDefs: NodeTypeDef[] = [
  /* ---------------- 数据 ---------------- */
  {
    type: 'data.source',
    version: '0.2.0',
    requires: null,
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
    label: '数据源',
    category: 'data',
    description:
      '选择已导入的数据集，只输出一个整表端口。时间列与启用的数值特征都在表中；需要单列时接「拆列」。',
    inputs: [],
    outputs: [{ id: WHOLE_TABLE_PORT, label: '整表', type: 'table' }],
    params: [
      {
        key: 'datasetId',
        label: '数据集',
        type: 'select',
        default: '',
        widget: 'datasetRef',
        hint: '在顶栏「导入数据」里添加本地 CSV',
      },
    ],
    // 资产在执行时按真实数据集动态生成
    assetRecipes: [],
  },
  {
    type: 'data.collect',
    // 0.2.0：端口形状换了（「列数」参数 + col_1…col_N → 一个多入端口，契约规格 R13）。
    // 版本号回答的正是"换过行为口径没有"，这类改动不该只藏在注释里。
    version: '0.2.0',
    requires: null,
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
    label: '列拼表',
    category: 'data',
    description:
      '把接进来的所有列拼回一张表：左边那**一个**入口能吃任意多根线（拆列的列、函数筛出来的列都行），右边出拼好的表。接几路拼几列，不用先说几个槽位。',
    /*
     * 一个多入端口（R13）。`optional: true` 是刻意的：一根都没接时它该在求值时报
     * "没有接入任何可读的列"（那句比"必需输入没接线"更贴近实情 —— 这节点空着不算错，
     * 只是还没接），而不是在 L1 就报一个红叉。
     */
    inputs: [{ id: 'in', label: '拼进来', type: 'table', multiple: true, optional: true }],
    outputs: [{ id: 'data', label: '表', type: 'table' }],
    params: [],
    // 画布上是一个圆点（左进右出，中间一个 ＋）：它只有一件事要做，没有参数可填
    shape: 'dot',
    assetRecipes: [],
  },
  {
    type: 'data.columns',
    version: '0.2.0',
    requires: null,
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
    label: '拆列',
    category: 'data',
    description:
      '把一张表摊开：每一列长成一个输出端口。与「列拼表」互为逆操作。留空就是"上游有几列就拆几列"——端口要等上游算过之后才长得出来。',
    inputs: [{ id: 'data', label: '表', type: 'table' }],
    // 输出端口 = 列名，由 resolvePorts 按上游实际结果动态生成，注册表里不写死
    outputs: [],
    params: [
      txt(
        'columns',
        '只拆这些特征（索引）',
        '',
        '填写从 1 开始的特征索引，用逗号分隔（如 1,3；全角逗号、分号、换行也认）。时间列不计入索引。' +
          '留空 = 上游有什么列就拆什么列（需要先跑一次，端口才会长出来）',
      ),
    ],
    // 资产在执行时按实际接线动态生成
    assetRecipes: [],
  },
  {
    type: 'data.preview',
    version: '0.1.0',
    requires: null,
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
    label: '数据预览',
    category: 'data',
    description:
      '接任意一步的输出，直接看那一步的真实结果：表看前几行原值，指标看数值。不改数据、原样透传给下游，所以可以插在链路任意位置当探针。',
    // 类型放宽为 any：它现在要能接表、指标、图，而不只是表
    inputs: [{ id: 'data', label: '数据', type: 'any' }],
    outputs: [{ id: 'head', label: '表', type: 'table' }],
    params: [
      num('rows', '行数', 5, {
        min: 1,
        max: 1000000,
        step: 1,
        portable: false,
        hint: '看前几行；只在详情里影响显示，不改变下游数据',
      }),
    ],
    // 资产在执行时按上游真实数据动态生成
    assetRecipes: [],
  },
  /* ---------------- 模型 ---------------- */
  {
    type: 'train.function',
    version: '0.2.0',
    lifecycle: 'current',
    requires: {
      runtime: 'host',
      packages: ['torch'],
      reason: 'PyTorch 训练与用户训练函数只能在本地宿主中执行',
    },
    runtimeClass: 'engine',
    determinism: 'stochastic',
    execClass: 'background',
    label: '自定义训练',
    category: 'model',
    description:
      '用 Python 的 fit_model 函数定义完整训练过程。宿主只注入原始训练表、验证表、模型工厂、设备、取消与进度；滑窗和 DataLoader 由函数自己创建。需要本地宿主。',
    inputs: [
      { id: 'model', label: '模型定义', type: 'model' },
      { id: 'train', label: '训练集', type: 'table' },
      { id: 'val', label: '验证集（早停）', type: 'table', optional: true },
      { id: 'scaler', label: '标准化器（可选）', type: 'scaler', optional: true },
    ],
    outputs: [
      { id: 'model', label: '已训练模型', type: 'model' },
      { id: 'metrics', label: '训练指标', type: 'metrics' },
      { id: 'history', label: '训练曲线', type: 'table' },
      { id: 'curve', label: '曲线（直出）', type: 'figure' },
    ],
    params: [
      sel('device', '设备', ['auto', 'cpu', 'cuda'], 'auto', 'auto = 有 CUDA 就用它'),
      {
        key: 'code',
        label: '训练函数',
        type: 'code',
        default:
          'def fit_model(model_factory, train_data, test_data, device, env, epochs=20, learning_rate=0.001):\n' +
          '    """完整训练入口。\n' +
          '    train_data / test_data 是接入的原始表；请在这里选列、分组、滑窗并创建 DataLoader。\n' +
          '    数据形状确定后调用 model_factory(input_shape, output_shape, ...) 创建模型。\n' +
          '    请定期调用 env.check_cancel()，并用 env.progress(比例, 说明) 汇报进度。\n' +
          '    """\n' +
          '    raise NotImplementedError("请在训练函数中实现 Dataset、DataLoader、训练与早停")\n',
        hint:
          '完整训练过程由这段函数定义。带数字/文字/布尔默认值的参数自动显示在右侧栏；项目不会替你选列、滑窗或创建 DataLoader。',
      },
    ],
    assetRecipes: [],
  },
  {
    /*
     * 这是第一张"跨到共享边界之外"的牌：真训练要 torch，而浏览器里的 Pyodide 没有它
     * （AGENTS.md R4 的判据是 pyodide-lock.json 那份包表）。所以它必须走本地宿主，
     * 而且**要在跑之前就说出来** —— 用户点一下才发现跑不了，比不让点更糟。
     *
     * 训练节点只保留真实执行路径：需要本地宿主与 torch，并且必须明确连接数据。
     */
    type: 'train.mlp',
    lifecycle: 'legacy',
    version: '0.1.0',
    requires: {
      runtime: 'host',
      packages: ['torch'],
      reason: '真训练要 torch：浏览器里的 Pyodide 没有它，这个节点只能由本地宿主算',
    },
    runtimeClass: 'engine',
    // GPU 上有非确定性归约，给了 seed 也不承诺逐位复现
    determinism: 'stochastic',
    execClass: 'background',
    label: '训练 MLP（真算）',
    category: 'model',
    description:
      '在本机进程里真的训一个小 MLP：有 CUDA 就用 GPU，实际用的设备记进指标与运行清单。需要本地宿主。',
    inputs: [
      { id: 'train', label: '训练集', type: 'table' },
      { id: 'val', label: '验证集', type: 'table', optional: true },
    ],
    outputs: [
      { id: 'model', label: '已训练模型', type: 'model' },
      { id: 'metrics', label: '训练指标', type: 'metrics' },
      { id: 'history', label: '训练曲线', type: 'table' },
      { id: 'curve', label: '曲线（直出）', type: 'figure' },
    ],
    params: [
      txt('label', '标签列', '', '可填列名或数值信号序号（从 1 开始；排除时间和工作段编号）'),
      txt('features', '特征列', '', '可填列名或数值信号序号（从 1 开始）；留空 = 除标签列外的数值信号列'),
      sel('task', '任务', ['auto', '分类', '回归'], 'auto', 'auto = 按标签自己判断'),
      /*
       * 训练块上的数字一律 `portable: false`：它们都在右侧栏直接改，再各长一个连线点，
       * 看上去就像"这里得接点什么"—— 而实际上没有东西会往这里接（超参搜索吃的是模型端口，
       * 产出的是指标，不喂训练节点）。少 5 个假把手，换来的是"这个框我能自己填"。
       */
      num('epochs', '轮数', 50, { min: 1, max: 500, step: 1, portable: false, hint: '跑得久，属于 background 级长任务；开了早停可能跑不满' }),
      num('hidden', '隐层宽度', 64, { min: 1, step: 8, portable: false }),
      num('lr', '学习率', 0.001, { min: 0.00001, max: 1, step: 0.0001, portable: false }),
      num('batch', '批大小', 64, { min: 1, step: 8, portable: false }),
      num('seed', '随机种子', 42, { min: 0, step: 1, portable: false, hint: 'CPU 上可复现；GPU 上仍有非确定性算子' }),
      sel('device', '设备', ['auto', 'cpu', 'cuda'], 'auto', 'auto = 有 CUDA 就用它'),
      ...TRAINING_OPTIMIZER_PARAMS,
      ...TRAINING_SCHEDULE_PARAMS,
      ...TRAINING_PERFORMANCE_PARAMS,
      bool(
        'earlyStop',
        '早停',
        false,
        '验证损失连续「容忍轮数」轮不再改善就停下，并**回到最好的那一轮**的权重。' +
          '默认关：加一个选项不该让已有工程的训练结果悄悄变了。没接验证集时它退成盯训练损失' +
          '（那样只省时间、防不了过拟合，节点上会把这句说出来）',
      ),
      num('patience', '容忍轮数', 5, {
        min: 1,
        max: 100,
        step: 1,
        portable: false,
        hint: '连续这么多轮没进步才停。中途进步一次会重新数',
      }),
      num('minDelta', '最小改善', 0.0001, {
        min: 0,
        step: 0.0001,
        portable: false,
        hint: '比这个还小的下降不算进步 —— 否则浮点噪声会让早停永远不触发',
      }),
    ],
    // 资产按真实产物生成（指标 + 训练曲线表），不从模板编
    assetRecipes: [],
  },
  {
    /*
     * 振动/声发射这类信号真正的用法：由用户函数准备好定长样本之后，一帧就是一个
     * (通道 × 窗长) 的多通道序列，1D-CNN 在它上面卷积。小表上的 MLP 只是把通路验通，
     * 这一张才是"用 GPU 值不值"的分水岭（见 sciviz-local/README.md 的实测表）。
     *
     * 窗长**不设参数**：它由上游那批 `点0…点N` 列自己决定，避免训练节点与用户数据准备
     * 代码出现两处不一致。
     */
    type: 'train.cnn1d',
    lifecycle: 'legacy',
    version: '0.1.0',
    requires: {
      runtime: 'host',
      packages: ['torch'],
      reason: '卷积要看 torch：浏览器里的 Pyodide 没有它，这个节点只能由本地宿主算',
    },
    runtimeClass: 'engine',
    // 与 train.mlp 同一条理由：GPU 上有非确定性归约，给了 seed 也不承诺逐位复现
    determinism: 'stochastic',
    execClass: 'background',
    label: '训练 1D-CNN（真算）',
    category: 'model',
    description:
      '把用户准备好的定长样本当多通道序列训一个 1D-CNN。标签从输入表的列来。需要本地宿主。',
    inputs: [
      { id: 'train', label: '训练帧', type: 'table' },
      { id: 'val', label: '验证帧', type: 'table', optional: true },
    ],
    outputs: [
      { id: 'model', label: '已训练模型', type: 'model' },
      { id: 'metrics', label: '训练指标', type: 'metrics' },
      { id: 'history', label: '训练曲线', type: 'table' },
      { id: 'curve', label: '曲线（直出）', type: 'figure' },
    ],
    params: [
      txt(
        'label',
        '标签列',
        '',
        '可填列名或数值信号序号（从 1 开始；排除时间和工作段编号）',
      ),
      sel('task', '任务', ['auto', '分类', '回归'], 'auto', 'auto = 按标签自己判断'),
      // 与 train.mlp 同一条理由：框上能改的数字不再各长一个连线点
      num('epochs', '轮数', 30, { min: 1, max: 500, step: 1, portable: false, hint: '跑得久，属于 background 级长任务；开了早停可能跑不满' }),
      num('hidden', '卷积通道数', 32, { min: 1, step: 8, portable: false, hint: '两层卷积的宽度：第二层是它的两倍' }),
      num('kernel', '卷积核', 5, { min: 3, max: 15, step: 2, portable: false, hint: '必须是奇数' }),
      num('batch', '批大小', 128, { min: 1, step: 16, portable: false, hint: '显存的主要开销之一：先调它' }),
      num('lr', '学习率', 0.001, { min: 0.00001, max: 1, step: 0.0001, portable: false }),
      num('dropout', 'Dropout', 0.2, { min: 0, max: 0.9, step: 0.05, portable: false }),
      num('seed', '随机种子', 42, { min: 0, step: 1, portable: false, hint: 'CPU 上可复现；GPU 上仍有非确定性算子' }),
      sel('device', '设备', ['auto', 'cpu', 'cuda'], 'auto', 'auto = 有 CUDA 就用它'),
      ...TRAINING_OPTIMIZER_PARAMS,
      ...TRAINING_SCHEDULE_PARAMS,
      ...TRAINING_PERFORMANCE_PARAMS,
      bool(
        'earlyStop',
        '早停',
        false,
        '验证损失连续「容忍轮数」轮不再改善就停下，并**回到最好的那一轮**的权重。默认关。' +
          'CNN 更容易过拟合（Dropout 之外这一项也很管用），但也更容易被噪声骗 —— 必要时调大「最小改善」',
      ),
      num('patience', '容忍轮数', 5, {
        min: 1,
        max: 100,
        step: 1,
        portable: false,
        hint: '连续这么多轮没进步才停。中途进步一次会重新数',
      }),
      num('minDelta', '最小改善', 0.0001, {
        min: 0,
        step: 0.0001,
        portable: false,
        hint: '比这个还小的下降不算进步',
      }),
    ],
    // 资产按真实产物生成（指标 + 训练曲线表），不从模板编
    assetRecipes: [],
  },
  {
    type: 'train.custom',
    lifecycle: 'legacy',
    version: '0.4.0',
    requires: {
      runtime: 'host',
      packages: ['torch'],
      reason: '自定义模型需要 torch：模型代码与 DataLoader 在本地宿主中执行',
    },
    runtimeClass: 'engine',
    determinism: 'stochastic',
    execClass: 'background',
    label: '训练自定义模型（真算）',
    category: 'model',
    description:
      '训练已连接的自定义模型。这里统一创建 Dataset / DataLoader：普通模型按行训练，TCN/RNN 可选择时序窗口；模型结构与内部维度只在「自定义模型」节点定义。',
    inputs: [
      { id: 'model', label: '模型定义', type: 'model' },
      { id: 'train', label: '训练集', type: 'table' },
      { id: 'val', label: '验证集', type: 'table', optional: true },
      { id: 'scaler', label: '标准化器（可选）', type: 'scaler', optional: true },
    ],
    outputs: [
      { id: 'model', label: '已训练模型', type: 'model' },
      { id: 'metrics', label: '训练指标', type: 'metrics' },
      { id: 'history', label: '训练曲线', type: 'table' },
      { id: 'curve', label: '曲线（直出）', type: 'figure' },
    ],
    params: [
      txt('label', '标签列', '', '默认 Dataset 支持列名或数值信号序号（从 1 开始）；自定义 Dataset 按代码自行读取'),
      txt('features', '特征列', '', '默认 Dataset 支持列名或数值信号序号（从 1 开始）；自定义 Dataset 按代码自行读取'),
      sel('task', '任务', ['回归', '分类', 'auto'], '回归', '自定义 Dataset 返回的 y 必须与任务类型匹配'),
      sel(
        'inputMode',
        '输入模式',
        ['表格', '时序窗口'],
        '表格',
        '表格 = 每行一个样本；时序窗口 = 自动生成 (批次, 时间, 特征)，供 TCN/RNN 使用',
      ),
      num('window', '窗口长度（时序）', 48, {
        min: 1,
        step: 1,
        portable: false,
        hint: '只在“时序窗口”模式使用；每个样本包含多少个连续历史时间点',
      }),
      num('horizon', '预测步长（时序）', 1, {
        min: 1,
        step: 1,
        portable: false,
        hint: '1 = 用窗口预测紧接着的下一个时间点',
      }),
      num('stride', '窗口步长（时序）', 1, {
        min: 1,
        step: 1,
        portable: false,
        hint: '相邻样本的窗口起点间隔；train / val / test 各自在内部生成，不跨集合',
      }),
      num('epochs', '轮数', 50, { min: 1, max: 500, step: 1, portable: false }),
      num('batch', '批大小', 64, { min: 1, step: 8, portable: false }),
      num('lr', '学习率', 0.001, { min: 0.00001, max: 1, step: 0.0001, portable: false }),
      num('seed', '随机种子', 42, { min: 0, step: 1, portable: false }),
      sel('device', '设备', ['auto', 'cpu', 'cuda'], 'auto', 'auto = 有 CUDA 就用它'),
      ...TRAINING_OPTIMIZER_PARAMS,
      ...TRAINING_SCHEDULE_PARAMS,
      ...TRAINING_PERFORMANCE_PARAMS,
      bool('earlyStop', '早停', false, '验证损失连续多轮没有改善时停止，并恢复最好权重'),
      num('patience', '容忍轮数', 5, { min: 1, max: 100, step: 1, portable: false }),
      num('minDelta', '最小改善', 0.0001, { min: 0, step: 0.0001, portable: false }),
      num('numWorkers', '加载进程数', 0, { min: 0, max: 16, step: 1, portable: false, hint: '默认 0，避免 Windows 宿主产生额外进程问题' }),
      bool('dropLast', '丢弃不完整批次', false, '默认保留最后一个不足 batch 的批次'),
    ],
    assetRecipes: [],
  },
  {
    type: 'model.predict',
    version: '0.1.0',
    requires: {
      runtime: 'host',
      packages: ['torch'],
      reason: '模型预测需要在本地宿主中执行训练好的 PyTorch 模型',
    },
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'background',
    label: '模型预测（真算）',
    category: 'model',
    description: '使用已训练模型处理验证集或测试集，输出可直接连接评估节点的预测表。',
    inputs: [
      { id: 'model', label: '已训练模型', type: 'model' },
      { id: 'data', label: '预测数据', type: 'table' },
      { id: 'scaler', label: '标准化器（可选）', type: 'scaler', optional: true },
    ],
    outputs: [{ id: 'predictions', label: '预测结果', type: 'table' }],
    params: [
      txt('label', '真实标签列', '', '有标签时会带入预测结果表，方便连接评估节点'),
      txt('features', '特征列', '', '留空使用训练模型记录的特征列'),
      txt('predictionPrefix', '预测列前缀', '预测', '输出列名形如 预测_目标列'),
      num('batch', '批大小', 256, { min: 1, step: 8, portable: false }),
      sel('device', '设备', ['auto', 'cpu', 'cuda'], 'auto'),
    ],
    assetRecipes: [],
  },
  /* ---------------- 评估 ---------------- */
  {
    /*
     * 真的评估：一张**同时有真实列与预测列的表**进去，指标与混淆矩阵出来。
     *
     * 它是**共享算子**（scikit-learn 在 Pyodide 的包表里），所以浏览器里也算得动 ——
     * 想看一个 F1 不必为了它去起宿主。
     *
     * 它只认两条对齐的真实序列，不根据模型类型编造指标。
     */
    type: 'eval.score',
    version: '0.1.0',
    requires: null,
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
    label: '评估打分（真算）',
    category: 'eval',
    description:
      '给一张带「真实列 + 预测列」的表：分类算准确率 / 精确率 / 召回率 / F1 与混淆矩阵，回归算 MAE / RMSE / R²。两个执行面都能跑。',
    inputs: [{ id: 'data', label: '数据（真实 + 预测）', type: 'table' }],
    outputs: [
      { id: 'metrics', label: '指标', type: 'metrics' },
      { id: 'matrix', label: '混淆矩阵', type: 'table' },
      { id: 'per_class', label: '分类别指标', type: 'table' },
    ],
    params: [
      txt('y_true', '真实标签列', '', '数据表里哪一列是答案。这个不能替你猜'),
      txt('y_pred', '预测列', '', '哪一列是模型的判断：分类给类别名，回归给数值'),
      sel('task', '任务', ['auto', '分类', '回归'], 'auto', 'auto = 按真实标签自己判断'),
    ],
    // 资产按真实产物生成（指标 + 两张表），不从模板编
    assetRecipes: [],
  },
  /* ---------------- 可视化 ---------------- */
  {
    type: 'viz.chart',
    version: '0.2.0',
    requires: null,
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
    label: '图表',
    category: 'viz',
    description: '接入一张上游数据表后立即绘制；图表类型与字段映射只作用于这份实际输入数据。',
    inputs: [{ id: 'data', label: '数据', type: 'table' }],
    outputs: [{ id: 'figure', label: '图', type: 'figure' }],
    params: [
      { key: 'chartType', label: '图表类型', type: 'select', default: 'scatter', widget: 'chartType' },
      { key: 'x', label: 'X 轴', type: 'text', default: '', widget: 'mapping' },
      { key: 'y', label: 'Y 轴', type: 'text', default: '', widget: 'mapping' },
      { key: 'color', label: '颜色', type: 'text', default: '', widget: 'mapping' },
      { key: 'palette', label: '配色', type: 'select', default: 'okabe-ito', widget: 'palette' },
      num('pointSize', '元素大小', 3.5, { min: 1, max: 12, step: 0.5 }),
      bool('showGrid', '显示网格线', true),
      bool('showLegend', '显示图例', true),
      txt('title', '标题', ''),
    ],
    assetRecipes: [],
  },
  {
    type: 'viz.density',
    // 0.3.0：接上线就由真实引擎计算，并允许用户控制 KDE 的取点比例。
    // 不只是实现细节 —— 老版本画的是**整份数据集**的分布，哪怕你筛过；现在画的是
    // 连进来那一列的实际值。
    version: '0.3.0',
    requires: null,
    runtimeClass: 'engine',
    determinism: 'deterministic',
    execClass: 'interactive',
    label: '概率密度图',
    category: 'viz',
    description:
      '接一列数据，画它的概率密度曲线：接上就算、直接画在框上，不用点运行。是哪一列由你接上的那根线决定；“取点比例”控制参与估计的输入点数，1 表示全部使用。',
    // 只有一个输入端口：一列数据
    inputs: [{ id: 'data', label: '数据列', type: 'table' }],
    outputs: [{ id: 'figure', label: '图', type: 'figure' }],
    params: [
      num('sampleRatio', '取点比例', 1, {
        min: 0,
        max: 1,
        step: 0.01,
        portable: false,
        hint: '0 = 不取点、无法估计；1 = 使用全部输入点；中间值按比例等间隔取点',
      }),
      num('bandwidth', '带宽', 0, {
        min: 0,
        portable: false,
        hint: '0 = 按 Silverman 经验法则自动选；填正数则手动指定平滑程度',
      }),
      bool('showStats', '标注均值/中位数', true),
      { key: 'palette', label: '配色', type: 'select', default: 'okabe-ito', widget: 'palette' },
      txt('title', '标题', ''),
    ],
    // 图表在执行时按上游接线动态生成
    assetRecipes: [],
  },

  /* ---------------- 自定义 ---------------- */
  {
    type: 'custom.script',
    version: '0.1.0',
    requires: null,
    runtimeClass: 'engine',
    // 用户写的代码，我们替它承诺不了任何东西（比如里面直接调 random）。
    // 报最保守的一档：它会进运行清单的"不可复现贡献项"，让人知道该自己固定随机源
    determinism: 'stochastic',
    // 用户代码也可能跑十分钟，但那需要节点自己声明执行等级 —— 目前等级是按算子类型定的（T7 之后再说）
    execClass: 'interactive',
    label: '函数',
    category: 'custom',
    description:
      '写一个 Python 函数。形参自动成为输入端口（无默认值的必须接线，有默认值的可在右侧栏直接改），return 字典的 key 成为输出端口。',
    // 端口由代码签名解析而来，注册表里不写死
    inputs: [],
    outputs: [],
    params: [
      {
        key: 'code',
        label: '函数代码',
        type: 'code',
        default:
          'def run(data, threshold=0.5):\n' +
          '    """形参自动变成输入端口，return 的 key 变成输出端口。\n' +
          '\n' +
          '    共享算子就在 sys.path 上，可以直接拿来用，例如把一张表拆成每列一个出口：\n' +
          '        from operators import split_columns\n' +
          '        pieces = split_columns(data, [1, 2])\n' +
          '        return {"液位": pieces["液位"], "流量": pieces["流量"]}\n' +
          '    """\n' +
          '    return {"out": data}\n',
        hint:
          '端口随签名自动增减。可 import 共享算子（如 operators.split_columns、infer_task 等）；' +
          '需要 GPU / torch 的算子只能在本地宿主上跑。分享工作流时，含自定义代码的节点会单独标注',
      },
    ],
    assetRecipes: [{ kind: 'dataset', nameTemplate: '函数输出', table: { rows: 100, cols: 5 } }],
  },
  {
    type: 'custom.model',
    version: '0.5.0',
    requires: {
      runtime: 'host',
      packages: ['torch'],
      reason: '自定义模型代码需要在本地宿主中编译和校验',
    },
    runtimeClass: 'engine',
    determinism: 'stochastic',
    execClass: 'interactive',
    label: '自定义模型',
    category: 'custom',
    description:
      '显式定义 PyTorch 模型结构与 MODEL_INTERFACE 输入/输出契约。MODEL_PARAMS 自动变成模型内部参数控件；Dataset、DataLoader 和训练过程由训练节点负责。',
    inputs: [],
    outputs: [{ id: 'model', label: '模型定义', type: 'model' }],
    params: [
      {
        key: 'code',
        label: '模型代码',
        type: 'code',
        default:
          'import math\n' +
          'import torch\n' +
          'from torch import nn\n\n' +
          '# 这里只定义网络结构；保存代码后，下面会自动生成可编辑控件\n' +
          '# 输入/输出端口可用 MODEL_INTERFACE 显式声明（省略则保持只有 model 输出）\n' +
          'MODEL_INTERFACE = {\n' +
          '    "inputs": [{"id": "features", "label": "特征", "type": "tensor", "optional": True, "shape": ["batch", "feature"], "dtype": "float32"}],\n' +
          '    "outputs": [{"id": "prediction", "label": "预测", "type": "tensor", "shape": ["batch", "target"]}],\n' +
          '}\n\n' +
          'MODEL_PARAMS = {\n' +
          '    "hidden_dim": {"type": "int", "default": 64, "min": 1, "label": "首层宽度"},\n' +
          '    "depth": {"type": "int", "default": 3, "min": 1, "max": 8, "label": "隐藏层数"},\n' +
          '    "width_multiplier": {"type": "float", "default": 1.0, "min": 0.25, "max": 4.0, "step": 0.25, "label": "宽度倍率"},\n' +
          '    "dropout": {"type": "float", "default": 0.1, "min": 0, "max": 0.9, "step": 0.05, "label": "Dropout"},\n' +
          '}\n\n' +
          'class Model(nn.Module):\n' +
          '    """模型块只描述结构；input_shape/output_dim 由训练节点注入。"""\n' +
          '    def __init__(self, input_shape, output_dim, hidden_dim=64, depth=3, width_multiplier=1.0, dropout=0.1):\n' +
          '        super().__init__()\n' +
          '        widths = [max(1, round(hidden_dim * width_multiplier ** i)) for i in range(depth)]\n' +
          '        layers = [nn.Flatten()]\n' +
          '        in_dim = math.prod(input_shape)\n' +
          '        for out_dim in widths:\n' +
          '            layers.extend([nn.Linear(in_dim, out_dim), nn.ReLU(), nn.Dropout(dropout)])\n' +
          '            in_dim = out_dim\n' +
          '        layers.append(nn.Linear(in_dim, output_dim))\n' +
          '        self.net = nn.Sequential(*layers)\n\n' +
          '    def forward(self, x):\n' +
          '        return self.net(x)\n',
        hint:
          '直接定义 class Model(nn.Module) 即可。MODEL_INTERFACE 显式定义可接入的输入/输出端口；MODEL_PARAMS 只放模型内部参数；input_shape、input_dim、output_dim 等数据形状由宿主自动提供。训练循环由「自定义训练」代码定义，签名参数自动生成控件。',
      },
    ],
    assetRecipes: [],
  },
  {
    type: 'custom.chart',
    version: '0.2.0',
    requires: null,
    // 自定义绘图函数仍然由用户定义，但它的输入输出走真引擎，结果直接进入统一画布预览。
    runtimeClass: 'engine',
    determinism: 'stochastic',
    execClass: 'interactive',
    label: '自定义图表',
    category: 'custom',
    description:
      '用 Python 函数和 Matplotlib 直接绘图：return {"figure": fig}。接上数据后，函数生成的图片会直接显示在节点框内。',
    inputs: [],
    outputs: [],
    params: [
      {
        key: 'code',
        label: '绘制函数',
        type: 'code',
        default:
          'def plot(data):\n' +
          '    import matplotlib.pyplot as plt\n' +
          '    fig, ax = plt.subplots(figsize=(6.4, 4.2), constrained_layout=True)\n' +
          '    if getattr(data, "ndim", 1) == 1:\n' +
          '        ax.plot(data, linewidth=1.4)\n' +
          '        ax.set_xlabel("样本")\n' +
          '        ax.set_ylabel("数值")\n' +
          '    elif data.shape[1] >= 2:\n' +
          '        x_name, y_name = data.columns[0], data.columns[1]\n' +
          '        ax.plot(data[x_name], data[y_name], linewidth=1.4)\n' +
          '        ax.set_xlabel(str(x_name))\n' +
          '        ax.set_ylabel(str(y_name))\n' +
          '    elif data.shape[1] == 1:\n' +
          '        y_name = data.columns[0]\n' +
          '        ax.plot(data[y_name], linewidth=1.4)\n' +
          '        ax.set_xlabel("样本")\n' +
          '        ax.set_ylabel(str(y_name))\n' +
          '    ax.grid(True, alpha=0.25)\n' +
          '    return {"figure": fig}\n',
        hint:
          '函数必须返回 {"figure": fig}，其中 fig 是 Matplotlib Figure。图型、X/Y、标题、颜色、图例等都在这段 Python 代码里控制；无需另接绘图节点。普通默认参数仍会自动生成可编辑控件。',
      },
    ],
    assetRecipes: [],
  },
  {
    type: 'workflow.group',
    version: '0.1.0',
    requires: null,
    // 这是 IR 元节点，不由 Python 实现；运行前会按内联子图展开。
    runtimeClass: 'engine',
    determinism: 'stochastic',
    execClass: 'interactive',
    label: '复合组块',
    category: 'custom',
    description:
      '把一段工作流封装成可复用节点。内部步骤会在运行前展开；输入、输出端口和可编辑参数由组定义提供。',
    inputs: [],
    outputs: [],
    params: [],
    assetRecipes: [],
  },
]

/** 内置节点。自建模块不在这里 —— 它们随用户增删变化，只能现取 */
export const nodeTypeMap = new Map(nodeTypeDefs.map((d) => [d.type, d]))

/**
 * 这个类型是不是"由引擎算出一张图"的节点（图表、概率密度图…）。
 *
 * 判据取**端口声明**里有没有 figure 输出，而不是列一份类型名单：名单会在加下一个出图
 * 算子时漏改，而漏改的症状很安静 —— 那张图照样算得出来，只是永远进不了资产库。
 *
   * 调用方要自己再确认它是引擎节点。
 */
export function producesFigure(type: string, node?: WorkflowNode): boolean {
  if (!hasNodeType(type)) return false
  const def = getNodeTypeDef(type)
  if (def.outputs.some((p) => p.type === 'figure')) return true
  // 函数类节点的输出端口来自代码签名，注册表里的 outputs 有意为空。
  // 约定 return {"figure": ...} 就是一个可直接绘制的 figure 输出。
  const code = node?.params.code ?? def.params.find((p) => p.key === 'code')?.default
  return typeof code === 'string' && parseSignature(code).outputs.some((p) => p.name === 'figure')
}

/**
 * 注册表 = 内置 + 自建。
 *
 * 内置的走常量表（快、可静态分析），自建的每次现取 —— 用户在弹窗里点保存之后
 * 要立刻能在画布上用它，缓存一份就会读到旧清单。
 */
export function allNodeDefs(): NodeTypeDef[] {
  return [...nodeTypeDefs, ...customModuleDefs()]
}

export function hasNodeType(type: string): boolean {
  return nodeTypeMap.has(type) || customModuleDefs().some((d) => d.type === type)
}

export function getNodeTypeDef(type: string): NodeTypeDef {
  const def = nodeTypeMap.get(type) ?? customModuleDefs().find((d) => d.type === type)
  if (!def) throw new Error(`未注册的节点类型: ${type}`)
  return def
}

/** 按参数默认值初始化一个节点的 params */
export function defaultParams(def: NodeTypeDef): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const p of def.params) out[p.key] = p.default
  if (def.type === 'train.function') {
    for (const p of parseTrainingSignature(String(out.code ?? '')).params) {
      if (!p.hasDefault || p.defaultLiteral === null) continue
      out[p.name] = p.defaultLiteral
    }
  }
  if (def.type === 'custom.model') {
    for (const p of parseModelParams(String(out.code ?? '')).specs) {
      // 没有 Python 默认值的构造参数只展示占位，不偷偷替用户传一个 0 / 空字符串。
      // 用户填写后 setParam 才会把它送进宿主，避免“必填”实际上没有生效。
      if (!p.required) out[p.key] = p.default
    }
  }
  return out
}

/** 从节点参数里取一个字符串，找不到就用兜底值 */
export function paramString(
  params: Record<string, string | number | boolean>,
  key: string,
  fallback = '',
): string {
  const v = params[key]
  return v === undefined || v === null ? fallback : String(v)
}

/** 展开资产名模板里的 {arch} {epochs} 之类占位符 */
export function expandTemplate(template: string, params: Record<string, string | number | boolean>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = params[key]
    return v === undefined ? `{${key}}` : String(v)
  })
}
