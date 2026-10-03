"""走完整传输层的端到端测试。

单元测试绕过了 WebSocket，而这一层恰好有两个"错了也不会报错、只会算错"的地方：
二进制帧的顺序，以及 JSON 与二进制混发时的边界。所以必须有一条真的过线的测试。
"""

from __future__ import annotations

import logging
import os
import sys
import tempfile
import threading
import time
import traceback
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures import column_specs, expect, port, synthetic, upload  # noqa: E402
from sciviz_host import server  # noqa: E402


class WireRoundTripTest(unittest.TestCase):
    def test_fixed_dataset_endpoint_serves_only_the_configured_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "source.csv"
            content = b"time,value\n0,1.25\n1,2.5\n"
            path.write_bytes(content)
            with patch.dict(os.environ, {"SCIVIZ_FIXED_DATASET_PATH": str(path)}):
                with TestClient(server.create_app()) as client:
                    response = client.get(
                        "/fixed-dataset/sheet1.csv",
                        params={"path": "C:\\private\\other.csv"},
                    )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, content)
        self.assertTrue(response.headers["content-type"].startswith("text/csv"))

    def test_fixed_dataset_endpoint_reports_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            missing = Path(temporary_directory) / "missing.csv"
            with patch.dict(os.environ, {"SCIVIZ_FIXED_DATASET_PATH": str(missing)}):
                with TestClient(server.create_app()) as client:
                    response = client.get("/fixed-dataset/sheet1.csv")

        self.assertEqual(response.status_code, 404)
        self.assertIn(str(missing), response.json()["detail"])

    def test_disconnect_stops_the_running_job(self) -> None:
        """断开连接 = 停下手里的活（否则会留下孤儿训练，见 server.py 里的注释）。

        用替身记录 `request_cancel` 被调过：这条要守的是**接线**（断开时有没有调用），
        而"调用之后真的停下来"是 T7 已经验过的协作式取消。
        """
        calls: list[str] = []
        original = server.session.EngineSession

        class Spy(original):  # type: ignore[misc, valid-type]
            def request_cancel(self) -> None:
                calls.append(self.id)
                super().request_cancel()

        server.session.EngineSession = Spy
        try:
            with TestClient(server.create_app()) as client:
                with client.websocket_connect("/engine") as ws:
                    ws.send_json({"type": "init"})
                    expect(ws, "ready")
                # 退出 with 就是断开
                for _ in range(50):
                    if calls:
                        break
                    time.sleep(0.05)
        finally:
            server.session.EngineSession = original

        self.assertTrue(calls, "断开时应当请求取消")

    def test_health_and_full_run(self) -> None:
        with TestClient(server.create_app()) as client:
            health = client.get("/health").json()
            self.assertTrue(health["ok"])
            self.assertEqual(health["backend"], "local")
            # 共享算子与宿主专属算子都要在清单里
            self.assertIn("train.mlp", health["operators"])
            self.assertIn("viz.chart", health["operators"])
            # 环境要如实报出来：运行清单里的 environment 段就是从这几项来的
            for key in ("python", "numpy", "pandas", "scipy"):
                self.assertIn(key, health)
            self.assertRegex(health["python"], r"^\d+\.\d+")
            self.assertIn(health["device"]["backend"], ("cuda", "cpu"))
            self.assertTrue(health["device"]["summary"])

            with client.websocket_connect("/engine") as ws:
                ws.send_json({"type": "init"})
                ready = expect(ws, "ready")
                self.assertIn("本地 Python", ready["engineInfo"])

                upload(ws, synthetic(rows=400))

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
                source = expect(ws, "nodeResult")
                self.assertEqual(source["refs"]["data"]["rowCount"], 400)

                ws.send_json(
                    {
                        "type": "evalNode",
                        "nodeId": "model",
                        "nodeType": "train.mlp",
                        "params": {"label": "label", "epochs": 8, "hidden": 8, "seed": 1},
                        "inputs": {"train": port("src", "data")},
                        "outputPorts": [
                            {"id": "model", "shape": "auto"},
                            {"id": "history", "shape": "table"},
                        ],
                    }
                )
                trained = expect(ws, "nodeResult")
                self.assertEqual(trained["refs"]["history"]["rowCount"], 8)
                self.assertGreater(trained["refs"]["metrics"]["values"]["参数量"], 0)
                # 元信息（待办 T11）**必须过线**：指标只收数值，设备与版本走 meta。
                # 这一段的存在有个具体原因：最初 server 只转发了 refs 与 artifacts，
                # 漏了 meta —— 而单元测试直接调 session，看不见这个漏转发
                self.assertIn("meta", trained)
                self.assertIn(trained["meta"]["设备"], ("cuda", "cpu"))
                self.assertIn("torch", trained["meta"])

                ws.send_json(
                    {"type": "head", "requestId": 1, "nodeId": "model", "portId": "history", "n": 3}
                )
                table = expect(ws, "head")["table"]
                self.assertEqual(len(table["rows"]), 3)
                self.assertIn("训练损失", table["columns"])
                ws.send_json(
                    {"type": "head", "requestId": 2, "nodeId": "model", "portId": "history", "n": 3, "offset": 3}
                )
                second_page = expect(ws, "head")["table"]
                self.assertEqual(second_page["totalRows"], 8)
                self.assertEqual(len(second_page["rows"]), 3)
                self.assertNotEqual(second_page["rows"], table["rows"])

    def test_bad_column_length_reports_back(self) -> None:
        """列长与声明对不上时必须回 datasetError，而不是让会话挂在一个半截状态"""
        with TestClient(server.create_app()) as client:
            with client.websocket_connect("/engine") as ws:
                ws.send_json({"type": "init"})
                expect(ws, "ready")
                specs = column_specs()
                ws.send_json(
                    {
                        "type": "setDataset",
                        "payload": {
                            "datasetId": "bad",
                            "rowCount": 100,
                            "timeColumn": "t",
                            "columns": specs,
                        },
                    }
                )
                ws.send_bytes(b"\x00" * 8)  # 只有 1 个 float64，声明的是 100 行
                failure = expect(ws, "datasetError")
                self.assertIn("100", failure["message"])

    def test_preflight_endpoint_answers(self) -> None:
        """跨机器体检走 HTTP（T17）：结构和"每条不行都得有下一步"都在这里钉住。

        判定本身在 `test_preflight.py` 里测（那边用假探针，不依赖本机装了什么）；
        这里守的是**它真的挂在 /preflight 上、而且离线程跑**（自问自答那一坑的回归）。
        """
        with TestClient(server.create_app()) as client:
            body = client.get("/preflight").json()
        self.assertIn(body["verdict"], ("ok", "warn", "blocked"))
        self.assertTrue(body["summary"])
        ids = [c["id"] for c in body["checks"]]
        for expected in ("python", "deps", "gpu", "webview2", "vcpp", "port", "path", "disk"):
            self.assertIn(expected, ids)
        # 端口那一条必须认出"占着它的就是我们自己" —— 它要回头问一次 /health，
        # 而事件循环一旦被占住，这个自问自答就会超时，把自己判成"被别人占了"
        port = next(c for c in body["checks"] if c["id"] == "port")
        self.assertEqual(port["level"], "ok", port["detail"])

    def test_disconnect_is_not_a_crash(self) -> None:
        """客户端走了以后，"回话送不出去"不许变成一条带 traceback 的 ERROR。

        现象：停宿主时控制台刷出"会话 … 的后台指令出错" + `WebSocketDisconnect` 的
        traceback，看起来像宿主出了故障 —— 其实只是那条回话没人接了。
        判据：断开之后仍在跑完的那条后台指令，最多留一条说明，不许有 ERROR。
        """
        release = threading.Event()
        original = server.session.EngineSession

        class Slow(original):  # type: ignore[misc, valid-type]
            def eval_node(self, payload, on_progress=None):  # type: ignore[override]
                # 卡在这里，让"客户端断开"发生在回话之前 —— 真实场景就是这个：
                # 活跑到一半，人把窗口关了
                release.wait(10)
                return {"ok": True, "refs": {}, "artifacts": [], "meta": {}}

        records: list[logging.LogRecord] = []
        handler = logging.Handler()
        handler.emit = records.append  # type: ignore[method-assign]
        host_log = logging.getLogger("sciviz_host")
        previous_level = host_log.level
        host_log.setLevel(logging.DEBUG)
        host_log.addHandler(handler)
        server.session.EngineSession = Slow
        try:
            with TestClient(server.create_app()) as client:
                with client.websocket_connect("/engine") as ws:
                    ws.send_json({"type": "init"})
                    expect(ws, "ready")
                    ws.send_json(
                        {
                            "type": "evalNode",
                            "nodeId": "n",
                            "nodeType": "train.mlp",
                            "params": {},
                            "inputs": {},
                            "outputPorts": [],
                        }
                    )
                    time.sleep(0.5)  # 等后台任务拿到锁、真的跑起来
                # 退出 with 就是断开
                release.set()
                for _ in range(100):
                    if any("没送出去" in r.getMessage() for r in records):
                        break
                    time.sleep(0.05)
        finally:
            release.set()
            server.session.EngineSession = original
            host_log.removeHandler(handler)
            host_log.setLevel(previous_level)

        self.assertEqual(
            [
                (r.getMessage(), "".join(traceback.format_exception(*r.exc_info)) if r.exc_info else "")
                for r in records
                if r.levelno >= logging.ERROR
            ],
            [],
        )
        self.assertTrue(
            any("没送出去" in r.getMessage() for r in records),
            "应当留下一条'消息没送出去'的说明 —— 否则这条用例没走到该走的路径",
        )


if __name__ == "__main__":
    unittest.main()
