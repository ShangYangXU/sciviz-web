# AGENTS.md

给在本仓库里干活的 agent。人读的是 `docs/`，这份只讲"怎么在这里把事情做对"。

---

## 1. 先读什么（顺序不能换）

| 顺序 | 文档 | 读它解决什么 |
|---|---|---|
| 1 | [docs/方案V3.md](./docs/方案V3.md) | 项目是什么、为谁做、**不做什么**。定位漂移过两次，这份是唯一依据 |
| 2 | [docs/架构总纲.md](./docs/架构总纲.md) | 分层、核心 IR、执行面、适配器、演进阶段 P0–P4、ADR |
| 3 | [docs/数据契约规格.md](./docs/数据契约规格.md) | **规范性判据**：端口类型、指纹、错误码、当前差异清单 |
| 4 | [docs/Agent面设计.md](./docs/Agent面设计.md) | agent 的入口与抓手、双向对称性、验收盲测、G0–G4 |
| 5 | [docs/接口文档.md](./docs/接口文档.md) | 接口登记册 + **变更记录**。改任何接口前先看，改完必须记 |
| 6 | [docs/开发日志.md](./docs/开发日志.md) | **为什么**这么做（做了什么看 git log）。只追加，不改写 |

---

## 2. 四条硬规则

**R1 · 契约是第一性对象，不许有第二处真相。**
凡是"同一件事有两处声明"的地方都是缺陷，哪怕是暂时的。现存的两处债，碰到相关代码时记一笔而不是再叠一层：

- `ENGINE_NODES` 白名单（`sciviz-web/src/engine/plan.ts`）与算子注册表（`src/workflow/nodeRegistry.ts`）；
- `src/workflow/executor.ts` 与真引擎平行的模拟执行路径。

**R2 · 契约层是纯逻辑。**
L0（IR）/ L1（契约）不得依赖 DOM、React、Zustand store、Worker、Pyodide。判据：能在 `node --test` 里直接跑。`src/engine/plan.ts`、`src/contract/*` 是样板。

**R3 · 改接口 = 先改文档。**
接口（CLI 命令与参数、wire 协议、HTTP 端点、文件格式、模块导出）的任何增删改：

1. 先在 [docs/接口文档.md](./docs/接口文档.md) 找到它的登记行；
2. 改完在该文件末尾的**变更记录**追加一行（日期 / 接口 ID / 改了什么 / 为什么 / 影响与迁移）；
3. 再动代码。

契约规则本身（端口类型、错误码含义）同理：先改 [docs/数据契约规格.md](./docs/数据契约规格.md)，再改代码。**错误码表即文档**，代码里多出一个码而规格里没有，就是缺陷。

**R4 · 共享算子的依赖以浏览器能提供什么为界。**
`sciviz-web/src/engine/python/` 下的算子要**同时**在浏览器（Pyodide）和本地宿主（`.venv`）
里跑，所以只能 import Pyodide 里有的库。判定依据不是"感觉"，是
`sciviz-web/node_modules/pyodide/pyodide-lock.json` 里那份包表（356 个包，含 scipy、
scikit-learn、statsmodels、pywavelets、scikit-image、xgboost…；**没有 torch**）。

不在表里的库不是"不许用"，而是**只能写成宿主专属算子**
（`sciviz-local/sciviz_host/gpu_ops.py`），由适配器自己声明这项能力。torch 就是这么处理的。

这条由 `npm test` 里的 `scripts/check-shared-operator-deps.mjs` 机检，别绕过它 ——
越界的症状是"本地跑得好好的、浏览器里炸"，而写代码的人九成时间在跑本地。

共享算子要用一个新库时，三处一起动：宿主 `requirements.txt`（版本锁到 Pyodide 那一份）、
`sciviz-web/pyodide-packages.json`、再跑 `node scripts/sync-pyodide.mjs` 把包拉到本地。

---

## 3. 常用命令

在 `sciviz-web/` 下：

