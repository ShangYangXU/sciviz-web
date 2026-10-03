# sciviz-desk · 最小桌面壳

把项目变成一个**本地应用**：双击（或一条命令）拉起宿主，然后开一个没有地址栏的窗口
指向它伺服的界面。

这个壳**不是最终形态**。它存在只为一件事：把 T16 那三个未知变成已知 —— 打包后多大、
启动链路通不通、WebView2 依赖怎么办。先量出来，再决定要不要上 Tauri 之类的真壳。

## 怎么用

```powershell
cd sciviz-desk
.\start-sciviz.ps1                 # 复用健康宿主或启动新宿主 + 开窗口；本次启动的宿主随窗口关闭
.\start-sciviz.ps1 -Build          # 启动前先构建 sciviz-web 的最新源码
.\start-sciviz.ps1 -NoWindow       # 只起宿主并自检（CI / 排障用，退出码非 0 即失败）
.\start-sciviz.ps1 -KeepHost       # 窗口关了也让宿主活着（接着用命令行跑东西）
.\start-sciviz.ps1 -App D:\sciviz-app   # 用打包后的布局（dist\ 与 operators\）
```

## 首次安装（给别人装的时候）

```powershell
# 1) 目标机器上先有运行时（这一步要在那台机器上做，路径才是它自己的）
.\setup-env.ps1

# 2) 装应用代码那一层
.\sciviz-desk\install-app.ps1 -App D:\sciviz-app -Runtime D:\sciviz

# 3) 先自检，再启动
pwsh -File D:\sciviz-app\start-sciviz.ps1 -App D:\sciviz-app -NoWindow
pwsh -File D:\sciviz-app\start-sciviz.ps1 -App D:\sciviz-app
```

装完的样子（**装完之后那台机器上不再需要仓库**）：

```
D:\sciviz-app\
  dist\            完整前端（含 pyodide 38MB 与 samples 5.6MB）
  operators\       共享算子（两个执行面同一份）
  sciviz_host\     宿主代码
  start-sciviz.ps1 / pack-app.ps1 / install-app.ps1 / README.md
  runtime.txt      运行时在哪（启动脚本第一个读它）
  VERSION.txt      这一版装了什么
```

**安装脚本不复制 `.venv`**：虚拟环境里带着绝对路径（`pyvenv.cfg`、`Scripts` 里的启动器、
editable 安装的 `.pth`），搬到别处是"看起来能用、某个角落开始报错"的典型来源。
运行时在那台机器上用 `setup-env.ps1` 建，这个脚本只把它**记下来**。

### 本机实测（装到一个干净的用户目录，2026-09-13）

| 检查 | 结果 |
|---|---|
| 从应用目录自检 | `start-sciviz.ps1 -App <应用目录> -NoWindow` → 就绪 7.3 秒 |
| 前端来自应用目录（不是仓库） | 把应用目录里的 `dist\index.html` 改名 → `/` 立刻 404 |
| 示例数据 | `/samples/boiler2-full.csv.gzip` → 200、5.3MB、**没有 Content-Encoding**（浏览器自己解） |
| 真浏览器打开 | 徽标显示「示例数据就绪 · 二号锅炉全量」，说明 58.7MB 的 CSV 真的解出来并导入了 |
| 更新只动应用层 | 更新包 **0.96MB**：`operators\runtime.py` 与 `sciviz_host\session.py` 被覆盖成新版，而 `dist\pyodide`、`dist\samples` 逐字节未变 |

> 还没验的：**一台全新的 Windows**（没装 Python、没装 Edge/WebView2）。那台机器上第一件事
> 应该是 `python -m sciviz_host.doctor`（它现在会打一遍跨机器体检，见 T17），
> 体检说"能跑"再往下装。

> **两种 PowerShell 都能跑。** 仓库里的 `.ps1` 现在都带 UTF-8 BOM，所以 Windows 自带的
> Windows PowerShell 5.1 也能正确读中文注释（以前不带 BOM，5.1 按 GBK 解码会报
> `Unexpected token`，看着像脚本写错了）。装了 PowerShell 7（`pwsh`）更好 —— 它原生 UTF-8、
> 启动也快一点，桌面快捷方式会自动优先用它。

## 桌面上放一个启动图标

