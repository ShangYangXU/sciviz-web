"""SciViz 自定义 PyTorch 模型的宿主侧接口。

这个模块只描述模型与数据加载的边界，不负责具体的训练循环。画布上传递的
是 table / tensor；Dataset 和 DataLoader 是宿主进程内的临时运行对象，由
训练算子创建。模型代码只负责网络结构，并用 `MODEL_PARAMS` 声明自己的超参数；可选的
`MODEL_INTERFACE` 用安全字面量声明端口契约，避免从 `forward` 签名猜测画布接口；
训练轮数、批大小、优化器以及表格/时序窗口的数据布局都由训练节点管理。
复杂模型仍然可以选择自定义 Dataset、collate_fn 或 sampler。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import ast
import json
import math
import re
import inspect
from collections.abc import Mapping as MappingABC
from typing import Any, Literal, Mapping, Protocol, Sequence, cast


TaskName = Literal["classification", "regression"]
ModelParamType = Literal[
    "int", "float", "bool", "text", "select",
    "list[int]", "list[float]", "list[str]", "list[bool]",
]
ModelParamScalar = str | int | float | bool
ModelParamDefault = ModelParamScalar | tuple[ModelParamScalar, ...]
ModelParamValue = ModelParamScalar | list[ModelParamScalar]
ModelListItemType = Literal["int", "float", "str", "bool"]
ModelPortType = Literal["any", "table", "tensor", "model", "metrics", "figure", "scaler"]
MAX_MODEL_LIST_ITEMS = 64
MAX_SAFE_MODEL_INT = 2**53 - 1
MAX_MODEL_INTERFACE_PORTS = 64


@dataclass(frozen=True)
class ModelInterfacePort:
    """模型接口上的一个可序列化端口描述。"""

    id: str
    type: ModelPortType
    label: str
    optional: bool = False
    multiple: bool = False
    shape: tuple[int | str, ...] = ()
    axes: tuple[str, ...] = ()
    dtype: str | None = None
    unit: str | None = None
    description: str | None = None


@dataclass(frozen=True)
class ModelInterface:
    inputs: tuple[ModelInterfacePort, ...] = ()
    outputs: tuple[ModelInterfacePort, ...] = ()


@dataclass(frozen=True)
class ModelParamSpec:
    """一个可由模型代码声明、并在模型节点中编辑的超参数。"""

    key: str
    type: ModelParamType
    default: ModelParamDefault
    required: bool = False
    label: str | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    options: tuple[str, ...] = ()
    hint: str | None = None
    min_items: int = 0
    max_items: int = MAX_MODEL_LIST_ITEMS
    item_min: float | None = None
    item_max: float | None = None


def _param_type(raw: Any, default: ModelParamScalar, options: Sequence[str]) -> ModelParamType:
    text = str(raw or "").strip().lower()
    if options or text in {"select", "enum", "choice"}:
        return "select"
    if text in {"int", "integer"} or (not text and isinstance(default, int) and not isinstance(default, bool)):
        return "int"
    if text in {"float", "number", "double"} or (not text and isinstance(default, float)):
        return "float"
    if text in {"bool", "boolean"} or (not text and isinstance(default, bool)):
        return "bool"
    if text in {"str", "string", "text"} or not text:
        return "text"
    raise ValueError(f"MODEL_PARAMS 中的参数类型「{raw}」不支持")


def _param_scalar(value: Any, key: str) -> ModelParamScalar:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return value
    if isinstance(value, str):
        return value
    raise TypeError(f"MODEL_PARAMS 参数「{key}」的 default 必须是数字、文字或布尔值")


def _normalize_list_type(raw_type: Any, default: Any, key: str) -> tuple[ModelParamType, ModelListItemType]:
    declared = str(raw_type or "").strip().lower()
    type_map: dict[str, ModelListItemType] = {
        "list[int]": "int",
        "list[float]": "float",
        "list[str]": "str",
        "list[bool]": "bool",
    }
    if not declared:
        raise ValueError(f"MODEL_PARAMS 参数「{key}」的列表必须显式声明 type")
    item_type = type_map.get(declared)
    if item_type is None:
        raise ValueError(
            f"MODEL_PARAMS 参数「{key}」的列表 type 必须是 list[int]、list[float]、list[str] 或 list[bool]"
        )
    if not isinstance(default, (list, tuple)):
        raise TypeError(f"MODEL_PARAMS 参数「{key}」的列表 default 必须是一维列表")
    return cast(ModelParamType, declared), item_type


def _validate_model_list_items(raw: Any, item_type: ModelListItemType, key: str, source: str) -> list[ModelParamScalar]:
    if not isinstance(raw, (list, tuple)):
        raise TypeError(f"模型参数「{key}」的 {source} 必须是 JSON 列表")
    if len(raw) > MAX_MODEL_LIST_ITEMS:
        raise ValueError(f"模型参数「{key}」最多允许 {MAX_MODEL_LIST_ITEMS} 项")
    result: list[ModelParamScalar] = []
    for index, value in enumerate(raw, start=1):
        valid = (
            (
                item_type == "int"
                and isinstance(value, int)
                and not isinstance(value, bool)
                and abs(value) <= MAX_SAFE_MODEL_INT
            )
            or (
                item_type == "int"
                and isinstance(value, float)
                and math.isfinite(value)
                and value.is_integer()
                and abs(value) <= MAX_SAFE_MODEL_INT
            )
            or (item_type == "float" and isinstance(value, (int, float)) and not isinstance(value, bool))
            or (item_type == "str" and isinstance(value, str))
            or (item_type == "bool" and isinstance(value, bool))
        )
        if not valid:
            raise ValueError(f"模型参数「{key}」第 {index} 项不是有效的 {item_type} 值")
        if item_type == "int":
            result.append(int(value))
        elif item_type == "float":
            try:
                numeric = float(value)
            except OverflowError as err:
                raise ValueError(f"模型参数「{key}」第 {index} 项超出有限数字范围") from err
            if not math.isfinite(numeric):
                raise ValueError(f"模型参数「{key}」第 {index} 项必须是有限数字")
            result.append(numeric)
        else:
            result.append(value)
    return result


def _nonnegative_int(config: Mapping[str, Any], key: str, name: str, fallback: int) -> int:
    value = config.get(name, fallback)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise TypeError(f"MODEL_PARAMS 参数「{key}」的 {name} 必须是非负整数")
    return value


def _optional_finite_number(config: Mapping[str, Any], key: str, name: str) -> float | None:
    value = config.get(name)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise TypeError(f"MODEL_PARAMS 参数「{key}」的 {name} 必须是有限数字")
    return float(value)


def _interface_text(config: Mapping[str, Any], key: str, name: str) -> str | None:
    value = config.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"MODEL_INTERFACE 端口「{key}」的 {name} 必须是文字")
    return value


def _interface_shape(config: Mapping[str, Any], key: str) -> tuple[int | str, ...]:
    value = config.get("shape")
    if value is None:
        return ()
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or len(value) > 16:
        raise TypeError(f"MODEL_INTERFACE 端口「{key}」的 shape 必须是不超过 16 项的列表")
    result: list[int | str] = []
    for item in value:
        if isinstance(item, bool):
            raise TypeError(f"MODEL_INTERFACE 端口「{key}」的 shape 只能包含非负整数或非空字符串")
        if isinstance(item, int) and 0 <= item <= MAX_SAFE_MODEL_INT:
            result.append(item)
        elif (
            isinstance(item, float)
            and math.isfinite(item)
            and item.is_integer()
            and 0 <= item <= MAX_SAFE_MODEL_INT
        ):
            result.append(int(item))
        elif isinstance(item, str) and item.strip():
            result.append(item.strip())
        else:
            raise TypeError(f"MODEL_INTERFACE 端口「{key}」的 shape 只能包含非负整数或非空字符串")
    return tuple(result)


def _interface_axes(config: Mapping[str, Any], key: str) -> tuple[str, ...]:
    value = config.get("axes")
    if value is None:
        return ()
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise TypeError(f"MODEL_INTERFACE 端口「{key}」的 axes 必须是字符串列表")
    if any(not isinstance(item, str) or not item.strip() for item in value):
        raise TypeError(f"MODEL_INTERFACE 端口「{key}」的 axes 必须是字符串列表")
    return tuple(str(item).strip() for item in value)


def _normalize_interface_direction(raw: Any, direction: str) -> tuple[ModelInterfacePort, ...]:
    if raw is None:
        return ()
    if isinstance(raw, MappingABC):
        items = list(raw.items())
    elif isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)):
        items = [(None, item) for item in raw]
    else:
        raise TypeError(f"MODEL_INTERFACE 的 {direction} 必须是端口列表或字典")
    if len(items) > MAX_MODEL_INTERFACE_PORTS:
        raise ValueError(f"MODEL_INTERFACE 的 {direction} 最多允许 {MAX_MODEL_INTERFACE_PORTS} 个端口")
    allowed = {"any", "table", "tensor", "model", "metrics", "figure", "scaler"}
    reserved = {"model"} if direction == "outputs" else set()
    result: list[ModelInterfacePort] = []
    seen: set[str] = set()
    for shorthand_id, declaration in items:
        if isinstance(declaration, str):
            config: Mapping[str, Any] = {"type": declaration}
        elif isinstance(declaration, MappingABC):
            config = declaration
        else:
            raise TypeError(f"MODEL_INTERFACE 的 {direction} 端口声明必须是字典或类型字符串")
        raw_id = config.get("id", shorthand_id)
        if not isinstance(raw_id, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", raw_id):
            raise ValueError(f"MODEL_INTERFACE 的 {direction} 端口 id 必须是合法标识符")
        key = raw_id
        if key in seen:
            raise ValueError(f"MODEL_INTERFACE 的 {direction} 存在重复端口「{key}」")
        if key in reserved:
            raise ValueError("MODEL_INTERFACE 输出不能使用保留名称「model」")
        seen.add(key)
        port_type = str(config.get("type") or "").strip().lower()
        if port_type not in allowed:
            raise ValueError(f"MODEL_INTERFACE 端口「{key}」的 type「{port_type}" + "」不受支持")
        optional = config.get("optional", False)
        multiple = config.get("multiple", False)
        if not isinstance(optional, bool) or not isinstance(multiple, bool):
            raise TypeError(f"MODEL_INTERFACE 端口「{key}」的 optional / multiple 必须是布尔值")
        port_shape = _interface_shape(config, key)
        axes = _interface_axes(config, key)
        if config.get("shape") is not None and config.get("axes") is not None and len(port_shape) != len(axes):
            raise ValueError(f"MODEL_INTERFACE 端口「{key}」的 axes 长度必须与 shape 一致")
        result.append(
            ModelInterfacePort(
                id=key,
                type=cast(ModelPortType, port_type),
                label=_interface_text(config, key, "label") or key,
                optional=optional,
                multiple=multiple,
                shape=port_shape,
                axes=axes,
                dtype=_interface_text(config, key, "dtype"),
                unit=_interface_text(config, key, "unit"),
                description=_interface_text(config, key, "description"),
            )
        )
    return tuple(result)


def normalize_model_interface(raw: Any) -> ModelInterface:
    """规范化用户模型的 MODEL_INTERFACE 字面量，不执行任何工厂函数。"""

    if raw is None:
        return ModelInterface()
    if callable(raw):
        raise TypeError("MODEL_INTERFACE 必须是字面量字典，不能是函数")
    if not isinstance(raw, MappingABC):
        raise TypeError("MODEL_INTERFACE 必须是一个字典")
    return ModelInterface(
        inputs=_normalize_interface_direction(raw.get("inputs"), "inputs"),
        outputs=_normalize_interface_direction(raw.get("outputs"), "outputs"),
    )


def normalize_model_interface_source(source: str, raw: Any = None) -> ModelInterface:
    """按源码确认 MODEL_INTERFACE 是字面量，防止宿主接受浏览器已拒绝的动态表达式。"""

    try:
        tree = ast.parse(source or "")
    except SyntaxError as err:
        raise ValueError(f"模型代码无法解析：{err}") from err
    assignment: ast.expr | None = None
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "MODEL_INTERFACE" for target in statement.targets
        ):
            assignment = statement.value
            break
        if (
            isinstance(statement, ast.AnnAssign)
            and isinstance(statement.target, ast.Name)
            and statement.target.id == "MODEL_INTERFACE"
        ):
            assignment = statement.value
            break
    if assignment is None:
        return normalize_model_interface(None)
    try:
        literal = ast.literal_eval(assignment)
    except (ValueError, TypeError, SyntaxError) as err:
        raise ValueError("MODEL_INTERFACE 必须是安全的 Python 字面量，不能调用函数或引用变量") from err
    return normalize_model_interface(literal)


def normalize_model_param_specs(raw: Any) -> tuple[ModelParamSpec, ...]:
    """规范化模型代码里的 ``MODEL_PARAMS`` 声明。

    支持两种写法：

    ``{"hidden_dim": 64}`` 是最简写法；
    ``{"hidden_dim": {"type": "int", "default": 64, "min": 1}}`` 可以补充界面元数据。

    该函数只接受字面量映射。这样模型超参数可审计、可保存到工程文件，
    也不会为了读取控件配置而执行一个不受约束的工厂函数。
    """

    if raw is None:
        return ()
    if callable(raw):
        raw = raw()
    if not isinstance(raw, MappingABC):
        raise TypeError("MODEL_PARAMS 必须是一个字典")

    specs: list[ModelParamSpec] = []
    for raw_key, declaration in raw.items():
        key = str(raw_key)
        if not re.fullmatch(r"[A-Za-z_]\w*", key):
            raise ValueError(f"MODEL_PARAMS 参数名「{key}」不是合法的 Python 标识符")
        if isinstance(declaration, MappingABC):
            if "default" not in declaration:
                raise ValueError(f"MODEL_PARAMS 参数「{key}」缺少 default")
            config = declaration
        else:
            config = {"default": declaration}
        raw_default = config["default"]
        raw_options = config.get("options") or ()
        if isinstance(raw_options, (str, bytes)) or not isinstance(raw_options, Sequence):
            raise TypeError(f"MODEL_PARAMS 参数「{key}」的 options 必须是列表")
        options = tuple(str(option) for option in raw_options)
        declared_type = str(config.get("type") or "").strip().lower()
        if isinstance(raw_default, (list, tuple)) or declared_type.startswith("list"):
            kind, item_type = _normalize_list_type(config.get("type"), raw_default, key)
            if options:
                raise ValueError(f"MODEL_PARAMS 参数「{key}」的列表不能声明 options")
            default_items = _validate_model_list_items(raw_default, item_type, key, "default")
            min_items = _nonnegative_int(config, key, "minItems", 0)
            max_items = _nonnegative_int(config, key, "maxItems", MAX_MODEL_LIST_ITEMS)
            if max_items > MAX_MODEL_LIST_ITEMS:
                raise ValueError(f"MODEL_PARAMS 参数「{key}」的 maxItems 不能超过 {MAX_MODEL_LIST_ITEMS}")
            if min_items > max_items:
                raise ValueError(f"MODEL_PARAMS 参数「{key}」的 minItems 不能大于 maxItems")
            if not min_items <= len(default_items) <= max_items:
                raise ValueError(f"MODEL_PARAMS 参数「{key}」的 default 项数必须在 {min_items}–{max_items} 之间")
            item_min = _optional_finite_number(config, key, "itemMin")
            item_max = _optional_finite_number(config, key, "itemMax")
            if item_type not in {"int", "float"} and (item_min is not None or item_max is not None):
                raise ValueError(f"MODEL_PARAMS 参数「{key}」只有数值列表可以设置 itemMin / itemMax")
            if item_min is not None and item_max is not None and item_min > item_max:
                raise ValueError(f"MODEL_PARAMS 参数「{key}」的 itemMin 不能大于 itemMax")
            if item_type == "int" and item_min is not None and item_max is not None:
                if math.ceil(item_min) > math.floor(item_max):
                    raise ValueError(f"MODEL_PARAMS 参数「{key}」的整数 itemMin / itemMax 之间没有可用值")
            for item in default_items:
                if not isinstance(item, (int, float)) or isinstance(item, bool):
                    continue
                if item_min is not None and item < item_min:
                    raise ValueError(f"MODEL_PARAMS 参数「{key}」的 default 含有小于 itemMin 的值")
                if item_max is not None and item > item_max:
                    raise ValueError(f"MODEL_PARAMS 参数「{key}」的 default 含有大于 itemMax 的值")
            specs.append(
                ModelParamSpec(
                    key=key,
                    type=kind,
                    default=tuple(default_items),
                    label=str(config["label"]) if config.get("label") is not None else None,
                    options=(),
                    hint=str(config["hint"]) if config.get("hint") is not None else None,
                    min_items=min_items,
                    max_items=max_items,
                    item_min=item_min,
                    item_max=item_max,
                )
            )
            continue

        default = _param_scalar(raw_default, key)
        kind = _param_type(config.get("type"), default, options)
        if kind == "int":
            if isinstance(default, bool) or int(float(default)) != float(default):
                raise ValueError(f"MODEL_PARAMS 参数「{key}」的 int default 必须是整数")
            default = int(default)
        elif kind == "float":
            default = float(default)
        elif kind == "bool":
            if isinstance(default, str):
                default = default.strip().lower() in {"1", "true", "yes", "on", "是"}
            else:
                default = bool(default)
        elif kind in {"text", "select"}:
            default = str(default)
        minimum = config.get("min")
        maximum = config.get("max")
        step = config.get("step")
        for name, value in (("min", minimum), ("max", maximum), ("step", step)):
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value))):
                raise TypeError(f"MODEL_PARAMS 参数「{key}」的 {name} 必须是有限数字")
        if kind == "select" and options and str(default) not in options:
            raise ValueError(f"MODEL_PARAMS 参数「{key}」的 default 不在 options 中")
        specs.append(
            ModelParamSpec(
                key=key,
                type=kind,
                default=default,
                required=False,
                label=str(config["label"]) if config.get("label") is not None else None,
                min=float(minimum) if minimum is not None else None,
                max=float(maximum) if maximum is not None else None,
                step=float(step) if step is not None else None,
                options=options,
                hint=str(config["hint"]) if config.get("hint") is not None else None,
            )
        )
    return tuple(specs)


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


def infer_model_param_specs(model_class: Any) -> tuple[ModelParamSpec, ...]:
    """从 ``nn.Module`` 构造函数的标量默认值推断模型节点控件。

    数据相关参数（input_dim、output_dim、spec 等）由训练数据自动提供，不会显示为
    模型超参数。复杂的 tuple/list 默认值需要在代码里用 MODEL_PARAMS 显式声明，
    这样不会把无法安全转换的 Python 对象错误地传进构造函数。
    """

    try:
        parameters = inspect.signature(model_class).parameters.values()
    except (TypeError, ValueError):
        return ()
    specs: list[ModelParamSpec] = []
    for parameter in parameters:
        if parameter.name in _AUTO_MODEL_ARGUMENTS or parameter.kind in (
            inspect.Parameter.VAR_POSITIONAL,
            inspect.Parameter.VAR_KEYWORD,
        ):
            continue
        annotation = str(parameter.annotation).lower()
        has_default = parameter.default is not inspect.Parameter.empty
        if has_default:
            try:
                default = _param_scalar(parameter.default, parameter.name)
            except TypeError:
                continue
            required = False
        elif "bool" in annotation:
            default, required = False, True
        elif any(word in annotation for word in ("int", "float", "number", "double")):
            default, required = 0, True
        else:
            default, required = "", True
        if isinstance(default, bool):
            kind: ModelParamType = "bool"
        elif isinstance(default, int) and not isinstance(default, bool):
            kind = "int"
        elif isinstance(default, float):
            kind = "float"
        else:
            kind = "text"
        specs.append(
            ModelParamSpec(
                key=parameter.name,
                type=kind,
                default=default,
                required=required,
                hint=str(parameter.annotation) if parameter.annotation is not inspect.Parameter.empty else None,
                step=1.0 if kind == "int" else None,
            )
        )
    return tuple(specs)


def resolve_model_params(
    specs: Sequence[ModelParamSpec], values: Mapping[str, Any] | None,
) -> dict[str, ModelParamValue]:
    """使用节点里保存的值，并按模型声明做类型和范围校验。"""

    provided = values if isinstance(values, MappingABC) else {}
    result: dict[str, ModelParamValue] = {}
    for spec in specs:
        if spec.required and spec.key not in provided:
            raise ValueError(f"模型参数「{spec.key}」没有默认值，请在模型定义节点中填写")
        raw = provided.get(spec.key, spec.default)
        if spec.type.startswith("list["):
            raw_item_type = spec.type[5:-1]
            if raw_item_type not in {"int", "float", "str", "bool"}:
                raise ValueError(f"模型参数「{spec.key}」声明了不支持的列表类型 {spec.type}")
            item_type = cast(ModelListItemType, raw_item_type)
            if isinstance(raw, str):
                try:
                    raw_list = json.loads(raw)
                except json.JSONDecodeError as err:
                    raise ValueError(f"模型参数「{spec.key}」不是有效的 JSON 列表") from err
            else:
                raw_list = raw
            items = _validate_model_list_items(raw_list, item_type, spec.key, "值")
            if len(items) < spec.min_items:
                raise ValueError(f"模型参数「{spec.key}」至少需要 {spec.min_items} 项")
            if len(items) > spec.max_items:
                raise ValueError(f"模型参数「{spec.key}」最多允许 {spec.max_items} 项")
            for index, item in enumerate(items, start=1):
                if not isinstance(item, (int, float)) or isinstance(item, bool):
                    continue
                if spec.item_min is not None and item < spec.item_min:
                    raise ValueError(f"模型参数「{spec.key}」第 {index} 项不能小于 {spec.item_min:g}")
                if spec.item_max is not None and item > spec.item_max:
                    raise ValueError(f"模型参数「{spec.key}」第 {index} 项不能大于 {spec.item_max:g}")
            result[spec.key] = items
            continue
        try:
            if spec.type == "int":
                value = int(float(raw))
                if float(raw) != value:
                    raise ValueError
            elif spec.type == "float":
                value = float(raw)
                if not math.isfinite(value):
                    raise ValueError
            elif spec.type == "bool":
                value = raw if isinstance(raw, bool) else str(raw).strip().lower() in {"1", "true", "yes", "on", "是"}
            else:
                value = str(raw)
        except (TypeError, ValueError) as err:
            raise ValueError(f"模型参数「{spec.key}」的值「{raw}」不符合 {spec.type}") from err
        if spec.type in {"int", "float"}:
            numeric = float(value)
            if spec.min is not None and numeric < spec.min:
                raise ValueError(f"模型参数「{spec.key}」不能小于 {spec.min:g}")
            if spec.max is not None and numeric > spec.max:
                raise ValueError(f"模型参数「{spec.key}」不能大于 {spec.max:g}")
        if spec.type == "select" and spec.options and str(value) not in spec.options:
            raise ValueError(f"模型参数「{spec.key}」的值「{value}」不在可选项中")
        result[spec.key] = value
    return result


@dataclass(frozen=True)
class ModelSpec:
    """一次训练实际看到的数据与模型输出契约。"""

    input_shape: tuple[int, ...]
    output_shape: tuple[int, ...]
    input_axes: tuple[str, ...]
    output_axes: tuple[str, ...]
    task: TaskName
    feature_names: tuple[str, ...] = ()
    target_names: tuple[str, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LoaderConfig:
    """传给自定义 DataLoader 工厂的稳定配置。"""

    batch_size: int
    shuffle: bool
    seed: int
    num_workers: int = 0
    drop_last: bool = False


class CustomModelPlugin(Protocol):
    """自定义模型脚本可以实现的扩展协议。

    这里有两档用法：

    * 推荐直接定义一个 ``torch.nn.Module`` 子类（可命名为 ``Model``），并可用
      ``MODEL_PARAMS`` 暴露模型超参数；宿主按训练节点的输入模式为普通表格或时序窗口
      创建 Dataset、DataLoader，并按 ``(x, y)`` 训练；
    * 旧式模型也可以实现 ``build_model(spec, model_params)``；
    * 完全自定义模型实现 ``make_spec``、``build_dataloader`` 和 step hooks，
      自己决定样本、batch、collate、sampler 以及模型的调用方式。

    ``Dataset`` / ``DataLoader`` 都只存在于宿主进程，不能作为画布端口传输。
    """

    def build_model(self, spec: ModelSpec, model_params: Mapping[str, Any]) -> Any:
        """
        根据数据规格和模型节点里的 model_params 创建一个 ``torch.nn.Module``。
        """

    def make_spec(
        self,
        data: Any,
        split: str,
        params: Mapping[str, Any],
        scaler: Any = None,
    ) -> ModelSpec | Mapping[str, Any]:
        """可选：描述无法从普通 ``(x, y)`` 样本自动推断的数据规格。"""

    def make_dataset(
        self,
        data: Any,
        split: str,
        params: Mapping[str, Any],
        scaler: Any = None,
    ) -> Any:
        """
        把一份 SciViz 数据转换成 ``torch.utils.data.Dataset``。

        Dataset 的每个样本应返回 ``(x, y)``；预测阶段也允许只返回 ``x``。
        ``scaler`` 是可选的上游训练集标准化器；``x`` 和 ``y`` 可以是 Tensor、numpy 数组或标量，宿主会在 batch 边界
        统一转换为 Tensor。
        """

    def loss_fn(self, prediction: Any, target: Any, spec: ModelSpec) -> Any:
        """返回一个标量 Tensor。"""

    def make_dataloader(self, dataset: Any, split: str, config: LoaderConfig) -> Any:
        """兼容入口：在 ``make_dataset`` 之后自定义 sampler / collate_fn。"""

    def build_dataloader(
        self,
        data: Any,
        split: str,
        params: Mapping[str, Any],
        scaler: Any = None,
    ) -> Any:
        """推荐入口：直接从原始分表创建完全自定义的 DataLoader。"""

    def train_step(self, model: Any, batch: Any, device: Any, spec: ModelSpec) -> Any:
        """可选：解析任意 batch，返回标量 loss 或 ``{'loss': ..., ...}``。"""

    def validation_step(self, model: Any, batch: Any, device: Any, spec: ModelSpec) -> Any:
        """可选：解析任意验证 batch，返回 loss 及可选 metrics。"""

    def predict_step(self, model: Any, batch: Any, device: Any, spec: ModelSpec) -> Any:
        """可选：解析任意预测 batch，返回预测值或 ``{'prediction': ...}``。"""

    def decode_predictions(self, prediction: Any, data: Any, spec: ModelSpec) -> Any:
        """可选：将预测 Tensor 转成 DataFrame 或 numpy 数组。"""


@dataclass
class CustomModelDefinition:
    """画布上的自定义模型定义句柄。

    代码节点只负责编译并校验模型协议，不在没有数据规格时盲目实例化网络。
    这个对象留在宿主会话内，通过 ``model`` 端口传给 ``train.custom``；真正的
    ``build_model(spec, model_params)`` 或模型类会在训练节点拿到训练集之后调用。
    """

    node_id: str
    source: str
    namespace: Mapping[str, Any]
    name: str = "自定义模型"
    parameter_specs: tuple[ModelParamSpec, ...] = ()
    parameter_values: Mapping[str, ModelParamValue] = field(default_factory=dict)
    interface: ModelInterface = field(default_factory=ModelInterface)
    interface_inputs: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class ModelBundle:
    """训练完成后留在宿主会话中的模型句柄。

    前端只接收摘要和 artifact；真正的 Module 不跨 JSON 传输，下游预测节点
    在同一宿主会话里通过这个 bundle 读取它。
    """

    module: Any
    node_type: str
    task: TaskName
    spec: ModelSpec
    plugin: Any = None
    feature_names: tuple[str, ...] = ()
    target_names: tuple[str, ...] = ()
    classes: Sequence[Any] | None = None
    center: Any = None
    scale: Any = None
    scaler: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def parameters(self):
        """让运行时可以像摘要普通 ``nn.Module`` 一样统计参数量。"""

        parameters = getattr(self.module, "parameters", None)
        return parameters() if callable(parameters) else ()

    def state_dict(self):
        return self.module.state_dict()

    def __call__(self, *args: Any, **kwargs: Any):
        return self.module(*args, **kwargs)
