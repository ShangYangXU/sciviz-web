"""跨运行缓存（T18）：能不能复用、以及**什么时候绝对不许复用**。

这一层守的是契约规格 R6.4 的落地：可复用的只有主线程说 `cacheable` 的那些
（`deterministic` / `seeded`），而判据不在这里 —— 宿主只认那个布尔值。
所以这里的用例重点是：**说不许复用时就一次都不许命中**。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import cache  # noqa: E402


class ResultCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        cache.RESULTS.clear()
        self.addCleanup(cache.RESULTS.clear)

    def test_same_fingerprint_hits(self) -> None:
        cache.RESULTS.put("fp-1", {"result": {"ok": True, "refs": {"data": {"rowCount": 10}}}, "outputs": {}})
        hit = cache.RESULTS.get("fp-1")
        self.assertIsNotNone(hit)
        # 命中的是**同一份东西**：拿回去之后照原样发回给上层
        self.assertEqual(hit["result"]["refs"]["data"]["rowCount"], 10)

    def test_different_fingerprint_misses(self) -> None:
        cache.RESULTS.put("fp-1", {"result": {"ok": True, "refs": {}}, "outputs": {}})
        self.assertIsNone(cache.RESULTS.get("fp-2"))

    def test_too_big_is_not_cached(self) -> None:
        """几百万行的表留在内存里"以防万一"不划算 —— 它直接不进缓存"""
        cache.RESULTS.put(
            "big",
            {"result": {"ok": True, "refs": {"data": {"rowCount": cache.MAX_ROWS + 1}}}, "outputs": {}},
        )
        self.assertIsNone(cache.RESULTS.get("big"))
        self.assertEqual(cache.RESULTS.stats()["skippedTooBig"], 1)

    def test_oldest_is_evicted(self) -> None:
        for i in range(cache.MAX_ENTRIES + 3):
            cache.RESULTS.put(f"fp-{i}", {"result": {"ok": True, "refs": {}}, "outputs": {}})
        self.assertEqual(cache.RESULTS.stats()["entries"], cache.MAX_ENTRIES)
        self.assertIsNone(cache.RESULTS.get("fp-0"), "最久没用的那条该被挤出去")
        self.assertIsNotNone(cache.RESULTS.get(f"fp-{cache.MAX_ENTRIES + 2}"))

    def test_empty_key_never_cached(self) -> None:
        """没有指纹就没法说"同一份输入" —— 宁可重算，不可乱认"""
        cache.RESULTS.put("", {"result": {"ok": True, "refs": {}}, "outputs": {}})
        self.assertIsNone(cache.RESULTS.get(""))


class SessionCachePolicyTest(unittest.TestCase):
    """会话层：说不许复用（`cacheable` 缺席或为假）时，一次都不许命中。"""

    def setUp(self) -> None:
        from sciviz_host import session

        cache.RESULTS.clear()
        self.addCleanup(cache.RESULTS.clear)
        self.session = session.EngineSession("cache-test")
        # 用户函数要先编译进引擎（核在真正求值前做这件事），否则示例代码跑不起来
        self.session.load_fn("n1", "run", "def run():\n    return {'out': 1}\n")
        self.payload = {
            "nodeId": "n1",
            "nodeType": "custom.script",
            "params": {"code": "def run():\n    return {'out': 1}\n"},
            "inputs": {},
            "outputPorts": [{"id": "out", "shape": "auto"}],
            "fingerprint": "fp-same",
        }

    def test_cacheable_false_always_recomputes(self) -> None:
        """stochastic 的算子（两个训练算子）永远重算 —— 拿上次的冒充这次的最糟"""
        runs: list[int] = []
        original = self.session._runtime.eval_payload

        def counting(text: str) -> str:
            runs.append(1)
            return original(text)

        self.session._runtime.eval_payload = counting  # type: ignore[method-assign]
        first = self.session.eval_node({**self.payload, "cacheable": False})
        second = self.session.eval_node({**self.payload, "cacheable": False})
        self.assertEqual(len(runs), 2, "说不许复用就必须真的再算一遍")
        self.assertNotIn("cached", second)
        self.assertTrue(first.get("ok"))

    def test_cacheable_true_reuses_the_same_output(self) -> None:
        runs: list[int] = []
        original = self.session._runtime.eval_payload

        def counting(text: str) -> str:
            runs.append(1)
            return original(text)

        self.session._runtime.eval_payload = counting  # type: ignore[method-assign]
        first = self.session.eval_node({**self.payload, "cacheable": True})
        second = self.session.eval_node({**self.payload, "cacheable": True})
        self.assertEqual(len(runs), 1, "同指纹的第二次不该再算")
        self.assertTrue(second.get("cached"))
        self.assertEqual(second["refs"], first["refs"], "复用的必须是同一份输出")

    def test_cache_hit_still_leaves_the_data_usable(self) -> None:
        """命中缓存之后，那批输出**必须还能用**：下游读输入、探针取行值都认会话里那份。

        第一版只把摘要回给上层、没把输出对象放回会话 —— 症状是**取行值时报
        "上游节点还没有求值结果"**，而节点状态写着 ready。盲测（run 之后紧跟一条
        inspect --rows）当场抓住了它。
        """
        code = (
            "import pandas as pd\n"
            "def run():\n"
            "    return {'out': pd.DataFrame({'a': [1, 2, 3]})}\n"
        )
        self.session.load_fn("n1", "run", code)
        payload = {**self.payload, "cacheable": True, "params": {"code": code}}
        self.session.eval_node(payload)
        second = self.session.eval_node(payload)
        self.assertTrue(second.get("cached"))

        table = self.session.head("n1", "out", 2)
        self.assertEqual(table["columns"], ["a"])
        self.assertEqual(table["rows"], [[1.0], [2.0]])

    def test_without_fingerprint_never_reuses(self) -> None:
        payload = {k: v for k, v in self.payload.items() if k != "fingerprint"}
        self.assertIsNone(self.session.eval_node({**payload, "cacheable": True}).get("cached"))
        self.assertIsNone(self.session.eval_node({**payload, "cacheable": True}).get("cached"))


if __name__ == "__main__":
    unittest.main()
