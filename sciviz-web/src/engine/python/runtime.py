"""执行引擎的 Python 侧运行时。

边界刻意做得很窄：主线程只送"指令"，中间节点的输出一直在 Python 侧流转。
真正会搬运字节的只有两处 —— 装载原始数据集（进来）和取前 N 行（出去）。
1M 行 × 10 列如果每个节点都来回搬一遍，光序列化就能把界面卡死。

所有对外入口都收发 JSON 字符串，不做 JS 对象的深层互转：
JsProxy 的嵌套访问又慢又容易出意外，而这里的数据量本来就小。
"""

import base64
import hashlib
import json
import math
import re
import traceback
from io import BytesIO
from pathlib import Path
from typing import Literal, TypedDict

import numpy as np
import pandas as pd

import operators

# datasetId -> Dataset
_datasets = {}
# nodeId -> {portId: DataFrame | ndarray | Series | 标量 | dict}
_outputs = {}
# nodeId -> (callable, fnName)
_fns = {}
# nodeId -> namespace containing a custom model plugin (build_model, make_dataset, ...)
_model_plugins = {}
# 所有数据集的时间列名。判断"输出的哪一列是时间"用它，而不是给 DataFrame 打标签 ——
# 打标签要跟着对象穿过 concat / 切片，而这些操作都不保证保留 attrs，早晚会丢。
_time_columns = set()
_matplotlib_backend_ready = False


class FigureImagePayload(TypedDict):
    mimeType: Literal["image/png"]
    data: str
    width: int
    height: int


MAX_FIGURE_BYTES = 8 * 1024 * 1024

_loading = None


class Cancelled(RuntimeError):
    """长任务被取消。

    它**不是错误**：用户按了取消。所以 `eval_payload` 把它与真异常分开报 ——
    否则运行清单里会多出一条"失败"，而下一次运行会去对比一个根本不存在的差异。
    """


def set_job_context(on_progress=None, should_cancel=None, artifacts=None, fingerprint=None):
    """给这一次求值装上作业上下文（进度 / 取消 / 产物落盘 + 它对应的输入指纹）。

    由**调用方**（宿主）在求值前装上、求值后清掉。之所以走模块级而不是算子的参数，
    是为了让算子签名保持四个参数不变 —— 共享算子在浏览器与宿主两侧写法完全一样，
    没装钩子时 `progress` / `check_cancel` 都是 no-op。

    **一次求值一个上下文**：上一轮的取消标志或产物清单漏到下一轮，表现都是
    "莫名其妙的行为"，而那是最难查的一类。
    """
    ENV.set_job_context(on_progress, should_cancel, artifacts, fingerprint)


def set_execution_face(name):
    """声明"现在这套 Python 跑在哪一侧"：`'pyodide'`（浏览器）或 `'host'`（本地宿主）。

    只为一件事：**把"缺某个库"翻译成下一步做什么** —— 而两侧的下一步完全不同。
    浏览器那侧装的包是打包时定下的，用户装不了任何东西；宿主那侧用户可以装。
    这句话不写清楚，用户拿到的就只有一句 `No module named 'torch'`。

    由**调用方在启动时**声明一次（浏览器的 worker 与宿主的会话各调一次），
    而不是每次求值都传：它是这套运行时的属性，不是某一次求值的属性。
    """
    ENV.face = str(name or "unknown")


class ArtifactStore:
    """产物登记处：算子把落盘的东西登记进来，随这一次求值的结果一并回传。

    这样"这次运行产出了哪些文件"与"这次运行算出了什么"走同一条路，
    运行清单不必再去猜、也不必另问一次。

    模型权重由宿主按唯一 artifact_id 原子提交到子目录；这里仍负责把该目录里的文件
    登记进本次运行清单。训练指纹用于判定当前结果，不用于磁盘路径，因此随机重训不会
    覆盖旧权重。
    """

    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.entries = []

    def reset(self):
        """一次求值一个干净的登记表"""
        self.entries = []

    def dir_for(self, key):
        digest = hashlib.sha256(str(key or "unknown").encode("utf-8")).hexdigest()[:16]
        target = self.root / digest
        target.mkdir(parents=True, exist_ok=True)
        return target

    def record(self, kind, path, fingerprint=None, artifact_id=None, sha256=None, created_at=None):
        target = Path(path)
        entry = {"kind": str(kind), "path": str(target)}
        try:
            entry["bytes"] = int(target.stat().st_size)
        except OSError:
            # 文件不在（写失败、被删）也要如实登记：清单里"有这条但 0 字节"
            # 比"这条不见了"更容易查
            entry["bytes"] = 0
        if fingerprint:
            entry["fingerprint"] = str(fingerprint)
        if artifact_id:
            entry["artifactId"] = str(artifact_id)
        if sha256:
            entry["sha256"] = str(sha256)
        if created_at:
            entry["createdAt"] = str(created_at)
        self.entries.append(entry)
        return target


