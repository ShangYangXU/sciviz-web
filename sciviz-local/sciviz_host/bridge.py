"""装载共享算子实现。

宿主**不复制**算子代码，而是从 `sciviz-web/src/engine/python/` 直接 import 同一份
`runtime.py` / `operators.py`。两份实现会让同一张图算出不同的指纹，缓存与复现记录
就全对不上了（架构总纲 A5：算子实现哈希进指纹）。

每个会话拿一份**独立的 runtime 模块实例**（同一个文件，各自 exec 一次）。这样
`_datasets` / `_outputs` 这些模块级状态天然按连接隔离 —— 界面、agent、重连后的
新页面各自看到自己的图，不会互相污染。代价是每会话多一份输出缓存，可接受。
"""

from __future__ import annotations

import functools
import importlib.util
import os
import sys
import types
from pathlib import Path


class SharedRuntimeMissing(RuntimeError):
    """找不到共享算子目录。装机或部署路径不对时唯一该看的错误"""


def shared_dir() -> Path:
    """共享算子目录。默认从仓库结构推导，可用 SCIVIZ_PY_DIR 覆盖"""
    override = os.environ.get("SCIVIZ_PY_DIR")
    if override:
        return Path(override).expanduser().resolve()
    # sciviz-local/sciviz_host/bridge.py → 仓库根
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "sciviz-web" / "src" / "engine" / "python"


def _require_files(directory: Path) -> None:
    for name in ("runtime.py", "operators.py"):
        if not (directory / name).is_file():
            raise SharedRuntimeMissing(
                f"共享算子目录里没有 {name}：{directory}。"
                "用 SCIVIZ_PY_DIR 指到 sciviz-web/src/engine/python"
            )


def _ensure_importable(directory: Path) -> None:
    """runtime.py 里有 `import operators`，所以共享目录必须先在 sys.path 上"""
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))


@functools.cache
def shared_operators() -> types.ModuleType:
    """共享算子表（无状态，进程内共用一份）"""
    directory = shared_dir()
    _require_files(directory)
    _ensure_importable(directory)
    import operators

    return operators


def new_runtime_module(session_id: str) -> types.ModuleType:
    """给一个会话开一份独立的 runtime 模块实例。

    不用 `import runtime`：那是进程级单例，两个连接会共享数据集与节点输出。
    这里按会话命名 exec 同一个文件，文件仍然只有一份。
    """
    directory = shared_dir()
    _require_files(directory)
    _ensure_importable(directory)

    module_name = f"sciviz_runtime_{session_id}"
    spec = importlib.util.spec_from_file_location(module_name, directory / "runtime.py")
    if spec is None or spec.loader is None:
        raise SharedRuntimeMissing(f"无法从 {directory / 'runtime.py'} 建立模块规格")
    module = importlib.util.module_from_spec(spec)
    # 先登记再 exec：runtime.py 若出现自引用（或将来加了 dataclass）才不会失败
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module

