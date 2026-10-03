"""执行引擎的算子。

统一签名 `(env, params, inputs, output_ports) -> {输出端口 id: 值}`。
算子里不存任何状态，状态都在 runtime 的 env 上 —— 这样单个算子可以单独看懂、单独测。

值只有几种：DataFrame / ndarray / Series / 标量 / 标量字典。
多一层自定义类型只会让每个算子都要判断一次它是什么。
"""


import re

import numpy as np
import pandas as pd

#: 分类与回归的判定阈值：标签取值数不超过这个，就当分类（见 infer_task）
_MAX_CLASSES = 20


def is_user_fn(node_type):
    """自定义节点（custom.*）的代码由用户写，走统一的加载与调用路径"""
    return str(node_type).startswith('custom.')


# ----------------------------------------------------------------------
# 值 → 表
# ----------------------------------------------------------------------


def as_frame(port_id, value):
    """统一成 (列名列表, DataFrame)，行值才能按列序取"""
    if isinstance(value, pd.DataFrame):
        return [str(c) for c in value.columns], value
    if isinstance(value, pd.Series):
        name = str(value.name) if value.name is not None else port_id
        return [name], value.to_frame(name)
    if isinstance(value, np.ndarray):
        if value.ndim == 1:
            return [port_id], pd.DataFrame({port_id: value})
        columns = [f'{port_id}[{i}]' for i in range(value.shape[1])]
        return columns, pd.DataFrame(value, columns=columns)
    if isinstance(value, (list, tuple)):
        return as_frame(port_id, np.asarray(value))
    raise TypeError(f'输出「{port_id}」不是一个表')


def time_column_of(time_columns, columns):
    """输出的哪一列是时间。按数据集登记过的时间列名认，不靠列名猜"""
    for c in columns:
        if str(c) in time_columns:
            return str(c)
    return None


# ----------------------------------------------------------------------
# 数据源
# ----------------------------------------------------------------------


def op_source(env, params, inputs, output_ports):
    """按端口形状取数据：整表 / 时间轴 / 单列。

    端口 id 与形状都由主线程从 `ports.ts` 推导后传进来，这里不自己拼端口名 ——
    否则两处各有一套规则，改了数据源的列开关之后就会悄悄错位。
    """
    ds = env.dataset(params.get('datasetId', ''))
    out = {}
    for spec in output_ports:
        port_id = spec['id']
        shape = spec.get('shape', 'auto')
        if shape == 'table':
            out[port_id] = ds.frame()
        elif shape == 'time':
            out[port_id] = ds.time_frame()
        else:
            out[port_id] = ds.column_frame(port_id)
    return out


# ----------------------------------------------------------------------
# 列拼表
# ----------------------------------------------------------------------


def op_collect(env, params, inputs, output_ports):
    """把多入端口接进来的一摞列横向拼回一张表。

    多入端口的顺序由主线程按连线顺序组装成列表，这里只负责拼接，
    不再按参数名猜测列序。
    """
    values = inputs.get('in') or []
    if not isinstance(values, list):
        values = [values]

    frames = []
    for value in values:
        if value is None:
            continue
        _columns, frame = as_frame('in', value)
        frames.append(frame)

    if not frames:
        raise ValueError('这个「列拼表」还没有接到任何列上 —— 把要拼的列连到它左边那个入口')

    out = pd.concat(frames, axis=1)
    # 同一个列被两根线接进来时会出现重名列，保留先来的
    return {'data': out.loc[:, ~out.columns.duplicated()]}


# ----------------------------------------------------------------------
# 拆列
# ----------------------------------------------------------------------


def _selection_tokens(value):
    """把索引参数拆成 token；保留字符串形式以便报出原始输入。"""

    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        raw = value
    else:
        text = str(value).strip()
        if not text:
            return []
        raw = re.split(r"[,，;；\n]", text)
    return [str(item).strip() for item in raw if str(item).strip()]


