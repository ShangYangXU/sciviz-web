"""训练列选择支持列名与从 1 开始的数值信号序号。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host.gpu_ops import _default_columns, _resolve_column_selection  # noqa: E402


class ColumnSelectorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.frame = pd.DataFrame(
            {
                "采样时间": [1.0, 2.0],
                "工作段编号": [1, 1],
                "蒸汽压力": [11.1, 11.2],
                "设定压力": [11.0, 11.0],
                "流量": [5.0, 5.1],
            }
        )

    def test_ordinals_skip_time_and_segment_id(self) -> None:
        self.assertEqual(
            _resolve_column_selection(
                self.frame,
                "1, 2，3",
                "训练集",
                "特征",
                time_columns={"采样时间"},
            ),
            ["蒸汽压力", "设定压力", "流量"],
        )

    def test_default_dataset_excludes_time_and_segment_columns(self) -> None:
        features, labels = _default_columns(
            self.frame,
            {"label": "3", "features": ""},
            "训练集",
            require_target=True,
            time_columns={"采样时间"},
        )
        self.assertEqual(features, ("蒸汽压力", "设定压力"))
        self.assertEqual(labels, ("流量",))

    def test_exact_numeric_column_name_takes_precedence_over_ordinal(self) -> None:
        frame = pd.DataFrame({"1": [9.0], "压力": [11.0]})
        self.assertEqual(_resolve_column_selection(frame, "1", "训练集", "标签"), ["1"])

    def test_out_of_range_ordinal_reports_available_mapping(self) -> None:
        with self.assertRaisesRegex(KeyError, "1=蒸汽压力.*2=设定压力.*3=流量"):
            _resolve_column_selection(
                self.frame,
                "4",
                "训练集",
                "标签",
                time_columns={"采样时间"},
            )


if __name__ == "__main__":
    unittest.main()