class Dataset:
    """一份装载进来的数据集。列以 numpy 数组持有，时间列单独放"""

    def __init__(self, dataset_id, row_count, time_column, columns):
        self.id = dataset_id
        self.row_count = int(row_count)
        self.time_column = time_column
        self.columns = list(columns)
        self.time = None
        self.data = {}

    def frame(self):
        """整表：时间列排最前，其余按前端给的启用顺序。

        时间排在前面不是审美问题 —— 只有特征值没有时刻，判断不了这段数据是什么时候的。
        """
        cols = {}
        if self.time_column and self.time is not None:
            cols[self.time_column] = self.time
        for name in self.columns:
            if name in self.data:
                cols[name] = self.data[name]
        if not cols:
            raise ValueError("这份数据集没有启用任何列，先在数据面板里打开至少一列")
        return pd.DataFrame(cols)

    def time_frame(self):
        if not self.time_column or self.time is None:
            raise ValueError("这份数据集没有时间列")
        return pd.DataFrame({self.time_column: self.time})

    def column_frame(self, name):
        if name not in self.data:
            raise KeyError(f"数据集里没有列「{name}」（可能已被关闭）")
        return pd.DataFrame({name: self.data[name]})


class Env:
    """算子能看到的全部外部状态。传给算子而不是让它们 import 本模块，避免循环导入"""

    def __init__(self):
        # 每个输入端口的"列名提示"，求值前由 _evaluate 填好
        self.labels = {}
        # 数据集登记过的时间列名。算子要用它判断"输出的哪一列是时间"
        self.time_columns = _time_columns
        self._on_progress = None
        self._should_cancel = None
        #: 产物登记处（宿主装；浏览器里是 None，那里没有文件系统）
        self.artifacts = None
        #: 这一次求值对应的输入指纹。由主线程算好传下来，产物按它归档
        self.fingerprint = ""
        #: 这套 Python 跑在哪一侧（见 set_execution_face）。默认 "unknown"，
        #: 两侧启动时都会显式声明 —— 不猜，猜错的文案比没有文案更糟
        self.face = "unknown"
        #: 这次求值的元信息（设备、版本…）。见 set_meta
        self.meta = {}
        #: 这次求值的数据**实际**的采样率（Hz）。由主线程从上游数据集的身份里查出来
        #: （契约规格 R3.4：采样率是数据的属性）。None = 查不出来，算子不许猜
        self.sample_rate = None
        #: 当前求值节点。宿主专属的自定义模型用它取已编译的模型脚本。
        self.node_id = ""

    def set_job_context(self, on_progress, should_cancel, artifacts, fingerprint):
        self._on_progress = on_progress
        self._should_cancel = should_cancel
        self.artifacts = artifacts
        self.fingerprint = str(fingerprint or "")
        # 元信息跟着"一次求值"走，所以在这里清空 —— 上一次的"用了 GPU"漏到这一次，
        # 就是一条**看起来完全合理**的假话
        self.meta = {}

    def set_meta(self, values):
        """登记这次求值的**元信息**：设备、版本、来源这类"数字之外的事实"。

        为什么需要它：输出的指标只收数值（`describe` 的 `_numbers`），于是
        "用了哪块 GPU""torch 什么版本"这类事实被**静默丢掉** —— 而它们正是判断
        "这次和上次是不是同一件事"要用的东西。

        只收 JSON 能表达的基本类型（字符串/数值/布尔）。收不下的就当没写：
        元信息里塞一个对象，界面与运行清单都没法如实展示它。
        """
        for key, value in dict(values or {}).items():
            if isinstance(value, (str, bool, int, float)) and not isinstance(value, complex):
                self.meta[str(key)] = value

    def artifact_path(self, name):
        """旧式普通文件产物路径，按本次输入指纹归档。

        不可变模型制品不得走此入口；宿主训练适配器负责按 artifact_id 原子提交。

        没有产物登记处就抛错，而不是悄悄返回一个临时路径 —— 那样用户的产物会
        落在某个他永远找不到的地方（浏览器里根本没有文件系统）。
        """
        if self.artifacts is None:
            raise RuntimeError("这个执行面不能把产物落盘：浏览器里的 Pyodide 没有文件系统")
        return self.artifacts.dir_for(self.fingerprint or "unknown") / str(name)

    def record_artifact(self, kind, path, artifact_id=None, sha256=None, created_at=None):
        """把刚落盘的产物登记进来，运行清单据此记下路径、身份与校验值"""
        if self.artifacts is None:
            return None
        return self.artifacts.record(
            kind, path, self.fingerprint, artifact_id, sha256, created_at
        )

    def progress(self, ratio, message=""):
        """报一句"做到哪儿了"。ratio 落在 [0, 1]。

        只管往上送，节流是传输层的事 —— 算子按自己最自然的粒度报（训练可以每个 batch
        报一次），不该为了"少发几条消息"把可中断点也一起变粗。
        """
        if self._on_progress is None:
            return
        self._on_progress(max(0.0, min(1.0, float(ratio))), str(message or ""))

    def check_cancel(self):
        """在可中断的点调用它。被取消时抛 `Cancelled`。

        这是**协作式**取消：同步 Python 里没有"从外面掐断"这回事，硬来只会把会话
        留在半截状态（数据集装了一半、输出表写了一半）。所以取消是一面旗子，
        算子负责在自己的循环里看它。
        """
        if self._should_cancel is not None and self._should_cancel():
            raise Cancelled("已取消")

    def dataset(self, dataset_id):
        ds = _datasets.get(str(dataset_id))
        if ds is None:
            raise KeyError(
                f"数据集「{dataset_id}」还没装载到执行引擎。"
                "请先在顶栏导入 CSV，并确认数据源节点选择了这份数据"
            )
        return ds

    def output(self, node_id, port_id):
        node_out = _outputs.get(node_id)
        if node_out is None:
            raise ValueError(f"上游节点「{node_id}」还没有求值结果")
        if port_id not in node_out:
            raise ValueError(f'上游节点「{node_id}」没有输出端口「{port_id}」')
        return node_out[port_id]

    def fn(self, node_id):
        hit = _fns.get(node_id)
        if hit is None:
            raise ValueError("这个函数节点还没加载代码")
        return hit

    def model_plugin(self, node_id):
        plugin = _model_plugins.get(node_id)
        if plugin is None:
            raise ValueError("这个自定义模型还没加载代码")
        return plugin