| 命令 | 作用 | 什么时候用 |
|---|---|---|
| `npm test` | 纯逻辑单测（`node --test` + tsx） | 改完契约层/纯函数，第一个跑它 |
| `npm run check:operators` | 共享算子的依赖边界（R4） | 给共享算子加了 import 之后 |
| `node scripts/gen-operator-hashes.mjs` | 重新生成算子实现哈希（进指纹用） | **改了 `src/engine/python/` 或 `sciviz_host/gpu_ops.py` 之后必跑**；忘了跑 `npm test` 会失败 |
| `npm run typecheck` | `tsc --noEmit` | 提交前必跑 |
| `npm run sciviz -- catalog [类型] [--json]` | 列出算子、端口、参数（agent 面的 G1） | 想知道"有哪些算子、怎么接"时，**不要读源码猜** |
| `npm run sciviz -- validate <文件.yaml> [--json]` | 静态校验一张图（L1） | 改图之后。`--columns 名=列1,列2` 让端口能算出来 |
| `npm run sciviz -- explain <错误码>` | 一个错误码的触发条件与修复动作 | 校验报错之后。**不要猜错误码的含义** |
| `npm run sciviz -- plan <文件.yaml> [--data 名=文件.csv]` | 只看"跑一遍会算什么"，不连引擎 | 动手跑之前；也能在宿主没起时检查工程能不能读懂 |
| `npm run sciviz -- run <文件.yaml> --data 名=文件.csv [--out 目录]` | 无头跑一遍，写运行清单与报告 | agent 要拿到真实数值时。需要本地宿主在跑 |
| `npm run sciviz -- doctor` | 环境自检：宿主在不在、能算什么 | 跑之前先问"为什么跑不了" |
| `npm run sciviz -- patch <工程> --ops ops.json [--dry-run]` | 改工程：一批动作，原子应用，逐条错误码 | **改图的唯一方式**。别整份重写文件——那让人看不出你动了哪几处 |
| `npm run sciviz -- patch <工程> --undo` | 撤销上一次改动（用文件里记的反向动作） | 改错了、或人要回退时 |
| `npm run sciviz -- inspect <工程> --node <id> [--rows N]` | 看某个节点算出来什么 | 跑完想知道数是多少时。`--from runs/<id>/run.json` 读上次的摘要，不加就现跑 |
| `npm run verify` | **注册式真值**：每个算子一组独立真值（解析解或朴素实现）真的跑一遍并逐个数比对 | 改了 `src/engine/python/`、`gpu_ops.py`，或新增算子时。**要宿主在跑** |
| `npm run blind` | 盲测：只走命令行跑完 agent 的整圈（读→写→判→跑→取数→错改拿码→改对重跑→撤销） | 动了 CLI / 补丁 / 校验器 / 工程文件格式时。**要宿主在跑** |
| `npm run e2e` | 真实浏览器的交互回归（需要 dev server + 浏览器） | 改画布交互 / 拖拽 / 连线 / 探针 |
| `npm run build` | `typecheck` + `vite build` | 提交前 |

在 `sciviz-local/` 下：

| 命令 | 作用 |
|---|---|
| `..\.venv\Scripts\python.exe -m unittest discover -s tests -v` | 宿主测试（含真的过 WebSocket 的那两条） |
| `.\run-host.ps1` | 起本地执行宿主（默认 `127.0.0.1:8765`，带 CUDA） |
| `..\.venv\Scripts\python.exe -m sciviz_host.doctor` | 环境自查：设备、库版本、算子清单 |

**不要用 `py -3.12` 跑这个项目的代码**：系统 Python 里那份 torch 是 CPU-only 构建，
跑起来一切正常、只是跑在 CPU 上 —— 结果是对的，所以不会有东西提醒你。整个项目的
Python 代码只用仓库根的 `.venv`；加库改 `requirements.txt` 再跑 `.\setup-env.ps1 -Update`。

---

## 4. 测试的三条分工（别用错工具）

| 脚本 | 守什么 | 不守什么 |
|---|---|---|
| `npm test`（`src/**/*.test.ts`） | 纯逻辑：求值计划、指纹、端口解析、YAML 往返、校验器 | 界面与真实执行 |
| `npm run e2e`（`scripts/e2e.mjs`） | 只有真实浏览器能验的**交互语义**：拖拽、拉线、拒连、框选、Delete | 数据算得对不对 |
| `scripts/verify-operator-truth.mjs` | 算子的**数值正确性**：独立扫 CSV / 独立 DFT 得到的真值 | 界面、接线 |
| `sciviz-local/tests/`（unittest） | 宿主与**共享算子**的行为（含"时间轴不是信号"这类口径） | 界面、契约层 |

"跑通了"不等于"算对了"。改算子实现时，若 `verify-operator-truth.mjs` 覆盖不到你改的算子，**把真值补进去**，别拿引擎自己的输出当期望值 —— 那只能证明"它和上次跑得一样"。

---

## 5. 目录速查

