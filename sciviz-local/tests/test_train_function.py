"""通用训练函数的宿主集成判据：签名参数、真实训练、稳定产物与预测句柄。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import session  # noqa: E402
from fixtures import feed, port, synthetic  # noqa: E402


MODEL_CODE = r'''
import torch
from torch import nn


class Model(nn.Module):
    def __init__(self, input_dim, output_dim):
        super().__init__()
        self.linear = nn.Linear(input_dim, output_dim)

    def forward(self, x):
        return self.linear(x)
'''

SEQUENCE_MODEL_CODE = r'''
import torch
from torch import nn


class Model(nn.Module):
    def __init__(self, input_dim, output_dim):
        super().__init__()
        self.linear = nn.Linear(input_dim, output_dim)

    def forward(self, x):
        return self.linear(x[:, -1, :])
'''

TRAIN_CODE = r'''
def fit_model(model, train_loader, val_loader, device, spec, params, env, epochs=1, lr=0.01):
    import torch

    optimizer = torch.optim.SGD(model.parameters(), lr=lr)
    loss_fn = torch.nn.MSELoss()
    history = []
    for epoch in range(epochs):
        model.train()
        total = 0.0
        samples = 0
        for x, y in train_loader:
            env.check_cancel()
            x = x.to(device=device, dtype=torch.float32)
            y = y.to(device=device, dtype=torch.float32).reshape(-1)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x).reshape(-1), y)
            loss.backward()
            optimizer.step()
            total += float(loss.detach().cpu()) * len(y)
            samples += len(y)
        train_loss = total / max(1, samples)
        history.append({"轮次": epoch + 1, "训练损失": train_loss})
        env.progress((epoch + 1) / epochs, f"第 {epoch + 1} 轮")
    return {
        "model": model,
        "metrics": {
            "训练损失": history[-1]["训练损失"],
            "训练轮数": float(epochs),
            "学习率": float(lr),
        },
        "history": history,
    }
'''


class TrainingFunctionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = session.EngineSession("training-function-test")
        feed(self.engine, synthetic(), "t")
        source = self.engine.eval_node(
            {
                "nodeId": "source",
                "nodeType": "data.source",
                "params": {"datasetId": "synthetic"},
                "inputs": {},
                "outputPorts": [{"id": "data", "shape": "table"}],
            }
        )
        self.assertTrue(source["ok"], source.get("message"))
        model = self.engine.eval_node(
            {
                "nodeId": "model-definition",
                "nodeType": "custom.model",
                "params": {"code": MODEL_CODE},
                "inputs": {},
                "outputPorts": [{"id": "model", "kind": "model"}],
            }
        )
        self.assertTrue(model["ok"], model.get("message"))

    def test_signature_values_drive_training_and_model_predict(self) -> None:
        self.engine.load_fn("trainer", "fit_model", TRAIN_CODE)
        progress = []
        trained = self.engine.eval_node(
            {
                "nodeId": "trainer",
                "nodeType": "train.function",
                "params": {
                    "code": TRAIN_CODE,
                    "features": "1,2",
                    "label": "3",
                    "task": "回归",
                    "batch": 64,
                    "seed": 17,
                    "device": "cpu",
                    "epochs": 2,
                    "lr": 0.02,
                },
                "inputs": {
                    "model": port("model-definition", "model"),
                    "train": port("source", "data"),
                    "epochs": {"kind": "literal", "value": 2},
                    "lr": {"kind": "literal", "value": 0.02},
                },
                "outputPorts": [
                    {"id": "model", "kind": "model"},
                    {"id": "metrics", "kind": "metrics"},
                    {"id": "history", "kind": "table"},
                    {"id": "curve", "kind": "figure"},
                ],
            },
            on_progress=lambda ratio, message: progress.append((ratio, message)),
        )
        self.assertTrue(trained["ok"], trained.get("message"))
        self.assertEqual(trained["refs"]["model"]["kind"], "model")
        self.assertEqual(trained["refs"]["metrics"]["values"]["训练轮数"], 2.0)
        self.assertEqual(trained["refs"]["metrics"]["values"]["学习率"], 0.02)
        self.assertEqual(trained["refs"]["history"]["rowCount"], 2)
        self.assertEqual(trained["refs"]["curve"]["kind"], "figure")
        self.assertTrue(progress)
        self.assertEqual(trained["meta"]["训练循环"], "自管（fit_model）")

        predicted = self.engine.eval_node(
            {
                "nodeId": "predict",
                "nodeType": "model.predict",
                "params": {"features": "1,2", "label": "3", "device": "cpu"},
                "inputs": {
                    "model": port("trainer", "model"),
                    "data": port("source", "data"),
                },
                "outputPorts": [{"id": "predictions", "kind": "table"}],
            }
        )
        self.assertTrue(predicted["ok"], predicted.get("message"))
        self.assertEqual(predicted["refs"]["predictions"]["rowCount"], 600)

    def test_non_finite_metrics_are_rejected(self) -> None:
        bad_code = TRAIN_CODE.replace('"学习率": float(lr),', '"学习率": float("nan"),')
        self.engine.load_fn("bad-trainer", "fit_model", bad_code)
        result = self.engine.eval_node(
            {
                "nodeId": "bad-trainer",
                "nodeType": "train.function",
                "params": {
                    "features": "x1,x2",
                    "label": "label",
                    "task": "回归",
                    "batch": 128,
                    "seed": 17,
                    "device": "cpu",
                    "epochs": 1,
                    "lr": 0.02,
                },
                "inputs": {
                    "model": port("model-definition", "model"),
                    "train": port("source", "data"),
                    "epochs": {"kind": "literal", "value": 1},
                    "lr": {"kind": "literal", "value": 0.02},
                },
                "outputPorts": [{"id": "model", "kind": "model"}],
            }
        )
        self.assertFalse(result["ok"])
        self.assertIn("有限数值", result["message"])

    def test_raw_tables_protocol_builds_segment_windows_inside_fit_model(self) -> None:
        segment_code = r'''
def add_segments(data):
    out = data.copy()
    out["工作段编号"] = [1] * 300 + [2] * 300
    return {"out": out}
'''
        self.engine.load_fn("segments", "add_segments", segment_code)
        segmented = self.engine.eval_node(
            {
                "nodeId": "segments",
                "nodeType": "custom.script",
                "params": {"code": segment_code},
                "inputs": {"data": port("source", "data")},
                "outputPorts": [{"id": "out", "kind": "table"}],
            }
        )
        self.assertTrue(segmented["ok"], segmented.get("message"))

        sequence_model = self.engine.eval_node(
            {
                "nodeId": "sequence-model",
                "nodeType": "custom.model",
                "params": {"code": SEQUENCE_MODEL_CODE},
                "inputs": {},
                "outputPorts": [{"id": "model", "kind": "model"}],
            }
        )
        self.assertTrue(sequence_model["ok"], sequence_model.get("message"))

        code_path = Path(__file__).resolve().parents[1] / "examples" / "tcn_segment_training.py"
        raw_code = code_path.read_text(encoding="utf-8")
        self.engine.load_fn("raw-trainer", "fit_model", raw_code)
        trained = self.engine.eval_node(
            {
                "nodeId": "raw-trainer",
                "nodeType": "train.function",
                "params": {
                    "code": raw_code,
                    "device": "cpu",
                    "past_n": 8,
                    "future_n": 1,
                    "stride": 1,
                    "batch_size": 128,
                    "epochs": 1,
                    "learning_rate": 0.001,
                    "patience": 2,
                    "min_delta": 0.0,
                    "seed": 7,
                },
                "inputs": {
                    "model": port("sequence-model", "model"),
                    "train": port("segments", "out"),
                    "val": port("segments", "out"),
                },
                "outputPorts": [
                    {"id": "model", "kind": "model"},
                    {"id": "metrics", "kind": "metrics"},
                    {"id": "history", "kind": "table"},
                    {"id": "curve", "kind": "figure"},
                ],
            }
        )
        self.assertTrue(trained["ok"], trained.get("message"))
        self.assertEqual(trained["refs"]["metrics"]["values"]["训练窗口数"], 584.0)
        self.assertEqual(trained["refs"]["metrics"]["values"]["测试窗口数"], 584.0)
        self.assertEqual(trained["refs"]["history"]["rowCount"], 1)
        self.assertEqual(trained["meta"]["数据加载"], "用户训练函数")


if __name__ == "__main__":
    unittest.main()