ENV = Env()


# ----------------------------------------------------------------------
# 数据集装载
# ----------------------------------------------------------------------


def begin_dataset(meta_json):
    global _loading
    meta = json.loads(meta_json)
    _loading = Dataset(
        meta["datasetId"],
        meta["rowCount"],
        meta.get("timeColumn"),
        meta.get("columns") or [],
    )


def set_time(array):
    """有时间列时才调用。

    不把 null 传进来当"没有时间列"用：JS 的 null 在 Python 侧是 JsNull 对象而不是 None，
    判断 `is not None` 会是真，然后在一个没有 to_py 的对象上炸掉。
    """
    if _loading is None:
        raise RuntimeError("还没有开始装载数据集")
    _loading.time = _own(array, np.float64)
    if _loading.time_column:
        _time_columns.add(_loading.time_column)


def add_column(name, array):
    if _loading is None:
        raise RuntimeError("还没有开始装载数据集")
    _loading.data[str(name)] = _own(array, np.float32)


def end_dataset():
    global _loading
    if _loading is None:
        raise RuntimeError("还没有开始装载数据集")
    _datasets[_loading.id] = _loading
    _loading = None


def abort_dataset():
    """放弃一次没装载完的数据集。

    装载中途失败（列数对不上、类型不认识）时 _loading 会停在半截状态。
    不清掉它，下一份数据集的 begin_dataset 就会在它上面继续追加列 ——
    症状是"换了一份数据，结果里混着上一次的列"，很难查。
    """
    global _loading
    _loading = None