```powershell
.\install-shortcut.ps1                              # 指向仓库布局
.\install-shortcut.ps1 -App D:\sciviz-app            # 指向装好的应用目录（见「首次安装」）
.\install-shortcut.ps1 -Name "科研数据图" -Desktop C:\Users\Public\Desktop   # 装给所有人
```

**双击它 = 先构建当前前端、复用或启动宿主、再开窗口**，与 `start-sciviz.ps1 -Build` 完全同一段逻辑。
启动器会验证宿主算子版本；默认端口被其他程序或旧宿主占用时，会尝试后续 32 个端口，并让窗口连到选中的端口。
Edge 用**固定的一份配置目录**（`%LOCALAPPDATA%\SciViz\shell\profile`）—— 浏览器对工程文件的写权限、
写入档位与报告草稿都挂在这份目录上；再点一次图标时，启动器认得出"已有窗口在用"，只多开一个窗口。
构建、宿主输出与失败原因写入 `%LOCALAPPDATA%\SciViz\logs`；双击启动失败时会显示日志位置并等待按键。
关掉窗口会停止本次启动的宿主；复用的宿主会保留，避免中断其他任务。
源码布局的 `-Build` 通过 `cmd.exe` 调用 `npm.cmd`，避免 Windows PowerShell 5.1 把 `npm.ps1` 转发的构建 stderr 误判成启动失败。

图标默认用 Edge 的（那个窗口就是它渲染的），想换就右键快捷方式改。用哪个 shell 也是自动选的：
装了 PowerShell 7 就用它，否则用系统自带的 5.1（一定在）。

## 分层：什么每天动，什么一年动

这是整个交付形态的关键决定（T15）。实测（本机，2026-09-13）：

| 层 | 内容 | 体积 | 多久动一次 |
|---|---|---|---|
| **运行时** | 仓库根 `.venv`（Python + torch + CUDA，47,447 个文件） | **4.68 GB** | 一年几次 |
| **运行时** | `dist/pyodide`（浏览器里的执行引擎） | 38.2 MB | 跟运行时一起 |
| **数据** | `dist/samples`（示例数据） | 5.6 MB | 仓库里存的是 gzip（58.7 → 5.6MB，界面用 `DecompressionStream` 解）；T20 已收 |
| **应用代码** | `dist/assets` + `index.html` | 0.81 MB | **每天** |
| **应用代码** | 共享算子 `operators.py` / `runtime.py` | 54 KB | **每天** |
| **应用代码** | 宿主专属算子与协议 `sciviz_host/*.py` | 63 KB | **每天** |

打包出来看：**`sciviz-desk\out\sciviz-app-<版本>.zip` 只有 0.31 MB**（压缩后）。

所以"更新前端与算子不需要重发安装包"这句话是**具体**的：每天变的是那 0.3 MB，
而 4.68 GB 的运行时原地不动。

```powershell
.\pack-app.ps1              # 用现成的 dist 打包
.\pack-app.ps1 -Build       # 先 npm run build 再打包
```

包里的 `VERSION.txt` 写了这一版装了什么。覆盖到应用目录即可，宿主会直接读新的
前端与算子（`SCIVIZ_PY_DIR` 指到算子目录，见 `sciviz_host/bridge.py`）。

