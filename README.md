# SciViz

**把模型训练、评估与数据分析的数据流，变成可校验的契约。**

SciViz 是面向研究者的本地工作流工具。你可以在画布上连接数据、Python 函数、模型、训练和图表，也可以让内置 Agent 或外部工具接着操作同一份工程。它关注每一步的输入输出、参数、数据身份和运行证据，方便检查结果与交接实验。

我是一名在读研究生，也在自己的研究中使用 SciViz，边用边完善。它目前还是一个早期项目，有不少地方需要继续打磨，主要在 Windows、Chrome 和 Python 3.12 环境验证。当前功能与边界见下文；完整设计见 [项目文档](docs/README.md)。

这个项目采用 **vibe coding（与 AI 协作编程）** 的方式开发。大量代码由 AI 辅助生成，我负责提出需求、讨论设计，并通过实际使用、测试和反馈持续检查与修正。

## 为什么做这个项目

这个项目起源于我使用 AI 编写深度学习代码、做数据分析时的一些困扰。代码里的函数越来越多，来回跳转时很容易看得头晕，难以一下看清数据经过了哪些处理、模块之间是怎么衔接的。分析过程中又会产生很多图表，散落在文件夹或 Notebook 里，管理和比较起来很不方便，也容易忘记某张图对应哪一次实验。

让 Agent 做实验时，还有一个困扰：它在执行，但我们有时并不知道它具体做了什么、改了哪些地方，又是怎么得到结果的。想检查或接手，往往还要重新翻代码和日志。

所以，我希望有一个人与 Agent 共用的实验工作台：**让 Agent 做实验，让人能实时查看过程，看清每一步的接口和结果。** 在画布上，人可以沿着数据流查看各个步骤的输入、输出、参数与连接关系，把图表放回对应的实验步骤中，并在需要时修改或接手。这里的接口，就是每一步接收什么、产出什么，以及它怎样与其他步骤连接。

## 可以做什么

- 导入本地 CSV，在画布上连接整表、拆列、数据预览、函数和图表。
- 写 Python 函数：形参形成输入端口，返回字典的键形成输出端口；用 Matplotlib 生成图片。
- 定义 PyTorch 模型与训练函数，在本地宿主执行，查看训练曲线并保存模型制品。
- 把一组步骤封装成子空间，添加笔记、批注和项目报告，保存成可比较的 `.sciviz` 文本工程。
- 通过端口检查、内容哈希、实现哈希和运行清单追踪一次计算；没有判据的规则会明确列为未检查。
- 在「AI 工作区」通过自己的模型 API 修改、运行和检查工程；画布旁的「只读问答」用于查询。
- 通过 CLI 和 MCP 操作工程文件；MCP 也提供连接当前前台画布的实验性入口。

普通计算在浏览器的 Pyodide 或本机 Python 中执行。内置 Agent 需要本地宿主；连接远程模型时，对话和选定的工程上下文会发送给你配置的服务商。

## 快速开始：浏览器画布

需要 **Node.js 22** 和现代浏览器。建议使用 Chrome 或 Edge；工程直接写回文件的能力取决于浏览器的文件系统授权。

```powershell
git clone https://github.com/ShangYangXU/sciviz-web.git SciViz
cd SciViz/sciviz-web
npm ci
npm run sync-pyodide
npm run dev
```

打开终端显示的本机网址（通常是 `http://localhost:5173`）。首次同步会下载 Pyodide 及选定的科学计算包，加载 Python 引擎也需要一点时间。

体验仓库中的合成数据示例：

1. 点击「导入数据」，选择仓库根目录的 [examples/quickstart.csv](examples/quickstart.csv)，保留数值列 `x`、`y`。
2. 点击「打开工程」，选择 [examples/quickstart.sciviz](examples/quickstart.sciviz)。数据名保持 `quickstart`；如未自动绑定，在数据源中重新选择它。
3. 画布显示「合成数据 → 原始数值 → y = 2x + 1」。预览应有 5 行，图表是一条直线。
4. 点击「保存工程」保存自己的副本。CSV 原文和模型权重不内嵌到工程中，分享时需同时提供相应文件。

