"""跨机器体检：**这台机器能不能跑这个项目**，以及跑不了时该怎么办。

与 `doctor.py` 的分工要说清，否则两份自检迟早会互相矛盾：

| | 回答什么 | 缺东西时算不算失败 |
|---|---|---|
| `doctor` | **这套 Python 环境**装齐了没有（库、算子、设备） | 算（缺依赖 = 环境坏了） |
| `preflight` | **这台机器**接得住吗（窗口运行时、端口、磁盘、路径、驱动） | 不算 —— 它输出"能跑 / 降级 / 跑不了"加一句修复建议 |

换一台机器、或者要把它装给别人用之前，跑它。每条检查都给三样东西：

- `level`：`ok` / `warn`（能跑但有代价）/ `blocked`（跑不了）；
- `detail`：**这台机器上实际看到的事实**（不是"应该是什么"）；
- `fix`：不行的时候照着做的一句话。没有可照做的话就写 None —— 空话不如不说。

三条刻意的选择：

1. **不猜**：查不到就说"查不到"（warn），不编一个值出来。
2. **CPU 回退算"降级"不算"跑不了"**：没有 CUDA 的机器上这个项目仍然能跑，只是慢。
3. 检查项用**注入探针**（默认走真机器），于是每条判定都能在测试里钉住 ——
   "换机器才发现的坑"不该只有换机器才能测。
"""

from __future__ import annotations

import importlib
import os
import platform
import shutil
import socket
import sys
from dataclasses import asdict, dataclass
from typing import Callable, Literal

from . import device

Level = Literal["ok", "warn", "blocked"]

#: 报告里要列出的一行名称 → 模块名。缺了任何一个都算环境不完整
REQUIRED_DEPS = {
    "numpy": "numpy",
    "pandas": "pandas",
    "scipy": "scipy",
    "scikit-learn": "sklearn",
    "matplotlib": "matplotlib",
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
}

#: 默认端口，与 `__main__.py` / `run-host.ps1` 保持一致
DEFAULT_PORT = 8765

#: 运行时（.venv 约 4.7GB）加一点余量。低于它就该说话
MIN_FREE_GB = 6.0

#: WebView2 Runtime 的注册表位置（桌面壳的窗口靠它渲染）
_WEBVIEW2_KEYS = (
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
)


@dataclass(frozen=True)
class Check:
    id: str
    title: str
    level: Level
    detail: str
    fix: str | None = None


def default_root() -> str:
    """仓库根：`sciviz-local/sciviz_host/preflight.py` 往上三层"""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _python_check(
    version: tuple[int, int] | None = None,
    executable: str | None = None,
) -> Check:
    version = version or sys.version_info[:2]
    executable = executable or sys.executable
    if version < (3, 11):
        return Check(
            "python",
            "Python 版本",
            "blocked",
            f"{version[0]}.{version[1]}（需要 ≥ 3.11）· {executable}",
            "用 .\\setup-env.ps1 建仓库根那份 .venv，再用 .\\run-host.ps1 起宿主",
        )
    in_venv = f"{os.sep}.venv{os.sep}" in executable
    return Check(
        "python",
        "Python 版本",
        "ok" if in_venv else "warn",
        f"{version[0]}.{version[1]} · {executable}",
        None
        if in_venv
        else (
            "这看起来不是仓库根的 .venv。系统 Python 里那份 torch 是 CPU-only 构建 —— "
            "跑起来一切正常、只是跑在 CPU 上。用 .\\run-host.ps1 起才是对的那套"
        ),
    )


def _deps_check(importer: Callable[[str], object] = importlib.import_module) -> Check:
    missing: list[str] = []
    for label, module_name in REQUIRED_DEPS.items():
        try:
            importer(module_name)
        except Exception:  # noqa: BLE001 —— 缺库的形式不止 ImportError（DLL 缺失也是）
            missing.append(label)
    if missing:
        return Check(
            "deps",
            "依赖",
            "blocked",
            f"缺 {'、'.join(missing)}",
            "跑 ..\\setup-env.ps1 -Update 补齐（它按 requirements.txt 装）",
        )
    return Check("deps", "依赖", "ok", f"{len(REQUIRED_DEPS)} 个必需库都在")


def _gpu_check(probe: Callable[[], device.DeviceInfo] = device.probe) -> Check:
    info = probe()
    if info.backend == "cuda":
        return Check("gpu", "GPU 与 CUDA", "ok", info.summary())
    suffix = f" —— {info.reason}" if info.reason else ""
    return Check(
        "gpu",
        "GPU 与 CUDA",
        "warn",
        info.summary() + suffix,
        "没有 GPU 也能跑，但训练会在 CPU 上，慢得多。要用 GPU：装 NVIDIA 驱动 + "
        "CUDA 版 torch（见 sciviz-local/README.md 的 GPU 一节）",
    )


def _path_check(path: str | None = None) -> Check:
    """安装路径含非 ASCII：**警告不是阻断**。

    这条是本机实测出来的：这个仓库自己就住在 `E:\\科研数据图帮助`，一路跑得通 ——
    把非 ASCII 路径报成"跑不了"是假话。但换机器时它确实是第一嫌疑（Windows 上
    脚本、编码、某些工具链都会在这里出岔），值得先说一句。
    """
    path = path or default_root()
    odd = sorted({ch for ch in path if ord(ch) > 127})
    if odd:
        return Check(
            "path",
            "安装路径",
            "warn",
            f"{path} 含非 ASCII 字符（{''.join(odd)}）",
            "本机一路跑得通，但换机器时它是第一嫌疑：能换成纯 ASCII 路径（如 D:\\sciviz）就换",
        )
    return Check("path", "安装路径", "ok", path)


