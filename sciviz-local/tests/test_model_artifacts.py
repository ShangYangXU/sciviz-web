"""不可变训练制品与跨宿主恢复判据。"""

from __future__ import annotations

import json
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import session  # noqa: E402
from fixtures import feed, port, synthetic  # noqa: E402


MODEL_CODE = '''
import torch
from torch import nn

class Model(nn.Module):
    def __init__(self, input_dim, output_dim):
        super().__init__()
        self.linear = nn.Linear(input_dim, output_dim)
    def forward(self, x):
        return self.linear(x)
'''

TRAIN_CODE = '''
def fit_model(model, train_loader, val_loader, device, spec, params, env, epochs=2, lr=0.01):
    import torch
    optimizer = torch.optim.SGD(model.parameters(), lr=lr)
    loss_fn = torch.nn.MSELoss()
    history = []
    for epoch in range(epochs):
        model.train()
        total = 0.0
        for x, y in train_loader:
            x = x.to(device=device, dtype=torch.float32)
            y = y.to(device=device, dtype=torch.float32).reshape(-1)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x).reshape(-1), y)
            loss.backward()
            optimizer.step()
            total += float(loss.detach().cpu()) * len(y)
        history.append({"轮次": epoch + 1, "训练损失": total / len(train_loader.dataset)})
    return {"model": model, "metrics": {"训练轮数": float(epochs)}, "history": history}
'''

STANDARDIZE_CODE = '''
from sklearn.preprocessing import StandardScaler

def standardize(data):
    scaler = StandardScaler().fit(data[["x1", "x2"]])
    return {"train": data.copy(), "val": data.copy(), "scaler": scaler}
'''