def _own(js_array, dtype):
    """把外来的数组变成 Python 自己拥有的一份。

    两个适配器都走这一条路：Pyodide 送来 JsProxy（`.to_py()` 之后是 memoryview），
    本地宿主送来 bytes（`frombuffer` 之后是 numpy 视图）。语义完全一样 ——
    "拷贝一份自己拥有的" —— 没有理由各写一份；而这份文件一旦分成两份，
    同一个算子在两个客户端就会算出不同的实现哈希，A5 的指纹承诺随即失效。

    先 frombuffer 拿到的是**指向对方内存的视图**，而对方随时可能回收它 ——
    留一个悬空视图会让数据时对时错，比多拷 40MB 危险得多。所以这里立刻拷一份。
    """
    if hasattr(js_array, 'to_py'):
        js_array = js_array.to_py()
    elif isinstance(js_array, np.ndarray):
        return np.array(js_array, dtype=dtype)
    return np.array(np.frombuffer(js_array, dtype=dtype), dtype=dtype)


# ----------------------------------------------------------------------
# 用户函数
# ----------------------------------------------------------------------


def load_fn(node_id, fn_name, code):
    """把用户代码编译进一个独立命名空间。只做一次，参数变化只重新调用"""
    _prepare_matplotlib_backend(code)
    namespace = {"__name__": "sciviz_user_code"}
    try:
        compiled = compile(code, f"<节点 {node_id}>", "exec")
    except SyntaxError as err:
        # 从聊天回复、文档、网页里复制代码时，最常带上的垃圾是 markdown 的代码围栏（```）。
        # 原来只报一句 "invalid syntax"，用户对着七十行代码找不出问题在哪；
        # 只在**真的把编译卡住的那一行**是围栏时加这句提示，所以文档字符串里合法出现的
        # 围栏不会误伤 —— 那种代码本来就编译得过。
        lines = code.splitlines()
        line = lines[err.lineno - 1].strip() if err.lineno and err.lineno <= len(lines) else ""
        if line.startswith("```"):
            raise SyntaxError(
                f"第 {err.lineno} 行是 markdown 的代码围栏「{line}」："
                "从聊天回复或文档里复制 Python 代码时容易把围栏一起粘进来，删掉这一行即可"
            ) from None
        raise
    exec(compiled, namespace)
    fn = namespace.get(fn_name)
    if fn is None:
        raise NameError(f"代码里没有定义函数 {fn_name}")
    if not callable(fn):
        raise TypeError(f"{fn_name} 不是一个函数")
    _fns[node_id] = (fn, fn_name)


def load_model(node_id, code):
    """编译自定义模型脚本，并缓存其命名空间。

    自定义模型不是普通数据函数：它的入口可以是 ``build_model``，也可以直接定义
    一个 ``torch.nn.Module`` 子类（默认优先找名为 ``Model`` 的类），可选入口
    是 ``make_spec``、``build_dataloader``、``train_step``、``validation_step``、
    ``predict_step``、``fit_model``，以及兼容用的 ``make_dataset``、``loss_fn``、
    ``make_dataloader``、``decode_predictions``。代码只在变化时重新编译；真正的 torch 代码由
    本地宿主执行，浏览器引擎会在求值前被契约层拦下。
    """
    source = str(code or "")
    cached = _model_plugins.get(node_id)
    if cached is not None and cached.get("__source__") == source:
        return

    namespace = {"__name__": "sciviz_custom_model"}
    try:
        compiled = compile(source, f"<自定义模型 {node_id}>", "exec")
    except SyntaxError as err:
        lines = source.splitlines()
        line = lines[err.lineno - 1].strip() if err.lineno and err.lineno <= len(lines) else ""
        if line.startswith("```"):
            raise SyntaxError(
                f"第 {err.lineno} 行是 markdown 的代码围栏「{line}」："
                "请删掉代码首尾的 ``` 行"
            ) from None
        raise
    exec(compiled, namespace)
    build = namespace.get("build_model")
    # 不导入 torch 做实例化，只在编译阶段确认代码看起来声明了 Module 类；
    # 真正的类型检查和实例化由宿主侧 train.custom 完成。
    has_module_class = bool(
        re.search(
            r"(?:^|\n)\s*class\s+[A-Za-z_]\w*\s*\([^\n)]*(?:torch\.)?nn\.Module",
            source,
        )
    )
    if not callable(build) and not has_module_class:
        raise NameError(
            "自定义模型代码必须定义 torch.nn.Module 子类（可命名为 Model），"
            "或提供兼容的 build_model(spec, model_params)"
        )
    namespace["__source__"] = source
    _model_plugins[node_id] = namespace


