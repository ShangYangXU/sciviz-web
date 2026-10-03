"""一次连接的引擎会话。

会话持有：一份已装载的数据集、若干节点输出、若干用户函数。这些状态来自共享
`runtime.py` 的模块级全局，所以每个会话拿的是**自己那一份模块实例**
（见 `bridge.new_runtime_module`），连接之间不会互相看见对方的节点输出。

所有方法都是同步的、会阻塞的（torch 一跑就是几秒）。调用方负责丢到线程里，
不要直接放在事件循环上。
"""

from __future__ import annotations

import json
import os
import threading
import traceback
from pathlib import Path
from typing import Any

import numpy as np

from . import bridge, cache, gpu_ops
from .protocol import ColumnMeta, DatasetPayload, EvalPayload

_DTYPES = {"float32": np.float32, "float64": np.float64}


class SessionError(RuntimeError):
    """会话层面的用法错误（协议顺序不对、列数对不上）"""


def available_operators() -> list[str]:
    """这个宿主能算的全部算子：共享的 + 宿主专属的"""
    table = bridge.shared_operators().OPERATORS
    return sorted(set(table) | set(gpu_ops.OPERATORS))


def install_gpu_operators() -> None:
    """把 GPU 算子追加进共享算子表。

    共享表来自 `operators.OPERATORS`（每个会话的 runtime 都指向它），所以只需要
    追加一次；重复调用无副作用。Pyodide 侧永远不会走到这里 —— 那里根本没有
    torch，这也是这些算子必须走这条路而不是写进 operators.py 的原因。
    """
    bridge.shared_operators().OPERATORS.update(gpu_ops.OPERATORS)


