"""跨运行的节点结果缓存 —— **进程级**，活在宿主里，不跨进程、不落盘。

## 为什么在宿主这一层

节点的输出（DataFrame）在引擎进程里，不在文件里。所以"上次算过的那份"只有**还活着的宿主**
拿得出来。CLI 每次 `run` 都是新的 WebSocket 会话、浏览器刷新页面也是新的会话，但只要宿主
进程还在，那些输出就还在 —— 缓存放这里，这一类重复计算就省掉了。

## 只缓存"可缓存"的

判据不在这一层：**主线程按算子声明的 `determinism` 决定**（契约规格 R6.4）——
`deterministic` 与 `seeded`（种子一致时）可缓存，`stochastic` / `volatile` 不可。
宿主只认请求里那个 `cacheable` 布尔值，这样"能不能复用"只有一处判据。

这条规矩不是洁癖：两个训练算子声明 `stochastic`（GPU 上的非确定性归约，实测 CPU/GPU
不逐位相同）。把它们的产物缓存起来复用，等于把"这一次算的"冒充成"这一次算的"——
而运行清单会照着报，看起来完全正常。

## 上限

缓存是为了省一次重算，不是为了把内存吃光。两条上限：
条目数，以及**单个条目太大就不进缓存**（几百万行的表留着"以防万一"不划算）。
"""

from __future__ import annotations

import os
from typing import Any

#: 最多留几条。图通常几十个节点，这个数够覆盖"重跑一遍同一张图"
MAX_ENTRIES = int(os.environ.get("SCIVIZ_CACHE_ENTRIES", "32"))

#: 单条结果的表格行数上限。超过它就不缓存 —— 内存换那一次重算不划算
MAX_ROWS = int(os.environ.get("SCIVIZ_CACHE_ROWS", "2000000"))


def rows_of(payload: dict[str, Any]) -> int:
    """这条缓存一共多少行（各端口里最大的那个）。

    只看得到摘要（引擎侧的对象不在这儿），但对"大不大"的判断足够了。
    """
    result = payload.get("result") or {}
    biggest = 0
    for ref in (result.get("refs") or {}).values():
        if isinstance(ref, dict):
            biggest = max(biggest, int(ref.get("rowCount") or 0))
    return biggest


class ResultCache:
    """一个进程一份。键是主线程算好的输入指纹。

    每条缓存装两样东西：

    - `result`：那一次求值回给上层的摘要（refs / artifacts / meta）；
    - `outputs`：**引擎侧那批输出对象本身**（DataFrame 等）。

    `outputs` 不能省：命中缓存时要把它们放回**当前这次会话**，否则下游读输入、
    探针取行值都会说"上游节点还没有求值结果"。只回摘要的第一版就是这么坏的 ——
    盲测当场撞上：`run` 之后紧跟一条 `inspect --rows`，缓存命中，然后取不到行值。
    """

    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}
        self.hits = 0
        self.misses = 0
        self.skips = 0  # 结果太大、没进缓存的次数

    def get(self, key: str) -> dict[str, Any] | None:
        hit = self._items.get(key)
        if hit is None:
            self.misses += 1
            return None
        # 重新插入 = 提到队尾，于是 dict 的插入序就是 LRU 序（Python 3.7+ 保序）
        self._items.pop(key)
        self._items[key] = hit
        self.hits += 1
        return hit

    def put(self, key: str, result: dict[str, Any]) -> None:
        """`result` 是 `{"result": 摘要, "outputs": 输出对象}`"""
        if not key:
            return
        if rows_of(result) > MAX_ROWS:
            self.skips += 1
            return
        self._items.pop(key, None)
        self._items[key] = result
        while len(self._items) > MAX_ENTRIES:
            self._items.pop(next(iter(self._items)))

    def clear(self) -> None:
        self._items.clear()

    def stats(self) -> dict[str, int]:
        return {
            "entries": len(self._items),
            "hits": self.hits,
            "misses": self.misses,
            #: 太大而没进缓存的次数：非零说明有节点白算了 —— 那是参数该调的信号
            "skippedTooBig": self.skips,
        }


#: 宿主进程中唯一的一份
RESULTS = ResultCache()
