"""评估算子 `eval.score`（待办 T9）。

判据是**独立真值**：同一个输入直接喂给 scikit-learn，逐项比。
不拿引擎自己的上一次输出当期望 —— 那只证明"它和上次一样"，证明不了"它算对了"。

它同时是共享算子（scikit-learn 在 Pyodide 的包表里），所以这里的比较也是
"两个执行面用的是同一套口径"的根据：口径由 sklearn 定，不分浏览器还是宿主。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn import metrics as skm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import bridge  # noqa: E402


class _Env:
    """共享算子用得上的那点外部状态：时间列名 + 元信息登记（见 T11）"""

    time_columns: set[str] = set()

    def __init__(self) -> None:
        self.meta: dict[str, object] = {}

    def set_meta(self, values) -> None:
        self.meta.update(values)


def score(table: pd.DataFrame, env: _Env | None = None, **params) -> dict:
    merged = {"y_true": "y_true", "y_pred": "y_pred", "task": "auto"}
    merged.update(params)
    return bridge.shared_operators().op_eval_score(env or _Env(), merged, {"data": table}, [])


class EvalScoreTest(unittest.TestCase):
    def test_classification_matches_sklearn(self) -> None:
        y_true = ["正常", "正常", "内圈", "内圈", "外圈", "外圈", "内圈", "外圈"]
        y_pred = ["正常", "正常", "内圈", "外圈", "外圈", "外圈", "内圈", "内圈"]
        labels = sorted(set(y_true) | set(y_pred))
        out = score(pd.DataFrame({"y_true": y_true, "y_pred": y_pred}))
        m = out["metrics"]

        self.assertEqual(m["样本数"], 8.0)
        self.assertEqual(m["类别数"], 3.0)
        self.assertAlmostEqual(m["准确率"], skm.accuracy_score(y_true, y_pred))
        for key, average in (("宏平均精确率", "macro"), ("宏平均召回率", "macro"), ("宏平均F1", "macro")):
            metric = {"宏平均精确率": skm.precision_score, "宏平均召回率": skm.recall_score, "宏平均F1": skm.f1_score}[key]
            self.assertAlmostEqual(
                m[key],
                metric(y_true, y_pred, labels=labels, average=average, zero_division=0),
                msg=f"{key} 与 sklearn 对不上",
            )
        self.assertAlmostEqual(
            m["加权F1"], skm.f1_score(y_true, y_pred, labels=labels, average="weighted", zero_division=0)
        )

        # 混淆矩阵：逐格比，而不是比总数 —— 行列错位会得到一个"总数相同但含义全错"的表
        expected = skm.confusion_matrix(y_true, y_pred, labels=labels)
        matrix = out["matrix"]
        self.assertEqual(len(matrix), len(labels))
        for i, label in enumerate(labels):
            self.assertEqual(matrix.iloc[i]["真实\\预测"], label)
            self.assertEqual(matrix.iloc[i]["合计"], float(expected[i].sum()))
            for j, other in enumerate(labels):
                self.assertEqual(matrix.iloc[i][f"预测 {other}"], float(expected[i][j]))

        # 分类别指标
        precision, recall, f1, support = skm.precision_recall_fscore_support(
            y_true, y_pred, labels=labels, zero_division=0
        )
        per = out["per_class"]
        for i, label in enumerate(labels):
            self.assertEqual(per.iloc[i]["类别"], label)
            self.assertEqual(per.iloc[i]["支持数"], float(support[i]))
            self.assertAlmostEqual(per.iloc[i]["精确率"], float(precision[i]))
            self.assertAlmostEqual(per.iloc[i]["召回率"], float(recall[i]))
            self.assertAlmostEqual(per.iloc[i]["F1"], float(f1[i]))

    def test_classification_is_order_stable(self) -> None:
        """行的顺序不该改变结果：同一个输入换行序，"指标变了"是最容易被误读成真实差异的噪声"""
        y_true = ["b", "a", "c", "a", "b", "c"]
        y_pred = ["b", "a", "c", "b", "a", "c"]
        first = score(pd.DataFrame({"y_true": y_true, "y_pred": y_pred}))
        shuffled = score(pd.DataFrame({"y_true": y_true, "y_pred": y_pred}).sample(frac=1, random_state=0))
        self.assertEqual(first["metrics"], shuffled["metrics"])
        self.assertTrue(first["matrix"].equals(shuffled["matrix"]), "混淆矩阵的行列顺序也要稳定")

    def test_regression_matches_sklearn(self) -> None:
        y_true = np.array([1.0, 2.0, 3.0, 4.0, 5.5])
        y_pred = np.array([1.2, 1.9, 3.4, 3.8, 5.0])
        out = score(pd.DataFrame({"y_true": y_true, "y_pred": y_pred}))
        m = out["metrics"]

        self.assertEqual(m["样本数"], 5.0)
        self.assertAlmostEqual(m["MAE"], skm.mean_absolute_error(y_true, y_pred))
        self.assertAlmostEqual(m["RMSE"], float(np.sqrt(skm.mean_squared_error(y_true, y_pred))))
        self.assertAlmostEqual(m["R2"], skm.r2_score(y_true, y_pred))
        # 回归没有混淆矩阵与分类别指标 —— 返回 None（界面说"本次没有值"），
        # 而不是空表（那会被当成"算出来是空的"）
        self.assertIsNone(out["matrix"])
        self.assertIsNone(out["per_class"])

    def test_task_is_inferred_from_the_labels(self) -> None:
        """auto：字符串标签 → 分类；小数标签 → 回归。判据只有一处（共享算子里的 infer_task）"""
        ops = bridge.shared_operators()
        self.assertEqual(ops.infer_task(np.array(["正常", "故障"])), "分类")
        self.assertEqual(ops.infer_task(np.array([0.0, 1.0, 1.0, 0.0])), "分类")
        self.assertEqual(ops.infer_task(np.array([65.2, 66.1, 67.4])), "回归")

    def test_missing_columns_say_what_exists(self) -> None:
        table = pd.DataFrame({"真实": ["a"], "预测": ["a"]})
        with self.assertRaises(KeyError) as caught:
            score(table, y_true="标签", y_pred="预测")
        message = str(caught.exception)
        self.assertIn("标签", message)
        self.assertIn("真实", message, "报错要列出实际有哪些列")

        with self.assertRaises(ValueError):
            score(pd.DataFrame({"y_true": [None], "y_pred": ["a"]}))

    def test_rows_with_missing_values_are_dropped_not_counted(self) -> None:
        """缺失值那一行不算进样本数：把 NaN 当一格算出来的准确率是假的，而且不报错"""
        table = pd.DataFrame(
            {"y_true": ["a", "a", None, "b"], "y_pred": ["a", "b", "a", None]}
        )
        out = score(table)
        self.assertEqual(out["metrics"]["样本数"], 2.0)
        self.assertAlmostEqual(out["metrics"]["准确率"], 0.5)

    def test_reports_which_library_and_task_produced_the_numbers(self) -> None:
        """元信息（T11）：指标只收数值，所以"哪一版实现算的、按哪个任务算的"要单独登记"""
        env = _Env()
        score(pd.DataFrame({"y_true": ["a", "b"], "y_pred": ["a", "b"]}), env=env)
        self.assertTrue(str(env.meta["库"]).startswith("scikit-learn "), env.meta)
        self.assertEqual(env.meta["任务"], "分类")