def _feature_columns(frame, time_columns=()):
    """返回可按 1-based 序号选择的数值特征，不让时间列占一个特征号。"""

    registered_time = {str(name) for name in (time_columns or ())}
    return [
        column
        for column in frame.columns
        if str(column) not in registered_time and pd.api.types.is_numeric_dtype(frame[column].dtype)
    ]


def _resolve_feature_selection(frame, value, time_columns=()):
    """把 1-based 特征索引解析成真实列名；保留旧工程的列名选择兼容。"""

    tokens = _selection_tokens(value)
    if not tokens:
        return list(frame.columns)

    # 旧工程导入时可能还带着列名。只在整组 token 都是现有列名、且没有数字 token 时
    # 兼容它们；新建节点的数字输入始终按特征索引解释。
    if all(not token.isdecimal() and token != "__time__" for token in tokens) and all(
        token in frame.columns for token in tokens
    ):
        return [next(column for column in frame.columns if column == token) for token in tokens]

    candidates = _feature_columns(frame, time_columns)
    mapping = "、".join(f"{index}={column}" for index, column in enumerate(candidates, 1)) or "无"
    selected = []
    seen = set()
    for token in tokens:
        if token == "__time__":
            column = time_column_of(time_columns, frame.columns)
            if column is None:
                raise KeyError(f"拆列选择了时间列，但上游没有登记时间列。可用特征（序号=列名）：{mapping}")
        elif token.isdecimal():
            index = int(token)
            if index < 1 or index > len(candidates):
                raise KeyError(f"拆列特征索引「{token}」超出范围；可用特征（序号=列名）：{mapping}")
            column = candidates[index - 1]
        elif token in frame.columns:
            # 仅供旧工程兼容；新建节点的界面与文档使用数字特征索引。
            column = next(column for column in frame.columns if column == token)
        else:
            raise ValueError(
                f"拆列只接受从 1 开始的特征索引，收到「{token}」；可用特征（序号=列名）：{mapping}"
            )
        if column not in seen:
            selected.append(column)
            seen.add(column)
    return selected


def split_columns(frame, indices=None, time_columns=()):
    """把一张表按特征索引摊开成 {列名: 单列表}。

    **这是"拆列"的唯一实现**，节点与自定义脚本共用。

    三个刻意的选择：

    - **一列一张单列表**（用 `frame[[name]]` 而不是 `frame[name]`）：与数据源"每个特征列
      一个端口"的形状一致。下游因此不需要分辨"这一步给我的是 Series 还是 DataFrame" ——
      那种分辨迟早会有人漏掉，而症状是"某个算子突然报 axis 相关的错"。
    - **不改行、不改索引**：拆列只改形状，不筛行。行数变了的话，下游按行对齐的那些算子
      （划分、评估）会静默错位。
    - **列不存在就报错，不静默跳过**：`KeyError` 里带上现有列，让"表里到底有什么"当场可见。

    `indices` 不给 = 拆全部列。给的话必须是从 1 开始的数值特征索引，按给定顺序输出。
    索引不包括登记的时间列。`time_columns` 只供节点执行面传入；`__time__` 是旧工程
    迁移用的兼容选择标识，不是新输入格式。

    自己写脚本时可以直接用：`from operators import split_columns`。
    """
    wanted = _resolve_feature_selection(frame, indices, time_columns)
    out = {}
    for column in wanted:
        out[column] = frame[[column]]
    return out


