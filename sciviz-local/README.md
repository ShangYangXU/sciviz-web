# sciviz-local · 本地执行宿主

把 SciViz 的执行引擎从"浏览器里的 Pyodide"换成"本机的 Python 进程"。换的动机只有
一个：**GPU**。Pyodide 是 CPU-only 的 CPython，接不了 CUDA；顺带解决浏览器内存上限
与长任务无法常驻的问题。

## 它是什么，不是什么

是一个**执行宿主**：跑算子、装数据、算结果，通过 WebSocket 把结果交给前端。
不是一个独立的桌面应用 —— 桌面外壳（Tauri / 启动器）是它之后的一层，见
[开发日志](../docs/开发日志.md)。

浏览器版**不需要被替换**。前端会自动探测：宿主在就跑宿主（能用 GPU），不在就回落
Pyodide（零安装、纯 CPU）。同一个界面，两种后端。

## 环境

整个项目只有**一个** Python 环境：仓库根目录的 `.venv`。从零重建：

```powershell
cd ..            # 回仓库根目录
.\setup-env.ps1
```

装完自查（Python、设备、各库版本、宿主能算的算子）：

```powershell
.\setup-env.ps1 -Update        # 按 requirements.txt 补齐（日常加库用这个）
.\setup-env.ps1 -Locked        # 按 requirements.lock.txt 装（换机器复现用这个）
.\.venv\Scripts\python.exe -m sciviz_host.doctor     # 只看环境现状
```

**别用系统 Python 跑这个项目的代码**：系统里那份 torch 是 CPU-only 构建，
会静默地跑在 CPU 上，而结果看起来完全正常。要加库就加在仓库根的
`requirements.txt`，然后跑 `.\setup-env.ps1 -Update`。

两个清单分工不同：`requirements.txt` 是**要什么**（人改），`requirements.lock.txt`
是**上次装出来的是什么**（生成，97 个包的确切版本）。换机器要复现同一份环境就用
`-Locked`。

VS Code 已经指到这个环境（`.vscode/settings.json`），所以写代码时
`import scipy` 之类直接可用，不需要再单独装。

## 跑起来

```powershell
cd sciviz-local
.\run-host.ps1                 # 用项目自带的 venv（含 CUDA 版 torch）
.\run-host.ps1 --port 9000     # 换端口
.\run-host.ps1 --open          # 顺手打开浏览器
```

**用脚本而不是 `py -3.12 -m sciviz_host`**：全局 Python 里装的是 CPU-only 的 torch，
用它启动会静默地跑在 CPU 上 —— 结果是对的，只是你以为用了 GPU。

前端（`cd sciviz-web && npm run dev`）会自动发现它。也可以强制指定：
`http://localhost:5173/?engine=local` 或 `?engine=pyodide`。

### AI 对话 provider（DeepSeek / OpenCode Go）

右侧「AI 对话」通过本机宿主转发到 OpenAI-compatible API，密钥只读宿主进程的环境变量，
不会进入浏览器、`.sciviz` 或会话日志。省略 `SCIVIZ_AGENT_PROVIDER` 时按
`DEEPSEEK_API_KEY` → `OPENCODE_API_KEY` / `OPENCODE_GO_API_KEY` 自动选择：

仓库不包含任何真实 API key，下面的值只是占位符；需要使用你自己的 provider 账户密钥。

```powershell
# DeepSeek 官方 API（模型省略时由 /models 自动发现）
$env:DEEPSEEK_API_KEY = "<填入你自己的 DeepSeek API key>"
$env:SCIVIZ_AGENT_PROVIDER = "deepseek"   # 可省略，默认 auto

# 或 OpenCode Go
$env:OPENCODE_GO_API_KEY = "<填入你自己的 OpenCode Go API key>"
$env:SCIVIZ_AGENT_PROVIDER = "opencode"   # 可省略，默认 auto
```

默认入口分别是 `https://api.deepseek.com` 与 OpenCode Go 官方专用入口
`https://opencode.ai/zen/go/v1`。Go 固定使用 `deepseek-v4.1-flash`；旧配置中的地址和模型覆盖不会改变它。
下面的通用覆盖仅对 DeepSeek 官方 provider 生效：

```powershell
$env:SCIVIZ_AGENT_BASE_URL = "https://你的网关/v1"
$env:SCIVIZ_AGENT_MODEL = "固定模型名"     # 可省略；省略时读取 /models 并在界面选择
.\run-host.ps1
```

启动后，面板会从 `GET /agent/config` 读取 provider 状态，再用同一进程令牌调用
`GET /agent/models`。provider 选择记在宿主配置中；OpenCode Go 始终固定使用
`deepseek-v4.1-flash`，DeepSeek 官方 provider 的模型仍可在界面中选择。

