"""长任务的进度与取消（待办 T7）。

守两件事，都是 wire 协议上的新消息 —— 在 session 那一层看不到：

1. 训练跑起来时，宿主**主动**往上报进度（界面上那句百分比就是从这来的），
   而不是等跑完才有一条结果；
2. 取消之后**两秒内**真的停下，而且会话还能继续用（不是"把连接弄坏了"），
   也不留下半截产物。

为什么走 TestClient 的 WebSocket 而不是直接调 `EngineSession`：
节流、消息类型、以及"取消不能排在那把锁后面"这三件事全在 server 这一层，
只测 session 会把它们全部绕过。
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures import expect, port, synthetic, upload  # noqa: E402
from sciviz_host import server  # noqa: E402


class JobControlTest(unittest.TestCase):
    def test_training_reports_progress_and_cancels_within_two_seconds(self) -> None:
        data = synthetic(rows=4000)
        with TestClient(server.create_app()) as client:
            with client.websocket_connect("/engine") as ws:
                ws.send_json({"type": "init"})
                expect(ws, "ready")
                upload(ws, data)

                ws.send_json(
                    {
                        "type": "evalNode",
                        "nodeId": "src",
                        "nodeType": "data.source",
                        "params": {"datasetId": "synthetic"},
                        "inputs": {},
                        "outputPorts": [{"id": "data", "shape": "table"}],
                    }
                )
                expect(ws, "nodeResult")

                # 轮数刻意开大：好让它在收到取消时**一定还在跑**
                ws.send_json(
                    {
                        "type": "evalNode",
                        "nodeId": "model",
                        "nodeType": "train.mlp",
                        "params": {
                            "label": "label",
                            "epochs": 400,
                            "hidden": 32,
                            "batch": 32,
                            "seed": 1,
                        },
                        "inputs": {"train": port("src", "data")},
                        "outputPorts": [{"id": "model", "shape": "auto"}],
                    }
                )

                # 1. 进度是主动报的：还没跑完，就先来了一条
                progress = expect(ws, "nodeProgress")
                self.assertEqual(progress["nodeId"], "model")
                self.assertGreater(progress["ratio"], 0.0)
                self.assertLessEqual(progress["ratio"], 1.0)

                # 2. 取消：从发出到停下，两秒出头之内（留点余量给慢机器）
                started = time.monotonic()
                ws.send_json({"type": "cancel", "nodeId": "model"})
                cancelled = expect(ws, "nodeCancelled", timeout=6.0)
                elapsed = time.monotonic() - started
                self.assertEqual(cancelled["nodeId"], "model")
                self.assertLess(elapsed, 2.5, f"取消用了 {elapsed:.2f}s，判据是两秒内")
                self.assertNotIn("traceback", cancelled)

                # 3. 不留半截产物：这次没有输出，就不能拿上一次的顶上
                ws.send_json(
                    {
                        "type": "head",
                        "requestId": 1,
                        "nodeId": "model",
                        "portId": "model",
                        "n": 1,
                    }
                )
                expect(ws, "headError")

                # 4. 会话还能用：取消不是"把连接弄坏了"，接着算别的东西照样出数
                ws.send_json(
                    {
                        "type": "evalNode",
                        "nodeId": "src2",
                        "nodeType": "data.source",
                        "params": {"datasetId": "synthetic"},
                        "inputs": {},
                        "outputPorts": [{"id": "data", "shape": "table"}],
                    }
                )
                again = expect(ws, "nodeResult")
                self.assertTrue(again["refs"], "取消之后同一会话应当还能继续算")
