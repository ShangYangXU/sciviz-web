"""设备探测：这台机器能不能跑 GPU、能跑什么。

torch 在这里是**可选依赖**。没装、或装的是 CPU-only 构建时，宿主仍然要能正常
提供 CPU 算子，而不是启动失败。所以探测结果是一个显式的对象，把"为什么是 CPU"
一起带出来 —— 界面上要如实说，不能让人以为自己在用 GPU。
"""

from __future__ import annotations

import functools
from dataclasses import dataclass
from typing import Literal

Backend = Literal["cuda", "cpu"]


@dataclass(frozen=True)
class DeviceInfo:
    """一次探测的结果。只描述事实，不描述期望"""

    backend: Backend
    torch_version: str | None
    cuda_version: str | None
    gpu_names: tuple[str, ...]
    total_memory_mb: int | None
    #: backend == 'cpu' 时，说明为什么。这句话会原样出现在界面上
    reason: str

    @property
    def usable_devices(self) -> tuple[str, ...]:
        """可以交给算子的设备串。'cuda' 排在前面 = 默认优先用它"""
        return ("cuda", "cpu") if self.backend == "cuda" else ("cpu",)

    def summary(self) -> str:
        """给界面看的一行字。必须能一眼回答「我到底有没有用上 GPU」"""
        if self.backend == "cuda":
            names = "、".join(self.gpu_names) or "未知型号"
            vram = f"{self.total_memory_mb} MB" if self.total_memory_mb else "显存未知"
            return f"GPU {names}（{vram}）· CUDA {self.cuda_version} · torch {self.torch_version}"
        torch_text = f"torch {self.torch_version}" if self.torch_version else "未装 torch"
        return f"CPU · {torch_text} · {self.reason}"

    def as_dict(self) -> dict[str, object]:
        return {
            "backend": self.backend,
            "torchVersion": self.torch_version,
            "cudaVersion": self.cuda_version,
            "gpuNames": list(self.gpu_names),
            "totalMemoryMb": self.total_memory_mb,
            "reason": self.reason,
            "summary": self.summary(),
        }


def _probe_torch() -> DeviceInfo:
    try:
        import torch
    except ImportError:
        return DeviceInfo(
            backend="cpu",
            torch_version=None,
            cuda_version=None,
            gpu_names=(),
            total_memory_mb=None,
            reason="没有安装 torch",
        )

    version = str(torch.__version__)
    cuda_version = torch.version.cuda
    if not torch.cuda.is_available():
        # 两种情况要分开说：装错了构建，和装了但用不了。用户要做的事完全不同
        reason = (
            "装的是 CPU-only 构建（CUDA 没编译进来）"
            if not cuda_version
            else f"CUDA {cuda_version} 编译进来了但设备不可用（驱动或显卡）"
        )
        return DeviceInfo(
            backend="cpu",
            torch_version=version,
            cuda_version=cuda_version,
            gpu_names=(),
            total_memory_mb=None,
            reason=reason,
        )

    names: list[str] = []
    memory_mb: int | None = None
    for index in range(torch.cuda.device_count()):
        properties = torch.cuda.get_device_properties(index)
        names.append(str(properties.name))
        if memory_mb is None:
            memory_mb = int(properties.total_memory // (1024 * 1024))

    return DeviceInfo(
        backend="cuda",
        torch_version=version,
        cuda_version=str(cuda_version),
        gpu_names=tuple(names),
        total_memory_mb=memory_mb,
        reason="",
    )


@functools.cache
def probe() -> DeviceInfo:
    """探测本机设备。缓存 —— 进程生命周期内设备不会变，而 import torch 要一两秒"""
    return _probe_torch()


def resolve(requested: str) -> str:
    """把算子参数里的设备选择落到一个真实可用的设备上。

    要 `cuda` 却拿不到时**回落**而不是报错：用户在图里存的是"用 GPU"这个意图，
    换台机器打开这张图仍然应该能跑，至于跑在哪，由运行清单如实记录。
    """
    info = probe()
    if requested == "cuda" and info.backend != "cuda":
        return "cpu"
    if requested in ("cpu", "cuda"):
        return requested
    return info.usable_devices[0]