# ----------------------------------------------------------------------
# 求值
# ----------------------------------------------------------------------


def eval_payload(payload_json):
    payload = json.loads(payload_json)
    node_id = payload["nodeId"]
    try:
        result = _evaluate(payload)
        refs = {}
        output_specs = {str(spec.get("id")): spec for spec in payload.get("outputPorts") or []}
        identity = str(payload.get("fingerprint") or "")
        lineage = [str(item) for item in (payload.get("lineage") or [])]
        for port_id, value in result.items():
            if value is None:
                # 函数有多条 return 分支时，端口在这一次可能确实没有值。
                # 不编一个空表出来冒充，直接不给 ref，让界面如实说"本次没有值"。
                continue
            refs[port_id] = describe(value, port_id, output_specs.get(port_id), identity=identity, lineage=lineage)
        _outputs[node_id] = result
        # 产物随结果一并回传：这次算出了什么、落了哪些文件，是同一条消息里的两件事
        artifacts = list(ENV.artifacts.entries) if ENV.artifacts is not None else []
        return json.dumps(
            {"ok": True, "refs": refs, "artifacts": artifacts, "meta": dict(ENV.meta)},
            ensure_ascii=False,
        )
    except Cancelled as err:
        # 取消单独一条路：它不是错误，上层要据此把节点放回"可以重试"而不是"失败"。
        # 注意**不动 `_outputs[node_id]`** —— 这次没有产出，旧的那些也已经被主线程丢掉了
        return json.dumps(
            {"ok": False, "cancelled": True, "message": str(err) or "已取消"},
            ensure_ascii=False,
        )
    except Exception as err:  # noqa: BLE001 —— 任何异常都要变成可见的 traceback，不能吞
        return json.dumps(
            {
                "ok": False,
                "message": error_message(err),
                "traceback": traceback.format_exc(),
            },
            ensure_ascii=False,
        )


def error_message(err):
    """异常 → 界面上那一行字。

    大多数异常照原样报（`KeyError: ...` 这种，共享算子里写的说明本身就是给用户看的）。
    只有一类要翻译：**缺库**。用户写 `import torch` 拿到一句
    `No module named 'torch'` 是没有用的 —— 那既不是他的错，也没告诉他下一步做什么，
    而下一步在浏览器与宿主上完全不同。
    """
    if isinstance(err, ModuleNotFoundError):
        module = getattr(err, "name", None) or _module_name_of(str(err)) or "某个模块"
        if ENV.face == "host":
            return (
                f"当前 Python 环境里没有模块「{module}」。"
                "先确认宿主是用 sciviz-local\\run-host.ps1 起的 —— 它钉的是仓库根的 .venv"
                "（torch 与 CUDA 都在那里）；要装新的库，把它加进 requirements.txt 再跑 "
                ".\\setup-env.ps1 -Update。"
            )
        if ENV.face == "pyodide":
            return (
                f"浏览器的执行引擎里没有模块「{module}」—— 它只带打包时定下的那批库，"
                "装不了新的。能跑这个库的是本地宿主：启动 sciviz-local\\run-host.ps1，"
                "刷新页面后重试（宿主里也缺的话，那边会告诉你装它的命令）。"
            )
        return (
            f"这个执行引擎里没有模块「{module}」。本地宿主能跑更多库："
            "启动 sciviz-local\\run-host.ps1 后重试。"
        )
    return f"{type(err).__name__}: {err}"


