"""拆列模块：**一列一个接口**这件事本身（T-拆列的收尾）。

节点（`data.columns`）把这件事接进图里，而真正的实现是 `operators.split_columns`
—— 一个可以直接 import 的普通函数。两条判据分开守：

- 这里守**函数**的行为：形状、行数、索引、缺列时报错；
- 宿主那条 e2e / `sciviz verify` 的夹具守**节点**：端口按上游实际的列长出来、每列一个。

形状那几条不是洁癖：下游（划分、评估、标准化）都按"表"接，一旦某一步给出 Series，
报错会出现在离原因很远的地方。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import bridge  # noqa: E402


class SplitColumnsTest(unittest.TestCase):
    def setUp(self) -> None:
        # 与宿主用的是同一份实现（bridge 把共享算子目录放上 sys.path）
        self.ops = bridge.shared_operators()
        self.frame = pd.DataFrame(
            {
                '时间': [0, 10, 20],
                '液位': [1.0, 2.0, 3.0],
                '流量': [4, 5, 6],
                '标签': ['a', 'b', 'c'],
            }
        )

    def test_one_column_one_frame(self) -> None:
        out = self.ops.split_columns(self.frame)
        self.assertEqual(list(out), ['时间', '液位', '流量', '标签'], '键就是列名，顺序即端口顺序')
        for name, piece in out.items():
            self.assertIsInstance(piece, pd.DataFrame, f'「{name}」必须是 DataFrame，不是 Series')
            self.assertEqual(list(piece.columns), [name], '一张单列表 —— 不多不少')
            self.assertEqual(len(piece), len(self.frame), '行数不能变：拆列只改形状')
            self.assertEqual(list(piece.index), list(self.frame.index), '索引也要原样')

    def test_feature_indices_select_values_and_dtypes(self) -> None:
        out = self.ops.split_columns(self.frame, [1, 2], {'时间'})
        self.assertEqual(out['液位']['液位'].tolist(), [1.0, 2.0, 3.0])
        self.assertEqual(out['流量']['流量'].tolist(), [4, 5, 6])
        # dtype 跟着走：把整数列拆成 object 会让下游的数值判断失效
        self.assertEqual(out['液位']['液位'].dtype, self.frame['液位'].dtype)
        self.assertEqual(out['流量']['流量'].dtype, self.frame['流量'].dtype)

    def test_subset_and_order_follow_the_request(self) -> None:
        out = self.ops.split_columns(self.frame, [2, 1], {'时间'})
        self.assertEqual(list(out), ['流量', '液位'], '给的顺序就是端口的顺序')

    def test_out_of_range_index_says_what_is_available(self) -> None:
        """越界索引要带上序号映射 —— 不然人只能去猜特征顺序"""
        with self.assertRaises(KeyError) as err:
            self.ops.split_columns(self.frame, [9], {'时间'})
        self.assertIn('液位', str(err.exception))
        self.assertIn('9', str(err.exception))

    def test_time_column_does_not_consume_feature_index(self) -> None:
        out = self.ops.split_columns(self.frame, [1], {'时间'})
        self.assertEqual(list(out), ['液位'])

    def test_non_positive_index_is_rejected(self) -> None:
        with self.assertRaises(KeyError):
            self.ops.split_columns(self.frame, [0], {'时间'})

    def test_empty_table_gives_no_ports(self) -> None:
        out = self.ops.split_columns(pd.DataFrame())
        self.assertEqual(out, {}, '空表没有列，也就没有端口 —— 这是"没有"，不是"报错"')

    def test_node_and_function_are_the_same_thing(self) -> None:
        """节点只是把端口翻译成一次调用：两者结果必须逐块相等（R1：不许第二处真相）"""

        class Env:
            pass

        env = Env()
        env.time_columns = {'时间'}
        ports = [{'id': '液位'}, {'id': '流量'}]
        via_node = self.ops.op_columns(env, {'columns': '1,2'}, {'data': self.frame}, ports)
        via_fn = self.ops.split_columns(self.frame, [1, 2], {'时间'})
        self.assertEqual(list(via_node), list(via_fn))
        for name in via_fn:
            pd.testing.assert_frame_equal(via_node[name], via_fn[name])

    def test_legacy_time_port_selects_registered_time_column_from_table(self) -> None:
        class Env:
            time_columns = {'时间'}

        via_legacy_port = self.ops.op_columns(
            Env(),
            {'columns': '__time__'},
            {'data': self.frame},
            [{'id': '__time__'}],
        )
        self.assertEqual(list(via_legacy_port), ['__time__'])
        pd.testing.assert_frame_equal(via_legacy_port['__time__'], self.frame[['时间']])


if __name__ == '__main__':
    unittest.main()