此示例完全由合成数据组成，运行不需要 API key、GPU 或本地宿主。

更多操作见 [使用引导手册](docs/使用引导手册.md)：画布快捷键、参数接线、图表快照、子空间、实验笔记、项目报告和 Agent 协作等小功能都按使用流程说明。

## 本地宿主、训练与内置 Agent

本地宿主提供 Python 执行、PyTorch 训练、模型制品保存和 Agent 网关。Windows 上从仓库根目录运行：

```powershell
# 需要 Python 3.12；默认安装 CUDA 12.6 对应的 PyTorch 构建。
# 网络可直连时使用 -NoProxy；已有环境需要更新时增加 -Update。
.\setup-env.ps1 -NoProxy
.\sciviz-local\run-host.ps1
```

默认宿主地址是 `http://127.0.0.1:8765`。浏览器检测到宿主后优先使用它。检查实际设备：

```powershell
.\.venv\Scripts\python.exe -m sciviz_host.doctor
```

没有 NVIDIA GPU 时可配置 CPU 构建：

```powershell
.\setup-env.ps1 -NoProxy -TorchIndex https://download.pytorch.org/whl/cpu `
  -TorchSpec 'torch==2.13.0+cpu' -TorchVisionSpec 'torchvision==0.28.0+cpu'
```

训练速度取决于硬件；以宿主自检报告的设备为准。项目的 Python 运行统一使用根目录 `.venv`，避免误用系统里的另一份 PyTorch。更多安装与宿主说明见 [sciviz-local/README.md](sciviz-local/README.md)。桌面启动入口见 [sciviz-desk/README.md](sciviz-desk/README.md)。

### BYOK：使用自己的模型服务

启动本地宿主后，打开「AI 工作区 → 模型服务设置」：选择服务商，输入自己的 API key，可调整基础地址和模型 ID，然后保存。在对话区选择支持工具调用的模型。

| 服务 | 接入方式 |
|---|---|
| DeepSeek | 官方兼容接口 |
| OpenAI | Chat Completions |
| Google Gemini | OpenAI 兼容入口 |
| 通义千问 | DashScope 兼容入口；可按地域调整基础地址 |
| Moonshot | 兼容入口 |
| OpenRouter | 兼容入口 |
| OpenCode Go | 专用适配器，固定套餐端点和模型 |
| 自定义服务 | OpenAI 兼容的 `/models` 与 `/chat/completions`；可连接本机模型服务 |

这是协议兼容接入。原生 Anthropic Messages、OpenAI Responses 等其他协议尚未实现；不同服务和模型的工具调用、多模态及账户权限也可能不同。模型列表不能保证其中每个模型都能用于 Agent。

密钥输入会遮住，保存后清空；已有密钥不会回填或经 HTTP 返回。留空表示保留，删除需点击「移除本地配置」。环境变量优先于本地保存值。远程地址要求 HTTPS；HTTP 仅用于本机回环地址。

凭据保存在本机状态目录的 `agent-providers.json`，开发模式默认是仓库根的 `.sciviz-state/`，已被 Git 忽略。它是受文件权限保护的**明文配置文件**，请勿分享该目录；没有实现系统加密凭据库。密钥不会写入 `.sciviz`、浏览器持久存储或模型工具参数。

也可以通过各服务的环境变量配置，或使用本机凭据 CLI（输入时隐藏，不把密钥放进命令行）：

```powershell
.\.venv\Scripts\python.exe -m sciviz_host.providers set openai
.\.venv\Scripts\python.exe -m sciviz_host.providers list
```

模型 API 的费用由所选服务商计费。工程行值、块内代码、图片与附件的外发范围由对话设置和你选择的内容决定；使用前请检查这些设置。用户 Python 函数在选定的执行环境里运行，本地宿主不提供恶意代码沙箱。

## CLI 与 MCP

在 `sciviz-web/` 目录运行：

```powershell
npm run sciviz -- catalog
npm run sciviz -- catalog data.source --json
npm run sciviz -- validate ../examples/quickstart.sciviz
npm run sciviz -- plan ../examples/quickstart.sciviz