def _module_name_of(text):
    """从 `No module named 'torch.nn'` 里取出模块名。

    `err.name` 从 3.6 起就有，这里是兜底：某些情况下它可能是 None（比如
    在 import 机制之外手工抛出的 ModuleNotFoundError）。
    """
    match = re.search(r"named '([^']+)'", text)
    return match.group(1) if match else None


def _evaluate(payload):
    node_type = payload["nodeType"]
    params = payload.get("params") or {}
    bindings = payload.get("inputs") or {}
    inputs = _resolve_inputs(bindings)
    output_ports = payload.get("outputPorts") or []

    # 这一次求值对应的输入指纹。产物按它归档，所以"同一份输入算两次"落在同一个目录 ——
    # 那是跨运行复用的立足点（待办 T18）
    ENV.fingerprint = str(payload.get("fingerprint") or "")
    ENV.node_id = str(payload.get("nodeId") or "")

    # 这份数据实际的采样率（Hz），由主线程从数据集身份里查出来。None = 查不出来。
    # 算子只读它，不许拿一个默认值顶上 —— 那等于编一个采样率出来，而下游每个频率值
    # 都建立在这个编出来的数字上（契约规格 R3.4）
    rate = payload.get("sampleRate")
    ENV.sample_rate = float(rate) if isinstance(rate, (int, float)) and rate > 0 else None

    # 端口在界面上叫什么，就当作这一路的"列名提示"。ndarray 自身没有列名，
    # 透传时不带上它，下游就会看到端口名（比如 "head"）当列名
    #
    # 多入端口（契约规格 R13）的值是一串绑定，没有"那一个上游端口名"可给 —— 用端口名。
    # 这一串里的每一项本来就带着自己的列名（单列表），只有裸 ndarray 才会退到这个提示上。
    def _label_of(port_id, binding):
        if isinstance(binding, list):
            return port_id
        return binding["portId"] if binding["kind"] == "port" else port_id

    ENV.labels = {port_id: _label_of(port_id, b) for port_id, b in bindings.items()}

    if node_type == "custom.model":
        load_model(payload["nodeId"], params.get("code", ""))

    if node_type in operators.OPERATORS:
        return operators.OPERATORS[node_type](ENV, params, inputs, output_ports)

    if operators.is_user_fn(node_type):
        return operators.op_userfn(ENV, payload["nodeId"], params, inputs)

    raise NotImplementedError(f"执行引擎还不支持节点类型「{node_type}」")


def _resolve_inputs(bindings):
    resolved = {}
    for port_id, binding in bindings.items():
        # 多入端口（契约规格 R13）：一个端口一串绑定，值按连线顺序给成列表
        if isinstance(binding, list):
            resolved[port_id] = [_resolve_binding(b) for b in binding]
        else:
            resolved[port_id] = _resolve_binding(binding)
    return resolved


def _resolve_binding(binding):
    """一条绑定 → 一个值。端口取上一次求值的输出，字面量原样用"""
    if binding["kind"] == "port":
        return ENV.output(binding["nodeId"], binding["portId"])
    return binding["value"]


