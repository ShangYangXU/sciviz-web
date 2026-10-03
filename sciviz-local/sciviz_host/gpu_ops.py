"""宿主专属算子（需要 torch，Pyodide 里不存在）。

这些算子**不属于**共享算子表 `operators.py`：浏览器适配器 import 它们会因为
没有 torch 而直接失败。它们由宿主在自己的注册表里追加，并把清单通过 `/health`
报给前端 —— 这正是架构总纲 §5 那句"适配器是唯一允许接触外部世界的地方"：
一个算子属于哪个适配器、这个适配器能算什么，由适配器自己声明。

算子签名与共享算子完全一致：`(env, params, inputs, output_ports) -> {端口: 值}`。
"""

from __future__ import annotations

import inspect
import hashlib
import json
import os
import re
import tempfile
import time
import uuid
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from re import fullmatch
from typing import Any

import numpy as np
import pandas as pd

from . import device as device_probe
from .model_api import (
    CustomModelDefinition,
    LoaderConfig,
    ModelBundle,
    ModelSpec,
    infer_model_param_specs,
    normalize_model_interface_source,
    normalize_model_param_specs,
    resolve_model_params,
)

def _as_frame(value: Any, what: str) -> pd.DataFrame:
    if value is None:
        raise ValueError(f"{what}没有接入")
    if isinstance(value, pd.DataFrame):
        return value
    if isinstance(value, pd.Series):
        name = str(value.name) if value.name is not None else what
        return value.to_frame(name)
    return pd.DataFrame(np.asarray(value))


def _numeric(frame: pd.DataFrame, what: str) -> pd.DataFrame:
    numeric = frame.select_dtypes(include=[np.number])
    if numeric.shape[1] == 0:
        raise ValueError(f"{what}里没有数值列")
    return numeric


def _num(params: dict[str, Any], key: str, fallback: float) -> float:
    """参数兜底。前端送下来的可能是字符串、空串或 None，全按"没填"处理"""
    try:
        out = float(params.get(key))
    except (TypeError, ValueError):
        return float(fallback)
    return out if np.isfinite(out) else float(fallback)


def _bool_param(params: dict[str, Any], key: str, fallback: bool = False) -> bool:
    """布尔参数兜底。

    界面上送的是 true / false，但工程文件是文本、人会手改：`true`、`1`、`是` 都该认。
    反过来（把 false 认成真）才是灾难，所以这里只放宽"真"的写法。
    """
    value = params.get(key)
    if value is None or value == "":
        return fallback
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on", "是")


#: 早停的两个默认值。容忍 5 轮、改善要超过 1e-4 —— 与 torch 早停类库的常见量级一致
DEFAULT_PATIENCE = 5
DEFAULT_MIN_DELTA = 1e-4


class EarlyStop:
    """早停的判据。**纯逻辑，不碰 torch** —— 这样它能被单独测，而不必真训一个网络。

    三条口径值得写下来，因为它们都是"看起来差不多、结果不同"的地方：

    - **盯谁**：有验证集就盯验证损失，没有才退到训练损失。退到训练损失时这件事必须
      被说出来（记进元信息），因为"用训练损失早停"约等于"越训越不停"。
    - **什么算改善**：要比历史最好值小过 `minDelta` 才算。浮点噪声级别的变化不算改善，
      否则容忍轮数永远不会用完。
    - **算不出数时不动**：NaN / Inf 既不当改善，也**不累计容忍轮数** —— 拿一个缺失的
      读数去累计"连续几轮没进步"，会把"验证集是空的"伪装成"早停生效了"。
    """

    def __init__(self, patience: float, min_delta: float, monitor: str) -> None:
        self.patience = max(1, int(patience))
        self.min_delta = max(0.0, float(min_delta))
        self.monitor = monitor
        self.best_value = float("inf")
        self.best_epoch = 0
        self.waited = 0
        self.stopped_at = 0

    def step(self, epoch: int, value: float | None) -> bool:
        """记一轮的监控值。返回这一轮是不是**新的最好**（是的话该存一份权重）。"""
        if value is None:
            return False
        number = float(value)
        if not np.isfinite(number):
            return False
        if number < self.best_value - self.min_delta:
            self.best_value = number
            self.best_epoch = int(epoch)
            self.waited = 0
            return True
        self.waited += 1
        if self.waited >= self.patience:
            self.stopped_at = int(epoch)
        return False

    @property
    def triggered(self) -> bool:
        return self.stopped_at > 0

    def note(self, epochs: int) -> str:
        """给人看的那一句。停在第几轮、最好第几轮、盯的是哪个损失，一次说清。"""
        if not self.triggered:
            return f"未触发（盯{self.monitor}，容忍 {self.patience} 轮，跑满 {epochs} 轮）"
        return (
            f"停在第 {self.stopped_at} 轮（盯{self.monitor}，容忍 {self.patience} 轮，"
            f"最好第 {self.best_epoch} 轮，已回到那一轮的权重）"
        )


def _early_stop(params: dict[str, Any], has_val: bool) -> EarlyStop | None:
    """读早停参数。**没打开就返回 None** —— 默认关：

    加一个选项不该让已有工程的训练结果悄悄变了（少跑的那些轮次会换掉交付的权重）。
    要默认开是一行的事，但那是一次**行为变更**，得单独登记与迁移。
    """
    if not _bool_param(params, "earlyStop"):
        return None
    return EarlyStop(
        _num(params, "patience", DEFAULT_PATIENCE),
        _num(params, "minDelta", DEFAULT_MIN_DELTA),
        # 没接验证集时退到训练损失。这条退路是刻意的：早停本身仍然有用（省 GPU 时间），
        # 但它防的是过拟合而训练损失只会一路向下 —— 所以退到哪一路必须被说出来
        "验证损失" if has_val else "训练损失",
    )


def _environment_facts() -> dict[str, Any]:
    """这次训练所在的环境。与运行清单里的 `environment` 是同一批事实。

    权重文件离开这台机器之后，只有它还能说明"当时是什么环境算出来的" ——
    换台机器加载权重对不上时，这是唯一能做差的东西。
    """
    import torch

    info = device_probe.probe()
    return {
        "torch": str(torch.__version__),
        "cuda": info.cuda_version,
        "device": info.backend,
        "gpu": list(info.gpu_names),
    }


def _note_environment(env, target: str, extra: dict[str, str] | None = None) -> None:
    """把"这次训练实际用了什么"登记成**元信息**（待办 T11）。

    为什么不能只放进指标：指标只收数值，而设备名与版本号是字符串 —— 塞进指标要么被丢掉，
    要么被编成一个数字。但这两样正是"这次和上次是不是同一件事"要用的东西：
    同一张图在 CPU 上跑和在 3050 上跑，指标看起来都对。

    `extra` 走同一扇门：早停那句"停在第几轮、盯的是哪个损失"也是这种**数字之外的事实**。
    它尤其不该只留在日志里 —— 日志会滚走，而运行清单里的元信息是这份结果的一部分。
    """
    info = device_probe.probe()
    env.set_meta(
        {
            "设备": target,
            "GPU": "、".join(info.gpu_names) if target == "cuda" and info.gpu_names else "—",
            "torch": str(info.torch_version or "未安装"),
            **(extra or {}),
        }
    )


def _artifact_json(value: Any) -> Any:
    """将制品元数据限制为可审计的 JSON 值，不把 Python 对象 pickle 进去。"""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, (float, np.floating)):
        number = float(value)
        return number if np.isfinite(number) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.ndarray):
        # sklearn 的 feature_names_in_ 与分类标签常用 object 数组；只接受其中的
        # JSON 标量，不对任意 Python 对象做 pickle。
        contents = _artifact_json(value.tolist())
        return {"$array": contents, "dtype": str(value.dtype), "shape": list(value.shape)}
    if isinstance(value, Mapping):
        return {str(key): _artifact_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_artifact_json(item) for item in value]
    raise TypeError(f"模型元数据含有不可持久化值：{type(value).__name__}")


def _artifact_value(value: Any) -> Any:
    """反解制品中受限的数组编码。"""
    if isinstance(value, dict):
        if set(value) == {"$array", "dtype", "shape"}:
            array = np.asarray(value["$array"], dtype=value["dtype"])
            return array.reshape(tuple(value["shape"]))
        return {key: _artifact_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_artifact_value(item) for item in value]
    return value


def _sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_sha256(source: Any) -> str | None:
    if source is None:
        return None
    return hashlib.sha256(str(source).encode("utf-8")).hexdigest()


def _function_sha256(function) -> str:
    try:
        source = inspect.getsource(function)
    except (OSError, TypeError):
        source = f"{function.__module__}.{function.__qualname__}"
    return _source_sha256(source) or ""


def _frame_identity(frame: Any) -> dict[str, Any] | None:
    if frame is None:
        return None
    table = _as_frame(frame, "训练数据")
    row_hashes = pd.util.hash_pandas_object(table, index=True, categorize=True).values
    digest = hashlib.sha256()
    digest.update(row_hashes.tobytes())
    digest.update(json.dumps(list(map(str, table.columns)), ensure_ascii=False).encode("utf-8"))
    digest.update(json.dumps([str(dtype) for dtype in table.dtypes]).encode("utf-8"))
    return {"sha256": digest.hexdigest(), "rows": int(len(table)), "columns": list(map(str, table.columns))}


_SCALER_CLASSES = {
    "StandardScaler", "MinMaxScaler", "MaxAbsScaler", "RobustScaler",
    "Normalizer", "QuantileTransformer", "PowerTransformer",
}


def _serialize_scaler(scaler: Any) -> dict[str, Any] | None:
    if scaler is None:
        return None
    module = type(scaler).__module__
    name = type(scaler).__name__
    if not module.startswith("sklearn.preprocessing.") or name not in _SCALER_CLASSES:
        raise TypeError(f"不支持安全持久化标准化器 {module}.{name}")
    get_params = getattr(scaler, "get_params", None)
    params = get_params(deep=False) if callable(get_params) else {}
    learned = {
        key: value for key, value in vars(scaler).items()
        if key.endswith("_") and not key.startswith("__")
    }
    return {"module": module, "class": name, "params": _artifact_json(params), "learned": _artifact_json(learned)}


def _restore_scaler(payload: dict[str, Any] | None) -> Any:
    if payload is None:
        return None
    module_name, class_name = payload.get("module"), payload.get("class")
    if not str(module_name).startswith("sklearn.preprocessing.") or class_name not in _SCALER_CLASSES:
        raise ValueError("制品中的标准化器类型不受支持")
    from sklearn import preprocessing

    cls = getattr(preprocessing, str(class_name), None)
    if cls is None:
        raise ValueError(f"当前环境无法恢复标准化器 {class_name}")
    scaler = cls(**_artifact_value(payload.get("params") or {}))
    learned = _artifact_value(payload.get("learned") or {})
    for key, value in learned.items():
        setattr(scaler, key, value)
    return scaler


def _spec_payload(spec: ModelSpec) -> dict[str, Any]:
    return {
        "inputShape": list(spec.input_shape),
        "outputShape": list(spec.output_shape),
        "inputAxes": list(spec.input_axes),
        "outputAxes": list(spec.output_axes),
        "task": str(spec.task),
        "features": list(spec.feature_names),
        "targets": list(spec.target_names),
        "metadata": _artifact_json(dict(spec.metadata)),
    }


