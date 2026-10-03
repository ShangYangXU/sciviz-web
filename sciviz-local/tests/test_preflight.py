"""跨机器体检（T17）的判定：每条检查都要能在测试里被钉住。

存在的理由很直接：这些坑**换一台机器才会遇到**（没装 WebView2、端口被占、
路径含中文、磁盘不够），而"只有换机器才能测"的判定等于永远不测。
所以每条检查都收探针参数，测试给假探针，判定本身是真的。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import device, preflight  # noqa: E402


class VerdictTest(unittest.TestCase):
    def _run(self, **levels):
        """只改关心的那一条，其它都当 ok —— 判据是聚合规则，不是具体机器"""
        probes = {
            name: (lambda level=level: preflight.Check(name, name, level, "detail"))
            for name, level in levels.items()
        }
        base = dict(
            python_check=probes.get("python", lambda: preflight.Check("python", "python", "ok", "")),
            deps_check=probes.get("deps", lambda: preflight.Check("deps", "deps", "ok", "")),
            gpu_check=probes.get("gpu", lambda: preflight.Check("gpu", "gpu", "ok", "")),
            webview2_check=probes.get("webview2", lambda: preflight.Check("webview2", "w", "ok", "")),
            vcpp_check=probes.get("vcpp", lambda: preflight.Check("vcpp", "v", "ok", "")),
            port_check=probes.get("port", lambda: preflight.Check("port", "p", "ok", "")),
            path_check=probes.get("path", lambda: preflight.Check("path", "p", "ok", "")),
            disk_check=probes.get("disk", lambda: preflight.Check("disk", "d", "ok", "")),
        )
        return preflight.run_checks(**base)

    def test_all_ok_is_ok(self) -> None:
        self.assertEqual(self._run()["verdict"], "ok")

    def test_warn_degrades(self) -> None:
        self.assertEqual(self._run(gpu="warn")["verdict"], "warn")

    def test_blocked_wins(self) -> None:
        """一条跑不了 = 整台机器跑不了 —— 不能因为别的都 ok 就说"能跑" """
        self.assertEqual(self._run(gpu="warn", deps="blocked")["verdict"], "blocked")

    def test_summary_matches_verdict(self) -> None:
        for level, expected in (("ok", "能跑"), ("warn", "能跑，但"), ("blocked", "跑不了")):
            result = self._run(deps=level)
            self.assertEqual(result["verdict"], level)
            self.assertIn(expected, result["summary"])


class SingleCheckTest(unittest.TestCase):
    def test_python_too_old_blocks(self) -> None:
        self.assertEqual(preflight._python_check((3, 10), r"D:\x\.venv\Scripts\python.exe").level, "blocked")

    def test_system_python_warns(self) -> None:
        """系统 Python 能跑，但那份 torch 是 CPU-only —— 必须说出来"""
        check = preflight._python_check((3, 12), r"C:\Python312\python.exe")
        self.assertEqual(check.level, "warn")
        self.assertIn("CPU", check.fix or "")

    def test_venv_python_is_ok(self) -> None:
        self.assertEqual(preflight._python_check((3, 12), r"D:\x\.venv\Scripts\python.exe").level, "ok")

    def test_missing_dep_blocks_with_a_command(self) -> None:
        def importer(name: str) -> object:
            if name == "scipy":
                raise ImportError("nope")
            return object()

        check = preflight._deps_check(importer)
        self.assertEqual(check.level, "blocked")
        self.assertIn("scipy", check.detail)
        self.assertIn("setup-env.ps1", check.fix or "")

    def test_gpu_cpu_only_is_warn_not_blocked(self) -> None:
        """没有 CUDA 的机器上这个项目仍然能跑 —— 只是慢。报成"跑不了"是假话"""
        info = device.DeviceInfo(
            backend="cpu", torch_version=None, cuda_version=None, gpu_names=(), total_memory_mb=None,
            reason="未装 torch",
        )
        check = preflight._gpu_check(lambda: info)
        self.assertEqual(check.level, "warn")
        self.assertIn("未装 torch", check.detail)

    def test_non_ascii_path_warns(self) -> None:
        check = preflight._path_check("E:\\科研数据图帮助")
        self.assertEqual(check.level, "warn")
        self.assertIn("非 ASCII", check.detail)

    def test_ascii_path_is_ok(self) -> None:
        self.assertEqual(preflight._path_check("D:\\sciviz").level, "ok")

    def test_low_disk_warns(self) -> None:
        class Usage:
            free = 1 * 1024**3

        self.assertEqual(preflight._disk_check("D:\\x", usage=lambda _p: Usage()).level, "warn")

    def test_webview2_missing_blocks(self) -> None:
        check = preflight._webview2_check(read_registry=lambda _root, _key: None, system="Windows")
        self.assertEqual(check.level, "blocked")
        self.assertIn("WebView2", check.fix or "")

    def test_webview2_found_is_ok(self) -> None:
        check = preflight._webview2_check(
            read_registry=lambda root, key: "152.0.4191.66" if "EdgeUpdate" in key else None,
            system="Windows",
        )
        self.assertEqual(check.level, "ok")
        self.assertIn("152", check.detail)

    def test_non_windows_skips_windows_only_checks(self) -> None:
        self.assertEqual(preflight._webview2_check(system="Linux").level, "ok")
        self.assertEqual(preflight._vcpp_check(system="Linux").level, "ok")

    def test_port_free_is_ok(self) -> None:
        class Sock:
            def close(self) -> None:
                pass

        self.assertEqual(preflight._port_check(8765, bind=lambda _a: Sock()).level, "ok")

    def test_port_taken_by_our_own_host_is_ok(self) -> None:
        """端口被占不一定是坏事：占它的可能正是我们自己的宿主，那说明直接能用"""
        def taken(_address):
            raise OSError("in use")

        check = preflight._port_check(8765, bind=taken, health=lambda: True)
        self.assertEqual(check.level, "ok")
        self.assertIn("已经有一个宿主", check.detail)

    def test_port_taken_by_someone_else_blocks_with_a_way_out(self) -> None:
        def taken(_address):
            raise OSError("in use")

        check = preflight._port_check(8765, bind=taken, health=lambda: False)
        self.assertEqual(check.level, "blocked")
        self.assertIn("--port 8766", check.fix or "")

    def test_real_run_produces_every_check(self) -> None:
        """本机真跑一遍：结构必须齐（具体等级随机器，不断言）"""
        result = preflight.run_checks()
        ids = [c["id"] for c in result["checks"]]
        for expected in ("python", "deps", "gpu", "webview2", "vcpp", "port", "path", "disk"):
            self.assertIn(expected, ids)
        self.assertIn(result["verdict"], ("ok", "warn", "blocked"))
        # 每条 blocked / warn 都必须给得出下一步，否则用户只能干看着
        for check in result["checks"]:
            if check["level"] != "ok":
                self.assertTrue(check["fix"], f"{check['id']} 说了不行，却没给出下一步")


if __name__ == "__main__":
    unittest.main()