def describe(value, port_id, output_spec=None, identity=None, lineage=None):
    """把一个输出值变成目录卡片，不把大对象搬回主线程。

    figure / scaler / model 的真实 Python 对象继续留在当前会话中，摘要只放前端
    需要的可序列化信息。这样自定义函数可以直接返回 DataFrame 或已拟合 scaler，
    而不会因为出口无法展平为普通表而失败。
    """
    declared_kind = str((output_spec or {}).get("kind") or "")
    if declared_kind == "scaler" or _looks_like_scaler(value):
        return _describe_meta({"kind": "scaler", "scaler": scaler_summary(value)}, identity, lineage)
    if declared_kind == "model" or _looks_like_model(value):
        return _describe_meta({"kind": "model", "model": model_summary(value)}, identity, lineage)
    if declared_kind == "figure":
        image = _matplotlib_figure_image(value)
        if image is not None:
            return _describe_meta({"kind": "figure", "image": image}, identity, lineage)
        if isinstance(value, (pd.DataFrame, pd.Series, np.ndarray, list, tuple)):
            # 兼容旧自定义绘图函数：返回 DataFrame 时仍走共享 SVG 图表路径。
            columns, frame = operators.as_frame(port_id, value)
            return _describe_meta({
                "kind": "figure",
                "columns": columns,
                "rowCount": int(len(frame)),
                "timeColumn": operators.time_column_of(_time_columns, columns),
            }, identity, lineage)
        raise TypeError(
            f"图像输出「{port_id}」必须是 Matplotlib Figure；旧绘图函数也可暂时返回 DataFrame"
        )
    if isinstance(value, dict):
        if declared_kind == "model":
            return _describe_meta({"kind": "model", "model": value}, identity, lineage)
        return _describe_meta({"kind": "metrics", "values": _numbers(value)}, identity, lineage)
    if isinstance(value, (bool, int, float, np.number)):
        return _describe_meta({"kind": "metrics", "values": {port_id: _finite(float(value))}}, identity, lineage)
    if isinstance(value, (pd.DataFrame, pd.Series, np.ndarray, list, tuple)):
        columns, frame = operators.as_frame(port_id, value)
        return _describe_meta({
            "kind": "table",
            "columns": columns,
            "rowCount": int(len(frame)),
            "timeColumn": operators.time_column_of(_time_columns, columns),
            "stats": _table_stats(frame, columns),
        }, identity, lineage)

    raise TypeError(
        f"输出「{port_id}」是 {type(value).__name__}，暂时不知道怎么展示。"
        "普通函数应 return DataFrame / ndarray / 标量；自定义图表请 return {'figure': Matplotlib Figure}，"
        "标准化器可以直接 return sklearn 的 scaler"
    )


def _describe_meta(summary, identity=None, lineage=None):
    """给每个摘要加上可追溯身份；不把空字段写进 wire。"""
    if identity:
        summary["identity"] = str(identity)
    if lineage:
        summary["lineage"] = [str(item) for item in lineage]
    return summary


def _table_stats(frame, columns):
    """按列给出轻量数值统计，不搬运原始行值。"""
    stats = {}
    for column in columns:
        try:
            numeric = pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype=float)
        except (KeyError, TypeError, ValueError):
            continue
        finite = numeric[np.isfinite(numeric)]
        if finite.size == 0:
            continue
        stats[str(column)] = {
            "count": int(finite.size),
            "min": _finite(float(np.min(finite))),
            "max": _finite(float(np.max(finite))),
            "mean": _finite(float(np.mean(finite))),
            "std": _finite(float(np.std(finite))),
        }
    return stats


def _prepare_matplotlib_backend(code: str) -> None:
    """自定义绘图只输出静态图片，不依赖桌面窗口或浏览器 Canvas 后端。"""
    global _matplotlib_backend_ready
    if _matplotlib_backend_ready or "matplotlib" not in str(code):
        return
    import matplotlib

    matplotlib.use("Agg", force=True)
    _matplotlib_backend_ready = True


def _matplotlib_figure_image(value: object) -> FigureImagePayload | None:
    """Matplotlib Figure → 可随 nodeResult 传输的 PNG 摘要。"""
    try:
        from matplotlib.figure import Figure
    except ImportError:
        return None
    if not isinstance(value, Figure):
        return None

    dpi = 120
    size = value.get_size_inches()
    width = max(1, int(round(float(size[0]) * dpi)))
    height = max(1, int(round(float(size[1]) * dpi)))
    output = BytesIO()
    value.savefig(output, format="png", dpi=dpi)
    png = output.getvalue()
    if len(png) > MAX_FIGURE_BYTES:
        raise ValueError(
            f"绘图图片为 {len(png) / 1024 / 1024:.1f} MB，超过 8 MB 传输上限；"
            "请在绘图函数里缩小 figsize 或减少图中元素"
        )
    return {
        "mimeType": "image/png",
        "data": base64.b64encode(png).decode("ascii"),
        "width": width,
        "height": height,
    }


def _looks_like_scaler(value):
    """识别 sklearn 风格的已拟合 scaler，不依赖 sklearn 类型本身。"""
    return (
        value is not None
        and callable(getattr(value, "transform", None))
        and any(hasattr(value, name) for name in ("scale_", "center_", "data_min_", "data_max_"))
    )


