"""用户准备的定长样本表 → 1D-CNN 训练。

项目不再提供隐式的信号分帧节点。测试用自定义函数构造训练所需的长表，
再验证 CNN 只负责读取 `起点`、`点0…点N` 与标签列。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures import feed, port, synthetic  # noqa: E402
from sciviz_host import session  # noqa: E402


class CnnPipelineTest(unittest.TestCase):
    PREPARE_CODE = """
import pandas as pd

def prepare(data, window=64, hop=32, carry="label"):
    rows = []
    channels = ["x1", "x2"]
    for start in range(0, len(data) - int(window) + 1, int(hop)):
        for channel in channels:
            row = {"起点": start}
            if carry:
                row[carry] = float(data.iloc[start][carry])
            row.update({f"点{i}": float(data.iloc[start + i][channel]) for i in range(int(window))})
            rows.append(row)
    return {"data": pd.DataFrame(rows)}
"""

    def setUp(self) -> None:
        self.engine = session.EngineSession("cnn")
        feed(self.engine, synthetic(rows=1200), "t")
        self.evaluate(
            "src",
            "data.source",
            {"datasetId": "synthetic"},
            {},
            [{"id": "data", "shape": "table"}],
        )

    def evaluate_raw(self, node_id: str, node_type: str, params, inputs, ports, fingerprint=None):
        """整条结果（含产物登记）。指纹要显式传：产物按它归档"""
        payload = {
            "nodeId": node_id,
            "nodeType": node_type,
            "params": params,
            "inputs": inputs,
            "outputPorts": ports,
        }
        if fingerprint is not None:
            payload["fingerprint"] = fingerprint
        return self.engine.eval_node(payload)

    def evaluate(self, node_id: str, node_type: str, params, inputs, ports):
        """只要 refs 的那种求值（大多数测试关心的只是输出摘要）"""
        result = self.evaluate_raw(node_id, node_type, params, inputs, ports)
        if not result.get("ok"):
            self.fail(f"{node_type} 失败：{result.get('message')}\n{result.get('traceback')}")
        return result["refs"]

    def window(self, node_id: str = "win", **params):
        base = {"window": 64, "hop": 32, "carry": "label"}
        base.update(params)
        self.engine.load_fn(node_id, "prepare", self.PREPARE_CODE)
        return self.evaluate(
            node_id,
            "custom.script",
            base,
            {
                "data": port("src", "data"),
                "window": {"kind": "literal", "value": base["window"]},
                "hop": {"kind": "literal", "value": base["hop"]},
                "carry": {"kind": "literal", "value": base["carry"]},
            },
            [{"id": "data", "shape": "table"}],
        )

    def test_carry_keeps_the_label_and_drops_it_from_the_signals(self) -> None:
        refs = self.window(carry="label")
        columns = refs["data"]["columns"]

        # 标签跟着帧走：每一帧都带上起点那一行的标签
        self.assertIn("label", columns)
        self.assertIn("点0", columns)
        self.assertIn("点63", columns)
        # 一帧一个通道一行：1200 行、窗长 64、hop 32 → 36 帧，再乘通道数
        self.assertEqual(refs["data"]["rowCount"] % 36, 0)

        # 不给 carry 时没有标签列 —— 训练节点就该在这里报错，而不是猜一个
        plain = self.window("win2", carry="")
        self.assertNotIn("label", plain["data"]["columns"])

    def test_cnn_trains_on_windowed_frames(self) -> None:
        refs = self.window(carry="label")
        trained = self.evaluate(
            "model",
            "train.cnn1d",
            {"label": "label", "epochs": 4, "hidden": 8, "batch": 64, "seed": 1},
            {"train": port("win", "data")},
            [{"id": "model", "shape": "auto"}, {"id": "history", "shape": "table"}],
        )

        metrics = trained["metrics"]["values"]
        # 窗长与通道数来自数据本身：label 是 carry 过来的元信息，不算通道
        self.assertEqual(metrics["窗长"], 64.0)
        self.assertEqual(metrics["通道数"], 2.0)
        self.assertGreater(metrics["训练样本数"], 0)
        self.assertGreater(metrics["参数量"], 0)
        self.assertEqual(metrics["训练轮数"], 4.0)
        self.assertIn(metrics["用了GPU"], (0.0, 1.0))
        # 训练损失必须真的下降，否则梯度多半没算
        self.assertEqual(trained["history"]["rowCount"], 4)
        table = self.engine.head("model", "history", 4)
        columns = table["columns"]
        losses = [row[columns.index("训练损失")] for row in table["rows"]]
        self.assertLess(losses[-1], losses[0], "训练损失没有下降，梯度大概没算")

    def test_missing_label_column_says_what_to_do(self) -> None:
        refs = self.window(carry="")  # 故意不把标签带过来
        result = self.engine.eval_node(
            {
                "nodeId": "model",
                "nodeType": "train.cnn1d",
                "params": {"label": "label", "epochs": 1},
                "inputs": {"train": port("win", "data")},
                "outputPorts": [{"id": "model", "shape": "auto"}],
            }
        )
        self.assertFalse(result["ok"])
        # 报错要指出样本表需要保留标签列，而不是只说"没有这一列"
        self.assertIn("标签要靠样本表里的标签列带过来", result["message"])

    def test_window_length_comes_from_the_frames(self) -> None:
        """窗长来自自定义函数生成的点列，训练节点不再重复声明窗长。"""
        self.engine.load_fn("win", "prepare", self.PREPARE_CODE)
        refs = self.evaluate(
            "win",
            "custom.script",
            {"code": self.PREPARE_CODE},
            {
                "data": port("src", "data"),
                "window": {"kind": "literal", "value": 32},
                "hop": {"kind": "literal", "value": 16},
                "carry": {"kind": "literal", "value": "label"},
            },
            [{"id": "data", "shape": "table"}],
        )
        self.assertIn("点31", refs["data"]["columns"])
        trained = self.evaluate(
            "model",
            "train.cnn1d",
            {"label": "label", "epochs": 1, "hidden": 4, "batch": 32, "seed": 1},
            {"train": port("win", "data")},
            [{"id": "model", "shape": "auto"}],
        )
        self.assertEqual(trained["metrics"]["values"]["窗长"], 32.0)

    def test_curve_output_is_chart_ready(self) -> None:
        """曲线直出（T10）：引擎直接给一张"轮次 / 曲线 / 值"的**长表**。

        界面画图的口径就是"X 一列、Y 一列、颜色分组"，所以长表意味着
        "训练曲线"不需要在界面侧另写一套多序列逻辑，也不必让用户再接一个图表节点。
        """
        self.window(carry="label")
        refs = self.evaluate(
            "model",
            "train.cnn1d",
            {"label": "label", "epochs": 3, "hidden": 4, "batch": 32, "seed": 1},
            {"train": port("win", "data")},
            [
                {"id": "model", "shape": "auto"},
                {"id": "history", "shape": "table"},
                {"id": "curve", "shape": "auto"},
            ],
        )
        self.assertEqual(refs["curve"]["kind"], "table")
        self.assertEqual(refs["curve"]["columns"], ["轮次", "曲线", "值"])

        # 每条曲线名与 history 的列一一对应（除轮次），行数是"轮次 × 曲线数"
        table = self.engine.head("model", "curve", 100)
        rows = table["rows"]
        names = {row[table["columns"].index("曲线")] for row in rows}
        self.assertEqual(names, set(refs["history"]["columns"]) - {"轮次"})
        self.assertEqual(len(rows), 3 * len(names))
        self.assertEqual([row[0] for row in rows[: len(names)]], [1.0] * len(names), "第一条曲线的轮次是 1")

    def test_checkpoint_lands_in_unique_immutable_artifact_directory(self) -> None:
        """产物落盘（T8）：每次训练新建 artifact_id 目录，同配置重训不覆盖旧权重。"""
        self.window(carry="label")
        fingerprint = "train.cnn1d\u0001impl=abc\u0001params=seed=1"
        result = self.evaluate_raw(
            "model",
            "train.cnn1d",
            {"label": "label", "epochs": 2, "hidden": 4, "batch": 32, "seed": 1},
            {"train": port("win", "data")},
            [{"id": "model", "shape": "auto"}, {"id": "history", "shape": "table"}],
            fingerprint=fingerprint,
        )
        self.assertTrue(result["ok"], result.get("message"))

        artifacts = result["artifacts"]
        kinds = {a["kind"]: a for a in artifacts}
        self.assertIn("model", kinds, "权重没有落盘")
        self.assertIn("meta", kinds, "meta 没有落盘 —— 下次复用就没法知道分数与曲线")

        weights = Path(kinds["model"]["path"])
        meta_path = Path(kinds["meta"]["path"])
        self.assertTrue(weights.is_file(), f"权重路径不是文件：{weights}")
        self.assertGreater(kinds["model"]["bytes"], 0)
        self.assertEqual(weights.parent, meta_path.parent, "权重与 meta 应当在同一目录")

        # 唯一制品身份与训练指纹分开：目录名不承担配置寻址功能。
        self.assertEqual(kinds["model"]["fingerprint"], fingerprint)
        self.assertRegex(kinds["model"]["artifactId"], r"^[a-f0-9]{32}$")
        self.assertRegex(kinds["model"]["sha256"], r"^[a-f0-9]{64}$")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        self.assertEqual(meta["artifactId"], kinds["model"]["artifactId"])
        self.assertEqual(meta["stateDict"]["sha256"], kinds["model"]["sha256"])
        self.assertEqual(meta["fingerprint"], fingerprint)
        self.assertEqual(meta["nodeType"], "train.cnn1d")
        self.assertEqual(len(meta["history"]), 2, "逐轮曲线要进 meta：不然下次还得重训一遍")
        self.assertIn("torch", meta["environment"])
        # 落盘这件事本身在**结果指标**里（meta.json 存在就说明写成功了，不必在里面再记一遍）
        self.assertEqual(result["refs"]["metrics"]["values"]["产物落盘"], 1.0)

        # 同一个指纹再训练一次也必须产生新目录，且不能改写第一份权重。
        original_weight_bytes = weights.read_bytes()
        again = self.evaluate_raw(
            "model2",
            "train.cnn1d",
            {"label": "label", "epochs": 2, "hidden": 4, "batch": 32, "seed": 1},
            {"train": port("win", "data")},
            [{"id": "model", "shape": "auto"}],
            fingerprint=fingerprint,
        )
        self.assertTrue(again["ok"], again.get("message"))
        second_ref = next(item for item in again["artifacts"] if item["kind"] == "model")
        second = Path(second_ref["path"])
        self.assertNotEqual(second_ref["artifactId"], kinds["model"]["artifactId"])
        self.assertNotEqual(second.parent, weights.parent, "每次成功训练使用唯一目录")
        self.assertEqual(weights.read_bytes(), original_weight_bytes, "新训练不能覆盖旧权重")

    def test_training_reports_the_device_it_actually_used(self) -> None:
        """元信息（T11）：指标只收数值，所以"实际用了什么设备、哪一版 torch"要单独登记。

        这一条是给"GPU 焦虑"用的：同一张图在 CPU 上跑和在 3050 上跑，指标看起来都对，
        只有设备名与版本能把它们分开。
        """
        self.window(carry="label")
        result = self.evaluate_raw(
            "model",
            "train.cnn1d",
            {"label": "label", "epochs": 1, "hidden": 4, "batch": 32, "seed": 1},
            {"train": port("win", "data")},
            [{"id": "model", "shape": "auto"}],
            fingerprint="meta-check",
        )
        self.assertTrue(result["ok"], result.get("message"))
        meta = result["meta"]
        self.assertIn(meta["设备"], ("cuda", "cpu"))
        self.assertIn("torch", meta)
        self.assertTrue(meta["torch"], "torch 版本不能是空的")
        # 设备与"用了GPU"这个指标必须说的是同一件事 —— 两处不一致就是界面在撒谎
        used_gpu = result["refs"]["metrics"]["values"]["用了GPU"]
        self.assertEqual(meta["设备"] == "cuda", used_gpu == 1.0)
        if meta["设备"] == "cuda":
            self.assertNotEqual(meta["GPU"], "—", "说是用了 GPU，就得说清是哪一块")