def _save_training_artifacts(
    env, node_type, model, metrics, history, params, *, inputs=None, training_params=None
) -> float:
    """原子提交一个唯一且不可变的模型制品，失败时让训练节点明确报错。"""
    import torch

    if env.artifacts is None:
        raise RuntimeError("当前执行面没有持久制品目录，不能将训练标记为成功")
    artifact_id = uuid.uuid4().hex
    root = env.artifacts.root
    root.mkdir(parents=True, exist_ok=True)
    pending = tempfile.mkdtemp(prefix=".pending-", dir=root)
    pending_dir = __import__("pathlib").Path(pending)
    final_dir = root / artifact_id
    committed = False
    try:
        spec = model.spec
        spec_payload = _spec_payload(spec)
        model_meta = dict(getattr(model, "metadata", {}) or {})
        definition = (inputs or {}).get("model")
        definition_source = getattr(definition, "source", None)
        training_code = (training_params or {}).get("code")
        training_node_params = dict(training_params or {})
        model_node_params = dict(params or {})
        data_identity = {
            name: _frame_identity((inputs or {}).get(name))
            for name in ("train", "val", "test")
            if (inputs or {}).get(name) is not None
        }
        adapter = str(model_meta.get("adapter") or node_type)
        implementation = {
            "adapter": adapter,
            "sha256": _function_sha256(
                {"train.mlp": op_train_mlp, "train.cnn1d": op_train_cnn1d,
                 "train.custom": _op_train_custom_impl, "train.function": op_train_function}[node_type]
            ),
        }
        created_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        weights_tmp = pending_dir / "model.pt"
        state = {key: tensor.detach().cpu().clone() for key, tensor in model.state_dict().items()}
        torch.save(state, weights_tmp)
        with open(weights_tmp, "rb+") as stream:
            stream.flush()
            os.fsync(stream.fileno())
        weights_hash = _sha256_file(weights_tmp)

        # 校验 state_dict 可安全读取，且严格匹配刚训练出的结构。
        loaded = torch.load(weights_tmp, map_location="cpu", weights_only=True)
        model.module.load_state_dict(loaded, strict=True)

        manifest = {
            "schemaVersion": 1,
            "artifactId": artifact_id,
            "nodeType": node_type,
            "fingerprint": str(env.fingerprint or ""),
            "createdAt": created_at,
            "modelImplementation": implementation,
            "modelDefinition": {
                "nodeId": getattr(definition, "node_id", None),
                "sha256": _source_sha256(definition_source),
            } if definition is not None else None,
            "trainingFunction": {
                "sha256": _source_sha256(training_code),
                "nodeId": getattr(env, "node_id", None),
            } if node_type == "train.function" else None,
            "modelParameters": _artifact_json(model_meta.get("modelParams", {})),
            "trainingNodeParameters": _artifact_json(training_node_params),
            "trainingCallParameters": _artifact_json(model_node_params),
            "modelMetadata": _artifact_json(model_meta),
            "modelSpec": spec_payload,
            "featureOrder": list(model.feature_names or spec.feature_names),
            "targetOrder": list(model.target_names or spec.target_names),
            "classes": _artifact_json(model.classes),
            "center": _artifact_json(model.center),
            "scale": _artifact_json(model.scale),
            "scaler": _serialize_scaler(model.scaler),
            "dataIdentity": data_identity,
            "metrics": _artifact_json(metrics),
            "history": _artifact_json(history.to_dict(orient="records")),
            "environment": _environment_facts(),
            "stateDict": {"file": "model.pt", "sha256": weights_hash, "bytes": weights_tmp.stat().st_size},
        }
        manifest_tmp = pending_dir / "meta.json"
        encoded = json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
        # 在提交目录前解析回读，确保待原子发布的清单结构完整。
        checked_manifest = json.loads(encoded.decode("utf-8"))
        if checked_manifest.get("artifactId") != artifact_id or checked_manifest.get("stateDict", {}).get("sha256") != weights_hash:
            raise ValueError("模型制品清单回读校验不一致")
        with open(manifest_tmp, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        manifest_hash = hashlib.sha256(encoded).hexdigest()

        # 目录名唯一，目标不存在；同卷 rename 是提交点。清理临时目录不影响旧制品。
        os.replace(pending_dir, final_dir)
        committed = True
        weights = final_dir / "model.pt"
        manifest_path = final_dir / "meta.json"
        env.record_artifact("model", weights, artifact_id, weights_hash, created_at)
        env.record_artifact("meta", manifest_path, artifact_id, manifest_hash, created_at)
        model.metadata.update({"artifactId": artifact_id, "artifactManifestSha256": manifest_hash})
        return 1.0
    except Exception as err:
        raise RuntimeError(f"模型制品未能安全保存；训练结果未登记为成功：{type(err).__name__}: {err}") from err
    finally:
        if not committed and pending_dir.exists():
            import shutil
            shutil.rmtree(pending_dir, ignore_errors=True)


def _legacy_param_number(params: Mapping[str, Any], key: str, fallback: int) -> int:
    """读取旧制品里以字符串保存的训练参数；旧文件只用于恢复，不参与新制品写入。"""
    try:
        value = int(float(params.get(key, fallback)))
    except (TypeError, ValueError):
        return int(fallback)
    return value if value > 0 else int(fallback)


def _load_legacy_checkpoint(path):
    """以受限白名单读取旧版包装式 checkpoint。

    旧版 `torch.save` 把 StandardScaler 一起包进了 `model.pt`。新版
    PyTorch 的 `weights_only=True` 默认不允许 sklearn / NumPy 对象，
    但恢复只需要其中的 state_dict。这里显式允许旧格式实际使用的
    StandardScaler 与 NumPy 容器，不退回到会执行任意 pickle 的不安全模式。
    """
    import torch
    from numpy.core.multiarray import _reconstruct, scalar
    from sklearn.preprocessing import StandardScaler
    from torch.serialization import safe_globals

    allowed = [
        StandardScaler,
        _reconstruct,
        scalar,
        np.ndarray,
        np.dtype,
    ]
    numpy_dtypes = getattr(np, "dtypes", None)
    for name in ("ObjectDType", "Float64DType"):
        dtype = getattr(numpy_dtypes, name, None) if numpy_dtypes is not None else None
        if dtype is not None:
            allowed.append(dtype)

    with safe_globals(allowed):
        return torch.load(path, map_location="cpu", weights_only=True)


def _restore_legacy_training_artifact(env, payload, inputs, directory, manifest):
    """恢复早期短哈希目录中的 `train.function` 制品。

    旧版本只保存了训练指纹、模型规格、指标/曲线和一个包着 `state_dict` 的
    `model.pt`，没有新版的模型定义哈希与输入身份明细。这里仍要求工程传入的
    指纹逐字相等，并用当前工程里的模型定义严格重建网络；不做目录扫描或模糊挑选。
    新训练不会再走这条路径。
    """
    import torch

    artifact_id = str(payload.get("restoreArtifactId") or "")
    expected_fingerprint = str(payload.get("fingerprint") or "")
    node_type = str(payload.get("nodeType") or "")
    if manifest.get("nodeType") != node_type:
        raise ValueError(f"旧模型制品 {artifact_id} 的训练节点类型不兼容；请重新定位制品或重新训练")
    if manifest.get("fingerprint") != expected_fingerprint:
        raise ValueError(f"旧模型制品 {artifact_id} 与当前训练指纹不匹配；请重新定位制品或重新训练")
    if node_type != "train.function":
        raise ValueError(
            f"旧模型制品 {artifact_id} 缺少新版恢复元数据；当前只兼容自定义训练函数，请重新训练"
        )

    definition = inputs.get("model")
    if not isinstance(definition, CustomModelDefinition):
        raise ValueError(f"旧模型制品 {artifact_id} 缺少当前模型定义；请重新定位制品或重新训练")

    spec_data = manifest.get("modelSpec") or {}
    try:
        task = str(spec_data["task"])
        if task not in {"classification", "regression"}:
            raise ValueError("未知任务")
        input_shape = tuple(int(value) for value in spec_data["inputShape"])
        output_shape = tuple(int(value) for value in spec_data["outputShape"])
        spec = ModelSpec(
            input_shape=input_shape,
            output_shape=output_shape,
            input_axes=tuple(str(value) for value in spec_data.get("inputAxes", [])) or _axes_for_shape(input_shape, output=False),
            output_axes=tuple(str(value) for value in spec_data.get("outputAxes", [])) or _axes_for_shape(output_shape, output=True),
            task=task,
            feature_names=tuple(str(value) for value in spec_data.get("features", [])),
            target_names=tuple(str(value) for value in spec_data.get("targets", [])),
            metadata={},
        )
    except (KeyError, TypeError, ValueError) as err:
        raise ValueError(f"旧模型制品 {artifact_id} 的模型规格不完整；请重新定位制品或重新训练") from err

    legacy_params = manifest.get("params")
    if not isinstance(legacy_params, Mapping):
        legacy_params = {}
    metadata = {
        "adapter": "training-function",
        "dataProtocol": "raw-tables",
        "modelDefinitionNodeId": definition.node_id,
        "modelParams": dict(resolve_model_params(tuple(definition.parameter_specs), definition.parameter_values)),
        "inputShape": list(spec.input_shape),
        "outputShape": list(spec.output_shape),
        "inputMode": "sequence",
        "window": int(spec.input_shape[0]) if spec.input_shape else _legacy_param_number(legacy_params, "past_n", 60),
        "horizon": _legacy_param_number(legacy_params, "future_n", 1),
        "stride": _legacy_param_number(legacy_params, "stride", 1),
        "segmentColumn": "工作段编号",
    }

    namespace = dict(definition.namespace)
    model_params = resolve_model_params(tuple(definition.parameter_specs), definition.parameter_values)
    build = namespace.get("build_model")
    model_class = _custom_model_class(namespace)
    if callable(build):
        module = build(spec, dict(model_params))
    elif model_class is not None:
        module = _build_model_class(model_class, spec, model_params)
    else:
        raise ValueError(f"旧模型制品 {artifact_id} 无法按当前模型定义重建模型；请重新训练")
    if not hasattr(module, "load_state_dict"):
        raise ValueError(f"旧模型制品 {artifact_id} 重建结果不是可加载模型；请重新训练")

    weights_path = directory / "model.pt"
    try:
        raw_state = _load_legacy_checkpoint(weights_path)
        state = raw_state.get("state_dict") if isinstance(raw_state, Mapping) else raw_state
        if not isinstance(state, Mapping):
            raise TypeError("旧 model.pt 中没有 state_dict")
        module.load_state_dict(state, strict=True)
    except Exception as err:
        raise ValueError(f"旧模型制品 {artifact_id} 无法安全读取或与当前模型结构不兼容；请重新定位制品或重新训练") from err

    module.eval()
    metadata["artifactId"] = artifact_id
    metadata["artifactManifestSha256"] = _sha256_file(directory / "meta.json")
    bundle = ModelBundle(
        module=module,
        node_type=node_type,
        task=spec.task,
        spec=spec,
        plugin=namespace,
        feature_names=tuple(spec.feature_names),
        target_names=tuple(spec.target_names),
        # 旧制品没有序列化 scaler；当前工程的上游 scaler 仍在输入端，优先复用它。
        scaler=inputs.get("scaler") or (
            raw_state.get("scaler") if isinstance(raw_state, Mapping) else None
        ),
        metadata=metadata,
    )
    history = pd.DataFrame(manifest.get("history") or [])
    metrics = _artifact_value(manifest.get("metrics") or {})
    expected_fingerprint = expected_fingerprint or None
    weights_hash = _sha256_file(weights_path)
    created_at = manifest.get("createdAt")
    env.artifacts.record("model", weights_path, expected_fingerprint, artifact_id, weights_hash, created_at)
    env.artifacts.record(
        "meta", directory / "meta.json", expected_fingerprint, artifact_id,
        metadata["artifactManifestSha256"], created_at,
    )
    env.set_meta({"模型制品": artifact_id, "恢复": "从旧版磁盘制品恢复"})
    return {"model": bundle, "metrics": metrics, "history": history, "curve": _curve_table(history)}


def restore_training_artifact(env, payload, inputs, artifact_dir):
    """校验工程引用并从 state_dict 重建训练输出；任何不匹配都显式失败。"""
    import torch

    artifact_id = str(payload.get("restoreArtifactId") or "")
    expected_fingerprint = str(payload.get("fingerprint") or "")
    expected_manifest_hash = str(payload.get("restoreArtifactSha256") or "")
    # 新制品使用 32 位 UUID；16 位目录名是早期版本按指纹短哈希保存的旧制品，
    # 只有工程显式引用它时才进入下面的兼容恢复路径。
    if not re.fullmatch(r"(?:[a-f0-9]{16}|[a-f0-9]{32})", artifact_id):
        raise ValueError("工程里的模型制品编号无效；请重新定位制品或重新训练")
    if not expected_fingerprint:
        raise ValueError("工程里的模型训练指纹缺失；请重新定位制品或重新训练")
    if not re.fullmatch(r"[a-f0-9]{64}", expected_manifest_hash):
        raise ValueError("工程里的模型制品清单校验值缺失或无效；请重新定位制品或重新训练")
    directory = __import__("pathlib").Path(artifact_dir).resolve()
    manifest_path = (directory / "meta.json").resolve()
    weights_path = (directory / "model.pt").resolve()
    if directory.parent != __import__("pathlib").Path(env.artifacts.root).resolve():
        raise ValueError("模型制品路径越出本机 .artifacts 目录；请重新定位制品或重新训练")
    if not manifest_path.is_file() or not weights_path.is_file():
        raise FileNotFoundError(f"模型制品 {artifact_id} 缺少 meta.json 或 model.pt；请重新定位制品或重新训练")
    actual_manifest_hash = _sha256_file(manifest_path)
    if actual_manifest_hash != expected_manifest_hash:
        raise ValueError(f"模型制品 {artifact_id} 的 meta.json 校验失败；请重新定位制品或重新训练")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        raise ValueError(f"模型制品 {artifact_id} 的 meta.json 已损坏；请重新定位制品或重新训练") from err
    if manifest.get("schemaVersion") is None and "artifactId" not in manifest:
        return _restore_legacy_training_artifact(env, payload, inputs, directory, manifest)
    if manifest.get("schemaVersion") != 1 or manifest.get("artifactId") != artifact_id:
        raise ValueError(f"模型制品 {artifact_id} 身份或版本不匹配；请重新定位制品或重新训练")
    if manifest.get("fingerprint") != expected_fingerprint:
        raise ValueError(f"模型制品 {artifact_id} 与当前训练指纹不匹配；请重新定位制品或重新训练")
    node_type = str(payload.get("nodeType") or "")
    if manifest.get("nodeType") != node_type:
        raise ValueError(f"模型制品 {artifact_id} 的训练节点类型不兼容；请重新定位制品或重新训练")
    if _artifact_json(payload.get("params") or {}) != manifest.get("trainingNodeParameters"):
        raise ValueError(f"模型制品 {artifact_id} 的训练参数与工程当前设置不一致；请重新定位制品或重新训练")
    for name, expected in (manifest.get("dataIdentity") or {}).items():
        if _frame_identity(inputs.get(name)) != expected:
            raise ValueError(f"模型制品 {artifact_id} 的 {name} 数据与当前工程不一致；请重新定位制品或重新训练")

    spec_data = manifest.get("modelSpec") or {}
    try:
        task = str(spec_data["task"])
        if task not in {"classification", "regression"}:
            raise ValueError("未知任务")
        spec = ModelSpec(
            input_shape=tuple(int(value) for value in spec_data["inputShape"]),
            output_shape=tuple(int(value) for value in spec_data["outputShape"]),
            input_axes=tuple(str(value) for value in spec_data["inputAxes"]),
            output_axes=tuple(str(value) for value in spec_data["outputAxes"]),
            task=task,
            feature_names=tuple(str(value) for value in spec_data.get("features", [])),
            target_names=tuple(str(value) for value in spec_data.get("targets", [])),
            metadata=_artifact_value(spec_data.get("metadata") or {}),
        )
    except (KeyError, TypeError, ValueError) as err:
        raise ValueError(f"模型制品 {artifact_id} 的模型规格不完整；请重新定位制品或重新训练") from err

    saved_node_params = manifest.get("trainingNodeParameters") or {}
    model_params = _artifact_value(manifest.get("modelParameters") or {})
    definition = inputs.get("model")
    if node_type in {"train.custom", "train.function"}:
        if not isinstance(definition, CustomModelDefinition):
            raise ValueError(f"模型制品 {artifact_id} 缺少当前模型定义；请重新定位制品或重新训练")
        saved_definition = manifest.get("modelDefinition") or {}
        if saved_definition.get("sha256") != _source_sha256(definition.source):
            raise ValueError(f"模型制品 {artifact_id} 的模型定义已变化；请重新定位制品或重新训练")
        resolved = resolve_model_params(tuple(definition.parameter_specs), definition.parameter_values)
        if _artifact_json(resolved) != manifest.get("modelParameters"):
            raise ValueError(f"模型制品 {artifact_id} 的模型参数已变化；请重新定位制品或重新训练")
        namespace = dict(definition.namespace)
        build = namespace.get("build_model")
        model_class = _custom_model_class(namespace)
        if callable(build):
            module = build(spec, model_params)
        elif model_class is not None:
            module = _build_model_class(model_class, spec, model_params)
        else:
            raise ValueError(f"模型制品 {artifact_id} 无法按当前定义重建模型；请重新定位制品或重新训练")
        plugin = namespace
        metadata = _artifact_value(manifest.get("modelMetadata") or {})
        if node_type == "train.function":
            training_code = saved_node_params.get("code")
            saved_fn = manifest.get("trainingFunction") or {}
            if saved_fn.get("sha256") != _source_sha256(training_code):
                raise ValueError(f"模型制品 {artifact_id} 的训练函数已变化；请重新定位制品或重新训练")
    elif node_type == "train.mlp":
        if _function_sha256(op_train_mlp) != (manifest.get("modelImplementation") or {}).get("sha256"):
            raise ValueError(f"模型制品 {artifact_id} 的 MLP 实现版本不兼容；请重新定位制品或重新训练")
        from torch import nn
        input_dim = spec.input_shape[-1]
        output_dim = spec.output_shape[-1]
        hidden = max(1, int(_num(saved_node_params, "hidden", 32)))
        module = nn.Sequential(nn.Linear(input_dim, hidden), nn.ReLU(), nn.Linear(hidden, hidden),
                               nn.ReLU(), nn.Linear(hidden, output_dim))
        plugin = None
        metadata = _artifact_value(manifest.get("modelMetadata") or {})
    elif node_type == "train.cnn1d":
        if _function_sha256(op_train_cnn1d) != (manifest.get("modelImplementation") or {}).get("sha256"):
            raise ValueError(f"模型制品 {artifact_id} 的 CNN 实现版本不兼容；请重新定位制品或重新训练")
        from torch import nn
        channels, window = spec.input_shape
        hidden = max(1, int(_num(saved_node_params, "hidden", 32)))
        kernel = int(_num(saved_node_params, "kernel", 5))
        dropout = _num(saved_node_params, "dropout", 0.2)
        output_dim = spec.output_shape[-1]

        class Net(nn.Module):
            def __init__(self):
                super().__init__()
                pad = kernel // 2
                self.body = nn.Sequential(
                    nn.Conv1d(channels, hidden, kernel, padding=pad), nn.ReLU(), nn.MaxPool1d(2),
                    nn.Conv1d(hidden, hidden * 2, kernel, padding=pad), nn.ReLU(), nn.AdaptiveAvgPool1d(1),
                )
                self.head = nn.Sequential(nn.Flatten(), nn.Dropout(dropout), nn.Linear(hidden * 2, output_dim))

            def forward(self, value):
                return self.head(self.body(value))

        module = Net()
        plugin = None
        metadata = _artifact_value(manifest.get("modelMetadata") or {})
    else:
        raise ValueError(f"模型制品 {artifact_id} 的节点类型不受支持；请重新定位制品或重新训练")

    if not hasattr(module, "load_state_dict"):
        raise ValueError(f"模型制品 {artifact_id} 重建结果不是可加载模型；请重新定位制品或重新训练")
    state_info = manifest.get("stateDict") or {}
    if state_info.get("file") != "model.pt" or _sha256_file(weights_path) != state_info.get("sha256"):
        raise ValueError(f"模型制品 {artifact_id} 的权重校验失败；请重新定位制品或重新训练")
    try:
        state = torch.load(weights_path, map_location="cpu", weights_only=True)
        module.load_state_dict(state, strict=True)
    except Exception as err:
        raise ValueError(f"模型制品 {artifact_id} 与当前模型结构不兼容；请重新定位制品或重新训练") from err
    module.eval()
    classes = _artifact_value(manifest.get("classes"))
    if isinstance(classes, dict):
        classes = np.asarray(classes)
    elif isinstance(classes, list):
        classes = np.asarray(classes)
    center = _artifact_value(manifest.get("center"))
    scale = _artifact_value(manifest.get("scale"))
    scaler = _restore_scaler(manifest.get("scaler"))
    metadata = dict(metadata)
    metadata["artifactId"] = artifact_id
    metadata["artifactManifestSha256"] = actual_manifest_hash
    bundle = ModelBundle(
        module=module,
        node_type=node_type,
        task=spec.task,
        spec=spec,
        plugin=plugin,
        feature_names=tuple(manifest.get("featureOrder") or spec.feature_names),
        target_names=tuple(manifest.get("targetOrder") or spec.target_names),
        classes=classes,
        center=center,
        scale=scale,
        scaler=scaler,
        metadata=metadata,
    )
    history = pd.DataFrame(manifest.get("history") or [])
    metrics = _artifact_value(manifest.get("metrics") or {})
    env.artifacts.record("model", weights_path, expected_fingerprint, artifact_id,
                         state_info.get("sha256"), manifest.get("createdAt"))
    env.artifacts.record("meta", manifest_path, expected_fingerprint, artifact_id,
                         actual_manifest_hash, manifest.get("createdAt"))
    env.set_meta({"模型制品": artifact_id, "恢复": "从磁盘制品恢复", **(manifest.get("environment") or {})})
    return {"model": bundle, "metrics": metrics, "history": history, "curve": _curve_table(history)}


def _curve_table(history: pd.DataFrame) -> pd.DataFrame:
    """逐轮曲线 → **长表**（轮次 / 曲线 / 值）。

    为什么要摊成长表：界面画图的口径是"X 一列、Y 一列、颜色分组"（见 `chartFromTable`），
    宽表要另写一套多序列逻辑。摊开之后它和一张普通的折线图输入没有区别 ——
    于是"训练曲线直出"不需要在界面侧另开一条画图路径。
    """
    empty = pd.DataFrame({"轮次": [], "曲线": [], "值": []})
    if "轮次" not in history.columns:
        return empty
    frames = [
        pd.DataFrame({"轮次": history["轮次"], "曲线": str(name), "值": history[name]})
        for name in history.columns
        if name != "轮次"
    ]
    return pd.concat(frames, ignore_index=True) if frames else empty


# ---------------------------------------------------------------------------
# 通用 PyTorch 训练接口
# ---------------------------------------------------------------------------


def _names(value: Any) -> list[str]:
    """把界面里的列名输入转成列表，兼容中文逗号、分号和换行。"""

    return [part.strip() for part in re.split(r"[,，;；\n]", str(value or "")) if part.strip()]


_TIME_COLUMN_ALIASES = {
    "time", "timestamp", "datetime", "date", "时间", "时间戳", "时间列", "时间轴", "时刻", "日期",
    "采样时间", "采集时间",
}
_SEGMENT_COLUMN_ALIASES = {
    "segment", "segmentid", "segmentno", "工作段", "工作段id", "工作段号", "工作段编号", "工段编号",
}


def _column_alias_key(value: Any) -> str:
    return re.sub(r"[\s_-]+", "", str(value).strip().casefold())


def _numeric_signal_columns(frame: pd.DataFrame, time_columns=()) -> list[Any]:
    """返回可按序号选取的数值信号列，不把时间或工作段编号当通道。"""

    registered_time = {str(name) for name in (time_columns or ())}
    time_aliases = {_column_alias_key(name) for name in _TIME_COLUMN_ALIASES}
    segment_aliases = {_column_alias_key(name) for name in _SEGMENT_COLUMN_ALIASES}
    columns = []
    for column in frame.columns:
        name = str(column)
        alias = _column_alias_key(name)
        if name in registered_time or alias in time_aliases or alias in segment_aliases:
            continue
        if pd.api.types.is_numeric_dtype(frame[column].dtype):
            columns.append(column)
    return columns


def _resolve_column_selection(frame: pd.DataFrame, value: Any, what: str, role: str, time_columns=()) -> list[Any]:
    """把列名或 1 起始数值通道序号解析为真实 DataFrame 列名。"""

    tokens = _names(value)
    if not tokens:
        return []
    columns_by_name = {str(column): column for column in frame.columns}
    candidates = _numeric_signal_columns(frame, time_columns)
    resolved = []
    for token in tokens:
        # 明确列名优先，因而名称本身为数字的列仍可用字面值选择。
        if token in columns_by_name:
            resolved.append(columns_by_name[token])
            continue
        if token.isdecimal():
            index = int(token)
            if index < 1 or index > len(candidates):
                mapping = "、".join(f"{i}={name}" for i, name in enumerate(candidates, 1)) or "无"
                raise KeyError(
                    f"{what}的{role}序号「{token}」超出范围；可用数值通道（序号=列名）：{mapping}"
                )
            resolved.append(candidates[index - 1])
            continue
        available = "、".join(str(column) for column in frame.columns)
        mapping = "、".join(f"{i}={name}" for i, name in enumerate(candidates, 1)) or "无"
        raise KeyError(
            f"{what}里没有{role}列「{token}」。可填写现有列名（{available}）或数值通道序号（{mapping}）"
        )
    return resolved


def _task_name(value: Any, fallback: str = "回归") -> str:
    text = str(value or fallback).strip().lower()
    if text in ("分类", "classification", "classify"):
        return "分类"
    if text in ("回归", "regression", "regress"):
        return "回归"
    if text == "auto":
        return "auto"
    raise ValueError(f"不认识的训练任务「{value}」，可选：auto、分类、回归")


def _is_classification(task: Any) -> bool:
    return str(task).strip().lower() in ("分类", "classification", "classify")


def _call_with_optional_spec(fn, first, second, spec):
    """兼容 loss_fn(pred, target) 与 loss_fn(pred, target, spec)。"""

    try:
        parameters = list(inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return fn(first, second, spec)
    positional = [
        p
        for p in parameters
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    if any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in parameters) or len(positional) >= 3:
        return fn(first, second, spec)
    return fn(first, second)


def _call_dataset_factory(factory, frame, split, params, scaler):
    """调用用户 Dataset 工厂，同时兼容可选的 scaler 参数。"""

    try:
        names = inspect.signature(factory).parameters
    except (TypeError, ValueError):
        names = {}
    if "scaler" in names:
        return factory(frame, split, params, scaler=scaler)
    return factory(frame, split, params)


def _call_data_hook(factory, frame, split, params, scaler):
    """调用从原始分表构建数据对象的用户 hook。"""

    try:
        names = inspect.signature(factory).parameters
    except (TypeError, ValueError):
        names = {}
    if "scaler" in names:
        return factory(frame, split, params, scaler=scaler)
    return factory(frame, split, params)


def _shape_tuple(value: Any, name: str) -> tuple[int, ...]:
    """把用户 spec 中的形状转成不含 batch 维的整数元组。"""

    if isinstance(value, int):
        value = (value,)
    if not isinstance(value, (tuple, list)) or not value:
        raise ValueError(f"自定义 make_spec 必须提供非空 {name}，例如 (通道数, 窗长)")
    try:
        shape = tuple(int(item) for item in value)
    except (TypeError, ValueError) as err:
        raise ValueError(f"自定义 make_spec 的 {name} 必须是整数元组") from err
    if any(item <= 0 for item in shape):
        raise ValueError(f"自定义 make_spec 的 {name} 每一维都必须大于 0")
    return shape


def _custom_spec_from_hook(result, default_task: str, params, frame) -> ModelSpec:
    """把 make_spec 返回的 ModelSpec 或字典规范化。"""

    if isinstance(result, ModelSpec):
        return result
    if not isinstance(result, Mapping):
        raise TypeError("make_spec(data, split, params) 必须返回 ModelSpec 或字典")

    input_shape = _shape_tuple(result.get("input_shape", result.get("inputShape")), "input_shape")
    output_shape = _shape_tuple(result.get("output_shape", result.get("outputShape")), "output_shape")
    task = _task_name(result.get("task", default_task), default_task)
    if task == "auto":
        task = default_task
    task_code = "classification" if task == "分类" else "regression"
    input_axes = tuple(str(item) for item in result.get("input_axes", result.get("inputAxes", ())))
    output_axes = tuple(str(item) for item in result.get("output_axes", result.get("outputAxes", ())))
    features = tuple(
        str(item)
        for item in (result.get("feature_names", result.get("features", ())) or _names(params.get("features")))
    )
    targets = tuple(
        str(item)
        for item in (result.get("target_names", result.get("targets", ())) or _names(params.get("label")))
    )
    metadata = dict(result.get("metadata") or {})
    metadata.setdefault("trainColumns", [str(column) for column in frame.columns])
    return ModelSpec(
        input_shape=input_shape,
        output_shape=output_shape,
        input_axes=input_axes or _axes_for_shape(input_shape, output=False),
        output_axes=output_axes or _axes_for_shape(output_shape, output=True),
        task=task_code,
        feature_names=features,
        target_names=targets,
        metadata=metadata,
    )


def _custom_spec_from_dataset(dataset, task: str, feature_names, target_names, classes, frame) -> ModelSpec:
    """仅在用户没有提供 make_spec 时，从兼容 Dataset 的首个样本推断形状。"""

    sample_x, sample_y = _batch_xy(dataset[0])
    if sample_y is None:
        raise ValueError(
            "自定义 Dataset 的 batch 结构无法自动推断标签。请实现 make_spec(data, split, params, scaler)，"
            "并在 train_step / validation_step 中自行解析 batch。"
        )
    try:
        input_shape = tuple(int(value) for value in np.asarray(sample_x).shape)
        target_shape = tuple(int(value) for value in np.asarray(sample_y).shape) or (1,)
    except (TypeError, ValueError) as err:
        raise ValueError(
            "无法从自定义 Dataset 的样本推断输入输出形状；请实现 make_spec(data, split, params, scaler)"
        ) from err
    if not input_shape:
        input_shape = (1,)
    output_shape = (int(len(classes)),) if task == "分类" and classes is not None else target_shape
    return ModelSpec(
        input_shape=input_shape,
        output_shape=output_shape,
        input_axes=_axes_for_shape(input_shape, output=False),
        output_axes=_axes_for_shape(output_shape, output=True),
        task="classification" if task == "分类" else "regression",
        feature_names=tuple(feature_names),
        target_names=tuple(target_names),
        metadata={
            "trainRows": int(len(dataset)),
            "trainColumns": [str(column) for column in frame.columns],
            "targetShape": list(target_shape),
            "classCount": int(len(classes)) if classes is not None else None,
            "split": "train",
        },
    )


def _input_mode(value: Any) -> str:
    """规范化训练节点的数据布局；默认保持旧工程的逐行表格语义。"""

    text = str(value or "表格").strip().lower()
    if text in {"表格", "table", "tabular", "row"}:
        return "table"
    if text in {"时序", "时序窗口", "sequence", "window", "temporal"}:
        return "sequence"
    raise ValueError(f"不认识的输入模式「{value}」，可选：表格、时序窗口")


def _default_columns(
    frame: pd.DataFrame,
    params: dict[str, Any],
    what: str,
    *,
    require_target: bool,
    time_columns=(),
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """解析默认 Dataset 使用的特征列与标签列。"""

    raw_labels = _names(params.get("label"))
    if require_target and not raw_labels:
        raise ValueError(f"{what}需要指定标签列")
    try:
        labels = _resolve_column_selection(frame, params.get("label"), what, "标签", time_columns)
    except KeyError:
        if require_target:
            raise
        labels = []

    features = _resolve_column_selection(frame, params.get("features"), what, "特征", time_columns)
    if not features:
        features = [column for column in _numeric_signal_columns(frame, time_columns) if column not in labels]
    if not features:
        raise ValueError(f"{what}里没有可用的数值特征列")
    return tuple(features), tuple(labels)


def _feature_matrix(frame: pd.DataFrame, features: tuple[str, ...], scaler) -> np.ndarray:
    """按训练时的列序取 float32 特征，并应用可选的训练集标准化器。"""

    x = np.asarray(frame[list(features)], dtype=np.float32)
    if scaler is None:
        return x

    transform = getattr(scaler, "transform", None)
    if not callable(transform):
        raise TypeError(
            "标准化器必须提供 transform(X)；如果模型代码自己处理标准化，"
            "可以不连接标准化器输入"
        )
    expected = getattr(scaler, "feature_names_in_", None)
    if expected is not None:
        expected_names = [str(name) for name in np.asarray(expected).reshape(-1).tolist()]
        if expected_names != list(features):
            raise ValueError(
                "标准化器拟合的特征列与训练节点的特征列顺序/数量不一致："
                f"标准化器是 {expected_names}，当前是 {list(features)}"
            )
    transformed = np.asarray(transform(x), dtype=np.float32)
    if transformed.shape != x.shape:
        raise ValueError(
            f"标准化器 transform 输出形状 {transformed.shape} 与特征形状 {x.shape} 不一致"
        )
    return transformed


def _encoded_targets(y_raw, labels: tuple[str, ...], task: str, classes=None):
    """把标签转换为训练 Tensor；验证集复用训练集的类别顺序。"""

    if y_raw is None:
        return None, classes
    if task != "分类":
        y = np.asarray(y_raw, dtype=np.float32)
        return (y[:, 0] if len(labels) == 1 else y), classes
    if len(labels) != 1:
        raise ValueError("默认分类 Dataset 只支持一个标签列；多输出分类请自定义 make_dataset")

    values = np.asarray(y_raw)[:, 0]
    if classes is None:
        classes, encoded = np.unique(values, return_inverse=True)
        return encoded.astype(np.int64), classes
    class_values = np.asarray(classes)
    index = {value: position for position, value in enumerate(class_values.tolist())}
    unknown = [value for value in np.unique(values).tolist() if value not in index]
    if unknown:
        raise ValueError(f"数据中出现训练集未见过的类别：{unknown}")
    encoded = np.asarray([index[value] for value in values.tolist()], dtype=np.int64)
    return encoded, class_values


def _default_tabular_dataset(
    frame: pd.DataFrame,
    params: dict[str, Any],
    task: str,
    what: str,
    *,
    scaler=None,
    require_target: bool = True,
    classes=None,
    time_columns=(),
):
    """没有自定义 Dataset 时，为普通表格提供一个安全的默认 Dataset。"""

    import torch
    from torch.utils.data import TensorDataset

    features, labels = _default_columns(
        frame, params, what, require_target=require_target, time_columns=time_columns
    )
    x = _feature_matrix(frame, features, scaler)
    valid = np.isfinite(x).all(axis=1)
    y_raw = frame[list(labels)].to_numpy() if labels else None
    if y_raw is not None:
        valid &= pd.notna(y_raw).all(axis=1)
    if not valid.any():
        raise ValueError(f"{what}里没有一行是完整的（特征与标签都不能有缺失值）")
    x = x[valid]
    if y_raw is not None:
        y_raw = y_raw[valid]
    y, classes = _encoded_targets(y_raw, labels, task, classes)

    tensors = (torch.from_numpy(x),) if y is None else (torch.from_numpy(x), torch.from_numpy(y))
    return (
        TensorDataset(*tensors),
        tuple(features),
        tuple(labels),
        classes,
        valid,
    )


def _default_sequence_dataset(
    frame: pd.DataFrame,
    params: dict[str, Any],
    task: str,
    what: str,
    *,
    scaler=None,
    require_target: bool = True,
    classes=None,
    time_columns=(),
):
    """把一份已经划分好的长表转换成滑动时序样本。"""

    import torch
    from torch.utils.data import TensorDataset

    features, labels = _default_columns(
        frame, params, what, require_target=require_target, time_columns=time_columns
    )
    window = max(1, int(_num(params, "window", 48)))
    horizon = max(1, int(_num(params, "horizon", 1)))
    stride = max(1, int(_num(params, "stride", 1)))
    x_rows = _feature_matrix(frame, features, scaler)
    y_rows = frame[list(labels)].to_numpy() if labels else None
    feature_valid = np.isfinite(x_rows).all(axis=1)
    target_valid = (
        pd.notna(y_rows).all(axis=1)
        if y_rows is not None
        else np.ones(len(frame), dtype=bool)
    )

    last_start = len(frame) - window - horizon
    starts = np.arange(0, max(0, last_start + 1), stride, dtype=np.int64)
    target_rows = starts + window + horizon - 1
    keep = np.asarray(
        [feature_valid[start : start + window].all() and target_valid[target]
         for start, target in zip(starts, target_rows)],
        dtype=bool,
    )
    starts = starts[keep]
    target_rows = target_rows[keep]

    if len(starts) > 0:
        x = np.stack([x_rows[start : start + window] for start in starts]).astype(np.float32)
    else:
        x = np.empty((0, window, len(features)), dtype=np.float32)
    y_raw = y_rows[target_rows] if y_rows is not None else None
    y, classes = _encoded_targets(y_raw, labels, task, classes)
    tensors = (torch.from_numpy(x),) if y is None else (torch.from_numpy(x), torch.from_numpy(y))
    return TensorDataset(*tensors), features, labels, classes, target_rows


def _custom_dataset(
    namespace,
    frame,
    split,
    params,
    scaler,
    task,
    what,
    *,
    time_columns=(),
    require_target: bool = True,
    classes=None,
):
    factory = namespace.get("make_dataset")
    if callable(factory):
        dataset = _call_dataset_factory(factory, frame, split, params, scaler)
        if dataset is None or not hasattr(dataset, "__getitem__") or not hasattr(dataset, "__len__"):
            raise TypeError(
                "make_dataset(data, split, params) 必须返回 torch.utils.data.Dataset，"
                "不能直接返回 DataLoader"
            )
        return dataset, (), tuple(_names(params.get("label"))), None, None
    if _input_mode(params.get("inputMode")) == "sequence":
        return _default_sequence_dataset(
            frame,
            params,
            task,
            what,
            scaler=scaler,
            require_target=require_target,
            classes=classes,
            time_columns=time_columns,
        )
    return _default_tabular_dataset(
        frame,
        params,
        task,
        what,
        scaler=scaler,
        require_target=require_target,
        classes=classes,
        time_columns=time_columns,
    )


def _make_dataloader(namespace, dataset, split, params, seed):
    """兼容入口：由 Dataset 创建 DataLoader；特殊模型可覆盖 make_dataloader。"""

    import torch
    from torch.utils.data import DataLoader

    config = _loader_config(params, split, seed)
    factory = namespace.get("make_dataloader")
    if callable(factory):
        loader = factory(dataset, split, config)
    else:
        generator = torch.Generator()
        generator.manual_seed(config.seed + (0 if split == "train" else 1))
        loader = DataLoader(
            dataset,
            batch_size=config.batch_size,
            shuffle=config.shuffle,
            generator=generator,
            num_workers=config.num_workers,
            drop_last=config.drop_last,
        )
    if not hasattr(loader, "__iter__"):
        raise TypeError("make_dataloader(dataset, split, config) 必须返回可迭代的 DataLoader")
    return loader, config


def _loader_config(params, split: str, seed: int) -> LoaderConfig:
    """生成传给默认或兼容 DataLoader 工厂的稳定配置。"""

    return LoaderConfig(
        batch_size=max(1, int(_num(params, "batch", 64))),
        shuffle=split == "train",
        seed=int(seed),
        num_workers=max(0, int(_num(params, "numWorkers", 0))),
        drop_last=_bool_param(params, "dropLast", False),
    )


def _build_direct_dataloader(namespace, frame, split, params, scaler, seed):
    """调用推荐的 build_dataloader(data, split, params, scaler) 入口。"""

    factory = namespace.get("build_dataloader")
    if not callable(factory):
        return None, _loader_config(params, split, seed)
    if frame is None:
        return None, _loader_config(params, split, seed)
    loader = _call_data_hook(factory, frame, split, params, scaler)
    if not hasattr(loader, "__iter__"):
        raise TypeError("build_dataloader(data, split, params, scaler) 必须返回可迭代的 DataLoader")
    return loader, _loader_config(params, split, seed)


def _batch_xy(batch):
    """训练 batch 的最小格式：(x, y)，也支持 {'x': ..., 'y': ...}。"""

    if isinstance(batch, dict):
        return batch.get("x", batch.get("features")), batch.get("y", batch.get("target"))
    if isinstance(batch, (tuple, list)):
        if len(batch) >= 2:
            return batch[0], batch[1]
        if len(batch) == 1:
            return batch[0], None
    return batch, None


def _to_device(value, device, *, target: bool, task: str):
    import torch

    tensor = value if isinstance(value, torch.Tensor) else torch.as_tensor(value)
    tensor = tensor.to(device)
    if target:
        return tensor.long() if _is_classification(task) else tensor.float()
    return tensor.float()


def _scalar_loss(loss, what: str):
    import torch

    if not isinstance(loss, torch.Tensor):
        loss = torch.as_tensor(loss, dtype=torch.float32)
    if loss.ndim != 0:
        loss = loss.mean()
    if not torch.isfinite(loss):
        raise ValueError(f"{what}产生了 NaN 或 Inf 损失")
    return loss


def _loader_rows(loader) -> int:
    try:
        return int(len(loader.dataset))
    except (AttributeError, TypeError, ValueError, NotImplementedError):
        return 0


def _batch_size(value: Any) -> int:
    """尽量从任意 batch / 用户结果中取得样本数，用户也可显式返回 batch_size。"""

    import torch

    if isinstance(value, torch.Tensor) or isinstance(value, np.ndarray):
        if value.ndim > 0:
            return max(1, int(value.shape[0]))
        return 1
    if isinstance(value, Mapping):
        for item in value.values():
            size = _batch_size(item)
            if size > 1:
                return size
        return 1
    if isinstance(value, (tuple, list)):
        for item in value:
            size = _batch_size(item)
            if size > 1:
                return size
        return max(1, len(value))
    return 1


def _normalise_step_result(result, what: str, batch) -> tuple[Any, int, dict[str, float], Any, Any]:
    """统一用户 step hook 的返回值。

    推荐返回 ``{"loss": loss, "batch_size": n, "metrics": {...}}``；
    训练 step 也可以直接返回 loss，验证 step 还可附带 prediction / target。
    """

    if isinstance(result, Mapping):
        if "loss" not in result:
            raise ValueError(f"{what}返回字典时必须包含 loss")
        loss = result["loss"]
        count = result.get("batch_size", result.get("size", _batch_size(batch)))
        metrics = result.get("metrics") or {}
        prediction = result.get("prediction")
        target = result.get("target")
    else:
        loss = result
        count = _batch_size(batch)
        metrics = {}
        prediction = None
        target = None
    if not isinstance(metrics, Mapping):
        raise TypeError(f"{what}返回的 metrics 必须是字典")
    try:
        count = max(1, int(count))
    except (TypeError, ValueError) as err:
        raise TypeError(f"{what}返回的 batch_size 必须是正整数") from err
    normalised_metrics: dict[str, float] = {}
    for key, value in metrics.items():
        try:
            import torch

            number = float(value.detach().cpu()) if isinstance(value, torch.Tensor) else float(value)
        except (TypeError, ValueError) as err:
            raise TypeError(f"{what}返回的指标「{key}」必须是数值") from err
        if np.isfinite(number):
            normalised_metrics[str(key)] = number
    return _scalar_loss(loss, what), count, normalised_metrics, prediction, target


def _metric_name(phase: str, name: str) -> str:
    text = str(name)
    return text if text.startswith(phase) else f"{phase}{text}"


def _evaluate_step_loader(env, model, loader, step_fn, spec, device, what: str):
    """用用户 validation_step 评估任意 batch 结构。"""

    import torch

    if loader is None:
        return {}
    model.eval()
    loss_total = 0.0
    rows = 0
    metric_totals: dict[str, float] = {}
    metric_rows: dict[str, int] = {}
    with torch.no_grad():
        for batch in loader:
            env.check_cancel()
            result = step_fn(model, batch, device, spec)
            loss, count, metrics, _, _ = _normalise_step_result(result, what, batch)
            loss_total += float(loss.detach().cpu()) * count
            rows += count
            for key, value in metrics.items():
                metric_totals[key] = metric_totals.get(key, 0.0) + value * count
                metric_rows[key] = metric_rows.get(key, 0) + count
    model.train()
    if rows == 0:
        return {}
    result = {"验证损失": loss_total / rows}
    for key, value in metric_totals.items():
        result[_metric_name("验证", key)] = value / max(1, metric_rows[key])
    return result


def _evaluate_loader(env, model, loader, criterion, spec, device, step_fn=None):
    """验证集求值，兼容默认 batch 和用户自定义 validation_step。"""

    if callable(step_fn):
        return _evaluate_step_loader(env, model, loader, step_fn, spec, device, "验证")

    import torch

    import torch

    if loader is None:
        return {}
    model.eval()
    loss_total = 0.0
    rows = 0
    predictions = []
    targets = []
    with torch.no_grad():
        for batch in loader:
            env.check_cancel()
            x_value, y_value = _batch_xy(batch)
            if y_value is None:
                continue
            x = _to_device(x_value, device, target=False, task=spec.task)
            y = _to_device(y_value, device, target=True, task=spec.task)
            output = model(x)
            loss = _scalar_loss(criterion(output, y), "验证")
            count = int(x.shape[0]) if getattr(x, "ndim", 0) > 0 else 1
            loss_total += float(loss.detach().cpu()) * count
            rows += count
            predictions.append(output.detach().cpu())
            targets.append(y.detach().cpu())
    model.train()
    if rows == 0 or not predictions:
        return {}
    result = {"验证损失": loss_total / rows}
    prediction = torch.cat(predictions, dim=0)
    target = torch.cat(targets, dim=0)
    if _is_classification(spec.task):
        predicted = prediction.argmax(dim=-1).reshape(-1)
        actual = target.reshape(-1)
        result["验证准确率"] = float((predicted == actual).float().mean())
    else:
        actual = target.float().reshape(-1)
        predicted = prediction.float().reshape(-1)
        residual = float(((actual - predicted) ** 2).sum())
        total = float(((actual - actual.mean()) ** 2).sum())
        result["验证R2"] = 1.0 - residual / total if total > 0 else float("nan")
    return result


# ---------------------------------------------------------------------------
# 训练控制面：优化器 / 学习率调度 / 精度（AMP）/ 梯度累积
#
# 三个训练节点（train.mlp、train.cnn1d、train.custom）共用下面这一份 `_run_training`。
# 它们之间的差别是"数据从哪来、loss 怎么算"，不该是"循环怎么写" —— 三份循环的代价是
# 加一个训练选项要改三处，而漏改的那一处不报错，只会让那个节点的行为与另外两个悄悄
# 不同（AGENTS.md R1）。
# ---------------------------------------------------------------------------

#: 调度器的可选项。界面、文档与实现只认这一串
SCHEDULERS = ("无", "余弦退火", "阶梯衰减", "平台衰减")

#: 精度的可选项。**默认 fp32**：换成半精度会改变算出来的数，不能悄悄替用户做这个决定
PRECISIONS = ("fp32", "bf16", "fp16")


@dataclass
class TrainOutcome:
    """一次训练在**控制面**上的结果。

    业务面（指标口径、产物、模型句柄）由各节点接在它后面；这里只放"循环跑成什么样"，
    因为三份循环收成一份之后，这些事实也必须只有一处定义。
    """

    history: list[dict[str, float]]
    stop: EarlyStop | None
    restored: bool
    elapsed: float
    final_lr: float
    precision: str
    scheduler: str
    accumulate: int
    #: 一轮里最多见过多少样本 —— 数据加载器报不出行数时的兜底
    samples: int

    def facts(self) -> dict[str, float]:
        """进**指标**的那部分：只能是数字（输出摘要的数值口径只认数字）。"""

        return {"梯度累积步数": float(self.accumulate), "最终学习率": float(self.final_lr)}

    def notes(self) -> dict[str, str]:
        """进**元信息**的那部分：精度与调度器是字符串，塞进指标要么被丢掉、要么被编成数字。"""

        return {"精度": self.precision, "调度器": self.scheduler}


def _make_optimizer(params: dict[str, Any], model: Any, lr: float):
    """优化器。支持哪些只在这里说一次 —— 三个训练节点共用同一份判断。"""

    import torch

    name = str(params.get("optimizer") or "Adam").strip().lower()
    kinds = {"adam": torch.optim.Adam, "sgd": torch.optim.SGD, "adamw": torch.optim.AdamW}
    kind = kinds.get(name)
    if kind is None:
        raise ValueError(f"优化器只支持 Adam、SGD、AdamW，收到「{params.get('optimizer')}」")
    kwargs: dict[str, Any] = {"lr": lr}
    if name == "sgd":
        # 只对 SGD 生效：给 Adam 系传 momentum 会被 torch 当成未知关键字
        kwargs["momentum"] = max(0.0, _num(params, "momentum", 0.0))
    return kind(model.parameters(), **kwargs)


def _make_scheduler(params: dict[str, Any], optimizer: Any, epochs: int):
    """学习率调度器。返回 ``(调度器 | None, 名字, 学习率下限)``。

    `无` 是默认：加一个选项不该让已有工程的训练结果悄悄变了。
    """

    import torch

    name = str(params.get("scheduler") or "无").strip()
    key = name.lower()
    floor = max(0.0, _num(params, "minLr", 0.0))
    gamma = _num(params, "schedulerGamma", 0.1)
    step = max(1, int(_num(params, "schedulerStep", 10)))
    if key in ("", "无", "none", "off"):
        return None, "无", floor
    if key in ("余弦退火", "cosine"):
        return (
            torch.optim.lr_scheduler.CosineAnnealingLR(
                optimizer, T_max=max(1, int(epochs)), eta_min=floor
            ),
            "余弦退火",
            floor,
        )
    if key in ("阶梯衰减", "step"):
        if not 0 < gamma < 1:
            raise ValueError(f"衰减倍率要在 0 与 1 之间（不含），收到 {gamma:g}")
        return (
            torch.optim.lr_scheduler.StepLR(optimizer, step_size=step, gamma=gamma),
            "阶梯衰减",
            floor,
        )
    if key in ("平台衰减", "plateau"):
        if not 0 < gamma < 1:
            raise ValueError(f"衰减倍率要在 0 与 1 之间（不含），收到 {gamma:g}")
        return (
            torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, factor=gamma, patience=step),
            "平台衰减",
            floor,
        )
    raise ValueError(f"不认识的调度器「{name}」，可选：{'、'.join(SCHEDULERS)}")


def _resolve_precision(params: dict[str, Any], device: Any) -> str:
    """这一次**实际**用什么精度算。

    默认 **fp32**。半精度会改变算出来的数（混合精度不是"更快的 fp32"，它是另一套数值），
    所以它必须是用户显式选的，而不是宿主按设备能力替他选的 —— 加一个选项不该让已有工程的
    训练结果悄悄变了（与早停默认关、`fs` 默认跟随数据是同一条规矩）。

    `bf16` 在 CPU 与 CUDA 上都成立（不需要梯度缩放，数值范围与 fp32 同阶）；
    `fp16` 只在 CUDA 上成立 —— CPU 上给了它当场报错，因为静默降级会让人以为自己
    正在用半精度。
    """

    raw = str(params.get("precision") or "fp32").strip().lower()
    is_cuda = str(device) == "cuda"
    if raw in ("fp32", "float32", ""):
        return "fp32"
    if raw in ("bf16", "bfloat16"):
        return "bf16"
    if raw in ("fp16", "float16", "half"):
        if not is_cuda:
            raise ValueError(
                "fp16 需要 CUDA：CPU 上没有 fp16 的加速，半精度只会更慢。"
                "请把「精度」改成 auto、bf16 或 fp32"
            )
        return "fp16"
    raise ValueError(f"不认识的精度「{params.get('precision')}」，可选：{'、'.join(PRECISIONS)}")


def _autocast_context(precision: str, device: Any):
    """精度对应的 autocast 上下文。fp32 用 nullcontext，循环里因此不必分支。"""

    import contextlib

    import torch

    if precision == "fp32":
        return contextlib.nullcontext()
    dtype = torch.float16 if precision == "fp16" else torch.bfloat16
    return torch.autocast(device_type=str(device), dtype=dtype)


def _make_scaler(precision: str):
    """fp16 需要梯度缩放（下溢会把更新变成噪声）；bf16 不需要。"""

    import torch

    if precision != "fp16":
        return None
    try:
        return torch.amp.GradScaler("cuda", enabled=True)
    except TypeError:  # torch < 2.3 的签名
        return torch.cuda.amp.GradScaler(enabled=True)


def _step_optimizer(optimizer: Any, scaler: Any) -> None:
    """一次真正的参数更新。fp16 下必须走 scaler，否则遇到 inf/nan 会污染权重。"""

    if scaler is None:
        optimizer.step()
        return
    scaler.step(optimizer)
    scaler.update()


def _clamp_lr(optimizer: Any, floor: float) -> None:
    """学习率下限。只在这一处 —— 下限对所有调度器应当是同一条判据。"""

    if floor <= 0:
        return
    for group in optimizer.param_groups:
        if float(group["lr"]) < floor:
            group["lr"] = floor


def _training_notes(
    stop: EarlyStop | None, epochs: int, outcome: TrainOutcome | None
) -> dict[str, str]:
    """进元信息的那几句：精度与调度器（字符串，指标收不下）＋早停（开着才有）。

    `outcome` 为 None = 用户用 `fit_model` 接管了整个循环：那时光靠"精度""调度器"
    两个词已经说不清这次是怎么跑的，所以明说一句"循环是用户自己的"。
    """

    if outcome is None:
        return {"训练循环": "自管（fit_model）"}
    notes = dict(outcome.notes())
    if stop is not None:
        notes["早停"] = stop.note(epochs)
    return notes


def _reject_host_controls(params: dict[str, Any]) -> None:
    """`fit_model` 接管循环时，宿主的控制项不会生效 —— 报错，不静默。

    "设了但没生效"是最难查的一类错：节点上写着余弦退火，结果里看不出任何差别，
    而报告里参数是真的、效果是假的。
    """

    ignored: list[str] = []
    if str(params.get("scheduler") or "无").strip().lower() not in ("", "无", "none", "off"):
        ignored.append("学习率调度")
    if int(_num(params, "accumulate", 1)) > 1:
        ignored.append("梯度累积")
    if str(params.get("precision") or "fp32").strip().lower() not in ("fp32", "float32", ""):
        ignored.append("精度")
    if ignored:
        raise ValueError(
            "fit_model 已经完全接管训练循环，这些参数不会生效："
            + "、".join(ignored)
            + "。请把它们改回默认值，或在你自己的 fit_model 里实现"
        )


def _run_training(
    env,
    model,
    train_loader,
    *,
    params: dict[str, Any],
    device: Any,
    epochs: int,
    step,
    validate=None,
    steps_per_epoch: int | None = None,
    has_val: bool = False,
) -> TrainOutcome:
    """训练循环：**三个训练节点唯一的一份实现**。

    它拥有（也就是"多样训练要求"里所有控制项的家）：优化器、学习率调度、精度（AMP）、
    梯度累积、轮次、逐轮验证、早停（含回到最好那一轮）、取消、进度、逐轮曲线。

    它不猜、也不该猜两件事，所以这两件事由调用方给：

    * ``step(batch) -> (loss, 样本数, 逐批指标, 预测, 目标)``：一个 batch 长什么样、loss 怎么算；
    * ``validate() -> {指标名: 数值}``：验证集上算什么（没有验证集就不传）。

    **进度按 micro-batch 记**（"已经看过多少数据"）。梯度累积只改变"每多少个
    micro-batch 更新一次参数"，不改变进度条的分母 —— 否则开了累积，进度条会慢成
    "看起来卡住了"。
    """

    import torch

    lr = _num(params, "lr", 1e-3)
    if lr <= 0:
        raise ValueError(f"学习率必须大于 0，收到 {lr:g}")
    accumulate = max(1, int(_num(params, "accumulate", 1)))
    precision = _resolve_precision(params, device)
    optimizer = _make_optimizer(params, model, lr)
    scheduler, scheduler_name, lr_floor = _make_scheduler(params, optimizer, epochs)
    scaler = _make_scaler(precision)
    stop = _early_stop(params, has_val)
    # 平台衰减与早停盯**同一个量**：两处各盯一个量，就会出现"早停说没进步、
    # 调度器说不用降"这种互相矛盾的读数
    monitor = "验证损失" if has_val else "训练损失"
    best_state: dict[str, Any] | None = None

    if steps_per_epoch is None:
        try:
            steps_per_epoch = max(1, len(train_loader))
        except (TypeError, ValueError, NotImplementedError):
            steps_per_epoch = None
    known = steps_per_epoch is not None and steps_per_epoch > 0
    total_batches = max(1, epochs * (int(steps_per_epoch) if known else 1))
    done_batches = 0
    samples = 0
    history: list[dict[str, float]] = []
    started = time.perf_counter()

    model.train()
    for epoch in range(1, epochs + 1):
        # 损失在**设备上**累加，一轮只同步一次回主机：每个 micro-batch 都
        # float(loss.detach().cpu()) 会让 GPU 每一批都等一次设备同步，小批量下
        # 这个等待比计算本身还长（实测能把 GPU 拖到比 CPU 还慢）
        loss_total = None
        seen = 0
        pending = 0
        metric_totals: dict[str, float] = {}
        metric_rows: dict[str, int] = {}
        optimizer.zero_grad(set_to_none=True)
        for batch in train_loader:
            # 每个 micro-batch 看一次取消标志：一轮可能几十秒，只在轮与轮之间检查太粗
            env.check_cancel()
            with _autocast_context(precision, device):
                loss, count, step_metrics, _, _ = step(batch)
                # 累积 k 个 micro-batch 再更新一次，等价于一个 k 倍大的批次：
                # 每个 micro-batch 先除以 k，加起来就是大 batch 的平均梯度
                scaled = loss / accumulate
            if scaler is not None:
                scaler.scale(scaled).backward()
            else:
                scaled.backward()
            pending += 1
            term = (loss.detach() * count).to(device)
            loss_total = term if loss_total is None else loss_total + term
            seen += count
            for key, value in step_metrics.items():
                metric_totals[key] = metric_totals.get(key, 0.0) + value * count
                metric_rows[key] = metric_rows.get(key, 0) + count
            if pending >= accumulate:
                _step_optimizer(optimizer, scaler)
                optimizer.zero_grad(set_to_none=True)
                pending = 0
            done_batches += 1
            # 进度不带消息：报损失要设备同步，而那是这段代码里最贵的一步。
            # 要给人看的数字在每轮结束时给
            env.progress(done_batches / total_batches if known else (epoch - 1) / epochs)

        if pending:
            # 一轮末尾不足 accumulate 的那几个 micro-batch 也要更新：丢掉它等于悄悄
            # 少学几个批次。代价是这个"半组"的步长比满组小，这是累积法的固有取舍
            _step_optimizer(optimizer, scaler)
            optimizer.zero_grad(set_to_none=True)

        samples = max(samples, seen)
        train_loss = (
            float(loss_total.cpu()) / max(1, seen) if loss_total is not None else float("nan")
        )
        env.progress(
            done_batches / total_batches if known else epoch / epochs,
            f"第 {epoch}/{epochs} 轮 · 训练损失 {train_loss:.4f}",
        )
        row: dict[str, float] = {"轮次": float(epoch), "训练损失": train_loss}
        for key, value in metric_totals.items():
            row[_metric_name("训练", key)] = value / max(1, metric_rows[key])
        if validate is not None:
            row.update(validate() or {})
        history.append(row)

        if stop is not None:
            if stop.step(epoch, row.get(stop.monitor)):
                # 留在 CPU 上：训练在 GPU，而这份快照只在结束时用一次
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            if stop.triggered:
                env.progress(1.0, f"早停：{stop.note(epochs)}")
                break

        if scheduler is not None:
            if isinstance(scheduler, torch.optim.lr_scheduler.ReduceLROnPlateau):
                scheduler.step(row.get(monitor))
            else:
                scheduler.step()
            _clamp_lr(optimizer, lr_floor)

    elapsed = time.perf_counter() - started
    restored = stop is not None and stop.triggered and best_state is not None
    if restored:
        model.load_state_dict(best_state)
    return TrainOutcome(
        history=history,
        stop=stop,
        restored=restored,
        elapsed=elapsed,
        final_lr=float(optimizer.param_groups[0]["lr"]),
        precision=precision,
        scheduler=scheduler_name,
        accumulate=accumulate,
        samples=samples,
    )


def _fit_loaders(
    env,
    model,
    train_loader,
    val_loader,
    spec,
    params,
    device,
    loss_fn,
    *,
    train_step=None,
    validation_step=None,
):
    """自定义模型这一档的训练：把数据与 batch 交给 `_run_training`。

    没有 step hook 时保留普通 ``(x, y)`` 兼容模式；提供 ``train_step`` 后，
    batch 的结构、设备搬运和模型调用全部交给用户代码，宿主仍然提供优化器、
    调度器、精度、轮次、验证、早停、取消、进度和结果汇总（见 `_run_training`）。
    """

    criterion = loss_fn
    custom_train_step = callable(train_step)
    custom_validation_step = callable(validation_step)
    if custom_train_step and val_loader is not None and not custom_validation_step:
        raise ValueError(
            "自定义 train_step 配合验证集时必须同时提供 validation_step，"
            "因为宿主无法猜测验证 batch 的结构"
        )
    has_val = val_loader is not None and _loader_rows(val_loader) > 0
    train_rows = _loader_rows(train_loader)

    def step(batch):
        if custom_train_step:
            return _normalise_step_result(train_step(model, batch, device, spec), "训练", batch)
        x_value, y_value = _batch_xy(batch)
        if y_value is None:
            raise ValueError("训练 Dataset 的每个样本必须返回 (x, y)，或实现 train_step")
        x = _to_device(x_value, device, target=False, task=spec.task)
        y = _to_device(y_value, device, target=True, task=spec.task)
        output = model(x)
        return _scalar_loss(criterion(output, y), "训练"), _batch_size(x), {}, None, None

    outcome = _run_training(
        env,
        model,
        train_loader,
        params=params,
        device=device,
        epochs=max(1, int(_num(params, "epochs", 50))),
        step=step,
        validate=lambda: _evaluate_loader(
            env, model, val_loader, criterion, spec, device, step_fn=validation_step
        )
        if has_val
        else None,
        has_val=has_val,
    )
    history = outcome.history
    lr = _num(params, "lr", 1e-3)
    if train_rows == 0:
        train_rows = outcome.samples
    stop = outcome.stop
    restored = outcome.restored
    elapsed = outcome.elapsed

    final_train = _evaluate_loader(
        env,
        model,
        train_loader,
        criterion,
        spec,
        device,
        step_fn=validation_step or train_step,
    )
    final_val = _evaluate_loader(
        env,
        model,
        val_loader,
        criterion,
        spec,
        device,
        step_fn=validation_step,
    )
    metrics: dict[str, float] = {
        "训练样本数": float(train_rows),
        "参数量": float(sum(p.numel() for p in model.parameters())),
        "训练轮数": float(len(history)),
        "批次大小": float(getattr(train_loader, "batch_size", _num(params, "batch", 64)) or 0),
        "学习率": float(lr),
        "最终训练损失": float(final_train.get("验证损失", float("nan"))),
        "耗时秒": round(elapsed, 3),
        "用了GPU": 1.0 if str(device) == "cuda" else 0.0,
        **outcome.facts(),
    }
    for key in ("验证准确率", "验证R2"):
        if key in final_train:
            metrics[f"最终训练{key[2:]}"] = float(final_train[key])
    for key in ("验证损失", "验证准确率", "验证R2"):
        if key in final_val:
            metrics[f"最终{key}"] = float(final_val[key])
    if stop is not None:
        metrics["最佳轮次"] = float(stop.best_epoch)
        metrics["早停触发"] = 1.0 if stop.triggered else 0.0
    return model, metrics, pd.DataFrame(history), restored, outcome


def _infer_task(labels: np.ndarray) -> str:
    """训练用的任务判定。

    **规则只有一处**：共享算子里的 `infer_task`（判据与理由都写在那里）。
    训练与评估对"这份标签是什么任务"必须给同一个答案 —— 两处各写一份，
    迟早一处改了另一处没改，而表现是"训练按分类、评估按回归"这种没人会想到的组合。
    """
    from . import bridge

    return bridge.shared_operators().infer_task(labels)


def _frames_from_table(frame: pd.DataFrame, what: str):
    """把用户准备好的定长样本表还原成 (样本, 通道, 窗长) 的三维数组 + 每帧的起始行号。

    用户准备的定长样本表是**长表**：一行 = 一帧 × 一个通道，列是 `点0…点W-1`。
    这里不重新分帧，只把它摆成卷积要的形状。三条约定：

    - 帧由 `起点` 认（那一列就是原始表里的行号，帧的标签也取同一行的）；
    - 通道按它们在表里出现的顺序排，每一帧的通道数必须一样，否则报错 ——
      悄悄按第一帧的形状去摆，会把后面的帧错位，而错位之后照样能算出数；
    - 窗长由 `点N` 列的个数认，**不另设参数**，避免数据准备与训练之间出现两处配置。
    """
    if "起点" not in frame.columns:
        raise KeyError(
            "训练样本里没有「起点」列：定长样本需要用它与原始行号关联（标签就按它对齐）"
        )

    indexed: dict[int, str] = {}
    for name in frame.columns:
        hit = fullmatch(r"点(\d+)", str(name))
        if hit:
            indexed[int(hit.group(1))] = str(name)
    if not indexed:
        raise KeyError(
            f"{what}里找不到「点0…点N」这些列 —— 它看起来不是定长样本表。"
            f"现有列：{'、'.join(str(c) for c in frame.columns)}"
        )
    window = len(indexed)
    if sorted(indexed) != list(range(window)):
        raise ValueError(f"{what}的点列不连续：{'、'.join(sorted(indexed))}")
    point_cols = [indexed[i] for i in range(window)]
    if window < 4:
        raise ValueError(f"窗长至少要 4 点（两层池化各要减半一次），收到 {window}")

    stacks: list[np.ndarray] = []
    starts: list[int] = []
    channels: int | None = None
    for start, group in frame.groupby("起点", sort=True):
        block = group[point_cols].to_numpy(dtype=np.float32)
        if channels is None:
            channels = block.shape[0]
        elif block.shape[0] != channels:
            raise ValueError(
                f"第 {start} 帧有 {block.shape[0]} 个通道，前面的帧有 {channels} 个 —— "
                "同一批帧的通道数必须一致（请检查样本准备代码）"
            )
        stacks.append(block)
        starts.append(int(start))

    if not stacks:
        raise ValueError(f"{what}里一帧都没有")
    matrix = np.stack(stacks)  # (样本, 通道, 窗长)
    return matrix, np.asarray(starts, dtype=np.int64), int(channels or 0), window


def _labels_for_frames(frame: pd.DataFrame, starts: np.ndarray, label_name: str, what: str):
    """每一帧的标签 = 它**起点那一行**的标签。

    这是样本与标签之间唯一说得通的约定：样本是"从第 n 行开始的一段"，它的标签就是
    第 n 行的标签。别的做法（取帧内多数票、取帧尾）都要先假定标签在帧内不变，
    而这个假定在故障诊断数据里经常不成立。取不到就报错，不猜。
    """
    if label_name not in frame.columns:
        available = "、".join(str(c) for c in frame.columns)
        raise KeyError(
            f"{what}里没有标签列「{label_name}」。现有列：{available}。"
            "标签要靠样本表里的标签列带过来，并在训练节点中填同一个列名"
        )
    first_rows = frame.groupby("起点", sort=True)[label_name].first()
    values = first_rows.to_numpy()
    if values.shape[0] != starts.shape[0]:
        raise ValueError(f"{what}的标签行数 {values.shape[0]} 与帧数 {starts.shape[0]} 对不上")
    return values


def _axes_for_shape(shape: tuple[int, ...], *, output: bool) -> tuple[str, ...]:
    if output:
        if len(shape) <= 1:
            return ("target",)
        return ("target",) + tuple(f"target_{i}" for i in range(1, len(shape)))
    if len(shape) == 1:
        return ("feature",)
    if len(shape) == 2:
        return ("time", "feature")
    return tuple(f"axis_{i}" for i in range(len(shape)))


def _custom_loss(namespace, spec):
    import torch
    from torch import nn

    user_loss = namespace.get("loss_fn")
    if callable(user_loss):
        return lambda prediction, target: _call_with_optional_spec(user_loss, prediction, target, spec)
    if _is_classification(spec.task):
        return nn.CrossEntropyLoss()
    return lambda prediction, target: nn.functional.mse_loss(
        prediction.reshape_as(target), target
    )


_AUTO_MODEL_ARGUMENTS = {
    "self",
    "cls",
    "spec",
    "model_spec",
    "input_shape",
    "output_shape",
    "input_dim",
    "output_dim",
    "input_size",
    "output_size",
    "in_features",
    "out_features",
    "in_channels",
    "out_channels",
    "num_classes",
    "n_classes",
    "task",
}


def _custom_model_class(namespace):
    """找到用户定义的 nn.Module；显式 MODEL_CLASS 优先，公开类取最后一个。"""

    import inspect
    import torch

    explicit = namespace.get("MODEL_CLASS")
    if explicit is not None:
        if not inspect.isclass(explicit) or not issubclass(explicit, torch.nn.Module):
            raise TypeError("MODEL_CLASS 必须指向 torch.nn.Module 的子类")
        return explicit
    candidates = [
        value
        for value in namespace.values()
        if inspect.isclass(value)
        and value is not torch.nn.Module
        and issubclass(value, torch.nn.Module)
        and getattr(value, "__module__", "") == "sciviz_custom_model"
        and not getattr(value, "__name__", "").startswith("_")
    ]
    if not candidates:
        return None
    return next((value for value in candidates if value.__name__ == "Model"), candidates[-1])


def _shape_size(shape):
    size = 1
    for value in shape:
        size *= int(value)
    return size


def _build_model_class(model_class, spec, model_params):
    """按构造函数名自动注入数据形状，其余参数来自模型节点。"""

    input_shape = tuple(spec.input_shape)
    output_shape = tuple(spec.output_shape)
    input_dim = input_shape[-1] if len(input_shape) > 1 else _shape_size(input_shape)
    output_dim = output_shape[-1] if len(output_shape) > 1 else _shape_size(output_shape)
    context = {
        "spec": spec,
        "model_spec": spec,
        "input_shape": input_shape,
        "output_shape": output_shape,
        "input_dim": input_dim,
        "output_dim": output_dim,
        "input_size": input_dim,
        "output_size": output_dim,
        "in_features": input_dim,
        "out_features": output_dim,
        "in_channels": input_dim,
        "out_channels": output_dim,
        "num_classes": output_dim,
        "n_classes": output_dim,
        "task": spec.task,
    }
    kwargs = {}
    for parameter in inspect.signature(model_class).parameters.values():
        if parameter.name in context:
            kwargs[parameter.name] = context[parameter.name]
        elif parameter.name in model_params:
            kwargs[parameter.name] = model_params[parameter.name]
        elif parameter.default is inspect.Parameter.empty and parameter.name not in _AUTO_MODEL_ARGUMENTS:
            raise ValueError(
                f"模型构造函数参数「{parameter.name}」没有默认值，"
                "请在 MODEL_PARAMS 中声明，或为它提供默认值"
            )
    return model_class(**kwargs)


def op_custom_model(env, params, inputs, output_ports):
    """编译一个可连接的自定义模型定义。

    模型定义本身没有训练数据，不能在这里猜输入输出形状，也不应该生成一个
    假模型。训练节点会在收到 ``CustomModelDefinition`` 后结合训练集生成 spec
    并调用其中的 ``build_model``。
    """

    namespace = env.model_plugin(env.node_id)
    raw_specs = namespace.get("MODEL_PARAMS", namespace.get("model_params"))
    model_class = _custom_model_class(namespace)
    parameter_specs = (
        normalize_model_param_specs(raw_specs)
        if raw_specs is not None
        else infer_model_param_specs(model_class)
    )
    parameter_values = resolve_model_params(parameter_specs, params)
    interface = normalize_model_interface_source(
        str(namespace.get("__source__", "")), namespace.get("MODEL_INTERFACE")
    )
    interface_inputs = {
        port.id: inputs[port.id]
        for port in interface.inputs
        if port.id in inputs
    }
    return {
        "model": CustomModelDefinition(
            node_id=env.node_id,
            source=str(namespace.get("__source__", "")),
            namespace=namespace,
            name=str(params.get("name") or "自定义模型"),
            parameter_specs=parameter_specs,
            parameter_values=parameter_values,
            interface=interface,
            interface_inputs=interface_inputs,
        )
    }


def _op_train_custom_impl(
    env,
    params,
    inputs,
    output_ports,
    *,
    node_type="train.custom",
    fit_hook_override=None,
    training_params=None,
):
    """按 SciViz 自定义模型协议训练一个用户模型。

    用户代码可以直接定义 torch.nn.Module 子类，或提供兼容的 build_model；可以选择
    只使用普通 ``(x, y)`` 兼容模式，也可以通过 make_spec、build_dataloader、
    train_step、validation_step 完全接管数据和 batch 解析。训练循环、早停、进度、
    取消和产物格式仍由宿主统一处理。
    """

    import torch

    model_definition = inputs.get("model")
    if not isinstance(model_definition, CustomModelDefinition):
        raise TypeError("训练自定义模型必须连接「自定义模型」节点的 model 输出")
    namespace = dict(model_definition.namespace)

    train = _as_frame(inputs.get("train"), "训练集")
    val = inputs.get("val")
    val_frame = _as_frame(val, "验证集") if val is not None else None
    scaler = inputs.get("scaler")
    parameter_specs = tuple(model_definition.parameter_specs)
    model_params = resolve_model_params(parameter_specs, model_definition.parameter_values)
    # 训练参数和模型参数分层：模型工厂只接收 model_params；可选数据/训练 hook
    # 仍然能读取训练配置，并通过 params["model_params"] 使用模型配置。
    hook_params = dict(params)
    hook_params["model_params"] = dict(model_params)
    build = namespace.get("build_model")
    model_class = _custom_model_class(namespace)
    if not callable(build) and model_class is None:
        raise NameError(
            "自定义模型代码必须定义 torch.nn.Module 子类（可命名为 Model），"
            "或提供兼容的 build_model(spec, model_params)"
        )

    requested_task = _task_name(params.get("task"), "回归")
    if requested_task == "auto":
        if callable(namespace.get("make_dataset")) or callable(namespace.get("build_dataloader")):
            label_names = [name for name in _names(params.get("label")) if name in train.columns]
        else:
            try:
                label_names = _resolve_column_selection(
                    train, params.get("label"), "训练集", "标签", getattr(env, "time_columns", ())
                )
            except KeyError:
                label_names = []
        if len(label_names) == 1:
            requested_task = _infer_task(train[label_names[0]].dropna().to_numpy())
        else:
            requested_task = "回归"

    spec_hook = namespace.get("make_spec")
    spec = None
    if callable(spec_hook):
        spec = _custom_spec_from_hook(
            _call_data_hook(spec_hook, train, "train", hook_params, scaler),
            requested_task,
            hook_params,
            train,
        )
        requested_task = "分类" if spec.task == "classification" else "回归"

    direct_loader = callable(namespace.get("build_dataloader"))
    train_dataset = None
    feature_names: tuple[str, ...] = tuple(_names(params.get("features")))
    target_names: tuple[str, ...] = tuple(_names(params.get("label")))
    classes = None
    if not direct_loader:
        train_dataset, dataset_features, dataset_targets, classes, _ = _custom_dataset(
            namespace,
            train,
            "train",
            hook_params,
            scaler,
            requested_task,
            "训练集",
            time_columns=getattr(env, "time_columns", ()),
        )
        feature_names = tuple(dataset_features) or feature_names
        target_names = tuple(dataset_targets) or target_names
        if len(train_dataset) == 0:
            raise ValueError("训练 Dataset 为空")
        if spec is None:
            spec = _custom_spec_from_dataset(
                train_dataset,
                requested_task,
                feature_names,
                target_names,
                classes,
                train,
            )
    elif spec is None:
        raise ValueError(
            "自定义 build_dataloader 不返回固定的默认样本结构，必须同时实现 "
            "make_spec(data, split, params, scaler) 来描述 input_shape / output_shape"
        )

    if spec is None:  # pragma: no cover - 上面的分支已经覆盖，保留作边界保护
        raise RuntimeError("没有生成 ModelSpec")
    if not feature_names:
        feature_names = tuple(spec.feature_names)
    if not target_names:
        target_names = tuple(spec.target_names)
    if not spec.feature_names or not spec.target_names:
        spec = ModelSpec(
            input_shape=spec.input_shape,
            output_shape=spec.output_shape,
            input_axes=spec.input_axes,
            output_axes=spec.output_axes,
            task=spec.task,
            feature_names=spec.feature_names or feature_names,
            target_names=spec.target_names or target_names,
            metadata=spec.metadata,
        )
    input_shape = spec.input_shape
    output_shape = spec.output_shape
    task_code = spec.task

    model = build(spec, dict(model_params)) if callable(build) else _build_model_class(model_class, spec, model_params)
    if not hasattr(model, "parameters") or not callable(model.parameters):
        raise TypeError("模型类或 build_model(spec, model_params) 必须返回 torch.nn.Module")
    requested = str(params.get("device") or "auto")
    target = device_probe.resolve(requested)
    if target == "cuda" and not torch.cuda.is_available():
        target = "cpu"
    torch_device = torch.device(target)
    model = model.to(torch_device)

    seed = int(_num(params, "seed", 42))
    torch.manual_seed(seed)
    if target == "cuda":
        torch.cuda.manual_seed_all(seed)
    if direct_loader:
        train_loader, loader_config = _build_direct_dataloader(
            namespace, train, "train", hook_params, scaler, seed
        )
    else:
        train_loader, loader_config = _make_dataloader(namespace, train_dataset, "train", hook_params, seed)
    val_loader = None
    if val_frame is not None:
        if direct_loader:
            val_loader, _ = _build_direct_dataloader(
                namespace, val_frame, "val", hook_params, scaler, seed
            )
        else:
            val_dataset, _, _, _, _ = _custom_dataset(
                namespace,
                val_frame,
                "val",
                hook_params,
                scaler,
                requested_task,
                "验证集",
                time_columns=getattr(env, "time_columns", ()),
                classes=classes,
            )
            if len(val_dataset) > 0:
                val_loader, _ = _make_dataloader(namespace, val_dataset, "val", hook_params, seed)

    if train_loader is None:
        raise ValueError("训练 DataLoader 为空")
    if fit_hook_override is not None:
        namespace["fit_model"] = fit_hook_override
    fit_hook = namespace.get("fit_model")
    outcome: TrainOutcome | None = None
    if callable(fit_hook):
        if node_type == "train.custom":
            _reject_host_controls(params)
        env.check_cancel()
        fit_result = fit_hook(
            model,
            train_loader,
            val_loader,
            torch_device,
            spec,
            dict(hook_params),
            env,
        )
        if not isinstance(fit_result, Mapping):
            raise TypeError(
                "fit_model(model, train_loader, val_loader, device, spec, params, env) "
                "必须返回字典"
            )
        model = fit_result.get("model", model)
        raw_metrics = fit_result.get("metrics") or {}
        if not isinstance(raw_metrics, Mapping):
            raise TypeError("fit_model 返回的 metrics 必须是字典")
        metrics = {}
        for key, value in raw_metrics.items():
            try:
                metric = float(value.detach().cpu()) if isinstance(value, torch.Tensor) else float(value)
            except (TypeError, ValueError) as err:
                raise TypeError(f"fit_model 返回的指标「{key}」必须是数值") from err
            if not np.isfinite(metric):
                raise ValueError(f"fit_model 返回的指标「{key}」必须是有限数值")
            metrics[str(key)] = metric
        history = fit_result.get("history")
        if history is None:
            history = pd.DataFrame()
        elif not isinstance(history, pd.DataFrame):
            history = pd.DataFrame(history)
        env.progress(1.0, "自定义 fit_model 完成")
    else:
        criterion = _custom_loss(namespace, spec)
        model, metrics, history, _, outcome = _fit_loaders(
            env,
            model,
            train_loader,
            val_loader,
            spec,
            params,
            torch_device,
            criterion,
            train_step=namespace.get("train_step"),
            validation_step=namespace.get("validation_step"),
        )
    bundle = ModelBundle(
        module=model,
        node_type=node_type,
        task=task_code,
        spec=spec,
        plugin=namespace,
        feature_names=tuple(feature_names),
        target_names=tuple(target_names),
        classes=classes,
        scaler=scaler,
        metadata={
            "adapter": "custom",
            "modelDefinitionNodeId": model_definition.node_id,
            "modelInterface": {
                "inputs": [asdict(item) for item in model_definition.interface.inputs],
                "outputs": [asdict(item) for item in model_definition.interface.outputs],
            },
            "modelParams": dict(model_params),
            "modelParamSpecs": [
                {
                    "key": item.key,
                    "type": item.type,
                    "default": item.default,
                    "label": item.label,
                    "min": item.min,
                    "max": item.max,
                    "step": item.step,
                    "options": list(item.options),
                    "hint": item.hint,
                }
                for item in parameter_specs
            ],
            "inputShape": list(input_shape),
            "outputShape": list(output_shape),
            "inputMode": _input_mode(params.get("inputMode")),
            "window": max(1, int(_num(params, "window", 48))),
            "horizon": max(1, int(_num(params, "horizon", 1))),
            "stride": max(1, int(_num(params, "stride", 1))),
            "loaderBatchSize": loader_config.batch_size,
            "customDataHooks": {
                "spec": callable(namespace.get("make_spec")),
                "loader": direct_loader or callable(namespace.get("make_dataloader")),
                "trainStep": callable(namespace.get("train_step")),
                "validationStep": callable(namespace.get("validation_step")),
                "predictStep": callable(namespace.get("predict_step")),
                "fitModel": callable(fit_hook),
            },
        },
    )
    artifact_params = dict(params)
    artifact_params["model_params"] = dict(model_params)
    metrics["产物落盘"] = _save_training_artifacts(
        env, node_type, bundle, metrics, history, artifact_params,
        inputs=inputs, training_params=training_params if training_params is not None else params,
    )
    _note_environment(
        env,
        target,
        {
            "模型": type(model).__name__,
            "输入形状": str(input_shape),
            "输出形状": str(output_shape),
            "数据加载": (
                "用户 build_dataloader"
                if direct_loader
                else "自定义 DataLoader"
                if callable(namespace.get("make_dataloader"))
                else "SciViz 时序 DataLoader"
                if _input_mode(params.get("inputMode")) == "sequence"
                else "SciViz DataLoader"
            ),
            "batch处理": "用户 step hook" if callable(namespace.get("train_step")) else "SciViz 默认处理",
            **_training_notes(
                None if outcome is None else outcome.stop,
                max(1, int(_num(params, "epochs", 50))),
                outcome,
            ),
        },
    )
    return {
        "model": bundle,
        "metrics": metrics,
        "history": history,
        "curve": _curve_table(history),
    }


def op_train_custom(env, params, inputs, output_ports):
    """兼容旧工程中的固定参数训练节点。"""

    return _op_train_custom_impl(env, params, inputs, output_ports)


class _TrainingModelFactory:
    """让用户训练函数在知道样本形状以后再创建模型。"""

    def __init__(self, definition: CustomModelDefinition, device) -> None:
        self.definition = definition
        self.device = device
        self.module = None
        self.spec = None
        # 显式接口是模型工厂的稳定、可审计入口；训练函数无需重新解析源码。
        self.interface = definition.interface
        self.interface_inputs = dict(definition.interface_inputs)
        self.model_params = resolve_model_params(
            tuple(definition.parameter_specs), definition.parameter_values
        )

    def __call__(
        self,
        input_shape,
        output_shape,
        *,
        task="regression",
        feature_names=(),
        target_names=(),
        input_axes=(),
        output_axes=(),
        metadata=None,
    ):
        if self.module is not None:
            raise RuntimeError("一次训练只能调用一次 model_factory；请复用第一次返回的模型")
        input_shape = _shape_tuple(input_shape, "input_shape")
        output_shape = _shape_tuple(output_shape, "output_shape")
        task_name = _task_name(task, "回归")
        if task_name == "auto":
            raise ValueError("model_factory 的 task 不能是 auto；请明确填写 regression 或 classification")
        if metadata is not None and not isinstance(metadata, Mapping):
            raise TypeError("model_factory 的 metadata 必须是字典或 None")
        spec = ModelSpec(
            input_shape=input_shape,
            output_shape=output_shape,
            input_axes=tuple(str(item) for item in input_axes)
            or _axes_for_shape(input_shape, output=False),
            output_axes=tuple(str(item) for item in output_axes)
            or _axes_for_shape(output_shape, output=True),
            task="classification" if task_name == "分类" else "regression",
            feature_names=tuple(str(item) for item in feature_names),
            target_names=tuple(str(item) for item in target_names),
            metadata=dict(metadata or {}),
        )
        namespace = dict(self.definition.namespace)
        build = namespace.get("build_model")
        model_class = _custom_model_class(namespace)
        if callable(build):
            model = build(spec, dict(self.model_params))
        elif model_class is not None:
            model = _build_model_class(model_class, spec, self.model_params)
        else:
            raise NameError(
                "自定义模型代码必须定义 torch.nn.Module 子类（可命名为 Model），"
                "或提供 build_model(spec, model_params)"
            )
        if not hasattr(model, "parameters") or not callable(model.parameters):
            raise TypeError("model_factory 创建结果必须是 torch.nn.Module")
        self.spec = spec
        self.module = model.to(self.device)
        return self.module


def _normalize_user_training_result(result, fallback_model):
    """校验用户训练函数的稳定返回结构。"""

    import torch

    if not isinstance(result, Mapping):
        raise TypeError("fit_model(...) 必须返回字典")
    model = result.get("model", fallback_model)
    if model is None or not hasattr(model, "parameters") or not callable(model.parameters):
        raise TypeError("fit_model 必须返回 model，或使用 model_factory 创建模型")
    raw_metrics = result.get("metrics") or {}
    if not isinstance(raw_metrics, Mapping):
        raise TypeError("fit_model 返回的 metrics 必须是字典")
    metrics = {}
    for key, value in raw_metrics.items():
        try:
            metric = float(value.detach().cpu()) if isinstance(value, torch.Tensor) else float(value)
        except (TypeError, ValueError) as err:
            raise TypeError(f"fit_model 返回的指标「{key}」必须是数值") from err
        if not np.isfinite(metric):
            raise ValueError(f"fit_model 返回的指标「{key}」必须是有限数值")
        metrics[str(key)] = metric
    history = result.get("history")
    if history is None:
        history = pd.DataFrame()
    elif not isinstance(history, pd.DataFrame):
        history = pd.DataFrame(history)
    metadata = result.get("metadata") or {}
    if not isinstance(metadata, Mapping):
        raise TypeError("fit_model 返回的 metadata 必须是字典")
    return model, metrics, history, dict(metadata)


def op_train_function(env, params, inputs, output_ports):
    """执行训练节点上的用户函数；新协议把原始表交给函数自行构造 DataLoader。"""

    fit_fn, fn_name = env.fn(env.node_id)
    if fn_name != "fit_model":
        raise ValueError("通用训练函数必须命名为 fit_model")
    try:
        signature = inspect.signature(fit_fn)
    except (TypeError, ValueError) as err:
        raise TypeError("无法读取 fit_model 的函数签名") from err

    dynamic_values = dict(params)
    fixed_inputs = {"model", "train", "val", "scaler"}
    for name in signature.parameters:
        if name not in fixed_inputs and name in inputs:
            dynamic_values[name] = inputs[name]

    # 旧工程仍按 0.1.0 的宿主 DataLoader 协议运行；新建节点不再生成这种签名。
    raw_protocol_names = {"model_factory", "train_data", "test_data", "val_data"}
    if not raw_protocol_names.intersection(signature.parameters):
        def invoke_fit_model(model, train_loader, val_loader, device, spec, fit_params, runtime_env):
            injected = {
                "model": model,
                "train_loader": train_loader,
                "val_loader": val_loader,
                "device": device,
                "spec": spec,
                "params": fit_params,
                "env": runtime_env,
            }
            kwargs = {}
            for parameter in signature.parameters.values():
                if parameter.kind is inspect.Parameter.POSITIONAL_ONLY:
                    raise TypeError(
                        f"fit_model 参数「{parameter.name}」不能使用仅位置参数；请改成普通或关键字参数"
                    )
                if parameter.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
                    continue
                if parameter.name in injected:
                    kwargs[parameter.name] = injected[parameter.name]
                elif parameter.name in fit_params:
                    kwargs[parameter.name] = fit_params[parameter.name]
                elif parameter.default is inspect.Parameter.empty:
                    raise ValueError(f"fit_model 的必需参数「{parameter.name}」没有值")
            return fit_fn(**kwargs)

        return _op_train_custom_impl(
            env,
            dynamic_values,
            inputs,
            output_ports,
            node_type="train.function",
            fit_hook_override=invoke_fit_model,
            training_params=params,
        )

    import torch

    model_definition = inputs.get("model")
    if not isinstance(model_definition, CustomModelDefinition):
        raise TypeError("自定义训练必须连接「自定义模型」节点的模型定义")
    train_data = _as_frame(inputs.get("train"), "训练集")
    test_value = inputs.get("val")
    test_data = _as_frame(test_value, "测试集") if test_value is not None else None
    scaler = inputs.get("scaler")

    requested = str(params.get("device") or "auto")
    target = device_probe.resolve(requested)
    if target == "cuda" and not torch.cuda.is_available():
        target = "cpu"
    torch_device = torch.device(target)
    model_factory = _TrainingModelFactory(model_definition, torch_device)

    injected = {
        "model_factory": model_factory,
        "train_data": train_data,
        "test_data": test_data,
        "val_data": test_data,
        "scaler": scaler,
        "device": torch_device,
        "params": dict(dynamic_values),
        "env": env,
    }
    kwargs = {}
    for parameter in signature.parameters.values():
        if parameter.kind is inspect.Parameter.POSITIONAL_ONLY:
            raise TypeError(
                f"fit_model 参数「{parameter.name}」不能使用仅位置参数；请改成普通或关键字参数"
            )
        if parameter.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD):
            continue
        if parameter.name in injected:
            kwargs[parameter.name] = injected[parameter.name]
        elif parameter.name in dynamic_values:
            kwargs[parameter.name] = dynamic_values[parameter.name]
        elif parameter.default is inspect.Parameter.empty:
            raise ValueError(f"fit_model 的必需参数「{parameter.name}」没有值")

    env.check_cancel()
    fit_result = fit_fn(**kwargs)
    model, metrics, history, result_metadata = _normalize_user_training_result(
        fit_result, model_factory.module
    )
    if model_factory.spec is None:
        raise ValueError(
            "fit_model 必须调用 model_factory(input_shape, output_shape, ...)；"
            "宿主不会根据某一份数据自动猜模型形状"
        )
    model = model.to(torch_device)
    spec = model_factory.spec
    parameter_specs = tuple(model_definition.parameter_specs)
    bundle = ModelBundle(
        module=model,
        node_type="train.function",
        task=spec.task,
        spec=spec,
        plugin=dict(model_definition.namespace),
        feature_names=tuple(spec.feature_names),
        target_names=tuple(spec.target_names),
        scaler=scaler,
        metadata={
            "adapter": "training-function",
            "dataProtocol": "raw-tables",
            "modelDefinitionNodeId": model_definition.node_id,
            "modelParams": dict(model_factory.model_params),
            "modelParamSpecs": [
                {
                    "key": item.key,
                    "type": item.type,
                    "default": item.default,
                    "label": item.label,
                    "min": item.min,
                    "max": item.max,
                    "step": item.step,
                    "options": list(item.options),
                    "hint": item.hint,
                }
                for item in parameter_specs
            ],
            "inputShape": list(spec.input_shape),
            "outputShape": list(spec.output_shape),
            **result_metadata,
        },
    )
    artifact_params = dict(dynamic_values)
    artifact_params["model_params"] = dict(model_factory.model_params)
    metrics["产物落盘"] = _save_training_artifacts(
        env, "train.function", bundle, metrics, history, artifact_params,
        inputs=inputs, training_params=params,
    )
    _note_environment(
        env,
        target,
        {
            "模型": type(model).__name__,
            "输入形状": str(spec.input_shape),
            "输出形状": str(spec.output_shape),
            "数据加载": "用户训练函数",
            "训练循环": "自管（fit_model）",
            "测试集用途": "由 fit_model 决定（可用于早停）" if test_data is not None else "未连接",
        },
    )
    env.progress(1.0, "自定义 fit_model 完成")
    return {
        "model": bundle,
        "metrics": metrics,
        "history": history,
        "curve": _curve_table(history),
    }


def _predict_loader(env, model, loader, device, *, step_fn=None, spec=None):
    import torch

    model.eval()
    outputs = []
    with torch.no_grad():
        for batch in loader:
            env.check_cancel()
            if callable(step_fn):
                result = step_fn(model, batch, device, spec)
                if isinstance(result, Mapping):
                    if "prediction" not in result:
                        raise ValueError("predict_step 返回字典时必须包含 prediction")
                    result = result["prediction"]
                outputs.append(result)
            else:
                x_value, _ = _batch_xy(batch)
                x = _to_device(x_value, device, target=False, task="regression")
                outputs.append(model(x).detach().cpu())
    if not outputs:
        return np.empty((0, 1), dtype=np.float32)
    if isinstance(outputs[0], pd.DataFrame):
        return pd.concat(outputs, ignore_index=True)
    if all(isinstance(value, torch.Tensor) for value in outputs):
        return torch.cat([value.detach().cpu() for value in outputs], dim=0).numpy()
    arrays = [np.asarray(value) for value in outputs]
    try:
        return np.concatenate(arrays, axis=0)
    except ValueError:
        return np.asarray(arrays)


def _prediction_frame(
    prediction,
    bundle: ModelBundle,
    data: pd.DataFrame,
    params,
    row_keys=None,
    target_rows=None,
):
    raw_prediction = prediction
    array = np.asarray(prediction)
    if array.ndim == 0:
        array = array.reshape(1, 1)
    elif array.ndim == 1:
        array = array.reshape(-1, 1)
    decoded = None
    decode = bundle.plugin.get("decode_predictions") if isinstance(bundle.plugin, dict) else None
    if callable(decode):
        decoded = _call_with_optional_spec(decode, raw_prediction, data, bundle.spec)
    if isinstance(decoded, pd.DataFrame):
        return decoded.reset_index(drop=True)
    if decoded is not None:
        array = np.asarray(decoded)
        if array.ndim == 1:
            array = array.reshape(-1, 1)
    elif _is_classification(bundle.task):
        indices = np.asarray(array.argmax(axis=-1)).reshape(-1)
        if bundle.classes is not None:
            values = np.asarray(bundle.classes, dtype=object)[indices]
        else:
            values = indices
        array = values.reshape(-1, 1)

    result = pd.DataFrame(index=np.arange(array.shape[0]))
    if row_keys is not None:
        result["样本"] = np.asarray(row_keys)[: len(result)]
    else:
        result["样本"] = np.arange(len(result))

    target_names = list(bundle.target_names)
    prefix = str(params.get("predictionPrefix") or "预测")
    for i in range(array.shape[1]):
        name = target_names[i] if i < len(target_names) else str(i)
        result[f"{prefix}_{name}"] = array[:, i]
    if target_rows is not None:
        positions = np.asarray(target_rows, dtype=np.int64)[: len(result)]
        target_data = data.iloc[positions]
    elif len(data) == len(result):
        target_data = data
    else:
        target_data = None
    if target_data is not None:
        for name in reversed(target_names):
            if name in target_data.columns:
                result.insert(1, name, target_data[name].to_numpy())
    return result


def op_model_predict(env, params, inputs, output_ports):
    """使用训练节点留在宿主会话中的模型句柄生成预测表。"""

    import torch
    from torch.utils.data import TensorDataset

    bundle = inputs.get("model")
    if not isinstance(bundle, ModelBundle):
        raise TypeError("预测节点需要连接真实训练节点的 model 输出，不能连接指标输出")
    data = _as_frame(inputs.get("data"), "预测数据")
    scaler = inputs.get("scaler") or bundle.scaler
    requested = str(params.get("device") or "auto")
    target = device_probe.resolve(requested)
    if target == "cuda" and not torch.cuda.is_available():
        target = "cpu"
    device = torch.device(target)
    model = bundle.module.to(device)

    row_keys = None
    target_rows = None
    if bundle.node_type == "train.mlp":
        raw_features = _names(params.get("features"))
        feature_names = (
            tuple(_resolve_column_selection(data, params.get("features"), "预测数据", "特征", getattr(env, "time_columns", ())))
            if raw_features
            else bundle.feature_names
        )
        if len(feature_names) != bundle.spec.input_shape[0]:
            raise ValueError(
                f"预测特征数为 {len(feature_names)}，模型训练时需要 {bundle.spec.input_shape[0]} 个"
            )
        missing = [name for name in feature_names if name not in data.columns]
        if missing:
            raise KeyError(f"预测数据缺少特征列：{'、'.join(missing)}")
        x_raw = np.asarray(data[list(feature_names)], dtype=np.float32)
        if bundle.center is not None and bundle.scale is not None:
            x_raw = (x_raw - bundle.center) / bundle.scale
        dataset = TensorDataset(torch.from_numpy(x_raw))
        loader = torch.utils.data.DataLoader(dataset, batch_size=max(1, int(_num(params, "batch", 256))), shuffle=False)
        prediction = _predict_loader(env, model, loader, device)
    elif bundle.node_type == "train.cnn1d":
        x_raw, starts, channels, window = _frames_from_table(data, "预测数据")
        if channels != bundle.spec.input_shape[0] or window != bundle.spec.input_shape[1]:
            raise ValueError(
                f"预测数据形状是 {channels} 通道 × {window} 点，"
                f"模型需要 {bundle.spec.input_shape[0]} 通道 × {bundle.spec.input_shape[1]} 点"
            )
        if bundle.center is not None and bundle.scale is not None:
            x_raw = (x_raw - bundle.center) / bundle.scale
        dataset = TensorDataset(torch.from_numpy(x_raw.astype(np.float32)))
        loader = torch.utils.data.DataLoader(dataset, batch_size=max(1, int(_num(params, "batch", 256))), shuffle=False)
        row_keys = starts
        prediction = _predict_loader(env, model, loader, device)
    else:
        namespace = bundle.plugin if isinstance(bundle.plugin, dict) else {}
        predict_params = dict(params)
        if not _names(predict_params.get("features")) and bundle.feature_names:
            predict_params["features"] = ",".join(bundle.feature_names)
        if not _names(predict_params.get("label")) and bundle.target_names:
            predict_params["label"] = ",".join(bundle.target_names)
        input_mode = str(bundle.metadata.get("inputMode") or "table")
        predict_params["inputMode"] = "时序窗口" if input_mode == "sequence" else "表格"
        for key, fallback in (("window", 48), ("horizon", 1), ("stride", 1)):
            predict_params[key] = int(bundle.metadata.get(key, fallback))
        if callable(namespace.get("build_dataloader")):
            loader, _ = _build_direct_dataloader(
                namespace,
                data,
                "test",
                predict_params,
                scaler,
                int(_num(params, "seed", 42)),
            )
        else:
            dataset, _, _, _, selected_rows = _custom_dataset(
                namespace,
                data,
                "test",
                predict_params,
                scaler,
                "分类" if _is_classification(bundle.task) else "回归",
                "预测数据",
                time_columns=getattr(env, "time_columns", ()),
                require_target=False,
                classes=bundle.classes,
            )
            if input_mode == "sequence" and selected_rows is not None:
                target_rows = np.asarray(selected_rows, dtype=np.int64)
                row_keys = data.index.to_numpy()[target_rows]
            loader, _ = _make_dataloader(
                namespace,
                dataset,
                "test",
                predict_params,
                int(_num(params, "seed", 42)),
            )
        prediction = _predict_loader(
            env,
            model,
            loader,
            device,
            step_fn=namespace.get("predict_step"),
            spec=bundle.spec,
        )

    env.set_meta({"设备": target, "预测样本数": int(len(prediction))})
    return {
        "predictions": _prediction_frame(
            prediction,
            bundle,
            data,
            params,
            row_keys,
            target_rows,
        )
    }


def op_train_cnn1d(env, params, inputs, output_ports):
    """真训练：在用户准备好的多通道定长样本上训一个 1D-CNN。

    与 `train.mlp` 的分工：那个解决"小表 + 扁平特征"，这个解决**时序信号**。
    卷积看的是"一帧之内相邻点之间的关系"，所以输入必须是 (通道 × 窗长) 的二维块 ——
    也就是定长样本表，不是原始长表。

    样本**常驻主机内存、按批搬上卡**：4GB 的显存装不下几十万帧，但装得下一批。
    这样显存只决定"批能开多大"，能训多少数据由主机内存决定 —— 对笔记本上的小卡
    是唯一可行的分法。
    """
    import torch
    from torch import nn

    train = _as_frame(inputs.get("train"), "训练帧")
    val = inputs.get("val")
    val_frame = _as_frame(val, "验证帧") if val is not None else None

    try:
        label_names = _resolve_column_selection(
            train, params.get("label"), "训练帧", "标签", getattr(env, "time_columns", ())
        )
    except KeyError as err:
        raise KeyError(f"标签要靠样本表里的标签列带过来；{err.args[0]}") from err
    if not label_names:
        raise ValueError(
            "要先指定标签列：训练节点需要知道每一帧是什么。"
            "请在样本表中保留标签列，并填写列名或数值通道序号"
        )
    if len(label_names) != 1:
        raise ValueError("这个训练节点只支持一个标签列")
    label_name = str(label_names[0])

    x_train_raw, starts, channels, window = _frames_from_table(train, "训练帧")
    y_train = _labels_for_frames(train, starts, label_name, "训练帧")

    keep = np.isfinite(x_train_raw.reshape(x_train_raw.shape[0], -1)).all(axis=1)
    keep &= pd.notna(y_train)
    if not keep.any():
        raise ValueError("训练集里没有一帧是完整的（点值与标签都不能有缺失）")
    x_train_raw = x_train_raw[keep]
    y_train = y_train[keep]

    task = str(params.get("task") or "auto")
    if task == "auto":
        task = _infer_task(y_train)
    if task not in ("分类", "回归"):
        raise ValueError(f"不认识的训练任务「{task}」，可选：auto、分类、回归")
    if task == "回归" and not np.issubdtype(np.asarray(y_train).dtype, np.number):
        raise ValueError("回归的标签必须是数值；如果它是类别名，把任务改成「分类」")

    epochs = max(1, int(_num(params, "epochs", 30)))
    hidden = max(1, int(_num(params, "hidden", 32)))
    kernel = int(_num(params, "kernel", 5))
    batch = max(1, int(_num(params, "batch", 128)))
    lr = _num(params, "lr", 1e-3)
    dropout = _num(params, "dropout", 0.2)
    seed = int(_num(params, "seed", 42))
    if kernel < 3 or kernel % 2 == 0:
        raise ValueError(f"卷积核要是 ≥3 的奇数（两侧对称 padding），收到 {kernel}")
    if lr <= 0:
        raise ValueError(f"学习率必须大于 0，收到 {lr:g}")
    if not 0 <= dropout < 1:
        raise ValueError(f"Dropout 要落在 [0, 1) 之间，收到 {dropout:g}")

    device = str(params.get("device") or "auto")
    target = device_probe.resolve(device)
    if target == "cuda" and not torch.cuda.is_available():
        target = "cpu"
    torch_device = torch.device(target)
    if target == "cuda":
        # 峰值显存要的是**这一次**的读数：不重置的话它会记着上一次（甚至别的图）的高水位
        torch.cuda.reset_peak_memory_stats()

    torch.manual_seed(seed)
    if target == "cuda":
        torch.cuda.manual_seed_all(seed)
    # 逐通道标准化，统计量**只在训练集上算**：在验证集上再算一遍就是信息泄漏
    center = x_train_raw.mean(axis=(0, 2), keepdims=True)
    scale = x_train_raw.std(axis=(0, 2), keepdims=True)
    scale[scale == 0] = 1.0
    x_train = (x_train_raw - center) / scale

    x_val = None
    y_val = None
    if val_frame is not None:
        v_raw, v_starts, v_channels, v_window = _frames_from_table(val_frame, "验证帧")
        if v_channels != channels or v_window != window:
            raise ValueError(
                f"验证帧的形状是 {v_channels} 通道 × {v_window} 点，训练帧是 "
                f"{channels} × {window} —— 两者必须一致，否则卷积核一个都用不上"
            )
        v_labels = _labels_for_frames(val_frame, v_starts, label_name, "验证帧")
        # 先按帧取好标签再筛行：反过来会得到"标签行数对不上帧数"的假错
        v_keep = np.isfinite(v_raw.reshape(v_raw.shape[0], -1)).all(axis=1)
        v_keep &= pd.notna(v_labels)
        x_val = ((v_raw[v_keep] - center) / scale).astype(np.float32)
        y_val = v_labels[v_keep]

    if task == "分类":
        classes, y_indices = np.unique(y_train, return_inverse=True)
        y_train_index = y_indices.astype(np.int64)
        output_dim = int(classes.size)
    else:
        classes = None
        y_train_index = None
        output_dim = 1

    class Net(nn.Module):
        """两层卷积 + 全局平均池化。

        刻意**不用 BatchNorm**：批大小 1（样本数不是批大小的整数倍时最后一批）会让
        BN 在训练态直接抛错，而把最后一批丢掉又会悄悄少算样本。对一个小网络来说，
        逐通道标准化 + Dropout 已经够了。
        """

        def __init__(self, in_channels: int):
            super().__init__()
            pad = kernel // 2
            self.body = nn.Sequential(
                nn.Conv1d(in_channels, hidden, kernel, padding=pad),
                nn.ReLU(),
                nn.MaxPool1d(2),
                nn.Conv1d(hidden, hidden * 2, kernel, padding=pad),
                nn.ReLU(),
                nn.AdaptiveAvgPool1d(1),
            )
            self.head = nn.Sequential(
                nn.Flatten(),
                nn.Dropout(dropout),
                nn.Linear(hidden * 2, output_dim),
            )

        def forward(self, x):
            return self.head(self.body(x))

    model = Net(channels).to(torch_device)
    criterion = nn.CrossEntropyLoss() if task == "分类" else nn.MSELoss()
    from torch.utils.data import DataLoader, TensorDataset

    train_targets = (
        y_train_index.astype(np.int64)
        if classes is not None
        else y_train.astype(np.float32)
    )
    train_loader = DataLoader(
        TensorDataset(torch.from_numpy(x_train.astype(np.float32)), torch.from_numpy(train_targets)),
        batch_size=batch,
        shuffle=True,
        generator=torch.Generator().manual_seed(seed),
        drop_last=False,
    )

    # 早停。与 train.mlp 同一份判据（`EarlyStop`），这里只负责"什么时候存快照、
    # 什么时候停、停完用谁重读指标"
    y_np = y_train_index.astype(np.int64) if classes is not None else y_train.astype(np.float32)

    rows = x_train.shape[0]
    has_val = x_val is not None and y_val is not None and len(x_val) > 0

    def step(batch):
        batch_x_cpu, batch_y_cpu = batch
        batch_x = batch_x_cpu.to(torch_device)
        batch_y = batch_y_cpu.to(torch_device)
        output = model(batch_x)
        loss = criterion(output.squeeze(-1) if classes is None else output, batch_y)
        return loss, int(batch_x.shape[0]), {}, None, None

    def validate():
        if not has_val:
            return {}
        return _validation(model, criterion, x_val, y_val, task, torch_device, classes)

    # 与 train.mlp 走**同一个**训练循环（调度器、精度、梯度累积、早停、取消、进度
    # 都在那一份里）。这个节点的差别只在数据与 loss：帧是 (通道 × 窗长) 的二维块
    outcome = _run_training(
        env,
        model,
        train_loader,
        params=params,
        device=torch_device,
        epochs=epochs,
        step=step,
        validate=validate,
        has_val=has_val,
    )
    history = outcome.history
    stop = outcome.stop
    restored = outcome.restored
    elapsed = outcome.elapsed

    metrics = {
        "训练样本数": float(rows),
        "通道数": float(channels),
        "窗长": float(window),
        "参数量": float(sum(p.numel() for p in model.parameters())),
        # 实际跑了多少轮：早停时它小于「轮数」参数
        "训练轮数": float(len(history)),
        "批次大小": float(batch),
        "学习率": float(lr),
        # 「最终」= **交付的那份权重**在训练集上的损失，所以一律事后复核一遍。
        # 曲线里那一行的"训练损失"是**这一轮边训边测**的平均（权重在轮内一直在变），
        # 它记的是过程；拿它当"最终损失"会描述一个并不是你拿到的模型。
        # 早停之后这一点尤其藏不住：那时最后几轮的数与交付的权重根本不是同一份。
        "最终训练损失": _mean_loss(
            model, criterion, x_train, y_np, torch_device, batch, classes is None
        ),
        "耗时秒": round(elapsed, 3),
        # 用 1/0 而不是 True/False：输出摘要的数值口径只认数字
        "用了GPU": 1.0 if target == "cuda" else 0.0,
        **outcome.facts(),
    }
    if stop is not None:
        metrics["最佳轮次"] = float(stop.best_epoch)
        metrics["早停触发"] = 1.0 if stop.triggered else 0.0
    if target == "cuda":
        # 峰值显存：这是"4GB 能开到多大"那个问题的机器读数，不是估的
        metrics["显存峰值MB"] = round(torch.cuda.max_memory_allocated() / (1024 * 1024), 1)
    # 最终验证读数：早停之后按恢复的权重重读；曲线里那一行不动（它记的是当时真的算出了什么）
    final_val = (
        _validation(model, criterion, x_val, y_val, task, torch_device, classes)
        if restored and x_val is not None and y_val is not None and len(x_val) > 0
        else history[-1]
    )
    for key in ("验证损失", "验证准确率", "验证R2"):
        if key in final_val:
            metrics[f"最终{key}"] = float(final_val[key])

    history_frame = pd.DataFrame(history)
    bundle = ModelBundle(
        module=model,
        node_type="train.cnn1d",
        task="classification" if task == "分类" else "regression",
        spec=ModelSpec(
            input_shape=(channels, window),
            output_shape=(output_dim,),
            input_axes=("channel", "time"),
            output_axes=("target",),
            task="classification" if task == "分类" else "regression",
            target_names=(label_name,),
        ),
        feature_names=tuple(f"点{i}" for i in range(window)),
        target_names=(label_name,),
        classes=classes,
        center=center,
        scale=scale,
        metadata={"adapter": "cnn1d", "channels": channels, "window": window},
    )
    metrics["产物落盘"] = _save_training_artifacts(
        env, "train.cnn1d", bundle, metrics, history_frame, params,
        inputs=inputs, training_params=params,
    )
    _note_environment(
        env,
        target,
        _training_notes(stop, epochs, outcome),
    )
    # curve 是"直出"的那一支：节点上不必再手工接一个图表节点就能看到走势
    return {
        "model": bundle,
        "metrics": metrics,
        "history": history_frame,
        "curve": _curve_table(history_frame),
    }


def op_train_mlp(env, params, inputs, output_ports):
    """真训练：在训练集上训一个小 MLP，返回指标与逐轮曲线。

    有 CUDA 就用 CUDA。这里不使用任何占位训练逻辑 —— 它是真的在算梯度，
    所以它返回的指标没有 `simulated` 标记。
    """
    import torch
    from torch import nn

    train = _as_frame(inputs.get("train"), "训练集")
    val = inputs.get("val")
    val_frame = _as_frame(val, "验证集") if val is not None else None

    label_names = _resolve_column_selection(
        train, params.get("label"), "训练集", "标签", getattr(env, "time_columns", ())
    )
    if not label_names:
        raise ValueError(
            "要先指定标签列：训练节点需要知道哪一列是答案，"
            "可填写列名或数值通道序号"
        )
    if len(label_names) != 1:
        raise ValueError("这个训练节点只支持一个标签列")
    label_name = label_names[0]

    feature_names = _resolve_column_selection(
        train, params.get("features"), "训练集", "特征", getattr(env, "time_columns", ())
    )
    if feature_names:
        picks = train[feature_names]
    else:
        wanted = [
            column
            for column in _numeric_signal_columns(train, getattr(env, "time_columns", ()))
            if column != label_name
        ]
        picks = train[wanted]

    # 训练只接收数值特征；时间列是索引属性，不应悄悄作为输入。
    features = picks.select_dtypes(include=[np.number])
    time_columns = {str(name) for name in getattr(env, "time_columns", [])}
    if time_columns:
        features = features.drop(columns=[name for name in features.columns if str(name) in time_columns])
    if features.shape[1] == 0:
        raise ValueError("除掉标签列与时间列之后没有可用的特征列")

    labels = np.asarray(train[label_name].to_numpy())
    rows = np.isfinite(np.asarray(features, dtype=np.float64)).all(axis=1)
    rows &= pd.notna(labels)
    if not rows.any():
        raise ValueError("训练集里没有一行是完整的（特征与标签都不能有缺失值）")

    features = features.loc[rows]
    labels = labels[rows]

    task = str(params.get("task") or "auto")
    if task == "auto":
        task = _infer_task(labels)
    if task not in ("分类", "回归"):
        raise ValueError(f"不认识的训练任务「{task}」，可选：auto、分类、回归")
    if task == "回归" and not np.issubdtype(labels.dtype, np.number):
        raise ValueError("回归的标签列必须是数值列；如果它是类别名，把任务改成「分类」")

    epochs = max(1, int(_num(params, "epochs", 50)))
    hidden = max(1, int(_num(params, "hidden", 64)))
    lr = _num(params, "lr", 1e-3)
    batch = max(1, int(_num(params, "batch", 64)))
    seed = int(_num(params, "seed", 42))
    if lr <= 0:
        raise ValueError(f"学习率必须大于 0，收到 {lr:g}")

    requested = str(params.get("device") or "auto")
    target = device_probe.resolve(requested)
    if target == "cuda" and not torch.cuda.is_available():
        target = "cpu"
    torch_device = torch.device(target)

    # 种子固定：CPU 上可复现；CUDA 上仍有非确定性算子，所以运行清单必须记设备与
    # torch 版本 —— 否则同一个工程在两台机器上结果对不上时无从判断（见开发日志）
    torch.manual_seed(seed)
    if target == "cuda":
        torch.cuda.manual_seed_all(seed)
    x_train_raw = np.asarray(features, dtype=np.float32)
    # 标准化统计量**只在训练集上算**：在验证集上再算一遍就是信息泄漏，
    # 会让验证分数好看一点，而那个数字没有任何意义
    center = x_train_raw.mean(axis=0, keepdims=True)
    scale = x_train_raw.std(axis=0, keepdims=True)
    scale[scale == 0] = 1.0
    x_train = (x_train_raw - center) / scale

    x_val = None
    y_val = None
    if val_frame is not None and label_name in val_frame.columns:
        val_features = val_frame[[str(c) for c in features.columns]]
        x_val = (np.asarray(val_features, dtype=np.float32) - center) / scale
        y_val = np.asarray(val_frame[label_name].to_numpy())

    x_tensor = torch.from_numpy(x_train)
    # 标签 → 类别下标。用 np.unique 的 inverse 而不是自己数：它同时处理数值与字符串
    # 标签，而且类别顺序是确定排序的（"按出现顺序编号"会让同一份数据换个行序就换编号）
    if task == "分类":
        classes, y_indices = np.unique(labels, return_inverse=True)
    else:
        classes, y_indices = None, None
    if classes is not None and y_indices is not None:
        y_tensor = torch.from_numpy(y_indices.astype(np.int64))
        output_dim = int(classes.size)
    else:
        y_tensor = torch.from_numpy(labels.astype(np.float32))
        output_dim = 1

    def build() -> nn.Module:
        return nn.Sequential(
            nn.Linear(x_train.shape[1], hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, output_dim),
        )

    model = build().to(torch_device)
    criterion = nn.CrossEntropyLoss() if task == "分类" else nn.MSELoss()
    from torch.utils.data import DataLoader, TensorDataset

    train_loader = DataLoader(
        TensorDataset(x_tensor, y_tensor),
        batch_size=batch,
        shuffle=True,
        generator=torch.Generator().manual_seed(seed),
        drop_last=False,
    )

    # 复核最终损失要用的标签数组（与 x_train 逐行对齐）：分类是下标，回归是浮点
    y_np = y_indices.astype(np.int64) if classes is not None else labels.astype(np.float32)
    rows_count = x_train.shape[0]
    has_val = x_val is not None and y_val is not None and len(x_val) > 0

    def step(batch):
        # 这个节点的"一个 batch"就是普通 (x, y)：结构固定，所以它可以零代码训练，
        # 代价是换 batch 结构要改用 train.custom（见开发日志的分档）
        batch_x_cpu, batch_y_cpu = batch
        batch_x = batch_x_cpu.to(torch_device)
        batch_y = batch_y_cpu.to(torch_device)
        output = model(batch_x)
        # 回归的输出是 (N,1) 而标签是 (N,)：不 squeeze 的话损失函数会静默广播，
        # 照样返回一个数，但那个数没有意义（只在日志里留一行 warning）
        loss = criterion(output.squeeze(-1) if classes is None else output, batch_y)
        return loss, int(batch_x.shape[0]), {}, None, None

    def validate():
        if not has_val:
            return {}
        return _validation(model, criterion, x_val, y_val, task, torch_device, classes)

    # 训练循环（优化器、调度器、精度、累积、早停、取消、进度）只有一份实现：
    # 三个训练节点之间的差别是"数据从哪来、loss 怎么算"，不是"循环怎么写"
    outcome = _run_training(
        env,
        model,
        train_loader,
        params=params,
        device=torch_device,
        epochs=epochs,
        step=step,
        validate=validate,
        has_val=has_val,
    )
    history = outcome.history
    stop = outcome.stop
    restored = outcome.restored
    elapsed = outcome.elapsed

    metrics = {
        "训练样本数": float(rows_count),
        "特征数": float(x_train.shape[1]),
        "参数量": float(sum(p.numel() for p in model.parameters())),
        # 实际跑了多少轮：早停时它小于「轮数」参数，而报告里要看的是这个
        "训练轮数": float(len(history)),
        "批次大小": float(batch),
        "学习率": float(lr),
        # 与 train.cnn1d 同一条口径：「最终训练损失」= **交付的那份权重**在训练集上的损失，
        # 所以一律事后复核一遍。曲线里那一行是"这一轮边训边测"的平均，记的是过程；
        # 早停之后这一点尤其藏不住 —— 最后几轮的数与交付的权重根本不是同一份
        "最终训练损失": _mean_loss(
            model, criterion, x_train, y_np, torch_device, batch, classes is None
        ),
        "耗时秒": round(elapsed, 3),
        # 用 1/0 而不是 True/False：输出摘要的数值口径只认数字，得让它能显示出来
        "用了GPU": 1.0 if target == "cuda" else 0.0,
        **outcome.facts(),
    }
    if stop is not None:
        metrics["最佳轮次"] = float(stop.best_epoch)
        metrics["早停触发"] = 1.0 if stop.triggered else 0.0
    # 最终验证读数。**早停回到最佳权重之后必须按恢复后的模型重读**，否则「最终验证损失」
    # 描述的是另一个模型。但曲线里那一行不能跟着改 —— 它记的是"当时那一轮真的算出了什么"，
    # 改了它，图上就会画出一个从没发生过的点。
    final_val = (
        _validation(model, criterion, x_val, y_val, task, torch_device, classes)
        if restored and x_val is not None and y_val is not None and len(x_val) > 0
        else history[-1]
    )
    for key in ("验证损失", "验证准确率", "验证R2"):
        if key in final_val:
            metrics[f"最终{key}"] = float(final_val[key])

    history_frame = pd.DataFrame(history)
    bundle = ModelBundle(
        module=model,
        node_type="train.mlp",
        task="classification" if task == "分类" else "regression",
        spec=ModelSpec(
            input_shape=(x_train.shape[1],),
            output_shape=(output_dim,),
            input_axes=("feature",),
            output_axes=("target",),
            task="classification" if task == "分类" else "regression",
            feature_names=tuple(str(c) for c in features.columns),
            target_names=(label_name,),
        ),
        feature_names=tuple(str(c) for c in features.columns),
        target_names=(label_name,),
        classes=classes,
        center=center,
        scale=scale,
        metadata={"adapter": "mlp"},
    )
    # 产物落盘：每次训练写入新的 `<仓库>/.artifacts/<artifact_id>/`，
    # 路径、制品身份与校验值随结果回传给运行清单（见 `_save_training_artifacts`）。
    metrics["产物落盘"] = _save_training_artifacts(
        env, "train.mlp", bundle, metrics, history_frame, params,
        inputs=inputs, training_params=params,
    )
    _note_environment(
        env,
        target,
        _training_notes(stop, epochs, outcome),
    )
    return {
        "model": bundle,
        "metrics": metrics,
        "history": history_frame,
        "curve": _curve_table(history_frame),
    }


def _mean_loss(model, criterion, x, y, torch_device, batch: int, squeeze: bool) -> float:
    """在一整份数据上算平均损失（不开梯度、不更新参数）。

    只有一个时候会用到它：**早停回到最佳权重之后**。那时"最后一轮"的读数描述的是
    一个你并没有拿到的模型，而指标的名字叫「最终」—— 它必须描述交付出去的那份权重，
    否则指标与权重是两件事，而这正是复现记录里最难查的那种错。
    """
    import torch

    n = int(x.shape[0])
    if n == 0:
        return float("nan")
    size = max(1, int(batch))
    # 类别下标是整数，回归目标是浮点：dtype 猜错会让损失函数广播出一个没有意义的数
    label_dtype = torch.long if np.asarray(y).dtype.kind in "iu" else torch.float32

    model.eval()
    total = 0.0
    with torch.no_grad():
        for start in range(0, n, size):
            stop = min(start + size, n)
            chunk_x = torch.as_tensor(x[start:stop], dtype=torch.float32, device=torch_device)
            chunk_y = torch.as_tensor(y[start:stop], dtype=label_dtype, device=torch_device)
            out = model(chunk_x)
            loss = criterion(out.squeeze(-1) if squeeze else out, chunk_y)
            total += float(loss.detach().cpu()) * (stop - start)
    model.train()
    return total / n


def _validation(model, criterion, x_val, y_val, task, torch_device, classes):
    """验证集上的损失与分数。用 eval() + no_grad：不关掉 dropout/bn 与梯度，
    验证分数会随批次抖动，看起来像"训练不稳定"
    """
    import torch

    model.eval()
    with torch.no_grad():
        x_tensor = torch.from_numpy(x_val).to(torch_device)
        if classes is not None:
            # 验证集里出现训练集没有的类别时只能丢掉那一行：给它编一个下标
            # 等于把噪声当正例喂进去，准确率会莫名其妙地偏低
            index_of = {value: index for index, value in enumerate(classes.tolist())}
            valid = np.array([v in index_of for v in y_val])
            if not valid.any():
                model.train()
                return {}
            x_tensor = x_tensor[valid]
            y_indices = np.array([index_of[v] for v in y_val[valid]], dtype=np.int64)
            y_tensor = torch.from_numpy(y_indices).to(torch_device)
            output = model(x_tensor)
            loss = float(criterion(output, y_tensor).detach().cpu())
            predicted = output.argmax(dim=1).cpu().numpy()
            accuracy = float((predicted == y_indices).mean())
            model.train()
            return {"验证损失": loss, "验证准确率": accuracy}

        y_tensor = torch.from_numpy(y_val.astype(np.float32)).to(torch_device)
        output = model(x_tensor).squeeze(-1)
        loss = float(criterion(output, y_tensor).detach().cpu())
        target = y_tensor.cpu().numpy()
        prediction = output.cpu().numpy()
        residual = float(((target - prediction) ** 2).sum())
        total = float(((target - target.mean()) ** 2).sum())
        r2 = 1.0 - residual / total if total > 0 else float("nan")
        model.train()
        return {"验证损失": loss, "验证R2": r2}


#: 只有本地宿主能提供的算子。键是节点类型，与前端 nodeRegistry 里的 id 对应
OPERATORS = {
    "custom.model": op_custom_model,
    "train.function": op_train_function,
    "train.custom": op_train_custom,
    "train.mlp": op_train_mlp,
    "train.cnn1d": op_train_cnn1d,
    "model.predict": op_model_predict,
}
