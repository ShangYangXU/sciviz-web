"""早停的判据。

`EarlyStop` 刻意写成**不碰 torch** 的纯逻辑 —— 否则要验它就得真训一个网络，
而真训练是随机的：随机训练里"该停的那一轮"每次都不一样，测出来的红/绿说明不了什么。
把判据抽出来之后，这里可以用一串手写的损失序列把每条口径钉死。

权重快照、恢复、重读最终指标那部分仍然只在算子里（要 torch），由 `sciviz run`
实跑一次覆盖（见开发日志），这里不假装验了它。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sciviz_host import gpu_ops  # noqa: E402


def run(stop, values):
    """按顺序喂损失，返回每轮的状态。遇到触发就停（与算子里的 break 一致）"""
    log = []
    for epoch, value in enumerate(values, start=1):
        improved = stop.step(epoch, value)
        log.append((epoch, improved, stop.triggered, stop.best_epoch))
        if stop.triggered:
            return log
    return log


class EarlyStopTest(unittest.TestCase):
    def test_stops_after_patience_epochs_without_improvement(self) -> None:
        stop = gpu_ops.EarlyStop(3, 0.0, "验证损失")
        log = run(stop, [1.0, 0.8, 0.6, 0.6, 0.6, 0.6])
        self.assertEqual([row[0] for row in log], [1, 2, 3, 4, 5, 6])
        self.assertTrue(log[-1][2], "连续 3 轮没改善就该在第 6 轮停")
        self.assertEqual(stop.best_epoch, 3, "最好的一次是第 3 轮，交付的权重也该是它")
        self.assertEqual(stop.stopped_at, 6)

    def test_improvement_resets_the_wait(self) -> None:
        """容忍轮数是"**连续**几轮没进步"，不是"累计"：中途进步一次就该重新数"""
        stop = gpu_ops.EarlyStop(2, 0.0, "验证损失")
        log = run(stop, [1.0, 0.9, 0.8, 0.85, 0.7, 0.6])
        self.assertFalse(any(row[2] for row in log), "每次进步都打断了容忍计数，不该停")
        self.assertEqual(stop.best_epoch, 6)

    def test_change_smaller_than_min_delta_is_not_improvement(self) -> None:
        """浮点噪声级别的"改善"不算改善，否则容忍轮数永远用不完，早停形同不存在"""
        stop = gpu_ops.EarlyStop(2, 0.01, "验证损失")
        log = run(stop, [1.0, 0.9995, 0.999])
        self.assertEqual([row[1] for row in log], [True, False, False], "0.0005 的进步小于 0.01")
        self.assertTrue(log[-1][2], "两轮不算改善就该停")

    def test_missing_reading_neither_improves_nor_counts(self) -> None:
        """NaN / None 不累计容忍轮数：拿缺失的读数去判"没进步"，
        会把"验证集是空的"伪装成"早停生效了"，然后交出一份根本没跑几轮的结果"""
        stop = gpu_ops.EarlyStop(2, 0.0, "验证损失")
        run(stop, [1.0, None, float("nan"), float("inf"), 0.5])
        self.assertFalse(stop.triggered, "缺失的读数不该被当成「没进步」")
        self.assertEqual(stop.best_epoch, 5, "唯一一次真实的改善是第 5 轮")

    def test_monitor_is_validation_loss_when_val_exists(self) -> None:
        stop = gpu_ops._early_stop({"earlyStop": True}, has_val=True)
        self.assertIsNotNone(stop)
        self.assertEqual(stop.monitor, "验证损失")

    def test_falls_back_to_train_loss_and_says_so(self) -> None:
        """没接验证集时早停仍然能省时间，但它防不了过拟合 —— 那句话必须被说出来"""
        stop = gpu_ops._early_stop({"earlyStop": True}, has_val=False)
        self.assertEqual(stop.monitor, "训练损失")
        stop.step(1, 0.5)
        stop.step(2, 0.5)
        stop.step(3, 0.5)
        self.assertIn("训练损失", stop.note(50))

    def test_off_by_default(self) -> None:
        """默认关：加一个选项不该让已有工程的训练结果悄悄变了"""
        self.assertIsNone(gpu_ops._early_stop({}, has_val=True))
        self.assertIsNone(gpu_ops._early_stop({"earlyStop": False}, has_val=True))
        # 但手改工程文件写出来的几种"真"都要认
        for truthy in (True, "true", "1", "是"):
            with self.subTest(earlyStop=truthy):
                self.assertIsNotNone(gpu_ops._early_stop({"earlyStop": truthy}, has_val=True))

    def test_patience_and_min_delta_come_from_params(self) -> None:
        stop = gpu_ops._early_stop(
            {"earlyStop": True, "patience": 1, "minDelta": 0.5}, has_val=True
        )
        self.assertEqual(stop.patience, 1)
        self.assertEqual(stop.min_delta, 0.5)
        # 非法值（0 / 负数 / 空串）退到安全的一侧，而不是算出"第 0 轮就停"
        broken = gpu_ops._early_stop({"earlyStop": True, "patience": 0, "minDelta": -3}, has_val=True)
        self.assertGreaterEqual(broken.patience, 1)
        self.assertEqual(broken.min_delta, 0.0)

    def test_defaults_match_the_registry(self) -> None:
        """界面上写的默认值与算子里的默认值必须是同一份，否则"没动过参数"的两次训练不等价"""
        stop = gpu_ops._early_stop({"earlyStop": True}, has_val=True)
        self.assertEqual(stop.patience, gpu_ops.DEFAULT_PATIENCE)
        self.assertEqual(stop.min_delta, gpu_ops.DEFAULT_MIN_DELTA)


class EarlyStopContractTest(unittest.TestCase):
    """早停的三件事必须一起发生：停、回到最好的权重、指标按恢复后的权重重读。

    这里验不了 torch 那部分，但可以钉住"参数名与判据同源"：界面上的参数键名
    改了而算子没改，早停就会静默失效（读不到参数=没打开）。
    """

    def test_param_names_are_the_ones_the_ui_sends(self) -> None:
        registry = Path(gpu_ops.__file__).resolve().parents[2] / "sciviz-web" / "src" / "workflow" / "nodeRegistry.ts"
        text = registry.read_text(encoding="utf-8")
        for key in ("earlyStop", "patience", "minDelta"):
            self.assertIn(f"'{key}'", text, f"界面上没有参数键 {key} —— 算子读不到它，早停会静默失效")


if __name__ == '__main__':
    unittest.main()