## GPU

CUDA 版 torch 装在**仓库根目录的 `.venv`**（不进 git）。放在这里不是因为洁癖：
Windows 的 CUDA 版 torch 轮子 2.4GB、解压后 4GB 以上，而本机 C 盘只剩 2.8GB，
装进全局 Python 必然中途失败。E 盘有 150GB+，所以 venv 建在仓库里。

`.\setup-env.ps1` 做的就是下面这几步。手动重建（换机器、或这套脚本失效时）：

```powershell
# 1) venv
py -3.12 -m venv ..\.venv

# 2) CUDA 版 torch。cu126 与已装的 2.13.0 同版本（避免 API 差异）；
#    驱动 546 支持 CUDA 12.x 的次版本兼容，所以 12.6 的运行时能在 12.3 的驱动上跑。
#    --cache-dir 指到 E 盘：默认缓存在 C 盘，cache 一项就把那 2.8GB 吃光。
..\.venv\Scripts\python.exe -m pip install --cache-dir ..\.pip-cache `
  --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple `
  "torch==2.13.0+cu126"

# 3) 其余依赖。numpy / pandas 锁到与浏览器端 Pyodide 相同的版本
..\.venv\Scripts\python.exe -m pip install fastapi "uvicorn[standard]" `
  "numpy==2.4.6" "pandas==3.0.2" httpx
```

本机直连 PyPI 与 download.pytorch.org 是通的（被重置的是 GitHub，不是 PyPI）。
若哪台机器上不通，给 pip 加 `--proxy`，或跑 `.\setup-env.ps1 -Proxy <地址>`。

验证：

```powershell
..\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
# 2.13.0+cu126 True
```

### GPU 不是自动更快

本机实测（RTX 3050 Laptop 4GB，60 轮 / 20 轮，MLP）：

| 规模 | CPU | GPU | 加速比 |
|---|---|---|---|
| 20k 行 × 32 特征，hidden 128，batch 256 | ~14–18s | ~17s | **约 1×，没有收益** |
| 20k 行 × 32 特征，hidden 128，batch 4096 | 1.58s | 0.64s | 2.5× |
| 200k 行 × 64 特征，hidden 256，batch 4096 | 23.4s | 2.7s | **8.7×** |

两个结论要记住：

1. **小模型小批量上 GPU 会更慢**：每步的计算是微秒级，而 kernel 启动与设备同步是
   几十微秒级，开销盖过收益。batch 太小的话，先把 batch 调大再谈 GPU。
2. 这个项目的真实场景是**用户准备好的定长振动样本做 1D-CNN**，那是 GPU 真正划算的地方；
   小表上的 MLP 只是把通路验通。

计时在同一台机器上也有 20% 上下的波动（热笔记本会降频），所以别拿单次读数下结论。
节点指标里同时给出 `耗时秒` 与 `用了GPU`，就是为了让这件事可查而不是靠猜。

### 1D-CNN：4GB 显存的实际边界

用户准备好的定长振动样本做 1D-CNN 才是这张卡真正划算的地方（也是这个项目要解决的问题）。
下面是同一台机器上的实测：8 通道 × 20 万行的合成信号，先在项目外或 `custom.script` 中
整理为窗长 2048、重叠率 0.9 的样本表，再连接 `训练 1D-CNN`，每档 2 轮。数字取自 `run.json` 的 `耗时秒` 与
`显存峰值MB`（`torch.cuda.max_memory_allocated()`，不是估的）：

| 窗长 | 批大小 | 卷积通道 | 参数量 | 耗时（2 轮） | 显存峰值 |
|---|---|---|---|---|---|
| 2048 | 64 | 32 | 11,811 | 0.48s | 108 MB |
| 2048 | 256 | 32 | 11,811 | 0.41s | 384 MB |
| 2048 | 256 | 64 | 44,099 | 0.52s | 737 MB |
| 2048 | 512 | 64 | 44,099 | 0.41s | 1457 MB |
| 2048 | 256 | 128 | 170,115 | 0.89s | 1445 MB |
| 2048 | 512 | 128 | 170,115 | **5.79s** | 2869 MB |
| 2048 | 512 | 256 | 667,907 | **24.1s** | **5693 MB** |
| 4096 | 128 | 64 | 44,099 | 0.57s | 737 MB |
| 2048（CPU） | 256 | 64 | 44,099 | 2.73s | — |

三条要记住的：

1. **超过显存不会报错，只会慢几十倍。** 倒数第二行那个配置在 4GB 卡上"跑成了"，
   而显存峰值是 5693 MB —— 比整张卡还大。这不是测量错误：Windows 的驱动会把装不下的
   部分**分页到系统内存**，于是训练照样出数，只是 2 轮跑了 24 秒（比 1.4GB 那一档慢约
   60 倍）。所以判断"这个批能开多大"要看**显存峰值**，不能看"跑没跑成" ——
   "结果是对的，只是慢得没道理"和那份 CPU-only torch 的坑是同一类。
2. **拐点在 1.5~2.9GB 之间。** 峰值 1.4GB 那一档还是 0.4~0.9 秒；到 2.9GB 已经 5.8 秒
   —— 同样的步数，差别只能是分页。再算上 CUDA 上下文与数据集本身的张量也要占地方，
   **把峰值压在 1.5GB 左右**是这张卡上的舒服区。要更大的批就先缩窗长，再考虑缩卷积宽度。
3. **GPU 值不值，取决于每步的计算量。** 最后两行是同一配置：CPU 2.73s、GPU 0.52s
   （约 5×）；而上一节那个小 MLP 上 GPU 几乎不赚。所以"上 GPU"不是一条口号，
   要看批大小与每步的计算量能不能盖过 kernel 启动与设备同步。

复现（换个驱动 / torch 版本 / 机器时先重跑一遍，别信这张表）：

```powershell
cd sciviz-local
.\run-host.ps1                                            # 另开一个终端
..\.venv\Scripts\python.exe benchmarks\bench_cnn_vram.py
```

脚本自己造合成数据、写图、调 `sciviz run`，最后打印上面那张表；产物落在仓库根的
`.tmp/bench/`（不进 git）。

## 自定义模型训练接口

画布里的 `custom.model`、`train.function` 与 `model.predict` 都只在本地宿主中执行。
新工程先在 `custom.model` 定义网络，再把它的 `model` 输出连接到「自定义训练」节点，
同时连接训练集（验证集可选）。`train.mlp`、`train.cnn1d` 和固定参数版 `train.custom`
已从新建节点库退场，但继续保留给旧工程读取和运行。

通用训练块的输入端口固定为模型、训练集、可选验证集和可选标准化器；输出保持：

| 输出端口 | 内容 |
|---|---|
| `model` | 宿主内真实模型句柄，可连接 `model.predict` |
| `metrics` | 数值训练指标 |
| `history` | 逐轮训练记录表 |
| `curve` | 可直接绘制的 `轮次 / 曲线 / 值` 长表 |

自定义模型节点只负责定义模型模块和模型超参数。推荐直接定义一个
`torch.nn.Module` 子类（命名为 `Model` 最清晰）；训练节点会根据训练集自动推断
输入输出形状，并把 `input_dim`、`output_dim`、`input_shape`、`output_shape`、`task`
等数据相关参数传给构造函数。构造函数中带标量默认值的参数会自动出现在模型节点里，
可以直接修改。需要中文标签、范围、下拉选项或复杂参数时，在代码中补充字面量
`MODEL_PARAMS`。旧式 `build_model(spec, model_params)` 仍然兼容：

```python
import torch
from torch import nn

