r"""量 1D-CNN 在**这张卡**上的耗时与显存峰值，用来回答"4GB 能开到多大"。

为什么要有这个脚本而不是只留一张表：显存与速度都随驱动、torch 版本、笔记本的散热
策略变，而"跑不动"在这里的表现又特别隐蔽 —— **超过显存不会报错，只会慢几十倍**
（Windows 驱动分页到系统内存）。所以判据必须能重新测，而不是信一张去年的表。

走的是产品自己的那条路：`sciviz run` → 宿主 → `gpu_ops.op_train_cnn1d`，
数字取自 `run.json` 的 `耗时秒` 与 `显存峰值MB`（`torch.cuda.max_memory_allocated()`）。

用法：

```powershell
cd sciviz-local
.\run-host.ps1                                   # 另开一个终端
..\.venv\Scripts\python.exe benchmarks\bench_cnn_vram.py
```

合成数据、图、运行产物都写在仓库根的 `.tmp/bench/`（那里不进 git）。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "sciviz-web"
WORK = ROOT / ".tmp" / "bench"
CSV = WORK / "bench8.csv"
GRAPH = WORK / "graph.yaml"

ROWS = 200_000
CHANNELS = 8
EPOCHS = 2
OVERLAP = 0.9

#: (窗长, 批大小, 卷积通道数, 设备)。窗长、批大小、卷积宽度是显存的三个主因
CONFIGS = [
    (2048, 64, 32, "cuda"),
    (2048, 256, 32, "cuda"),
    (2048, 256, 64, "cuda"),
    (2048, 512, 64, "cuda"),
    (2048, 256, 128, "cuda"),
    (2048, 512, 128, "cuda"),
    (2048, 512, 256, "cuda"),  # 这一档是去找上限的：失败（或变慢）本身就是结论
    (4096, 128, 64, "cuda"),
    (2048, 256, 64, "cpu"),
]

TEMPLATE = """name: bench
nodes:
  - id: n1
    type: data.source
    label: 数据源
    params: {{ datasetId: ds-1 }}
    position: {{ x: 0, y: 0 }}
  - id: n2
    type: custom.script
    label: 准备定长样本
    params:
      code: |
        import pandas as pd
        def prepare(data):
            rows = []
            channels = [c for c in data.columns if str(c).startswith("c")]
            window = {window}
            hop = max(1, int(window * (1 - {overlap})))
            for start in range(0, len(data) - window + 1, hop):
                for channel in channels:
                    row = {{"起点": start, "label": float(data.iloc[start]["label"])}}
                    row.update({{f"点{{i}}": float(data.iloc[start + i][channel]) for i in range(window)}})
                    rows.append(row)
            return {{"data": pd.DataFrame(rows)}}
    position: {{ x: 220, y: 0 }}
  - id: n3
    type: train.cnn1d
    label: 训练
    params:
      label: label
      task: 分类
      epochs: {epochs}
      hidden: {hidden}
      kernel: 5
      batch: {batch}
      lr: 0.001
      dropout: 0.2
      seed: 1
      device: {device}
    position: {{ x: 440, y: 0 }}
edges:
  - {{ id: e1, source: n1, sourcePort: __table__, target: n2, targetPort: data }}
  - {{ id: e2, source: n2, sourcePort: data, target: n3, targetPort: train }}
"""


def make_data() -> None:
    """8 通道 + 标签。三类的波形形态不同，所以训练有东西可学。

    时间列**必须叫「时间」**：导入管线按名字/格式识别时间轴，识别不出来的那一列
    会当成普通数值通道参与卷积 —— 而时间戳与按时间排布的标签高度相关，那等于送答案。
    """
    rng = np.random.default_rng(7)
    t = np.arange(ROWS) / 1000.0
    label = (np.arange(ROWS) // (ROWS // 3 + 1)).clip(max=2)

    columns: dict[str, np.ndarray] = {"时间": t}
    for c in range(CHANNELS):
        phase = 2 * np.pi * (2.0 + c * 0.5) * t + c
        wave = np.where(
            label == 0,
            np.sin(phase),
            np.where(
                label == 1,
                np.sign(np.sin(phase)),
                np.exp(-((t * 10 + c) % 1)) * np.sin(phase * 4),
            ),
        )
        columns[f"c{c + 1}"] = (wave + rng.normal(0, 0.05, ROWS)).astype(np.float32)
    columns["label"] = label.astype(np.int32)

    matrix = np.column_stack([columns[name] for name in columns])
    np.savetxt(
        CSV,
        matrix,
        delimiter=",",
        header=",".join(columns),
        comments="",
        fmt="%.6g",
    )
    print(f"合成数据：{CSV.name}（{ROWS} 行 × {len(columns)} 列）")


def measure(window: int, batch: int, hidden: int, device: str) -> dict:
    GRAPH.write_text(
        TEMPLATE.format(
            window=window,
            batch=batch,
            hidden=hidden,
            device=device,
            epochs=EPOCHS,
            overlap=OVERLAP,
        ),
        encoding="utf-8",
    )
    proc = subprocess.run(
        [
            "node",
            "--import",
            "tsx",
            "scripts/sciviz.mjs",
            "run",
            str(GRAPH),
            f"--data=ds-1={CSV}",
            f"--out={WORK / 'runs'}",
        ],
        cwd=WEB,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        tail = (proc.stdout or proc.stderr).strip().splitlines()[-3:]
        return {"ok": False, "why": " / ".join(line.strip() for line in tail)[-240:]}

    latest = max((p for p in (WORK / "runs").iterdir() if p.is_dir()), key=lambda p: p.name)
    manifest = json.loads((latest / "run.json").read_text(encoding="utf-8"))
    node = next(n for n in manifest["nodes"] if n["nodeId"] == "n3")
    if node["status"] != "ready":
        return {"ok": False, "why": (node.get("error") or {}).get("message", node["status"])[:240]}
    values = node["outputs"]["model"]["values"]
    return {
        "ok": True,
        "frames": int(values["训练样本数"]),
        "channels": int(values["通道数"]),
        "seconds": values["耗时秒"],
        "vram": values.get("显存峰值MB"),
        "params": int(values["参数量"]),
    }


def main() -> int:
    WORK.mkdir(parents=True, exist_ok=True)
    if not CSV.exists():
        make_data()

    print(f"重叠率 {OVERLAP} · 每档 {EPOCHS} 轮 · 数据 {CSV.name}\n")
    print("| 窗长 | 批大小 | 卷积通道 | 参数量 | 耗时 | 显存峰值 | 备注 |")
    print("|---|---|---|---|---|---|---|")
    failed = 0
    for window, batch, hidden, device in CONFIGS:
        out = measure(window, batch, hidden, device)
        note = "" if device == "cuda" else "CPU"
        if not out["ok"]:
            failed += 1
            print(f"| {window} | {batch} | {hidden} | — | — | — | 失败：{out['why']} |")
            sys.stdout.flush()
            continue
        vram = f"{out['vram']} MB" if out["vram"] is not None else "—"
        header = (
            f"| {window} | {batch}{'（CPU）' if device == 'cpu' else ''} | {hidden} | "
            f"{out['params']} | {out['seconds']}s | {vram} | {out['frames']} 帧 × "
            f"{out['channels']} 通道{('，' + note) if note else ''} |"
        )
        print(header)
        sys.stdout.flush()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