# 以下需要本地宿主。
npm run sciviz -- doctor
npm run sciviz -- run ../examples/quickstart.sciviz --out runs/quickstart
```

运行输出包含 `run.json` 和 `report.md`。通过 `inspect` 查看节点结果，通过 `patch --ops` 修改工程；完整参数见 [接口文档](docs/接口文档.md)。`plan` 可以离线检查数据绑定和求值范围，不会执行 Python。

MCP 使用 stdio。客户端启动命令为 `node --import tsx scripts/sciviz-mcp.mjs`，工作目录设为本机仓库的 `sciviz-web/`；`SCIVIZ_MCP_ROOT` 可限定允许访问的项目根目录。安装 npm 依赖后即可启动；执行、取数和实时画布操作需要宿主，实时画布还需要打开 SciViz 页面。具体接入见 [MCP 面设计](docs/MCP面设计.md)。当前 MCP 的大负载分页和传输仍在完善，见 [审查记录](docs/公开前审查.md)。

## 项目结构

```text
docs/                           定位、架构、契约与接口记录
examples/                       合成数据与最小工程
sciviz-web/
  src/workflow/                 图结构、端口、注册表、工程格式
  src/contract/                 目录、校验器、错误码、补丁词汇
  src/kernel/                   与界面无关的调度与运行清单
  src/engine/                   浏览器 / 宿主适配器、共享 Python 算子
  src/agent/                    工具、上下文、会话与 CLI Facade
  src/store/                    浏览器状态与结果资产
  src/components/、src/canvas/  用户界面
  scripts/                      CLI、MCP、检查与浏览器回归
sciviz-local/sciviz_host/        本地宿主、训练、Agent 网关
sciviz-desk/                    Windows 桌面启动脚本
```

图、契约和无头核保持纯逻辑，界面与 CLI 共用求值核。通用 Python 算子只有一份实现，浏览器与本地宿主共同使用；PyTorch 算子由宿主单独提供。

## 开发与验证

```powershell
cd sciviz-web
npm test
npm run typecheck
npm run build
```

`npm test` 包含层级依赖、共享算子依赖、实现哈希、Agent/MCP 静态检查及纯逻辑测试。需要宿主的验证：

```powershell
npm run verify
npm run blind
npm run mcp-smoke
```

浏览器交互验证需要在另一个终端启动 `npm run dev -- --port 5174`，然后运行 `npm run e2e`。脚本可通过 `CHROME_PATH` 指定 Chrome/Edge。宿主测试从仓库根目录运行：

```powershell
cd sciviz-local
..\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

接口和契约改动先更新 `docs/`；共享算子增加依赖时同时更新浏览器包清单与宿主依赖。详细约定见 [AGENTS.md](AGENTS.md)。

## 当前边界

- 这是早期版本，尚未提供各平台的独立安装包；Windows 以外的平台尚未完成端到端验证。
- `.sciviz` 保存工程与引用，数据文件、运行产物和模型权重需分别管理。
- 类型、图结构、数据身份已有检查；完整轴语义、单位、数据划分泄漏及环境复现仍有缺口。以校验输出的 `notChecked` 与运行清单的 `gaps` 为准。
- 自定义代码与随机训练不会自动变成可复现实验，需要自行控制依赖、随机种子与数据划分。
- MCP 与实时画布入口仍在演进；大工程首次加载和前端包体积还有优化空间。

## 反馈与交流

如果你在使用中遇到问题，或者有改进建议，欢迎在 [Issues](https://github.com/ShangYangXU/sciviz-web/issues) 中告诉我。尽量附上操作步骤、预期结果和实际遇到的情况，方便我复现和排查。

我自己也在持续使用这个软件，会认真查看反馈，并尽力修复发现的问题。作为一个还在学习和完善中的项目，也欢迎大家交流想法，一起把它做得更好用。

## 许可证

项目代码采用 [MIT License](LICENSE)。第三方依赖遵循各自许可证；模型服务条款、外部数据和权重的授权需分别确认。
