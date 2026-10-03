"""缺库的报错要翻成人话（待办 T14）。

用户写 `import torch` 拿到的第一行不该是 `No module named 'torch'` —— 那既不是他的错，
也没告诉他下一步做什么。而"下一步"在两侧完全不同：
浏览器那侧的包是打包时定下的（装不了新的），宿主那侧能装。

这条测试钉的就是这条分流。**注意**：宿主这边的 Python 装了 torch，所以"浏览器缺 torch"
这个真实场景只能换个名字来演（真正的 torch 场景由 e2e 在浏览器里验）——
而文案的分流只看 `face`，不看模块名，所以两者走的是同一条路。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import bridge  # noqa: E402


def run_user_fn(runtime, code: str) -> dict:
    runtime.load_fn("f1", "run", code)
    raw = runtime.eval_payload(
        json.dumps(
            {
                "nodeId": "f1",
                "nodeType": "custom.script",
                "params": {},
                "inputs": {},
                "outputPorts": [{"id": "out", "shape": "auto"}],
            }
        )
    )
    return json.loads(raw)


class MissingModuleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = bridge.new_runtime_module("t14")

    def test_browser_message_points_at_the_host(self) -> None:
        self.runtime.set_execution_face("pyodide")
        out = run_user_fn(
            self.runtime,
            "def run():\n    import no_such_module_xyz\n    return {'out': 1}\n",
        )
        self.assertFalse(out["ok"])
        self.assertIn("no_such_module_xyz", out["message"], "要说清缺的是哪个模块")
        self.assertIn("run-host.ps1", out["message"], "要给出可照做的命令")
        self.assertIn("宿主", out["message"])
        self.assertIn("刷新页面", out["message"])
        # 翻译不等于把证据丢掉：原始那句话仍在 traceback 里
        self.assertIn("No module named", out["traceback"])

    def test_host_message_points_at_the_environment(self) -> None:
        self.runtime.set_execution_face("host")
        out = run_user_fn(
            self.runtime,
            "def run():\n    import no_such_module_xyz\n    return {'out': 1}\n",
        )
        self.assertIn("no_such_module_xyz", out["message"])
        self.assertIn("requirements.txt", out["message"], "宿主侧要指向怎么装库")
        self.assertIn("setup-env.ps1", out["message"])
        self.assertNotIn("刷新页面", out["message"], "宿主侧的下一步不是刷新页面")

    def test_two_faces_do_not_share_the_same_wording(self) -> None:
        code = "def run():\n    import no_such_module_xyz\n    return {'out': 1}\n"
        self.runtime.set_execution_face("pyodide")
        browser = run_user_fn(self.runtime, code)["message"]
        self.runtime.set_execution_face("host")
        host = run_user_fn(self.runtime, code)["message"]
        self.assertNotEqual(browser, host, "两侧的下一步不同，文案就不能是同一句")

    def test_unknown_face_falls_back_to_something_actionable(self) -> None:
        """没声明 face 时不许什么都不说：第三种人（嵌进别处的调用方）也该拿到一句能照做的话"""
        self.runtime.set_execution_face("")
        out = run_user_fn(
            self.runtime,
            "def run():\n    import no_such_module_xyz\n    return {'out': 1}\n",
        )
        self.assertIn("run-host.ps1", out["message"])

    def test_other_errors_are_left_alone(self) -> None:
        """只翻译缺库这一种：别的异常里那句说明本身就是给用户看的，别动它"""
        self.runtime.set_execution_face("host")
        out = run_user_fn(
            self.runtime,
            "def run():\n    raise KeyError('列「液位」不存在')\n    return {}\n",
        )
        self.assertTrue(out["message"].startswith("KeyError:"), out["message"])
        self.assertIn("液位", out["message"])
