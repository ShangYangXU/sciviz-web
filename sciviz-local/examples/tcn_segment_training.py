def fit_model(
    model_factory,
    train_data,
    test_data,
    device,
    env,
    past_n=60,
    future_n=1,
    stride=1,
    batch_size=64,
    epochs=100,
    learning_rate=0.001,
    patience=12,
    min_delta=0.0,
    seed=42,
):
    """按工作段独立滑窗训练 TCN；测试集作为早停验证集。"""
    import numpy as np
    import pandas as pd
    import torch
    from torch.utils.data import DataLoader, Dataset

    segment_column = "工作段编号"

    past_n = int(past_n)
    future_n = int(future_n)
    stride = int(stride)
    batch_size = int(batch_size)
    epochs = int(epochs)
    patience = int(patience)
    seed = int(seed)
    learning_rate = float(learning_rate)
    min_delta = float(min_delta)

    if past_n < 1 or future_n < 1 or stride < 1:
        raise ValueError("past_n、future_n、stride 都必须大于 0")
    if batch_size < 1 or epochs < 1 or patience < 1:
        raise ValueError("batch_size、epochs、patience 都必须大于 0")
    if learning_rate <= 0 or min_delta < 0:
        raise ValueError("learning_rate 必须大于 0，min_delta 不能小于 0")
    if test_data is None:
        raise ValueError("请连接测试集；这个函数用测试集损失执行早停")

    def prepare_frame(data, name):
        if not isinstance(data, pd.DataFrame):
            raise TypeError(f"{name}必须是 pandas DataFrame")
        if data.empty:
            raise ValueError(f"{name}为空")
        if segment_column not in data.columns:
            raise ValueError(f"{name}缺少「{segment_column}」列")
        if data[segment_column].isna().any():
            raise ValueError(f"{name}的「{segment_column}」存在空值")
        return data

    train_data = prepare_frame(train_data, "训练集")
    test_data = prepare_frame(test_data, "测试集")
    if list(train_data.columns) != list(test_data.columns):
        raise ValueError("训练集和测试集的列名或列顺序不一致")

    # 当前工作流约定第一列是时间列；时间和工作段编号都不进入模型。
    time_column = train_data.columns[0]
    excluded = {time_column, segment_column}
    feature_columns = [
        column
        for column in train_data.select_dtypes(include=[np.number]).columns
        if column not in excluded
    ]
    if not feature_columns:
        raise ValueError("除时间列和工作段编号外，没有可训练的数值通道")

    class SegmentWindowDataset(Dataset):
        """各工作段独立切窗，任何样本都不会跨工作段边界。"""

        def __init__(self, data, name):
            self.values = data.loc[:, feature_columns].to_numpy(
                dtype=np.float32, na_value=np.nan, copy=True
            )
            self.groups = []
            self.starts = []
            counts = []

            for positions in data.groupby(segment_column, sort=False).indices.values():
                positions = np.sort(np.asarray(positions, dtype=np.int64))
                possible = len(positions) - past_n - future_n + 1
                if possible <= 0:
                    continue

                starts = np.arange(0, possible, stride, dtype=np.int64)
                finite = np.isfinite(self.values[positions]).all(axis=1)
                bad_prefix = np.empty(len(positions) + 1, dtype=np.int64)
                bad_prefix[0] = 0
                np.cumsum((~finite).astype(np.int64), out=bad_prefix[1:])
                ends = starts + past_n + future_n
                starts = starts[bad_prefix[ends] == bad_prefix[starts]]

                if len(starts):
                    self.groups.append(positions)
                    self.starts.append(starts)
                    counts.append(len(starts))

            if not counts:
                minimum = past_n + future_n
                raise ValueError(
                    f"{name}没有可用窗口；每个工作段至少需要 {minimum} 个连续有效点"
                )
            self.cumulative_ends = np.cumsum(counts, dtype=np.int64)

        def __len__(self):
            return int(self.cumulative_ends[-1])

        def __getitem__(self, index):
            if index < 0:
                index += len(self)
            if index < 0 or index >= len(self):
                raise IndexError("窗口索引超出范围")

            group_index = int(
                np.searchsorted(self.cumulative_ends, index, side="right")
            )
            previous_end = (
                0 if group_index == 0 else int(self.cumulative_ends[group_index - 1])
            )
            local_index = int(index - previous_end)
            positions = self.groups[group_index]
            start = int(self.starts[group_index][local_index])

            x_rows = positions[start : start + past_n]
            y_rows = positions[start + past_n : start + past_n + future_n]
            x = torch.from_numpy(self.values[x_rows])
            # TCN 输出二维张量；多步预测时把“未来步 × 通道”展平。
            y = torch.from_numpy(self.values[y_rows].reshape(-1))
            return x, y

    train_dataset = SegmentWindowDataset(train_data, "训练集")
    test_dataset = SegmentWindowDataset(test_data, "测试集")
    generator = torch.Generator().manual_seed(seed)
    train_loader = DataLoader(
        train_dataset,
        batch_size=batch_size,
        shuffle=True,
        generator=generator,
        drop_last=False,
        num_workers=0,
    )
    test_loader = DataLoader(
        test_dataset,
        batch_size=batch_size,
        shuffle=False,
        drop_last=False,
        num_workers=0,
    )

    torch.manual_seed(seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(seed)

    channel_count = len(feature_columns)
    if future_n == 1:
        target_names = list(feature_columns)
    else:
        target_names = [
            f"t+{step}:{column}"
            for step in range(1, future_n + 1)
            for column in feature_columns
        ]
    model = model_factory(
        input_shape=(past_n, channel_count),
        output_shape=(future_n * channel_count,),
        task="regression",
        feature_names=feature_columns,
        target_names=target_names,
        input_axes=("time", "feature"),
        output_axes=("target",),
        metadata={
            "timeColumn": str(time_column),
            "segmentColumn": segment_column,
            "pastN": past_n,
            "futureN": future_n,
            "stride": stride,
        },
    )
    loss_fn = torch.nn.MSELoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=learning_rate)

    def mean_loss(loader, training):
        model.train(training)
        total_loss = 0.0
        sample_count = 0
        context = torch.enable_grad() if training else torch.no_grad()
        with context:
            for x, y in loader:
                env.check_cancel()
                x = x.to(device=device, dtype=torch.float32)
                y = y.to(device=device, dtype=torch.float32)
                if training:
                    optimizer.zero_grad(set_to_none=True)
                prediction = model(x)
                if prediction.shape != y.shape:
                    raise ValueError(
                        f"TCN 输出形状 {tuple(prediction.shape)} 与标签形状 {tuple(y.shape)} 不一致"
                    )
                loss = loss_fn(prediction, y)
                if training:
                    loss.backward()
                    optimizer.step()
                count = int(x.shape[0])
                total_loss += float(loss.detach().cpu()) * count
                sample_count += count
        return total_loss / max(1, sample_count)

    history = []
    best_test_loss = float("inf")
    best_epoch = 0
    best_state = None
    stale_epochs = 0

    for epoch in range(1, epochs + 1):
        train_loss = mean_loss(train_loader, training=True)
        test_loss = mean_loss(test_loader, training=False)
        history.append(
            {"轮次": epoch, "训练损失": train_loss, "测试损失": test_loss}
        )

        if test_loss < best_test_loss - min_delta:
            best_test_loss = test_loss
            best_epoch = epoch
            stale_epochs = 0
            best_state = {
                name: value.detach().cpu().clone()
                for name, value in model.state_dict().items()
            }
        else:
            stale_epochs += 1

        env.progress(epoch / epochs, f"第 {epoch}/{epochs} 轮，测试损失 {test_loss:.6g}")
        if stale_epochs >= patience:
            break

    if best_state is not None:
        model.load_state_dict(best_state)

    return {
        "model": model,
        "metrics": {
            "最佳测试损失": best_test_loss,
            "最佳轮次": float(best_epoch),
            "训练轮数": float(len(history)),
            "训练窗口数": float(len(train_dataset)),
            "测试窗口数": float(len(test_dataset)),
            "早停触发": float(len(history) < epochs),
        },
        "history": history,
        "metadata": {
            "inputMode": "sequence",
            "window": past_n,
            "horizon": future_n,
            "stride": stride,
            "segmentColumn": segment_column,
            "timeColumn": str(time_column),
            "featureColumns": [str(column) for column in feature_columns],
            "loaderBatchSize": batch_size,
        },
    }
