"""训练控制项：优化器 / 学习率调度 / 梯度累积 / 精度（AMP）。

这一组里**梯度累积那条是真值**，不是"和上次跑得一样"：k 个 micro-batch 的批均值
再取平均，就是全体样本的批均值 —— 所以"批 b × 累积 k"与"批 b×k"必须给出**同一组
权重**。学习率调度同样不靠感觉：余弦退火跑满必须落在下限上，阶梯衰减的倍率是算得出来的。

另外两条守的是结构：

* **训练循环只有一份**（三个训练节点共用 `_run_training`）—— 见 `test_only_one_...`；
* **设了但不会生效的参数必须当场报错**（`fit_model` 那一档），不能静默忽略。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures import feed, port, synthetic  # noqa: E402
from sciviz_host import gpu_ops, session  # noqa: E402


class _Silent:
    """`_run_training` 只要环境两件事：看一次取消、报一次进度。"""

    def __init__(self) -> None:
        self.messages: list[tuple[float, str]] = []

    def check_cancel(self) -> None:
        return None

    def progress(self, ratio: float, message: str = "") -> None:
        self.messages.append((ratio, message))


def _data(rows: int = 8):
    import torch

    x = torch.arange(rows * 3, dtype=torch.float32).reshape(rows, 3) / 10.0
    y = torch.arange(rows, dtype=torch.float32).reshape(rows, 1) / 10.0
    return x, y


def _fresh_model():
    """同一个种子 = 同一组初始权重。两次对照必须从同一处出发，否则比的不是累积"""

    import torch
    from torch import nn

    torch.manual_seed(123)
    return nn.Sequential(nn.Linear(3, 4), nn.ReLU(), nn.Linear(4, 1))


def _run(*, batch: int, accumulate: int, epochs: int = 1, rows: int = 8, **params):
    import torch
    from torch.utils.data import DataLoader, TensorDataset

    x, y = _data(rows)
    model = _fresh_model()
    loader = DataLoader(TensorDataset(x, y), batch_size=batch, shuffle=False)

    def step(batch_data):
        batch_x, batch_y = batch_data
        loss = torch.nn.functional.mse_loss(model(batch_x), batch_y)
        return loss, int(batch_x.shape[0]), {}, None, None

    outcome = gpu_ops._run_training(
        _Silent(),
        model,
        loader,
        params={"epochs": epochs, "lr": 0.1, "optimizer": "SGD", "accumulate": accumulate, **params},
        device="cpu",
        epochs=epochs,
        step=step,
    )
    return model, outcome


class GradientAccumulationTest(unittest.TestCase):
    def test_accumulated_micro_batches_equal_one_big_batch(self) -> None:
        """4 批 ×2 个样本 与 1 批 ×8 个样本：数学上就是同一件事。"""

        import torch

        micro, _ = _run(batch=2, accumulate=4)
        single, _ = _run(batch=8, accumulate=1)
        for index, (left, right) in enumerate(zip(micro.parameters(), single.parameters())):
            self.assertTrue(
                torch.allclose(left, right, atol=1e-6, rtol=0),
                f"第 {index} 个参数不一致：累积出来的梯度不等于大批次的梯度。\n{left}\n{right}",
            )

    def test_accumulation_is_reported(self) -> None:
        _, outcome = _run(batch=2, accumulate=4)
        self.assertEqual(outcome.accumulate, 4)
        self.assertEqual(outcome.facts()["梯度累积步数"], 4.0)

    def test_leftover_micro_batches_are_not_dropped(self) -> None:
        """一轮末尾不足累积数的那些批也要更新 —— 丢掉等于悄悄少学几个批次。"""

        import torch

        trained, _ = _run(rows=6, batch=2, accumulate=4)
        reference = _fresh_model()
        self.assertFalse(
            all(
                torch.allclose(left, right, atol=1e-9, rtol=0)
                for left, right in zip(trained.parameters(), reference.parameters())
            ),
            "只攒了一半就整组丢掉：权重一次都没更新",
        )

    def test_default_is_no_accumulation(self) -> None:
        _, outcome = _run(batch=8, accumulate=1)
        self.assertEqual(outcome.accumulate, 1)


class SchedulerTest(unittest.TestCase):
    def test_default_is_no_schedule(self) -> None:
        """默认不动学习率：加一个选项不该让已有工程的训练结果悄悄变了。"""

        _, outcome = _run(batch=8, accumulate=1, epochs=3, lr=0.05)
        self.assertEqual(outcome.scheduler, "无")
        self.assertAlmostEqual(outcome.final_lr, 0.05, places=9)

    def test_cosine_ends_on_the_floor(self) -> None:
        _, outcome = _run(
            batch=8, accumulate=1, epochs=4, lr=1.0, scheduler="余弦退火", minLr=0.1
        )
        self.assertEqual(outcome.scheduler, "余弦退火")
        self.assertAlmostEqual(outcome.final_lr, 0.1, places=9)

    def test_step_decay_multiplies_by_gamma(self) -> None:
        """1.0、每轮乘 0.5、跑 3 轮 → 0.125。这是算出来的，不是观察出来的。"""

        _, outcome = _run(
            batch=8,
            accumulate=1,
            epochs=3,
            lr=1.0,
            scheduler="阶梯衰减",
            schedulerStep=1,
            schedulerGamma=0.5,
        )
        self.assertAlmostEqual(outcome.final_lr, 0.125, places=9)

    def test_lr_never_goes_below_the_floor(self) -> None:
        _, outcome = _run(
            batch=8,
            accumulate=1,
            epochs=3,
            lr=1.0,
            scheduler="阶梯衰减",
            schedulerStep=1,
            schedulerGamma=0.1,
            minLr=0.5,
        )
        self.assertAlmostEqual(outcome.final_lr, 0.5, places=9)

    def test_unknown_scheduler_says_what_is_allowed(self) -> None:
        with self.assertRaises(ValueError) as caught:
            _run(batch=8, accumulate=1, scheduler="随便")
        self.assertIn("余弦退火", str(caught.exception))


class PrecisionTest(unittest.TestCase):
    def test_default_is_fp32(self) -> None:
        """默认不动数值：混合精度不是"更快的 fp32"，它换的是另一套数。"""

        self.assertEqual(gpu_ops._resolve_precision({}, "cpu"), "fp32")
        self.assertEqual(gpu_ops._resolve_precision({"precision": "fp32"}, "cuda"), "fp32")
        self.assertEqual(gpu_ops._resolve_precision({"precision": "bf16"}, "cuda"), "bf16")

    def test_fp16_on_cpu_says_which_way_out(self) -> None:
        """静默降级会让人以为自己正在用半精度 —— 报错并给出可照做的三条路。"""

        with self.assertRaises(ValueError) as caught:
            gpu_ops._resolve_precision({"precision": "fp16"}, "cpu")
        message = str(caught.exception)
        self.assertIn("CUDA", message)
        self.assertIn("bf16", message)

    def test_bf16_runs_and_is_reported(self) -> None:
        import torch

        _, outcome = _run(batch=8, accumulate=1, precision="bf16")
        self.assertEqual(outcome.precision, "bf16")
        self.assertTrue(torch.isfinite(torch.tensor(outcome.final_lr)))


class OneLoopTest(unittest.TestCase):
    def test_only_one_place_computes_gradients(self) -> None:
        """三个训练节点共用一份循环：梯度回传在宿主里只允许出现一次。

        这条守的是 AGENTS.md R1。以前 train.mlp 与 train.cnn1d 各写一遍循环，
        加一个训练选项要改三处，而漏改的那一处不会报错 —— 它只会让那个节点的行为
        与另外两个悄悄不同。
        """

        import inspect

        source = Path(gpu_ops.__file__).read_text(encoding="utf-8")
        loop = inspect.getsource(gpu_ops._run_training)
        self.assertGreater(loop.count(".backward()"), 0, "循环里居然没有梯度回传")
        self.assertEqual(
            source.count(".backward()"),
            loop.count(".backward()"),
            "训练循环只能有一份：三个训练节点必须共用 `_run_training`"
            "（多出来的梯度回传说明有人在算子内部又写了一遍循环）",
        )

    def test_fit_model_rejects_controls_it_cannot_honour(self) -> None:
        """设了但不会生效，比没有这个参数更坏：报告里参数是真的，效果是假的。"""

        with self.assertRaises(ValueError) as caught:
            gpu_ops._reject_host_controls({"scheduler": "余弦退火", "accumulate": 4})
        message = str(caught.exception)
        self.assertIn("学习率调度", message)
        self.assertIn("梯度累积", message)
        # 默认值不算"设了"
        gpu_ops._reject_host_controls({"scheduler": "无", "accumulate": 1, "precision": "fp32"})

    def test_fit_model_still_rejects_explicit_precision(self) -> None:
        with self.assertRaises(ValueError) as caught:
            gpu_ops._reject_host_controls({"precision": "bf16"})
        self.assertIn("精度", str(caught.exception))


class TrainNodeControlsTest(unittest.TestCase):
    """控制项要真的走到指标与元信息里 —— 否则界面上设了也没人看得见。"""

    def setUp(self) -> None:
        self.engine = session.EngineSession("controls")
        feed(self.engine, synthetic(), "t")

    def evaluate(self, node_id: str, node_type: str, params, inputs, ports):
        result = self.engine.eval_node(
            {
                "nodeId": node_id,
                "nodeType": node_type,
                "params": params,
                "inputs": inputs,
                "outputPorts": ports,
            }
        )
        if not result.get("ok"):
            self.fail(f"{node_type} 失败：{result.get('message')}\n{result.get('traceback')}")
        return result

    def test_mlp_node_reports_accumulation_and_schedule(self) -> None:
        source = self.evaluate(
            "src",
            "data.source",
            {"datasetId": "synthetic"},
            {},
            [{"id": "data", "shape": "table"}],
        )
        self.assertTrue(source["ok"])
        result = self.evaluate(
            "model",
            "train.mlp",
            {
                "label": "3",
                "features": "1,2",
                "epochs": 4,
                "hidden": 8,
                "seed": 1,
                "batch": 64,
                "accumulate": 2,
                "scheduler": "余弦退火",
                "minLr": 0.0005,
                "precision": "fp32",
            },
            {"train": port("src", "data")},
            [{"id": "metrics", "shape": "metrics"}],
        )
        values = result["refs"]["metrics"]["values"]
        # 余弦退火跑满 → 落在下限上（这个数是算出来的，不是观察出来的）
        self.assertAlmostEqual(values["最终学习率"], 0.0005, places=9)
        self.assertEqual(values["梯度累积步数"], 2.0)
        # 字符串那部分走元信息：指标只收数值
        self.assertEqual(result["meta"]["精度"], "fp32")
        self.assertEqual(result["meta"]["调度器"], "余弦退火")
