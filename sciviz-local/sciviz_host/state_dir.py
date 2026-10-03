"""宿主本机状态目录的唯一判定处。

对话会话、provider 凭据都落在这里。它不进仓库、不进工程文件 —— 所以判定只能有一处：
两处各写一遍"开发模式是仓库根、安装版是 LOCALAPPDATA"的话，早晚会有一处先漂移，
症状是"会话列表忽然空了"，而没有人会想到是路径算错了。
"""

from __future__ import annotations

import os
from pathlib import Path


def state_root() -> Path:
    configured = os.environ.get("SCIVIZ_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    # 仓库布局：<仓库根>/.sciviz-state（已在 .gitignore 里）
    return Path(__file__).resolve().parents[2] / ".sciviz-state"