def _looks_like_model(value):
    """识别宿主侧模型句柄，兼容旧调用方未声明 output kind 的情况。"""
    return (
        value is not None
        and callable(getattr(value, "parameters", None))
        and callable(getattr(value, "state_dict", None))
    )


def _json_value(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (str, bool, int, float)) or value is None:
        return value
    return str(value)


def scaler_summary(value):
    """只摘要 scaler 的拟合参数，真实对象继续留在 `_outputs` 供下游函数使用。"""
    names = getattr(value, "feature_names_in_", None)
    if names is None:
        raw = getattr(value, "scale_", None)
        names = [f"feature_{i}" for i in range(len(raw))] if raw is not None else []
    summary = {
        "type": f"{type(value).__module__}.{type(value).__name__}",
        "columns": [str(x) for x in _json_value(names)],
    }
    for source, target in (
        ("mean_", "mean"),
        ("scale_", "scale"),
        ("var_", "var"),
        ("center_", "center"),
        ("data_min_", "data_min"),
        ("data_max_", "data_max"),
        ("n_samples_seen_", "n_samples_seen"),
    ):
        if hasattr(value, source):
            summary[target] = _json_value(getattr(value, source))
    return summary


def model_summary(value):
    """摘要自定义模型；不尝试把权重序列化进节点输出。"""
    summary = {"type": f"{type(value).__module__}.{type(value).__name__}"}
    parameters = getattr(value, "parameters", None)
    if callable(parameters):
        try:
            summary["parameterCount"] = int(sum(int(p.numel()) for p in parameters()))
        except Exception:  # noqa: BLE001 - 模型摘要不能阻断模型本身的产出
            pass
    return summary


def _numbers(d):
    out = {}
    for k, v in d.items():
        if isinstance(v, (bool, int, float, np.number)):
            out[str(k)] = _finite(float(v))
    return out


def _finite(value):
    """NaN / ±Inf → None。

    协议里写的是"算出来是 NaN/Inf 就给 null，界面显示 —"。但 Python 的
    json.dumps 默认会把它们写成裸的 NaN / Infinity —— 那不是合法 JSON，
    浏览器 JSON.parse 直接抛错，表现成"探针无缘无故空白"，最难查的一类故障。
    所以出口统一过滤一次：因子类特征（波形因子、峭度…）在常值信号上就是 NaN，
    这条路一定会走到。
    """
    return value if math.isfinite(value) else None


def _rows(frame, n, offset=0):
    """从 offset 起取 n 行 → 可 JSON 序列化的嵌套列表，NaN/Inf 转 null"""
    out = []
    start = max(0, int(offset))
    for row in frame.iloc[start:start + max(0, int(n))].to_numpy().tolist():
        out.append([_finite(v) if isinstance(v, float) else v for v in row])
    return out


def outputs_of(node_id):
    """这次会话里那个节点的输出对象（没有就 None）。

    给跨会话复用用：缓存留下的不只是摘要，还有这些对象 —— 只有把它们放回新的会话，
    下游读输入、探针取行值才拿得到东西。只回摘要的话，命中缓存的下一步就是
    "上游节点还没有求值结果"（实测撞到过）。
    """
    node_out = _outputs.get(node_id)
    return dict(node_out) if node_out is not None else None


def put_outputs(node_id, mapping):
    """把一份输出对象放回**这次**会话（跨会话复用时用）"""
    _outputs[node_id] = dict(mapping)


def head_payload(node_id, port_id, n, offset=0):
    value = ENV.output(node_id, port_id)
    if isinstance(value, dict) or isinstance(value, (bool, int, float, np.number)):
        raise TypeError(f"输出「{port_id}」不是一个表，没有行可以预览")

    columns, frame = operators.as_frame(port_id, value)
    return json.dumps(
        {
            "columns": columns,
            "rows": _rows(frame, n, offset),
            "totalRows": int(len(frame)),
            "timeColumn": operators.time_column_of(_time_columns, columns),
        },
        ensure_ascii=False,
    )


def drop_node(node_id):
    _outputs.pop(node_id, None)
    _fns.pop(node_id, None)
    _model_plugins.pop(node_id, None)