class ModelArtifactTest(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = session.EngineSession("model-artifact-original")
        feed(self.engine, synthetic(), "t")
        self._eval(
            self.engine,
            {
                "nodeId": "source", "nodeType": "data.source", "params": {"datasetId": "synthetic"},
                "inputs": {}, "outputPorts": [{"id": "data", "shape": "table"}],
            },
        )
        self.engine.load_fn("standardizer", "standardize", STANDARDIZE_CODE)
        self._eval(
            self.engine,
            {
                "nodeId": "standardizer", "nodeType": "custom.script", "params": {"code": STANDARDIZE_CODE},
                "inputs": {"data": port("source", "data")},
                "outputPorts": [
                    {"id": "train", "shape": "table"}, {"id": "val", "shape": "table"},
                    {"id": "scaler", "kind": "scaler"},
                ],
            },
        )
        self._eval(
            self.engine,
            {
                "nodeId": "model-definition", "nodeType": "custom.model", "params": {"code": MODEL_CODE},
                "inputs": {}, "outputPorts": [{"id": "model", "kind": "model"}],
            },
        )

    def _eval(self, engine, payload):
        result = engine.eval_node(payload)
        self.assertTrue(result.get("ok"), result.get("message"))
        return result

    def _training_payload(self, **extra):
        payload = {
            "nodeId": "trainer",
            "nodeType": "train.function",
            "fingerprint": "f" * 64,
            "params": {
                "code": TRAIN_CODE, "features": "x1,x2", "label": "label", "task": "回归",
                "device": "cpu", "epochs": 2, "lr": 0.01,
            },
            "inputs": {
                "model": port("model-definition", "model"),
                "train": port("standardizer", "train"),
                "val": port("standardizer", "val"),
                "scaler": port("standardizer", "scaler"),
                "epochs": {"kind": "literal", "value": 2},
                "lr": {"kind": "literal", "value": 0.01},
            },
            "outputPorts": [
                {"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"},
                {"id": "history", "shape": "table"}, {"id": "curve", "kind": "figure"},
            ],
        }
        payload.update(extra)
        return payload

    def _fresh_host(self, model_code=MODEL_CODE):
        engine = session.EngineSession("model-artifact-reopened")
        feed(engine, synthetic(), "t")
        self._eval(
            engine,
            {"nodeId": "source", "nodeType": "data.source", "params": {"datasetId": "synthetic"},
             "inputs": {}, "outputPorts": [{"id": "data", "shape": "table"}]},
        )
        engine.load_fn("standardizer", "standardize", STANDARDIZE_CODE)
        self._eval(
            engine,
            {"nodeId": "standardizer", "nodeType": "custom.script", "params": {"code": STANDARDIZE_CODE},
             "inputs": {"data": port("source", "data")},
             "outputPorts": [{"id": "train", "shape": "table"}, {"id": "val", "shape": "table"},
                             {"id": "scaler", "kind": "scaler"}]},
        )
        self._eval(
            engine,
            {"nodeId": "model-definition", "nodeType": "custom.model", "params": {"code": model_code},
             "inputs": {}, "outputPorts": [{"id": "model", "kind": "model"}]},
        )
        return engine

    def test_repeat_training_is_immutable_and_new_host_restores_without_fit_model(self) -> None:
        self.engine.load_fn("trainer", "fit_model", TRAIN_CODE)
        first = self._eval(self.engine, self._training_payload())
        first_model_artifact = next(a for a in first["artifacts"] if a["kind"] == "model")
        first_manifest = next(a for a in first["artifacts"] if a["kind"] == "meta")
        first_path = Path(first_model_artifact["path"])
        first_bytes = first_path.read_bytes()
        before_model = self.engine._runtime.outputs_of("trainer")["model"]
        sample = torch.tensor([[0.15, -0.4], [0.9, 0.1]], dtype=torch.float32)
        expected = before_model(sample).detach().cpu().numpy()
        expected_scaler_mean = before_model.scaler.mean_.tolist()

        # 同配置再次随机训练有新身份，首份权重文件仍是原字节。
        second = self._eval(self.engine, self._training_payload())
        second_model_artifact = next(a for a in second["artifacts"] if a["kind"] == "model")
        self.assertNotEqual(first_model_artifact["artifactId"], second_model_artifact["artifactId"])
        self.assertEqual(first_path.read_bytes(), first_bytes)

        # 新 OS 进程模拟宿主重启。子进程不加载 fit_model 函数，恢复若误进训练分支会失败。
        restore_payload = self._training_payload(
            restoreArtifactId=first_model_artifact["artifactId"],
            restoreArtifactSha256=first_manifest["sha256"],
        )
        child = r'''
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd() / "tests"))
import torch
from sciviz_host import session
from fixtures import feed, synthetic, port
payload = json.loads(sys.stdin.read())
engine = session.EngineSession("artifact-after-process-restart")
feed(engine, synthetic(), "t")
source = engine.eval_node({"nodeId":"source", "nodeType":"data.source", "params":{"datasetId":"synthetic"}, "inputs":{}, "outputPorts":[{"id":"data","shape":"table"}]})
engine.load_fn("standardizer", "standardize", payload["standardizeCode"])
standardizer = engine.eval_node({"nodeId":"standardizer", "nodeType":"custom.script", "params":{"code":payload["standardizeCode"]}, "inputs":{"data":port("source","data")}, "outputPorts":[{"id":"train","shape":"table"},{"id":"val","shape":"table"},{"id":"scaler","kind":"scaler"}]})
definition = engine.eval_node({"nodeId":"model-definition", "nodeType":"custom.model", "params":{"code":payload["modelCode"]}, "inputs":{}, "outputPorts":[{"id":"model","kind":"model"}]})
if not source.get("ok") or not standardizer.get("ok") or not definition.get("ok"):
    print(json.dumps({"error": source.get("message") or standardizer.get("message") or definition.get("message")})); sys.exit(2)
result = engine.eval_node(payload["request"])
if not result.get("ok"):
    print(json.dumps({"error": result.get("message")})); sys.exit(3)
model = engine._runtime.outputs_of("trainer")["model"]
prediction = model(torch.tensor(payload["sample"], dtype=torch.float32)).detach().cpu().numpy().tolist()
restored_model = engine._runtime.outputs_of("trainer")["model"]
print(json.dumps({"restored":result.get("restored", False), "rows":result["refs"]["history"]["rowCount"], "prediction":prediction, "scalerMean":restored_model.scaler.mean_.tolist()}))
'''
        completed = subprocess.run(
            [sys.executable, "-c", child],
            cwd=Path(__file__).resolve().parents[1],
            input=json.dumps({"request": restore_payload, "modelCode": MODEL_CODE,
                              "standardizeCode": STANDARDIZE_CODE, "sample": sample.tolist()}),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        restored = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertTrue(restored["restored"])
        np.testing.assert_allclose(restored["prediction"], expected, rtol=0, atol=0)
        np.testing.assert_allclose(restored["scalerMean"], expected_scaler_mean, rtol=0, atol=0)
        self.assertEqual(restored["rows"], 2)

    def test_missing_corrupt_and_incompatible_artifacts_fail_closed(self) -> None:
        self.engine.load_fn("trainer", "fit_model", TRAIN_CODE)
        trained = self._eval(self.engine, self._training_payload())
        model_ref = next(a for a in trained["artifacts"] if a["kind"] == "model")
        meta_ref = next(a for a in trained["artifacts"] if a["kind"] == "meta")
        base = self._training_payload(
            restoreArtifactId=model_ref["artifactId"], restoreArtifactSha256=meta_ref["sha256"]
        )

        reopened = self._fresh_host()
        missing_manifest_anchor = reopened.eval_node({**base, "restoreArtifactSha256": None})
        self.assertFalse(missing_manifest_anchor["ok"])
        self.assertIn("清单校验值缺失或无效", missing_manifest_anchor["message"])

        Path(model_ref["path"]).unlink()
        missing = reopened.eval_node(base)
        self.assertFalse(missing["ok"])
        self.assertIn("重新定位制品或重新训练", missing["message"])

        # 再次训练形成新目录后改坏权重，校验失败也不得回退到训练函数。
        retrained = self._eval(self.engine, self._training_payload())
        model_ref = next(a for a in retrained["artifacts"] if a["kind"] == "model")
        meta_ref = next(a for a in retrained["artifacts"] if a["kind"] == "meta")
        Path(model_ref["path"]).write_bytes(b"truncated")
        corrupt_payload = self._training_payload(
            restoreArtifactId=model_ref["artifactId"], restoreArtifactSha256=meta_ref["sha256"]
        )
        corrupt = reopened.eval_node(corrupt_payload)
        self.assertFalse(corrupt["ok"])
        self.assertIn("校验失败", corrupt["message"])

        incompatible_host = self._fresh_host(MODEL_CODE + "\n# changed definition\n")
        incompatible = incompatible_host.eval_node(
            self._training_payload(
                restoreArtifactId=meta_ref["artifactId"], restoreArtifactSha256=meta_ref["sha256"]
            )
        )
        self.assertFalse(incompatible["ok"])
        self.assertIn("模型定义已变化", incompatible["message"])
        self.assertIn("重新定位制品或重新训练", incompatible["message"])

    def test_builtin_mlp_is_rebuilt_from_its_versioned_definition(self) -> None:
        engine = session.EngineSession("builtin-mlp-artifact")
        data = synthetic()
        feed(engine, data, "t")
        source = self._eval(
            engine,
            {"nodeId": "source", "nodeType": "data.source", "params": {"datasetId": "synthetic"},
             "inputs": {}, "outputPorts": [{"id": "data", "shape": "table"}]},
        )
        params = {"label": "label", "epochs": 2, "hidden": 8, "seed": 13, "device": "cpu"}
        payload = {
            "nodeId": "mlp", "nodeType": "train.mlp", "fingerprint": "mlp-fingerprint-v1",
            "params": params, "inputs": {"train": port("source", "data")},
            "outputPorts": [
                {"id": "model", "kind": "model"}, {"id": "metrics", "kind": "metrics"},
                {"id": "history", "shape": "table"}, {"id": "curve", "kind": "figure"},
            ],
        }
        trained = self._eval(engine, payload)
        model_artifact = next(item for item in trained["artifacts"] if item["kind"] == "model")
        manifest = next(item for item in trained["artifacts"] if item["kind"] == "meta")
        bundle = engine._runtime.outputs_of("mlp")["model"]
        raw = np.asarray([[0.2, -0.1], [0.8, 0.4]], dtype=np.float32)
        normalized = (raw - bundle.center) / bundle.scale
        expected = bundle.module(torch.from_numpy(normalized)).detach().cpu().numpy()

        reopened = session.EngineSession("builtin-mlp-reopened")
        feed(reopened, synthetic(), "t")
        self._eval(
            reopened,
            {"nodeId": "source", "nodeType": "data.source", "params": {"datasetId": "synthetic"},
             "inputs": {}, "outputPorts": [{"id": "data", "shape": "table"}]},
        )
        restored = self._eval(
            reopened,
            {**payload, "restoreArtifactId": model_artifact["artifactId"],
             "restoreArtifactSha256": manifest["sha256"]},
        )
        self.assertTrue(restored["restored"])
        recovered = reopened._runtime.outputs_of("mlp")["model"]
        actual = recovered.module(torch.from_numpy(normalized)).detach().cpu().numpy()
        np.testing.assert_allclose(actual, expected, rtol=0, atol=0)
        np.testing.assert_allclose(recovered.center, bundle.center, rtol=0, atol=0)
        np.testing.assert_allclose(recovered.scale, bundle.scale, rtol=0, atol=0)

    def test_legacy_short_hash_training_artifact_can_be_reopened(self) -> None:
        """旧版按短哈希目录保存的 TCN 权重可由工程明确引用后恢复。"""
        self.engine.load_fn("trainer", "fit_model", TRAIN_CODE)
        trained = self._eval(self.engine, self._training_payload())
        model_ref = next(item for item in trained["artifacts"] if item["kind"] == "model")
        meta_ref = next(item for item in trained["artifacts"] if item["kind"] == "meta")
        current_manifest = json.loads(Path(meta_ref["path"]).read_text(encoding="utf-8"))

        with tempfile.TemporaryDirectory() as root:
            previous_root = os.environ.get("SCIVIZ_ARTIFACT_DIR")
            os.environ["SCIVIZ_ARTIFACT_DIR"] = root
            try:
                artifact_id = "d" * 16
                directory = Path(root) / artifact_id
                directory.mkdir()
                state = torch.load(Path(model_ref["path"]), map_location="cpu", weights_only=True)
                legacy_scaler = self.engine._runtime.outputs_of("standardizer")["scaler"]
                torch.save(
                    {"state_dict": state, "nodeType": "train.function", "scaler": legacy_scaler},
                    directory / "model.pt",
                )
                legacy_manifest = {
                    "nodeType": "train.function",
                    "fingerprint": self._training_payload()["fingerprint"],
                    "createdAt": "2026-09-18 21:15:32",
                    "params": {str(key): str(value) for key, value in self._training_payload()["params"].items()},
                    "metrics": current_manifest["metrics"],
                    "history": current_manifest["history"],
                    "modelSpec": current_manifest["modelSpec"],
                    "environment": current_manifest.get("environment", {}),
                }
                manifest_path = directory / "meta.json"
                manifest_path.write_text(
                    json.dumps(legacy_manifest, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()

                reopened = self._fresh_host()
                restored = self._eval(
                    reopened,
                    self._training_payload(
                        restoreArtifactId=artifact_id,
                        restoreArtifactSha256=manifest_hash,
                    ),
                )
                self.assertTrue(restored["restored"])
                self.assertEqual(restored["refs"]["history"]["rowCount"], len(current_manifest["history"]))
            finally:
                if previous_root is None:
                    os.environ.pop("SCIVIZ_ARTIFACT_DIR", None)
                else:
                    os.environ["SCIVIZ_ARTIFACT_DIR"] = previous_root


if __name__ == "__main__":
    unittest.main()
