"""环境自查：这套环境到底能干什么。

写成模块而不是把 Python 塞进 PowerShell 的 here-string 里，是因为这个报告本身
就天天要用 —— 换机器、装完依赖、怀疑"怎么变慢了"的时候，第一件事都是跑它。

    py -3.12 -m sciviz_host.doctor

退出码：0 = 环境可用（CPU 回退也算可用，但会出警告）；1 = 环境是坏的（缺依赖）。
刻意不因为"没有 CUDA"就返回失败：CPU-only 的机器上这个项目仍然该能跑起来。
"""

from __future__ import annotations

import importlib
import sys

from . import bridge, device, preflight, session

#: 报告里要列出的一行名称 → 模块名。与 `preflight` **共用一份**：
#: 两处各写一份的话，加一个依赖时漏改一处，两份自检就会互相矛盾。
REQUIRED = preflight.REQUIRED_DEPS


def report() -> tuple[list[str], list[str]]:
    """返回 (要打印的行, 缺失的包)"""
    lines = [f"Python  {sys.version.split()[0]}  ({sys.executable})"]

    info = device.probe()
    lines.append(f"设备    {info.summary()}")

    missing: list[str] = []
    for label, module_name in REQUIRED.items():
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            missing.append(label)
            lines.append(f"  {label:<13} 缺失")
            continue
        lines.append(f"  {label:<13}{getattr(module, '__version__', '?')}")

    try:
        operators = session.available_operators()
    except bridge.SharedRuntimeMissing as err:
        missing.append("共享算子")
        lines.append(f"算子    共享算子目录不可用：{err}")
    else:
        lines.append(f"算子    {len(operators)} 个：{'、'.join(operators)}")

    return lines, missing


def main() -> int:
    lines, missing = report()
    print("\n".join(lines))

    if missing:
        print(f"\n环境不完整：缺 {'、'.join(missing)}。跑 ..\\setup-env.ps1 补上。")
        return 1
    if device.probe().backend != "cuda":
        # 这是警告不是错误：但必须说出来，否则"跑了半小时"会被当成正常
        print("\n警告：没有可用的 CUDA，训练会跑在 CPU 上。跑 .\\run-host.ps1 才是带 CUDA 的那套环境。")

    # 这份 Python 环境之外的事（窗口运行时、端口、磁盘、路径）交给 preflight：
    # 它回答的是"这台机器接得住吗"，判据与给用户看的建议都在那儿，这里只负责打印
    result = preflight.run_checks()
    print(f"\n跨机器体检：{result['summary']}")
    for check in result["checks"]:
        mark = {"ok": "✔", "warn": "!", "blocked": "✘"}[check["level"]]
        print(f"  {mark} {check['title']}：{check['detail']}")
        if check["fix"]:
            print(f"      → {check['fix']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