def op_columns(env, params, inputs, output_ports):
    """把一张表摊开：一列一个输出端口。与 `op_collect` 互为逆操作。

    输出端口通常是解析后的真实列名；上游摘要尚未就绪时，主线程可能先传入
    `__feature_index_N` 占位端口。下游拿到的仍然是一张**单列表**。

    有哪些端口不由这里决定：主线程按上游实际的列算好（`resolvePorts`）再传进来。
    让算子自己决定端口，端口列表就有了第二处真相 —— 界面画出来的和引擎产出的
    迟早对不上，而那种错表现为"连着的线突然没数据"。

    真正的拆列在 `split_columns` 里（那个函数可以直接 import 来用），这里只负责
    把节点参数与端口翻译成一次调用。
    """
    _cols, frame = as_frame('data', inputs.get('data'))
    if not output_ports:
        raise ValueError(
            '这个节点还没有输出端口。留空「只拆这些特征（索引）」时，'
            '端口要等上游算过一次之后才长得出来 —— 先把上游接好并运行'
        )
    selected = split_columns(frame, params.get('columns'), getattr(env, 'time_columns', ()))
    ordered = list(selected.items())
    out = {}
    for position, spec in enumerate(output_ports):
        port_id = str(spec['id'])
        # 已知真实列名时按名字取；占位端口或旧 __time__ 端口按本次选择顺序映射。
        if port_id in selected:
            out[port_id] = selected[port_id]
        elif (port_id.startswith('__feature_index_') or port_id == '__time__') and position < len(ordered):
            out[port_id] = ordered[position][1]
        else:
            available = '、'.join(str(c) for c in frame.columns)
            raise KeyError(f'拆列输出端口「{port_id}」没有对应列。现有列：{available}')
    return out


# ----------------------------------------------------------------------
# 自定义函数
# ----------------------------------------------------------------------


def op_userfn(env, node_id, params, inputs):
    fn, name = env.fn(node_id)
    kwargs = {key: _as_call_arg(value) for key, value in inputs.items()}
    result = fn(**kwargs)

    if result is None:
        raise ValueError(f'函数 {name} 没有 return 字典')
    if not isinstance(result, dict):
        raise TypeError(
            f'函数 {name} 要 return 一个字典（形如 return {{"输出名": 值}}），'
            f'实际返回的是 {type(result).__name__}'
        )
    return {str(k): v for k, v in result.items()}


def _as_call_arg(value):
    """喂给用户函数的值：单列表降级成 ndarray，多列给 DataFrame。

    单列给 ndarray 而不是 Series：形参名本身就是列名，再套一层 index 只会让人猜
    "这个 index 是什么"；而用户的 numpy 代码对 ndarray 最直接。
    """
    if isinstance(value, pd.DataFrame):
        numeric = value.select_dtypes(include=[np.number])
        if numeric.shape[1] == 1:
            return numeric.iloc[:, 0].to_numpy()
        return value
    return value


# ----------------------------------------------------------------------
# 数据预览
# ----------------------------------------------------------------------


def op_preview(env, params, inputs, output_ports):
    """原样透传。

    透传的是**同一个对象**，不做任何复制 —— 探针插在链路中间时的承诺就是"不改数据"，
    一旦复制，下游看到的就不是上游那一个表了。

    唯一的例外是裸 ndarray：它自身没有列名，直接透传下游会把端口名当列名看到
    （"head" 而不是 "y"）。给它按上游端口名套一层 DataFrame 补上列名。
    """
    label = env.labels.get('data', 'data')
    value = inputs.get('data')
    if isinstance(value, np.ndarray) and value.ndim == 1:
        return {'head': pd.DataFrame({label: value})}
    return {'head': value}


# ----------------------------------------------------------------------
# 共享表工具

def _numeric_only(frame, what):
    """只取数值列。时间列、通道名这类非数值列不参与运算"""
    numeric = frame.select_dtypes(include=[np.number])
    if numeric.shape[1] == 0:
        raise ValueError(f'{what}需要至少一个数值列')
    return numeric