def artifact_root() -> Path:
    """产物放在哪儿：默认 `<仓库根>/.artifacts`，可用 `SCIVIZ_ARTIFACT_DIR` 覆盖。

    与 `.venv` 同一个理由放在仓库旁边：产物可能很大（权重），但它是**可以重建的**，
    所以不进 git；而"就在项目旁边"这个位置让用户找得到它。
    """
    override = os.environ.get("SCIVIZ_ARTIFACT_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[2] / ".artifacts"


class EngineSession:
    def __init__(self, session_id: str) -> None:
        install_gpu_operators()
        self.id = session_id
        self._runtime = bridge.new_runtime_module(session_id)
        # 声明这套 Python 在哪一侧：缺库时的文案据此分流（见 runtime.set_execution_face）
        self._runtime.set_execution_face("host")
        self._columns: list[ColumnMeta] = []
        self._row_count = 0
        self._dataset_id = ""
        #: 取消标志。一次求值一个干净的开始，见 `eval_node`
        self._cancel = threading.Event()
        #: 产物登记处。一次求值一份清单，见 `eval_node`
        self._artifacts = self._runtime.ArtifactStore(artifact_root())

    def request_cancel(self) -> None:
        """请求取消当前这次求值。

        只置一面旗子 —— 真正的中断发生在算子的可中断点上（`Env.check_cancel`）。
        不在这里做别的：同步 Python 里没有"从外面掐断"这回事，而且这个方法可能被
        WebSocket 的事件循环调用，任何阻塞都会把后面的消息一起堵住。
        """
        self._cancel.set()

    @property
    def dataset_id(self) -> str:
        """正在装载（或刚装载完）的数据集 id。报错时要用它把消息挂回正确的那份数据"""
        return self._dataset_id

    def abort_dataset(self) -> None:
        """放弃一次没装载完的数据集。

        共享 runtime 的装载状态是模块级全局，失败时必须显式结束它，
        否则下一份数据集会被上一份的半截数据污染。
        """
        self._runtime.abort_dataset()
        self._columns = []
        self._row_count = 0

    # ------------------------------------------------------------------
    # 数据集装载：一条 JSON 描述 + N 个二进制帧
    # ------------------------------------------------------------------

    def begin_dataset(self, payload: DatasetPayload) -> None:
        if self._columns:
            raise SessionError("上一份数据集还没有装载完，不能开始装下一份")
        columns = list(payload.get("columns") or [])
        if not columns:
            raise SessionError("数据集里一列都没有")

        self._row_count = int(payload["rowCount"])
        self._dataset_id = str(payload["datasetId"])
        self._columns = columns
        self._runtime.begin_dataset(
            json.dumps(
                {
                    "datasetId": payload["datasetId"],
                    "rowCount": self._row_count,
                    "timeColumn": payload.get("timeColumn"),
                    # runtime 只关心"有哪些列"，时间列由 set_time 单独送
                    "columns": [c["name"] for c in columns if c["kind"] == "column"],
                },
                ensure_ascii=False,
            )
        )

    def feed_column(self, blob: bytes) -> str | None:
        """喂一列。返回数据集 id 表示这是最后一列、已经装载完；否则返回 None"""
        if not self._columns:
            raise SessionError("没有正在装载的数据集，却收到了二进制数据")

        meta = self._columns.pop(0)
        dtype = _DTYPES.get(meta["dtype"])
        if dtype is None:
            raise SessionError(f"不认识的列类型「{meta['dtype']}」")
        itemsize = np.dtype(dtype).itemsize
        if len(blob) % itemsize:
            raise SessionError(
                f"列「{meta['name']}」的字节数 {len(blob)} 不是 {itemsize} 的整数倍"
            )

        array = np.frombuffer(blob, dtype=dtype)
        if array.size != self._row_count:
            raise SessionError(
                f"列「{meta['name']}」有 {array.size} 个值，"
                f"但这份数据集声明的是 {self._row_count} 行"
            )

        if meta["kind"] == "time":
            self._runtime.set_time(array)
        else:
            self._runtime.add_column(meta["name"], array)

        if self._columns:
            return None
        self._runtime.end_dataset()
        return self._dataset_id

    # ------------------------------------------------------------------
    # 求值与预览
    # ------------------------------------------------------------------

    def load_fn(self, node_id: str, fn_name: str, code: str) -> None:
        self._runtime.load_fn(node_id, fn_name, code)

    def eval_node(self, payload: EvalPayload, on_progress=None) -> dict[str, Any]:
        """求值。`on_progress(ratio, message)` 由调用方给（宿主把它变成 wire 消息）。

        钩子**只活在这一次求值里**：结束就摘掉，免得一次取消把后面每一次求值都取消掉。

        **可缓存的结果会跨会话复用**（见 `cache.py`）：判据是请求里的 `cacheable`
        ——它由主线程按算子声明的 `determinism` 给出（R6.4）。命中时直接回上一次的结果，
        一个算子都不跑；没命中就照常算，算完把结果放回去。
        """
        key = str(payload.get("fingerprint") or "")
        # 工程引用是唯一的重开恢复入口。带引用时先验证磁盘制品，即使当前进程内存缓存
        # 恰好有同指纹输出，也不能用内存对象掩盖制品缺失或损坏。
        artifact_id = payload.get("restoreArtifactId")
        if artifact_id:
            self._cancel.clear()
            self._artifacts.reset()
            self._runtime.set_job_context(
                on_progress,
                self._cancel.is_set,
                self._artifacts,
                payload.get("fingerprint"),
            )
            try:
                bindings = payload.get("inputs") or {}
                inputs = self._runtime._resolve_inputs(bindings)
                outputs = gpu_ops.restore_training_artifact(
                    self._runtime.ENV,
                    payload,
                    inputs,
                    artifact_root() / str(artifact_id),
                )
                self._runtime.put_outputs(payload["nodeId"], outputs)
                output_specs = {str(spec.get("id")): spec for spec in payload.get("outputPorts") or []}
                lineage = [str(item) for item in (payload.get("lineage") or [])]
                identity = str(payload.get("fingerprint") or "")
                refs = {
                    port_id: self._runtime.describe(
                        value,
                        port_id,
                        output_specs.get(port_id),
                        identity=identity,
                        lineage=lineage,
                    )
                    for port_id, value in outputs.items()
                    if value is not None
                }
                return {
                    "ok": True,
                    "refs": refs,
                    "artifacts": list(self._artifacts.entries),
                    "meta": dict(self._runtime.ENV.meta),
                    "restored": True,
                }
            except Exception as err:  # noqa: BLE001 - 恢复失败必须作为节点错误返回
                return {
                    "ok": False,
                    "message": f"模型制品 {artifact_id} 无法恢复：{err}；请重新定位制品或重新训练",
                    "traceback": traceback.format_exc(),
                }
            finally:
                self._runtime.set_job_context()
        if payload.get("cacheable") and key:
            hit = cache.RESULTS.get(key)
            if hit is not None:
                # 把上一次那批**输出对象**放回这一次会话：只回摘要是不够的 ——
                # 下游要读它们的输入，探针要取行值，两件事都只认会话里的那份
                self._runtime.put_outputs(payload["nodeId"], hit["outputs"])
                # 回的是**上一次那一份**，所以如实标出来。用户据此知道"这一步没重算"
                return {**hit["result"], "cached": True}

        self._cancel.clear()
        self._artifacts.reset()
        self._runtime.set_job_context(
            on_progress,
            self._cancel.is_set,
            self._artifacts,
            payload.get("fingerprint"),
        )
        try:
            raw = self._runtime.eval_payload(json.dumps(payload, ensure_ascii=False))
        finally:
            # 上下文只活在这一次求值里：漏到下一次，表现会是"上一轮的产物又登记了一遍"
            self._runtime.set_job_context()
        result = json.loads(raw)
        if payload.get("cacheable") and key and result.get("ok"):
            outputs = self._runtime.outputs_of(payload["nodeId"])
            if outputs:
                cache.RESULTS.put(key, {"result": result, "outputs": outputs})
        return result

    def head(self, node_id: str, port_id: str, n: int, offset: int = 0) -> dict[str, Any]:
        raw = self._runtime.head_payload(node_id, port_id, int(n), int(offset))
        return json.loads(raw)

    def drop_node(self, node_id: str) -> None:
        self._runtime.drop_node(node_id)
