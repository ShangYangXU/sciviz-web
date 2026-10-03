"""测试共用的数据与工具。放一处，免得两个测试文件各造一份合成数据"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile
import time
from typing import Any

import numpy as np

# 测试跑训练会把产物落到 <仓库>/.artifacts —— 那是**产品**该用的地方，测试不该往
# 仓库里丢文件。所以在 import 时就把它指到临时目录（`setdefault`：显式设过的仍然优先）。
_ARTIFACT_TMP = tempfile.mkdtemp(prefix="sciviz-artifacts-")
os.environ.setdefault("SCIVIZ_ARTIFACT_DIR", _ARTIFACT_TMP)
atexit.register(shutil.rmtree, _ARTIFACT_TMP, ignore_errors=True)


def synthetic(rows: int = 600, seed: int = 3) -> dict[str, np.ndarray]:
    """一份"学得动"的小数据集：标签由特征决定，所以准确率必须明显高于瞎猜"""
    rng = np.random.default_rng(seed)
    t = np.arange(rows, dtype=np.float64) / 100.0
    x1 = (np.sin(2 * np.pi * t) + rng.normal(0, 0.1, rows)).astype(np.float32)
    x2 = (np.cos(2 * np.pi * t) + rng.normal(0, 0.1, rows)).astype(np.float32)
    # 刻意用 float 而不是 int：从 CSV 读进来的 0/1 标签就是这个 dtype，
    # 而"按 dtype 判分类"曾经把二分类悄悄当成回归
    label = (x1 > 0).astype(np.float32)
    return {"t": t, "x1": x1, "x2": x2, "label": label}


def column_specs(time_name: str = "t", columns: tuple[str, ...] = ("x1", "x2", "label")):
    """线上协议的列描述：顺序就是二进制帧的顺序"""
    specs = [{"name": time_name, "dtype": "float64", "kind": "time"}]
    specs += [{"name": name, "dtype": "float32", "kind": "column"} for name in columns]
    return specs


def frames(data: dict[str, np.ndarray], specs) -> list[bytes]:
    return [np.asarray(data[spec["name"]]).tobytes() for spec in specs]


def port(node_id: str, port_id: str) -> dict[str, str]:
    return {"kind": "port", "nodeId": node_id, "portId": port_id}


def feed(engine, columns: dict[str, np.ndarray], time_name: str = "t") -> None:
    """把一份数据集直接喂进会话（绕过 WebSocket）。走的是与前端同一个装载入口"""
    others = tuple(name for name in columns if name != time_name)
    specs = column_specs(time_name, others)
    engine.begin_dataset(
        {
            "datasetId": "synthetic",
            "rowCount": int(len(next(iter(columns.values())))),
            "timeColumn": time_name,
            "columns": specs,
        }
    )
    for spec in specs:
        engine.feed_column(np.asarray(columns[spec["name"]]).tobytes())


def expect(ws, kind: str, timeout: float = 15.0) -> dict[str, Any]:
    """等到指定类型的消息。中间收到别的就丢掉 —— 但超时时要把它报出来。

    **按时间等，不按条数等。** 宿主会在中间插进度消息（长任务可以插成千上万条），
    按条数设上限的写法会在"进度变得比消息预算还多"时突然失败，
    而失败信息（"没有等到 nodeResult"）完全看不出是这个原因。

    **不要改成"后台线程读 + 队列超时"。** 实测过一次，那个写法会**丢消息**：
    TestClient 的 `receive_json()` 内部是 `portal.call(...)`，从另一个线程反复调它
    不是线程安全的 —— 表现是"训练明明跑完了、算子的返回也打出来了，却永远等不到
    nodeResult"。当时的现场：直接读能拿到，换线程读就拿不到。

    所以这里是**阻塞读**。它不会卡住的前提是"每条请求都有回话"—— 协议本来就是这样
    （连不认识的指令也会回一条 initError）。反过来说，如果哪天加了"只发不收"的指令，
    第一件要做的事是给这条助手加超时，而不是起线程。
    """
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        message = ws.receive_json()
        last = message
        if message.get("type") == kind:
            return message
    raise AssertionError(f"等 {kind} 超时（{timeout}s）；期间最后收到的是 {last}")


def upload(ws, data: dict[str, np.ndarray], dataset_id: str = "synthetic") -> None:
    """走线上的两条路把一份数据集送进去：一条 JSON 描述 + N 个二进制帧"""
    specs = column_specs("t", tuple(name for name in data if name != "t"))
    ws.send_json(
        {
            "type": "setDataset",
            "payload": {
                "datasetId": dataset_id,
                "rowCount": int(len(data["t"])),
                "timeColumn": "t",
                "columns": specs,
            },
        }
    )
    for blob in frames(data, specs):
        ws.send_bytes(blob)
    expect(ws, "datasetReady")