def infer_task(labels):
    """从标签本身判断这是分类还是回归，而不是让用户每次填一遍。

    判据：**非数值一律当分类**；数值列要"都是整数、非负、种类不超过 20"三条同时成立
    才算分类。真实回归标签恰好同时命中这三条的概率很低，而用户填错任务的代价是
    拿到一个看不懂的分数。

    必须按"值是不是整数"判断，**不能按 dtype**：从 CSV 读进来的 0/1 标签是 float，
    按 dtype 判断会把一个二分类悄悄当成回归，然后给出一个 R² 让你去解释。

    放在共享算子里而不是各处各写一份：训练与评估对"这份标签是什么任务"必须给
    同一个答案 —— 两处各写一份，迟早一处改了另一处没改。
    """
    if not np.issubdtype(np.asarray(labels).dtype, np.number):
        return '分类'
    values = np.asarray(labels)
    rounded = np.round(values)
    if not np.allclose(values, rounded):
        return '回归'
    unique = np.unique(rounded)
    if unique.size <= _MAX_CLASSES and unique.min() >= 0:
        return '分类'
    return '回归'


# 图表：接上游表时，先把要画的点抽稀出来
# ----------------------------------------------------------------------

# 图上最多画多少个点。与前端抽稀数据集视图的上限同一个量级，
# 两边按同一种取舍来看图，形状才有可比性。
CHART_MAX_POINTS = 6000

# 这些图型靠"包络抽稀"保毛刺：折线/散点上一个尖峰就是一次异常，
# 等距抽样很可能整个跳过去。直方图/密度图/柱状图相反 —— 它们要看分布形状，
# 包络专挑极值会把分布拉歪，必须等距抽样。（前端抽稀也是按图型这么分的。）
_ENVELOPE_CHARTS = ('line', 'scatter', 'box')