MODEL_PARAMS = {
    "hidden_dim": {"type": "int", "default": 64, "min": 1, "label": "隐藏层宽度"},
    "dropout": {"type": "float", "default": 0.1, "min": 0, "max": 0.9},
}

class Model(nn.Module):
    def __init__(self, input_dim, output_dim, hidden_dim=64, dropout=0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.Flatten(), nn.Linear(input_dim, hidden_dim), nn.ReLU(),
            nn.Dropout(dropout), nn.Linear(hidden_dim, output_dim),
        )

    def forward(self, x):
        return self.net(x)

# 兼容旧接口：def build_model(spec, model_params): ...
```

训练循环由训练节点中的 `fit_model` 函数定义；其带标量默认值的参数（如 `epochs=20`、
`lr=0.001`）自动生成节点内控件和参数端口。宿主注入模型、DataLoader、设备、数据规格、
`params` 与 `env`，并统一处理模型句柄、数值指标、训练曲线、产物归档、取消和进度。
用户代码应定期调用 `env.check_cancel()` 与 `env.progress(...)`，并返回
`{"model": model, "metrics": {"训练损失": 0.1}, "history": [{"轮次": 1, "训练损失": 0.1}]}`。

只有标签/特征列、任务类型、批大小、随机种子和设备等数据准备选项仍由节点负责。
标准化器连接后宿主会在默认表格 Dataset 中使用它变换特征；不连接时直接使用原始特征。
自定义 `make_dataset` / `build_dataloader` 可以自行决定如何使用该 scaler。

新训练块的代码结构示例：

```python
def fit_model(model, train_loader, val_loader, device, spec, params, env, epochs=20, lr=0.001):
    # 在这里编写自己的优化器、损失、训练循环、验证与早停。
    # 带标量默认值的参数会自动生成控件；宿主已准备好模型和 DataLoader。
    ...
