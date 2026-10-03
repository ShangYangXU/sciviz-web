"""`py -3.12 -m sciviz_host` 的入口。"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import webbrowser
from pathlib import Path


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="sciviz-host",
        description="SciViz 本地执行宿主：把执行引擎搬到本机，好让算子用上 GPU",
    )
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认只监听本机）")
    parser.add_argument("--port", type=int, default=8765, help="端口，默认 8765")
    parser.add_argument("--dist", type=Path, default=None, help="打包好的前端目录")
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    parser.add_argument("--verbose", action="store_true", help="打印每条消息")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    # Agent 源码闸门只能操作这份仓库，不取启动 shell 的任意 cwd。
    os.environ.setdefault("SCIVIZ_WORKSPACE_ROOT", str(Path(__file__).resolve().parents[2]))
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s %(message)s",
    )

    # 先探测再启动：设备结论要出现在第一屏，而不是等用户跑了一次训练才发现是 CPU
    from . import bridge, device, server, session

    try:
        operators = session.available_operators()
    except bridge.SharedRuntimeMissing as err:
        print(f"找不到共享算子：{err}", file=sys.stderr)
        return 2

    import uvicorn

    dist = server.resolved_dist(args.dist)
    print(f"设备   {device.probe().summary()}")
    print(f"算子   {len(operators)} 个：{'、'.join(operators)}")
    print(f"前端   {dist if dist else '未找到 dist（用 npm run dev 起前端）'}")
    print(f"地址   http://{args.host}:{args.port}")
    if device.probe().backend != "cuda":
        # 这一行防的是最常见的一种错：拿系统 Python 起宿主。系统里那份 torch 是
        # CPU-only 的，跑起来一切正常，只是慢 —— 所以不会有任何东西提醒你。
        print("提示   现在没有可用的 CUDA。本项目的环境在仓库根的 .venv（带 CUDA），")
        print("       用 sciviz-local\\run-host.ps1 启动才是那一套。")

    if args.open:
        threading.Timer(
            1.0, lambda: webbrowser.open(f"http://{args.host}:{args.port}")
        ).start()

    uvicorn.run(server.create_app(dist, port=args.port), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