def _decimate_indices(values, n, max_points, mode):
    """抽稀后的行下标，升序且不重复。

    envelope：每个桶取该列的最小值与最大值两个点。桶数取 max_points/2，
    所以输出的点数不超过 max_points。
    """
    if n <= max_points:
        return np.arange(n)

    if mode != 'envelope':
        step = int(np.ceil(n / max_points))
        return np.arange(0, n, step)

    buckets = max(1, max_points // 2)
    edges = np.linspace(0, n, buckets + 1).astype(int)
    picks = []
    for i in range(buckets):
        lo = int(edges[i])
        hi = int(max(edges[i] + 1, edges[i + 1]))
        segment = values[lo:hi]
        if segment.size == 0:
            continue
        finite = np.isfinite(segment)
        if not finite.any():
            # 整段都是 NaN：给一个代表点就够，免得整段从图上消失
            picks.append(lo)
            continue
        masked = np.where(finite, segment, np.nan)
        picks.append(lo + int(np.nanargmin(masked)))
        picks.append(lo + int(np.nanargmax(masked)))
    return np.unique(np.asarray(picks, dtype=int))


def _ratio_point_limit(n, ratio):
    """把 0~1 的取点比例转换成实际点数。

    密度估计至少需要两个点；因此正比例在极小时保留 2 个点，比例为 0 则返回 0，
    让前端明确显示“有效数据点不足”，而不是偷偷把 0 改成一个别的比例。
    """
    try:
        value = float(ratio)
    except (TypeError, ValueError) as err:
        raise ValueError("取点比例必须是 0 到 1 之间的数") from err
    if not np.isfinite(value) or value < 0 or value > 1:
        raise ValueError("取点比例必须是 0 到 1 之间的数")
    if value == 0:
        return 0
    return min(n, max(2, int(np.ceil(n * value))))


def op_chart(env, params, inputs, output_ports):
    """图表节点的数据面：把上游表抽稀成可以直接画的点。

    没接上游就什么都不产出（`figure` 端口这次没有值）；契约层会要求图表节点连接
    输入数据，界面也只显示这份真实输入生成的图，不会另从数据集选择器回退。

    列原样保留（含时间列）：哪一列当 X、哪一列当 Y 是映射的事，抽稀不该顺手把
    用户可能马上要改的列丢掉。
    """
    value = inputs.get('data')
    if value is None:
        return {'figure': None}

    _cols, frame = as_frame('data', value)
    if len(frame) == 0:
        return {'figure': None}

    chart_type = str(params.get('chartType') or 'scatter')
    mode = 'envelope' if chart_type in _ENVELOPE_CHARTS else 'stride'

    # 包络要盯着一列看。优先用户映射的 Y，其次第一个数值列（时间列不算，
    # 它对时间轴单调递增，拿它做包络等于等距抽样）
    numeric = _numeric_only(frame, '出图')
    time_col = time_column_of(env.time_columns, list(frame.columns))
    measures = [c for c in numeric.columns if str(c) != str(time_col)]
    column = str(params.get('y') or '')
    if column not in frame.columns or column not in measures:
        column = str(measures[0]) if measures else str(numeric.columns[0])

    values = frame[column].to_numpy(dtype=np.float64)
    index = _decimate_indices(values, len(frame), CHART_MAX_POINTS, mode)
    return {'figure': frame.iloc[index].reset_index(drop=True)}


# 概率密度图与普通图表共用同一份抽稀工具，但密度图只按等距方式取样，
# 避免极值包络改变分布形状。
def op_density(env, params, inputs, output_ports):
    value = inputs.get('data')
    if value is None:
        raise ValueError('还没有接到要画的列：把上游某一列（或一张单列表）连到「数据列」')

    _cols, frame = as_frame('data', value)
    if len(frame) == 0:
        raise ValueError('接进来的这一列没有数据行')

    numeric = _numeric_only(frame, '概率密度图')
    time_col = time_column_of(env.time_columns, list(frame.columns))
    measures = [c for c in numeric.columns if str(c) != str(time_col)]
    if not measures:
        raise ValueError('接进来的是时间列，它不是测量值，请改接测量列')

    values = frame[measures[0]].to_numpy(dtype=np.float64)
    limit = _ratio_point_limit(len(frame), params.get('sampleRatio', 1))
    if limit == 0:
        return {'figure': frame.iloc[0:0].copy()}
    index = _decimate_indices(values, len(frame), limit, 'stride')
    return {'figure': frame.iloc[index].reset_index(drop=True)}


# ----------------------------------------------------------------------
# 评估
# ----------------------------------------------------------------------


def op_eval_score(env, params, inputs, output_ports):
    """真算评估指标：给一张**同时有真实列与预测列的表**。

    分类给准确率 / 精确率 / 召回率 / F1 与混淆矩阵，回归给 MAE / RMSE / R²。

    为什么不直接吃模型：模型是宿主侧的权重（浏览器里没有 torch），而指标只需要两条
    对齐的序列。这样它两个执行面都能跑 —— 判据是 scikit-learn 在 Pyodide 的包表里
    （AGENTS.md R4）—— 于是"想看一个 F1"不必为了它去起宿主。

    数值口径**以 scikit-learn 为准**：这里不自己写公式。自己写的话，"和 sklearn 对不上"
    时没法判断是谁错了。守卫在测试里：同一个输入喂给两边，逐项比 ——
    引擎自己的上一次输出不算真值。
    """
    cols, frame = as_frame('data', inputs.get('data'))
    names = {}
    for key, what in (('y_true', '真实标签列'), ('y_pred', '预测列')):
        value = str(params.get(key) or '').strip()
        if not value:
            raise ValueError(f'要指定{what}：数据表里哪一列是它，这个不能替你猜')
        if value not in frame.columns:
            available = '、'.join(str(c) for c in frame.columns)
            raise KeyError(f'数据表里没有{what}「{value}」。现有列：{available}')
        names[key] = value

    # 两列都得有值的行才算：缺失值上算出来的指标没有意义，而它不会报错
    pair = frame[[names['y_true'], names['y_pred']]].dropna()
    if len(pair) == 0:
        raise ValueError('真实列与预测列里没有一行是同时有值的 —— 指标无从算起')
    y_true_raw = pair[names['y_true']].to_numpy()
    y_pred_raw = pair[names['y_pred']].to_numpy()

    task = str(params.get('task') or 'auto')
    if task == 'auto':
        task = infer_task(y_true_raw)
    if task not in ('分类', '回归'):
        raise ValueError(f'不认识的评估任务「{task}」，可选：auto、分类、回归')

    # 顶层包才有 __version__（`sklearn.metrics` 上没有这个属性）
    import sklearn
    from sklearn import metrics as skm

    # 元信息：这批数字是哪一版实现算的、按哪个任务算的。指标里放不下字符串，
    # 而它们正是"这次和上次是不是同一件事"要用的东西
    env.set_meta({"库": f"scikit-learn {sklearn.__version__}", "任务": task})

    if task == '分类':
        # 类别顺序按字符串排：得是**稳定**的，否则同一个输入的混淆矩阵行列会跳，
        # 而"行列换了个位置"看起来只是数字变了 —— 那种错很难看出来
        labels = sorted({str(v) for v in y_true_raw} | {str(v) for v in y_pred_raw})
        y_true = np.array([str(v) for v in y_true_raw])
        y_pred = np.array([str(v) for v in y_pred_raw])
        matrix_counts = skm.confusion_matrix(y_true, y_pred, labels=labels)
        precision, recall, f1, support = skm.precision_recall_fscore_support(
            y_true, y_pred, labels=labels, zero_division=0
        )
        metrics = {
            '样本数': float(len(y_true)),
            '类别数': float(len(labels)),
            '准确率': float(skm.accuracy_score(y_true, y_pred)),
            '宏平均精确率': float(
                skm.precision_score(y_true, y_pred, labels=labels, average='macro', zero_division=0)
            ),
            '宏平均召回率': float(
                skm.recall_score(y_true, y_pred, labels=labels, average='macro', zero_division=0)
            ),
            '宏平均F1': float(
                skm.f1_score(y_true, y_pred, labels=labels, average='macro', zero_division=0)
            ),
            '加权F1': float(
                skm.f1_score(y_true, y_pred, labels=labels, average='weighted', zero_division=0)
            ),
        }
        rows = []
        for i, label in enumerate(labels):
            row = {'真实\\预测': label}
            for j, other in enumerate(labels):
                row[f'预测 {other}'] = float(matrix_counts[i][j])
            row['合计'] = float(matrix_counts[i].sum())
            rows.append(row)
        matrix = pd.DataFrame(rows)
        per_class = pd.DataFrame(
            {
                '类别': labels,
                '支持数': support.astype(float),
                '精确率': precision.astype(float),
                '召回率': recall.astype(float),
                'F1': f1.astype(float),
            }
        )
        return {'metrics': metrics, 'matrix': matrix, 'per_class': per_class}

    try:
        y_true = y_true_raw.astype(np.float64)
        y_pred = y_pred_raw.astype(np.float64)
    except (TypeError, ValueError):
        raise ValueError('回归评估要求真实值与预测值都是数值；如果它们是类别名，把任务改成「分类」') from None
    metrics = {
        '样本数': float(len(y_true)),
        'MAE': float(skm.mean_absolute_error(y_true, y_pred)),
        # RMSE 用平方根自己开：sklearn 的 squared=False 已经弃用，而"用哪个参数"这种
        # 事不该让调用方去猜版本
        'RMSE': float(np.sqrt(skm.mean_squared_error(y_true, y_pred))),
        'R2': float(skm.r2_score(y_true, y_pred)),
    }
    # 回归没有混淆矩阵与分类别指标。返回 None 而不是空表：
    # 界面会说"本次没有值"，而空表会被当成"算出来是空的"
    return {'metrics': metrics, 'matrix': None, 'per_class': None}


OPERATORS = {
    'data.source': op_source,
    'data.collect': op_collect,
    'data.columns': op_columns,
    'data.preview': op_preview,
    'viz.chart': op_chart,
    'viz.density': op_density,
    'eval.score': op_eval_score,
}