```

函数应返回 `{"model": model, "metrics": {"训练损失": 0.1}, "history": [...]}`；
指标必须是数值。需要按住取消按钮和显示进度时，在循环中调用 `env.check_cancel()` 与
`env.progress(ratio, message)`。

下面是可选的扩展入口：

```python
def build_model(spec, params):
    # spec.input_shape / spec.output_shape 不含 batch 维
    ...

def make_dataset(data, split, params, scaler=None):
    # 兼容入口：返回 Dataset，每个样本返回 (x, y)
    ...

def make_dataloader(dataset, split, config):
    # 兼容入口：在 make_dataset 之后自定义 sampler / collate_fn
    ...

def make_spec(data, split, params, scaler=None):
    # 使用复杂 batch 时必须提供；宿主无法猜测你的输入输出形状
    return {
        "input_shape": (128, 4),
        "output_shape": (1,),
        "task": "regression",
    }

def build_dataloader(data, split, params, scaler=None):
    # 推荐入口：直接从原始分表创建你自己的 Dataset / DataLoader
    ...

def train_step(model, batch, device, spec):
    # 由你解析 batch、把数据搬到 device、调用模型并返回 loss
    ...

def validation_step(model, batch, device, spec):
    # 返回 loss，或 {"loss": loss, "metrics": {"MAE": value}}
    ...

def predict_step(model, batch, device, spec):
    # 返回预测值，或 {"prediction": prediction}
    ...

def fit_model(model, train_loader, val_loader, device, spec, params, env):
    # 可选高级入口：完全接管 optimizer / scheduler / 多输入训练循环
    ...

def loss_fn(prediction, target, spec):
    # 可选；不提供时分类用 CrossEntropy，回归用 MSE
    ...

def decode_predictions(prediction, data, spec):
    # 可选；返回 DataFrame 或 numpy 数组
    ...
```

`Dataset` 与 `DataLoader` 是宿主运行时对象，不作为画布端口传输。普通表格可以不写
`make_dataset`，训练器会根据 `features` / `label` 自动创建；TCN、LSTM 等时序模型如果
batch 仍是 `(x, y)`，可以只实现 `make_dataset`；如果 batch 是多输入、带 mask、变长序列
或自定义 collate，则实现 `make_spec`、`build_dataloader` 和 step hooks。此时宿主不再
拆 batch，也不假设模型调用形式。模型代码里的 `fit_model` hook 只为旧 `train.custom`
工程兼容；新工程将训练循环放在 `train.function`。训练后的留出集流程是：
`train.function` → `model.predict` → `eval.score`。

## 算子从哪来

宿主**不复制**算子实现，而是直接 import `../sciviz-web/src/engine/python/` 下的
`runtime.py` 与 `operators.py`。两份实现会让同一张图算出不同的指纹，缓存与复现
记录就全对不上了（架构总纲 A5）。

GPU 算子（`sciviz_host/gpu_ops.py`）是**宿主专属**的：它们依赖 torch，而 Pyodide
里没有 torch，所以由宿主在自己的注册表里追加，并通过 `/health` 报给前端。

### 哪些算子算"共享"，哪些算"宿主专属"

判定依据是**浏览器能不能提供那个库**，不是偏好：

| 用到的库 | 放哪 |
|---|---|
| 浏览器里有（numpy、pandas、scipy、scikit-learn、statsmodels、pywavelets…） | 共享算子 `sciviz-web/src/engine/python/operators.py`，两边都能跑 |
| 浏览器里没有（torch…） | 宿主专属 `sciviz_host/gpu_ops.py`，由适配器声明这项能力 |

完整可选清单就是 `sciviz-web/node_modules/pyodide/pyodide-lock.json`（356 个包）。
这条规则由 `npm test` 里的 `check-shared-operator-deps.mjs` 机检。

代价说清楚：scipy（13.4MB）与 scikit-learn（4.2MB）会进浏览器首次加载，
在原来的约 20MB 上接近翻倍。换来的是一套算子写一次两边都能跑。

共享算子的位置可以覆盖：

```powershell
$env:SCIVIZ_PY_DIR = "D:\path\to\engine\python"
```

## 接口

| 端点 | 用途 |
|---|---|
| `GET /health` | 后端、设备、算子清单、版本号 |
| `WS /engine` | 引擎协议，与 `sciviz-web/src/engine/protocol.ts` 同构 |
| `GET /` | 如果 `sciviz-web/dist` 存在，直接伺服打包好的前端 |

只监听 `127.0.0.1`。**这不是可以暴露到局域网的服务**：它执行任意 Python
（用户自定义算子），没有认证。

## 测试

```powershell
cd sciviz-local
py -3.12 -m unittest discover -s tests -v
```