> 这个 zip 是**更新包，不是完整安装**。它只装"每天动的那一层"：
> `dist\assets` + `index.html` + `operators\` + `host\`。
> 首次安装还需要完整的前端目录（含 `pyodide` 与 `samples`）与运行时 `.venv` ——
> 那两样一年也动不了几次，正因为把它们排除在包外，"每天更新"才只有 0.3MB。
> 应用目录的样子：
>
> ```
> <应用目录>\
>   dist\            完整前端（首次安装时放全，之后只替换 assets 与 index.html）
>   operators\       共享算子（更新包会替换）
>   sciviz_host\     宿主专属算子与协议（更新包会替换；目录名固定，见下）
>   VERSION.txt
> ```
>
> 用 `-App <应用目录>` 启动时，脚本认的就是这个布局（`dist\` 与 `operators\` 两个入口）。
> 应用目录里有 `sciviz_host\` 时，启动脚本会把它放进 `PYTHONPATH` —— 这样它赢过开发机上
> 那份指向仓库的 editable 安装（`.venv` 里的 `.pth`），"更新宿主代码"才真的生效。
> 这个目录不能改名：能赢的前提是**模块名**对得上。

**为什么不做单文件 exe**：把 4.68 GB 的 torch + CUDA 塞进一个 exe，每次改一行前端代码
都要重新分发 4.68 GB，而且 PyInstaller 那套打包对 torch/CUDA 的 DLL 布局特别敏感。
分层之后每次更新只动 0.3 MB —— 代价是要多一个"应用目录"的概念。

## 三个未知，实测答案

### 1. 打包后多大

运行时 4.68 GB（其中 torch + CUDA 占绝大部分），应用代码 0.31 MB（zip）。
这两个数字决定了上面那条分层：**不能让它们绑在一起发**。

### 2. 启动链路通不通

通。链路是：`start-sciviz.ps1` → 起 `.venv` 里的宿主（隐藏窗口）→ 轮询 `/health`
→ 就绪后开 Edge 的 `--app` 窗口指向实际宿主端口（默认 `8765`，被旧宿主占用时选备用端口）→ Chat 与画布共用此宿主 → 关窗口时收掉本次启动的宿主。

**宿主就绪实测 4.0 ~ 4.1 秒**（两次，含 torch 与 CUDA 的 import 与设备探测）。
这段时间里没有任何东西可看 —— 所以脚本会先把"运行时 / 前端 / 算子"三行打出来，
让用户知道它在动。

验证到什么程度：窗口进程确实起来了（默认 `--app=http://127.0.0.1:8765`），宿主确实在伺服
前端（`/` 返回 200 且标题是「SciViz · 科研数据可视化工作台」，`/health` 报 13 个算子、
设备 cuda），并且用同引擎的无头截图确认**页面真的渲染出来了**（节点库 28 种、空画布、
右侧面板都在）。

### 3. WebView2 依赖怎么办

本机两样都有：

| 组件 | 版本 | 位置 |
|---|---|---|
| Microsoft Edge | 153.0.4234.32 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| WebView2 Runtime | 152.0.4191.66 | `C:\Program Files (x86)\Microsoft\EdgeWebView\Application` |

现在的壳直接用 Edge 的 `--app` 模式：**它用的就是 WebView2 那个引擎**（同一套
Chromium 内核），所以"WebView2 依赖"在这里不是纸面假设。换成 Tauri/WebView2 宿主时，
依赖的仍然是同一个运行时 —— 上面那一行版本号就是换壳之后需要的最低要求。

Windows 10/11 自带 Edge；WebView2 Runtime 对普通用户机器不一定有（企业镜像常被裁掉），
所以 T17 的跨机器体检里要查它。

## 启动链的防复发处理

- **Edge 配置目录固定一处、且不清理**：写权限、`localStorage`（写入档位 / 草稿工程身份）与
  IndexedDB 里的报告草稿都挂在这份目录上。曾经改成"每次启动换一个新目录、退出即删"，代价是
  工程每次都要重新授权 —— 而授权框只在用户手势里弹得出来，于是自动保存与 Agent 写报告
  全都写不回去，报错还长得像磁盘问题（2026-09-27 实测；见 `docs/开发日志.md`）。
  重复双击由 `Test-SciVizProfileInUse`（按进程命令行里的 `--user-data-dir` 判定）挡住：
  已有窗口在用时只多开一个窗口，宿主与配置目录都不动。
- **`--no-first-run` 不能省**：新的配置目录会触发 Edge 的首次运行向导，它会盖在界面前面，
  用户会以为"打开的是浏览器"。
- **端口先探测再启动**：健康的 SciViz 宿主直接复用；占用端口不是当前版本时，寻找空闲端口，
  不启动一个必然因端口冲突退出的第二宿主。
- **失败必须留下证据**：快捷方式启动窗口会暂停显示错误；启动器、构建和宿主日志保存在
  `%LOCALAPPDATA%\SciViz\logs`。

## 还不是最终形态的地方

- 窗口是 Edge 的 app 模式，不是一个真正的打包应用：任务栏图标、单实例、开机自启、
  托盘这些都没有；
- 每次启动要等 4 秒（torch 的 import）：真壳可以把宿主做成常驻服务，界面先出来；
- **装到"全新 Windows"这条路上，没验过的部分**：那台机器要先装 Python、建运行时、
  装 WebView2 与 VC++ 运行库。前三件的检查已经有了（`preflight`），但没有一台干净的
  机器可以走一遍 —— 所以这条留给真正要发的时候（见上面「首次安装」那一节）。
