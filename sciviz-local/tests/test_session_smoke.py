"""本地宿主的端到端冒烟。

装数据 → 求值 → 真训练 → 取前 N 行，走的是前端会走的那条完整路径（同一套算子、
同一份 runtime.py）。**CPU 上必须也能过**：GPU 只是更快的那条路，不是唯一能
跑通的那条；如果只有装 CUDA 的机器能过，这个测试就失去意义了。
"""

from __future__ import annotations

import base64
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import device, session  # noqa: E402
from fixtures import feed, port, synthetic  # noqa: E402


class DeviceProbeTest(unittest.TestCase):
    def test_reports_a_usable_summary(self) -> None:
        info = device.probe()
        self.assertIn(info.backend, ("cuda", "cpu"))
        self.assertTrue(info.summary())
        # 要 cuda 而拿不到时回落而不是炸掉：换台机器打开同一张图仍然应该跑得动
        self.assertIn(device.resolve("cuda"), ("cuda", "cpu"))


class TrainPipelineTest(unittest.TestCase):
    """source → train.mlp。数据划分由用户在外部或自定义函数中完成。"""

    def setUp(self) -> None:
        self.engine = session.EngineSession("test")
        feed(self.engine, synthetic(), "t")

    def evaluate(self, node_id: str, node_type: str, params, inputs, ports):
        result = self.engine.eval_node(
            {
                "nodeId": node_id,
                "nodeType": node_type,
                "params": params,
                "inputs": inputs,
                "outputPorts": ports,
            }
        )
        if not result.get("ok"):
            self.fail(f"{node_type} 失败：{result.get('message')}\n{result.get('traceback')}")
        return result["refs"]

    def test_training_actually_learns(self) -> None:
        source = self.evaluate(
            "src",
            "data.source",
            {"datasetId": "synthetic"},
            {},
            [{"id": "data", "shape": "table"}],
        )
        self.assertEqual(source["data"]["kind"], "table")
        self.assertEqual(source["data"]["rowCount"], 600)

        epochs = 30
        refs = self.evaluate(
            "model",
            "train.mlp",
            {"label": "label", "epochs": epochs, "hidden": 16, "seed": 7},
            {"train": port("src", "data")},
            [{"id": "model", "shape": "auto"}, {"id": "history", "shape": "table"}],
        )

        metrics = refs["metrics"]
        self.assertEqual(metrics["kind"], "metrics")
        values = metrics["values"]
        self.assertGreater(values["参数量"], 0)
        self.assertEqual(values["训练轮数"], float(epochs))
        # 没有隐式划分：没有验证集时曲线仍能证明训练损失下降
        self.assertGreater(values["最终训练损失"], 0.0)

        self.assertEqual(refs["history"]["kind"], "table")
        self.assertEqual(refs["history"]["rowCount"], epochs)

        table = self.engine.head("model", "history", epochs)
        columns = table["columns"]
        losses = [row[columns.index("训练损失")] for row in table["rows"]]
        self.assertLess(losses[-1], losses[0], "训练损失没有下降，梯度大概没算")

    def test_unknown_label_column_says_what_exists(self) -> None:
        """报错要能直接指出下一步动作，而不是只说「出错了」"""
        self.evaluate("src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}])
        result = self.engine.eval_node(
            {
                "nodeId": "model",
                "nodeType": "train.mlp",
                "params": {"label": "不存在的列", "epochs": 1},
                "inputs": {"train": port("src", "data")},
                "outputPorts": [{"id": "model", "shape": "auto"}],
            }
        )
        self.assertFalse(result["ok"])
        self.assertIn("不存在的列", result["message"])
        self.assertIn("x1", result["message"])

    def test_curve_is_a_long_table(self) -> None:
        """曲线直出（T10）：两个训练算子给的是同一种形状 —— 轮次 / 曲线 / 值"""
        self.evaluate("src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}])
        refs = self.evaluate(
            "model",
            "train.mlp",
            {"label": "label", "epochs": 3, "hidden": 8, "seed": 1},
            {"train": port("src", "data")},
            [{"id": "model", "shape": "auto"}, {"id": "curve", "shape": "auto"}],
        )
        self.assertEqual(refs["curve"]["columns"], ["轮次", "曲线", "值"])
        self.assertEqual(refs["curve"]["rowCount"], 3, "没接验证集时只有训练损失一条曲线 × 3 轮")

    def test_custom_standardizer_returns_train_val_test_and_scaler(self) -> None:
        """自定义函数按 train 拟合 scaler，并把同一个 scaler 用到三份数据。"""
        self.evaluate("src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}])
        code = """
from sklearn.preprocessing import StandardScaler

def standardize(train, val, test):
    numeric = train.select_dtypes(include="number").columns
    scaler = StandardScaler().fit(train[numeric])

    def apply(frame):
        result = frame.copy()
        result[numeric] = scaler.transform(frame[numeric])
        return result

    return {"train": apply(train), "val": apply(val), "test": apply(test), "scaler": scaler}
"""
        self.engine.load_fn("standardizer", "standardize", code)
        refs = self.evaluate(
            "standardizer",
            "custom.script",
            {"code": code},
            {
                "train": port("src", "data"),
                "val": port("src", "data"),
                "test": port("src", "data"),
            },
            [
                {"id": "train", "shape": "table"},
                {"id": "val", "shape": "table"},
                {"id": "test", "shape": "table"},
                {"id": "scaler", "shape": "scaler"},
            ],
        )
        for split in ("train", "val", "test"):
            self.assertEqual(refs[split]["kind"], "table")
            self.assertEqual(refs[split]["rowCount"], 600)
        self.assertEqual(refs["scaler"]["kind"], "scaler")
        self.assertEqual(refs["scaler"]["scaler"]["n_samples_seen"], 600)
        self.assertEqual(len(refs["scaler"]["scaler"]["scale"]), 4)

    def test_custom_chart_keeps_legacy_dataframe_returns_compatible(self) -> None:
        """旧自定义绘图函数返回 DataFrame 时仍能走共享 SVG 兼容路径。"""
        self.evaluate("src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}])
        code = """
def plot(data):
    return {"figure": data}
"""
        self.engine.load_fn("chart", "plot", code)
        refs = self.evaluate(
            "chart",
            "custom.chart",
            {"code": code, "chartType": "line"},
            {"data": port("src", "data")},
            [{"id": "figure", "shape": "auto", "kind": "figure"}],
        )
        self.assertEqual(refs["figure"]["kind"], "figure")
        self.assertEqual(refs["figure"]["rowCount"], 600)

    def test_custom_chart_serializes_matplotlib_figure_as_png(self) -> None:
        """新自定义绘图函数返回 Figure，宿主经 wire 回传可直接显示的 PNG。"""
        self.evaluate("src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}])
        code = """
def plot(data):
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(2, 1.5))
    ax.plot(data["x1"], data["x2"])
    return {"figure": fig}
"""
        self.engine.load_fn("chart-image", "plot", code)
        refs = self.evaluate(
            "chart-image",
            "custom.chart",
            {"code": code},
            {"data": port("src", "data")},
            [{"id": "figure", "shape": "auto", "kind": "figure"}],
        )

        image = refs["figure"]["image"]
        self.assertEqual(refs["figure"]["kind"], "figure")
        self.assertEqual(image["mimeType"], "image/png")
        self.assertEqual((image["width"], image["height"]), (240, 180))
        self.assertTrue(base64.b64decode(image["data"], validate=True).startswith(b"\x89PNG\r\n\x1a\n"))

    def test_density_sample_ratio_controls_point_count(self) -> None:
        """概率密度图按 0~1 比例取点，1 取全量，0 不偷偷造点。"""
        self.evaluate("src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}])
        refs = self.evaluate(
            "density",
            "viz.density",
            {"sampleRatio": 0.25},
            {"data": port("src", "data")},
            [{"id": "figure", "shape": "auto", "kind": "figure"}],
        )
        self.assertEqual(refs["figure"]["rowCount"], 150)

        zero = self.evaluate(
            "density-zero",
            "viz.density",
            {"sampleRatio": 0},
            {"data": port("src", "data")},
            [{"id": "figure", "shape": "auto", "kind": "figure"}],
        )
        self.assertEqual(zero["figure"]["rowCount"], 0)

    def test_gpu_is_actually_used_when_available(self) -> None:
        """有 CUDA 却静默跑在 CPU 上，是这里最危险的一种错：结果是对的，
        但你以为用了 GPU —— 于是拿"跑了三小时"去解释一个 CPU 上十分钟就够的事。

        没有 GPU 的机器上跳过：这条只在有卡的地方有意义。
        """
        info = device.probe()
        if info.backend != "cuda":
            self.skipTest(f"本机没有可用的 CUDA（{info.reason}）")

        self.evaluate(
            "src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}]
        )
        refs = self.evaluate(
            "model",
            "train.mlp",
            {"label": "label", "epochs": 2, "hidden": 8, "seed": 1},
            {"train": port("src", "data")},
            [{"id": "model", "shape": "auto"}],
        )
        self.assertEqual(refs["metrics"]["values"]["用了GPU"], 1.0)


class SplitColumnsTest(unittest.TestCase):
    """拆列：一张表摊成"一列一个端口"。

    真值就是**喂进去的那几条 numpy 数组**，不是引擎自己的上一次输出 ——
    所以这里比的是"值对不对"，不是"和上次一样不一样"。
    """

    def setUp(self) -> None:
        self.engine = session.EngineSession("columns")
        self.data = synthetic(rows=50)
        feed(self.engine, self.data, "t")
        self.evaluate(
            "src", "data.source", {"datasetId": "synthetic"}, {}, [{"id": "data", "shape": "table"}]
        )

    def evaluate(self, node_id, node_type, params, inputs, ports):
        result = self.engine.eval_node(
            {
                "nodeId": node_id,
                "nodeType": node_type,
                "params": params,
                "inputs": inputs,
                "outputPorts": ports,
            }
        )
        if not result.get("ok"):
            self.fail(f"{node_type} 失败：{result.get('message')}\n{result.get('traceback')}")
        return result["refs"]

    def test_each_port_carries_exactly_one_column(self) -> None:
        refs = self.evaluate(
            "cols",
            "data.columns",
            {},
            {"data": port("src", "data")},
            [{"id": "x1", "shape": "auto"}, {"id": "x2", "shape": "auto"}],
        )
        for name in ("x1", "x2"):
            self.assertEqual(refs[name]["kind"], "table")
            self.assertEqual(refs[name]["columns"], [name], "一个端口必须只带一列")
            self.assertEqual(refs[name]["rowCount"], 50)

        # 值必须与喂进去的那一条完全一致（float32 往返，用 5 位小数比）
        table = self.engine.head("cols", "x1", 5)
        got = [row[0] for row in table["rows"]]
        want = [float(v) for v in self.data["x1"][:5]]
        for index, (a, b) in enumerate(zip(got, want)):
            self.assertAlmostEqual(a, b, places=5, msg=f"第 {index} 行对不上")

        next_page = self.engine.head("cols", "x1", 5, 5)
        self.assertEqual(next_page["totalRows"], 50)
        for index, row in enumerate(next_page["rows"], start=5):
            self.assertAlmostEqual(row[0], float(self.data["x1"][index]), places=5)

    def test_column_missing_from_upstream_is_reported_with_what_exists(self) -> None:
        result = self.engine.eval_node(
            {
                "nodeId": "cols",
                "nodeType": "data.columns",
                "params": {},
                "inputs": {"data": port("src", "data")},
                "outputPorts": [{"id": "不存在的列", "shape": "auto"}],
            }
        )
        self.assertFalse(result["ok"])
        self.assertIn("不存在的列", result["message"])
        self.assertIn("x1", result["message"])

    def test_no_ports_yet_says_what_to_do(self) -> None:
        """留空列名时端口要跑一次才长得出来。这时给出的必须是"下一步做什么"，不是空表"""
        result = self.engine.eval_node(
            {
                "nodeId": "cols",
                "nodeType": "data.columns",
                "params": {},
                "inputs": {"data": port("src", "data")},
                "outputPorts": [],
            }
        )
        self.assertFalse(result["ok"])
        self.assertIn("端口", result["message"])


class DatasetBoundaryTest(unittest.TestCase):
    def test_length_mismatch_is_rejected_and_recoverable(self) -> None:
        engine = session.EngineSession("boundary")
        engine.begin_dataset(
            {
                "datasetId": "bad",
                "rowCount": 10,
                "timeColumn": None,
                "columns": [{"name": "x", "dtype": "float32", "kind": "column"}],
            }
        )
        with self.assertRaises(session.SessionError):
            engine.feed_column(np.zeros(7, dtype=np.float32).tobytes())

        # 半途失败之后必须还能装下一份，不能被上一份的半截状态污染
        engine.abort_dataset()
        feed(engine, synthetic(rows=20), "t")
        refs = engine.eval_node(
            {
                "nodeId": "src",
                "nodeType": "data.source",
                "params": {"datasetId": "synthetic"},
                "inputs": {},
                "outputPorts": [{"id": "data", "shape": "table"}],
            }
        )
        self.assertTrue(refs["ok"], refs)
        self.assertEqual(refs["refs"]["data"]["rowCount"], 20)

    def test_binary_without_dataset_is_rejected(self) -> None:
        engine = session.EngineSession("stray")
        with self.assertRaises(session.SessionError):
            engine.feed_column(b"")


if __name__ == "__main__":
    unittest.main()