def _disk_check(
    path: str | None = None,
    usage: Callable[[str], object] = shutil.disk_usage,
) -> Check:
    path = path or default_root()
    try:
        free_gb = usage(path).free / (1024**3)
    except OSError as err:
        return Check("disk", "磁盘空间", "warn", f"查不到：{err}", None)
    if free_gb < MIN_FREE_GB:
        return Check(
            "disk",
            "磁盘空间",
            "warn",
            f"{free_gb:.1f} GB 可用（建议 ≥ {MIN_FREE_GB:g} GB）",
            "运行时（.venv，含 CUDA 版 torch）约 4.7GB，示例数据与训练产物还要占地方",
        )
    return Check("disk", "磁盘空间", "ok", f"{free_gb:.1f} GB 可用")


def _webview2_check(
    read_registry: Callable[[int, str], str | None] | None = None,
    system: str | None = None,
) -> Check:
    """桌面壳的窗口是 WebView2 渲染的（`--app` 用的就是它）。没有它 = 窗口打不开。"""
    system = system or platform.system()
    if system != "Windows":
        return Check("webview2", "WebView2 运行时", "ok", f"非 Windows（{system}）")

    if read_registry is None:
        import winreg

        def read_registry(root: int, key: str) -> str | None:
            try:
                with winreg.OpenKey(root, key) as handle:
                    value, _ = winreg.QueryValueEx(handle, "pv")
                    return str(value)
            except OSError:
                return None

        roots: tuple[int, ...] = (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER)
    else:
        roots = (0, 1)

    for root in roots:
        for key in _WEBVIEW2_KEYS:
            version = read_registry(root, key)
            if version:
                return Check("webview2", "WebView2 运行时", "ok", version)
    return Check(
        "webview2",
        "WebView2 运行时",
        "blocked",
        "没找到（注册表里两个位置都没有）",
        "装一次 WebView2 Runtime（微软官方免费；Win11 自带、Win10 可能要手动装）："
        "https://developer.microsoft.com/microsoft-edge/webview2/",
    )


def _vcpp_check(
    exists: Callable[[str], bool] = os.path.exists,
    system: str | None = None,
) -> Check:
    """VC++ 运行库：torch 与 numpy 的 Windows 轮子都要它。缺了报的是一句难懂的 DLL 错。"""
    system = system or platform.system()
    if system != "Windows":
        return Check("vcpp", "VC++ 运行库", "ok", f"非 Windows（{system}）")
    system32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    wanted = ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll")
    missing = [name for name in wanted if not exists(os.path.join(system32, name))]
    if missing:
        return Check(
            "vcpp",
            "VC++ 运行库",
            "warn",
            f"System32 里少了 {'、'.join(missing)}",
            "装「Microsoft Visual C++ 2015-2022 Redistributable (x64)」",
        )
    return Check("vcpp", "VC++ 运行库", "ok", "x64 运行库在")


def _port_check(
    port: int = DEFAULT_PORT,
    bind: Callable[[tuple[str, int]], object] | None = None,
    health: Callable[[], bool] | None = None,
) -> Check:
    """端口被占：占它的如果正是我们自己的宿主，那是好事；否则起不来。"""
    if bind is None:

        def bind(address: tuple[str, int]) -> object:
            sock = socket.socket()
            try:
                sock.bind(address)
            except OSError:
                # 端口被占：这个 socket 没用了，得关掉 —— 不关会漏一个句柄
                # （测试里表现为一条 ResourceWarning）
                sock.close()
                raise
            return sock

    try:
        sock = bind(("127.0.0.1", port))
        close = getattr(sock, "close", None)
        if close is not None:
            close()
        return Check("port", "宿主端口", "ok", f"{port} 空闲")
    except OSError:
        pass

    if health is None:
        import urllib.request

        def health() -> bool:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as res:
                    return res.status == 200
            except Exception:  # noqa: BLE001
                return False

    if health():
        return Check("port", "宿主端口", "ok", f"{port} 上已经有一个宿主在跑（直接用就行）")
    return Check(
        "port",
        "宿主端口",
        "blocked",
        f"{port} 被别的程序占着，而且它不是本项目的宿主",
        f"关掉占着 {port} 的那个程序，或者换端口起：.\\run-host.ps1 --port 8766",
    )


def run_checks(
    *,
    python_check: Callable[[], Check] = _python_check,
    deps_check: Callable[[], Check] = _deps_check,
    gpu_check: Callable[[], Check] = _gpu_check,
    webview2_check: Callable[[], Check] = _webview2_check,
    vcpp_check: Callable[[], Check] = _vcpp_check,
    port_check: Callable[[], Check] = _port_check,
    path_check: Callable[[], Check] = _path_check,
    disk_check: Callable[[], Check] = _disk_check,
) -> dict:
    """跑一遍全部检查，给出"能跑 / 降级 / 跑不了"。"""
    checks = [
        python_check(),
        deps_check(),
        gpu_check(),
        webview2_check(),
        vcpp_check(),
        port_check(),
        path_check(),
        disk_check(),
    ]
    levels = {c.level for c in checks}
    verdict: Level = "blocked" if "blocked" in levels else ("warn" if "warn" in levels else "ok")
    return {
        "verdict": verdict,
        #: 给人看的一句话，与 verdict 一致 —— 不另编一套说法
        "summary": {
            "ok": "能跑：这台机器上该有的都在",
            "warn": "能跑，但有代价（看下面每条的说明）",
            "blocked": "跑不了：先照下面标 blocked 的那几条做",
        }[verdict],
        "checks": [asdict(c) for c in checks],
    }