```
docs/                     方案的唯一来源（先改这里再改代码）
sciviz-web/               浏览器端 + 契约层 + CLI
  src/contract/           L1：错误码表、算子清单、静态校验器（G0 新增）
  src/contract/ops.ts     人与 agent 共用的动作词汇表（G2）
  src/kernel/             L3：无头核（调度 + 数据集身份 + 运行清单）。不依赖 DOM/store
    patch.ts              补丁应用器：原子，结构性错误在写入前拦住（G2）
  src/agent/              L4：给 CLI 用的 Facade（装载 / 运行 / 报告 / 宿主客户端）。用了 node:fs，界面不许 import
  src/workflow/           L0：IR、端口解析、算子注册表、YAML 往返
    project.ts            `.sciviz` 工程文件：人与 agent 共用那一份（G2）
  src/engine/             执行面：调度、指纹、适配器选址
    plan.ts               纯函数：算谁该重算（无头可跑的样板）
    graphRunner.ts        界面侧的薄壳：订阅 store → 调核 → 写回（真正的调度在 src/kernel）
    python/               算子的唯一实现（宿主直接 import，不许复制）
  src/data/               导入与列式存储；csvParse.ts 是浏览器 Worker 与 CLI 共用的解析
  src/store/              Zustand store（浏览器侧状态；契约层不许 import）
  scripts/sciviz.mjs      agent 面 CLI（G0）
  scripts/e2e.mjs         浏览器交互回归
sciviz-local/             本地执行宿主（GPU / 大内存 / 长任务）
  sciviz_host/            WebSocket 引擎服务；算子不复制，直接 import 共享 runtime
```

---

## 6. 本机环境的几个坑（都会伪装成产品缺陷）

1. **浏览器取不到 zip（HTTP 204）**：本机若装了带内核网络过滤的下载器（实测为 IDM 的 `IDMWFP.sys`），Chromium 收到的 zip 响应会被换成空响应，Pyodide 起不来。先跑 `node scripts/check-zip-fetch.mjs` 分辨"环境问题"还是"应用问题"。
2. **Windows 上的动态 `import()`**：绝对路径必须以 `file://` URL 传入（用 `pathToFileURL`），否则报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: protocol 'e:'`。Linux/macOS 上两种写法恰好都能跑，所以很容易漏。
3. **"没有浏览器"其实只是没有 playwright 那个 chromium**：`scripts/e2e.mjs` 里硬编码的 playwright 路径本机不存在，但它支持 `CHROME_PATH`，而系统装了 Chrome。两条命令就能跑起来：

   ```powershell
   npm run dev -- --port 5174
   $env:CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'; npm run e2e
   ```

   界面层因此是可验证的 —— 别因为"本机没有 Chromium"就跳过 e2e。

4. **改完 `src/engine/python/*.py` 要重启 dev server**：浏览器那侧的执行引擎是 worker，
   它把 `runtime.py` / `operators.py` 以 `?raw` 内联进模块（见 `engineWorker.ts`）。dev server
   跑久了之后，worker 可能仍然拿到旧的字符串 —— 症状是"明明加了函数，浏览器里 `import`
   却说没有"（实测：给共享算子加了 `split_columns`，CLI 一切正常，e2e 里的浏览器报
   `ImportError: cannot import name 'split_columns'`，重启 dev server 就对了）。
   同一处还有 `public/pyodide` 与 `public/samples` 这两块静态资源，改完也该重启。
   判据：`curl "http://localhost:5174/src/engine/python/operators.py?raw"` 里能看到你新加的符号。

   **本地宿主同理，而且更容易看漏**：`bridge.shared_operators()` 是 `@functools.cache` ——
   宿主进程只在第一次用到时 import 一次那份 `operators.py`。所以**改了共享算子必须重启宿主**
   （`.\run-host.ps1`），否则新算子只存在于文件里。症状不在算子身上：节点会说
   "执行引擎还不支持节点类型「xxx」"，而浏览器（Pyodide）那条路可能一切正常，于是你以为是
   宿主专属算子写漏了。判据一条就够：`GET /health` 的 `operators` 列表里有没有你新加的类型。
   顺带一条选址事实：宿主在跑时界面默认走宿主（`backend.chooseBackend` 探到就用），
   所以"我在浏览器里试过没问题"在这台机器上不构成结论。

5. **`.venv\Scripts\python.exe` 起的进程，在进程列表里显示的是基础解释器的路径**：
   Windows 的 venv 用 launcher 再执行基础 `python.exe`，所以任务管理器 / WMI 里的
   `CommandLine` 写的是 `C:\...\Python312\python.exe` —— 而那个进程**用的确实是 `.venv`
   的环境**（包从 `.venv\Lib\site-packages` 加载，`/health` 报的也是那份 CUDA torch）。
   判据：看它加载的模块（`(Get-Process -Id <pid>).Modules` 里有没有
   `.venv\Lib\site-packages\...`），或直接读 `/health` 的设备与 torch 版本 ——
   **不要凭命令行里的解释器路径判断"这个宿主是系统 Python 起的"**。踩过一次：
   一个正经的宿主因此被判成"CPU-only 的错环境"。

---

## 7. 提交与仓库约定

- 分支前缀 `codex/`。
- 提交前：`npm run typecheck` + `npm test`；改过界面再加 `npm run e2e`；改过宿主再加那里的 unittest。
- **工作树可能带着别人未提交的改动**。提交前先 `git status`，只提交你确认属于本次任务的文件，不要顺手 `git add -A`。
- 新增设计或改动架构：先改 `docs/`，再改代码（本仓库的既定纪律，见 `docs/README.md`）。
