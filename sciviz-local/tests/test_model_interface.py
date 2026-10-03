"""统一模型训练接口的端到端测试。

这里故意用一段很小的用户模型代码，验证的不是网络效果，而是接口边界：
自定义 Dataset、训练器创建的 DataLoader、模型句柄、预测节点和指标端口是否能串起来。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import session  # noqa: E402
from sciviz_host.model_api import (  # noqa: E402
    normalize_model_interface,
    normalize_model_interface_source,
    normalize_model_param_specs,
    resolve_model_params,
)
from fixtures import feed, port, synthetic  # noqa: E402


CUSTOM_MODEL = r'''
import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


def make_dataset(data, split, params, scaler=None):
    features = [name.strip() for name in params["features"].split(",") if name.strip()]
    x = data[features].to_numpy(dtype=np.float32).copy()
    y = data[params["label"]].to_numpy(dtype=np.float32).copy()
    return TensorDataset(torch.from_numpy(x), torch.from_numpy(y))


def make_dataloader(dataset, split, config):
    generator = torch.Generator().manual_seed(config.seed + (0 if split == "train" else 1))
    return DataLoader(
        dataset,
        batch_size=config.batch_size,
        shuffle=config.shuffle,
        generator=generator,
        num_workers=config.num_workers,
        drop_last=config.drop_last,
    )


def build_model(spec, params):
    return nn.Sequential(nn.Linear(spec.input_shape[0], spec.output_shape[0]))


def loss_fn(prediction, target, spec):
    return torch.nn.functional.mse_loss(prediction.reshape(-1), target.reshape(-1))
'''

DEFAULT_MODEL = r'''
import torch
from torch import nn


def build_model(spec, params):
    input_dim = 1
    for size in spec.input_shape:
        input_dim *= size
    output_dim = 1
    for size in spec.output_shape:
        output_dim *= size
    return nn.Sequential(nn.Flatten(), nn.Linear(input_dim, output_dim))
'''


PARAMETER_MODEL = r'''
import torch
from torch import nn


MODEL_PARAMS = {
    "hidden_dim": {"type": "int", "default": 8, "min": 1},
    "dropout": {"type": "float", "default": 0.1, "min": 0.0, "max": 0.9},
}


def build_model(spec, model_params):
    assert set(model_params) == {"hidden_dim", "dropout"}
    assert model_params["hidden_dim"] == 16
    assert model_params["dropout"] == 0.3
    return nn.Sequential(
        nn.Linear(spec.input_shape[0], int(model_params["hidden_dim"])),
        nn.Dropout(float(model_params["dropout"])),
        nn.Linear(int(model_params["hidden_dim"]), spec.output_shape[0]),
    )
'''


CLASS_MODEL = r'''
import torch
from torch import nn


class Model(nn.Module):
    def __init__(self, input_dim, hidden_dim=8):
        super().__init__()
        self.hidden = nn.Linear(input_dim, hidden_dim)
        self.output = nn.Linear(hidden_dim, 1)

    def forward(self, x):
        return self.output(torch.relu(self.hidden(x)))
'''


LIST_PARAMETER_MODEL = r'''
import torch
from torch import nn


MODEL_PARAMS = {
    "hidden_widths": {
        "type": "list[int]",
        "default": [8, 4],
        "minItems": 1,
        "maxItems": 4,
        "itemMin": 1,
        "itemMax": 32,
    },
}


class Model(nn.Module):
    def __init__(self, input_dim, hidden_widths):
        super().__init__()
        assert isinstance(hidden_widths, list)
        layers = []
        current = input_dim
        for width in hidden_widths:
            layers.extend([nn.Linear(current, width), nn.ReLU()])
            current = width
        layers.append(nn.Linear(current, 1))
        self.layers = nn.Sequential(*layers)

    def forward(self, x):
        return self.layers(x)
'''


SEQUENCE_MODEL = r'''
import torch
from torch import nn


MODEL_PARAMS = {
    "base_channels": {"type": "int", "default": 8, "min": 1},
    "depth": {"type": "int", "default": 2, "min": 1},
}


class Model(nn.Module):
    def __init__(self, input_dim, output_dim, base_channels=8, depth=2):
        super().__init__()
        layers = []
        in_channels = input_dim
        for index in range(depth):
            out_channels = base_channels * (index + 1)
            layers.extend([nn.Conv1d(in_channels, out_channels, 3, padding=1), nn.ReLU()])
            in_channels = out_channels
        self.features = nn.Sequential(*layers)
        self.output = nn.Linear(in_channels, output_dim)

    def forward(self, x):
        hidden = self.features(x.transpose(1, 2))
        return self.output(hidden[:, :, -1])
'''


ARBITRARY_BATCH_MODEL = r'''
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


def make_spec(data, split, params, scaler=None):
    return {
        "input_shape": (2,),
        "output_shape": (1,),
        "task": "regression",
        "feature_names": ("x1", "x2"),
        "target_names": ("label",),
    }


def build_dataloader(data, split, params, scaler=None):
    features = data[["x1", "x2"]].to_numpy(dtype="float32")
    target = data["label"].to_numpy(dtype="float32").reshape(-1, 1)
    # 第三个字段故意不是模型输入，验证宿主不会尝试猜测 batch 的含义。
    mask = torch.ones((len(data), 1), dtype=torch.float32)
    dataset = TensorDataset(torch.from_numpy(features), torch.from_numpy(target), mask)
    return DataLoader(dataset, batch_size=17, shuffle=split == "train")


def build_model(spec, params):
    return nn.Linear(spec.input_shape[0], spec.output_shape[0])


def train_step(model, batch, device, spec):
    features, target, mask = batch
    features = features.to(device)
    target = target.to(device)
    mask = mask.to(device)
    prediction = model(features)
    error = (prediction - target) * mask
    loss = (error ** 2).mean()
    return {"loss": loss, "batch_size": target.shape[0], "metrics": {"MAE": error.abs().mean()}}


def validation_step(model, batch, device, spec):
    features, target, mask = batch
    prediction = model(features.to(device))
    target = target.to(device)
    error = prediction - target
    return {"loss": (error ** 2).mean(), "metrics": {"MAE": error.abs().mean()}}


def predict_step(model, batch, device, spec):
    features, _, _ = batch
    return {"prediction": model(features.to(device))}
'''


class CustomModelInterfaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = session.EngineSession("custom-model-test")
        feed(self.engine, synthetic(), "t")
        source = self.engine.eval_node(
            {
                "nodeId": "src",
                "nodeType": "data.source",
                "params": {"datasetId": "synthetic"},
                "inputs": {},
                "outputPorts": [{"id": "data", "shape": "table"}],
            }
        )
        self.assertTrue(source["ok"], source.get("message"))

    def evaluate(self, node_id: str, node_type: str, params, inputs, output_ports):
        result = self.engine.eval_node(
            {
                "nodeId": node_id,
                "nodeType": node_type,
                "params": params,
                "inputs": inputs,
                "outputPorts": output_ports,
            }
        )
        self.assertTrue(result["ok"], result.get("message"))
        return result

    def define_model(self, node_id: str, code: str, **model_params) -> str:
        params = {"code": code, **model_params}
        result = self.evaluate(
            node_id,
            "custom.model",
            params,
            {},
            [{"id": "model", "kind": "model"}],
        )
        self.assertEqual(result["refs"]["model"]["kind"], "model")
        return node_id

    def test_model_params_are_defined_in_model_block_and_passed_separately(self) -> None:
        specs = normalize_model_param_specs(
            {
                "hidden_dim": {"type": "int", "default": 8, "min": 1},
                "dropout": {"type": "float", "default": 0.1},
            }
        )
        assert resolve_model_params(specs, {"hidden_dim": "16", "dropout": "0.3"}) == {
            "hidden_dim": 16,
            "dropout": 0.3,
        }
        model_node = self.define_model(
            "parameter-definition",
            PARAMETER_MODEL,
            hidden_dim=16,
            dropout=0.3,
        )
        trained = self.evaluate(
            "parameter-custom",
            "train.custom",
            {
                "features": "x1,x2",
                "label": "label",
                "task": "回归",
                "epochs": 1,
                "batch": 64,
                "lr": 0.01,
                "device": "cpu",
            },
            {"model": port(model_node, "model"), "train": port("src", "data")},
            [{"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"}],
        )
        self.assertEqual(trained["refs"]["model"]["kind"], "model")

    def test_list_model_params_are_typed_and_passed_as_python_lists(self) -> None:
        specs = normalize_model_param_specs(
            {
                "dilations": {
                    "type": "list[int]",
                    "default": [1, 2, 4],
                    "minItems": 1,
                    "maxItems": 4,
                    "itemMin": 1,
                    "itemMax": 16,
                }
            }
        )
        resolved = resolve_model_params(specs, {"dilations": "[1,4,8]"})
        self.assertEqual(resolved, {"dilations": [1, 4, 8]})
        resolved_values = resolved["dilations"]
        if not isinstance(resolved_values, list):
            self.fail("列表参数未恢复为新的 Python list")
        resolved_values.append(16)
        self.assertEqual(resolve_model_params(specs, None), {"dilations": [1, 2, 4]})
        for invalid in ('[1,"4"]', '[]', '[1,2,32]', '[[1],2]'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                resolve_model_params(specs, {"dilations": invalid})
        with self.assertRaisesRegex(ValueError, "显式声明 type"):
            normalize_model_param_specs({"empty": {"default": []}})
        with self.assertRaisesRegex(ValueError, "有效的 int"):
            normalize_model_param_specs({"large": {"type": "list[int]", "default": [2**53]}})

        other_specs = normalize_model_param_specs(
            {
                "rates": {"type": "list[float]", "default": [0.1, 0.2]},
                "names": {"type": "list[str]", "default": ["conv", "relu"]},
                "enabled": {"type": "list[bool]", "default": [True, False]},
                "empty": {"type": "list[int]", "default": []},
            }
        )
        self.assertEqual(
            resolve_model_params(
                other_specs,
                {"rates": "[0.3,0.4]", "names": '["dense"]', "enabled": "[false,true]", "empty": "[]"},
            ),
            {"rates": [0.3, 0.4], "names": ["dense"], "enabled": [False, True], "empty": []},
        )

        model_node = self.define_model("list-model-definition", LIST_PARAMETER_MODEL, hidden_widths="[3, 2]")
        trained = self.evaluate(
            "list-model-train",
            "train.custom",
            {
                "features": "x1,x2",
                "label": "label",
                "task": "回归",
                "epochs": 1,
                "batch": 64,
                "lr": 0.01,
                "device": "cpu",
            },
            {"model": port(model_node, "model"), "train": port("src", "data")},
            [{"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"}],
        )
        self.assertEqual(trained["refs"]["metrics"]["values"]["参数量"], 20.0)

    def test_explicit_model_interface_is_normalized_and_validated(self) -> None:
        interface = normalize_model_interface(
            {
                "inputs": [
                    {
                        "id": "features",
                        "type": "tensor",
                        "shape": ["batch", "feature"],
                        "axes": ["sample", "feature"],
                        "dtype": "float32",
                    },
                    {"id": "context", "type": "table", "multiple": True},
                ],
                "outputs": {"prediction": {"type": "tensor", "shape": ["batch", "target"]}},
            }
        )
        self.assertEqual([item.id for item in interface.inputs], ["features", "context"])
        self.assertEqual(interface.inputs[0].shape, ("batch", "feature"))
        self.assertTrue(interface.inputs[1].multiple)
        self.assertEqual(interface.outputs[0].id, "prediction")
        with self.assertRaisesRegex(ValueError, "不受支持"):
            normalize_model_interface({"inputs": [{"id": "x", "type": "unknown"}]})
        with self.assertRaisesRegex(ValueError, "保留名称"):
            normalize_model_interface({"outputs": [{"id": "model", "type": "model"}]})
        with self.assertRaisesRegex(ValueError, "axes 长度"):
            normalize_model_interface({"inputs": [{"id": "x", "type": "tensor", "shape": [1], "axes": []}]})
        with self.assertRaisesRegex(ValueError, "安全的 Python 字面量"):
            normalize_model_interface_source("MODEL_INTERFACE = make_interface()")

    def test_model_class_can_be_pasted_without_build_model_wrapper(self) -> None:
        model_node = self.define_model("class-definition", CLASS_MODEL, hidden_dim=16)
        trained = self.evaluate(
            "class-custom",
            "train.custom",
            {
                "features": "x1,x2",
                "label": "label",
                "task": "回归",
                "epochs": 1,
                "batch": 64,
                "lr": 0.01,
                "device": "cpu",
            },
            {"model": port(model_node, "model"), "train": port("src", "data")},
            [{"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"}],
        )
        self.assertEqual(trained["refs"]["model"]["kind"], "model")
        # hidden_dim=16 来自自定义模型块；参数量可以证明宿主实例化 Model 时确实使用了它，
        # 而不是只把代码定义句柄接到了训练节点。
        self.assertEqual(trained["refs"]["metrics"]["values"]["参数量"], 65.0)

    def test_sequence_model_uses_training_node_window_loader(self) -> None:
        model_node = self.define_model(
            "sequence-definition",
            SEQUENCE_MODEL,
            base_channels=4,
            depth=3,
        )
        trained = self.evaluate(
            "sequence-custom",
            "train.custom",
            {
                "features": "x1,x2",
                "label": "label",
                "task": "回归",
                "inputMode": "时序窗口",
                "window": 12,
                "horizon": 1,
                "stride": 2,
                "epochs": 1,
                "batch": 64,
                "lr": 0.01,
                "device": "cpu",
            },
            {"model": port(model_node, "model"), "train": port("src", "data")},
            [{"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"}],
        )
        self.assertEqual(trained["refs"]["model"]["kind"], "model")
        self.assertEqual(trained["refs"]["metrics"]["values"]["训练样本数"], 294.0)
        self.assertEqual(trained["meta"]["数据加载"], "SciViz 时序 DataLoader")

        predicted = self.evaluate(
            "sequence-predict",
            "model.predict",
            {"device": "cpu", "batch": 64},
            {"model": port("sequence-custom", "model"), "data": port("src", "data")},
            [{"id": "predictions", "kind": "table"}],
        )
        prediction_ref = predicted["refs"]["predictions"]
        self.assertEqual(prediction_ref["rowCount"], 294)
        self.assertIn("label", prediction_ref["columns"])
        self.assertIn("预测_label", prediction_ref["columns"])

    def test_custom_dataset_loader_model_and_predict_are_connected(self) -> None:
        model_node = self.define_model("custom-definition", CUSTOM_MODEL)
        trained = self.evaluate(
            "custom",
            "train.custom",
            {
                "features": "x1,x2",
                "label": "label",
                "task": "回归",
                "epochs": 3,
                "batch": 32,
                "lr": 0.01,
                "device": "cpu",
                "seed": 7,
            },
            {
                "model": port(model_node, "model"),
                "train": port("src", "data"),
                "val": port("src", "data"),
            },
            [
                {"id": "model", "kind": "model"},
                {"id": "metrics", "kind": "metrics"},
                {"id": "history", "kind": "table"},
                {"id": "curve", "kind": "figure"},
            ],
        )
        self.assertEqual(trained["refs"]["model"]["kind"], "model")
        self.assertEqual(trained["refs"]["metrics"]["kind"], "metrics")
        self.assertEqual(trained["refs"]["history"]["rowCount"], 3)
        self.assertEqual(trained["refs"]["curve"]["rowCount"], 9)
        self.assertEqual(trained["meta"]["数据加载"], "自定义 DataLoader")

        predicted = self.evaluate(
            "predict",
            "model.predict",
            {"device": "cpu", "batch": 64},
            {"model": port("custom", "model"), "data": port("src", "data")},
            [{"id": "predictions", "kind": "table"}],
        )
        prediction_ref = predicted["refs"]["predictions"]
        self.assertEqual(prediction_ref["kind"], "table")
        self.assertEqual(prediction_ref["rowCount"], 600)
        self.assertIn("预测_label", prediction_ref["columns"])

        scored = self.evaluate(
            "score",
            "eval.score",
            {"y_true": "label", "y_pred": "预测_label", "task": "回归"},
            {"data": port("predict", "predictions")},
            [{"id": "metrics", "kind": "metrics"}],
        )
        self.assertEqual(scored["refs"]["metrics"]["kind"], "metrics")
        self.assertIn("RMSE", scored["refs"]["metrics"]["values"])

    def test_custom_model_can_use_the_default_dataset_and_loader(self) -> None:
        model_node = self.define_model("default-definition", DEFAULT_MODEL)
        trained = self.evaluate(
            "default-custom",
            "train.custom",
            {
                "features": "x1,x2",
                "label": "label",
                "task": "回归",
                "epochs": 2,
                "batch": 64,
                "lr": 0.01,
                "device": "cpu",
            },
            {"model": port(model_node, "model"), "train": port("src", "data")},
            [{"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"}],
        )
        self.assertEqual(trained["refs"]["model"]["kind"], "model")
        self.assertEqual(trained["refs"]["metrics"]["values"]["训练轮数"], 2.0)
        self.assertEqual(trained["meta"]["数据加载"], "SciViz DataLoader")

    def test_custom_loader_and_step_hooks_can_use_arbitrary_batch(self) -> None:
        model_node = self.define_model("arbitrary-batch-definition", ARBITRARY_BATCH_MODEL)
        trained = self.evaluate(
            "arbitrary-batch",
            "train.custom",
            {
                "task": "回归",
                "epochs": 2,
                "lr": 0.01,
                "device": "cpu",
                "seed": 11,
            },
            {
                "model": port(model_node, "model"),
                "train": port("src", "data"),
                "val": port("src", "data"),
            },
            [
                {"id": "model", "kind": "model"},
                {"id": "metrics", "kind": "metrics"},
                {"id": "history", "kind": "table"},
                {"id": "curve", "kind": "figure"},
            ],
        )
        self.assertEqual(trained["meta"]["数据加载"], "用户 build_dataloader")
        self.assertEqual(trained["meta"]["batch处理"], "用户 step hook")
        self.assertIn("验证MAE", trained["refs"]["history"]["columns"])

        predicted = self.evaluate(
            "arbitrary-batch-predict",
            "model.predict",
            {"device": "cpu"},
            {"model": port("arbitrary-batch", "model"), "data": port("src", "data")},
            [{"id": "predictions", "kind": "table"}],
        )
        self.assertEqual(predicted["refs"]["predictions"]["rowCount"], 600)
        self.assertIn("预测_label", predicted["refs"]["predictions"]["columns"])

    def test_builtin_model_output_is_a_model_handle(self) -> None:
        trained = self.evaluate(
            "builtin",
            "train.mlp",
            {"label": "label", "epochs": 1, "hidden": 8, "batch": 64, "device": "cpu"},
            {"train": port("src", "data")},
            [{"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"}],
        )
        self.assertEqual(trained["refs"]["model"]["kind"], "model")
        predicted = self.evaluate(
            "builtin-predict",
            "model.predict",
            {"device": "cpu"},
            {"model": port("builtin", "model"), "data": port("src", "data")},
            [{"id": "predictions", "kind": "table"}],
        )
        self.assertEqual(predicted["refs"]["predictions"]["rowCount"], 600)
        self.assertIn("预测_label", predicted["refs"]["predictions"]["columns"])


if __name__ == "__main__":
    unittest.main()
