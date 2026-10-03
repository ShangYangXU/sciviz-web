# MCP 面设计 v0.2

> 状态：已实现（stdio 薄壳、共享 ToolSpec、CLI 转发与冒烟回归已落地；本文仍是行为规格）
> 日期：2026-09-14
> 上位：[Agent面设计](./Agent面设计.md) §6 / §11-G4 ｜ [架构总纲](./架构总纲.md) §9 ｜ 仓库根 `AGENTS.md` R1/R3
> 作用：记录 MCP 的接口规格与实现边界 —— **有哪些工具、每个工具返回什么、壳负责什么、明确不做什么**，以及 agent 一定会踩的坑（真训练链路的模型、预测与评估边界，见 §6.5）。

---

## 0. 一句话

**MCP 是 `sciviz` 命令行的第二种传输，不是第二个核。**

一个协议壳、零新增依赖、十五个工具，每个工具都调用 CLI 或它登记的用例；工具声明从
`src/agent/tools.ts` 的唯一注册表按 `mcp` surface 取得。shell 里不允许出现任何一行关于端口、校验、
指纹、重算的判断。判据写在 §2，是可机检的，不是告诫。

---

## 1. 为什么现在做

[Agent面设计](./Agent面设计.md) §11 的 G4 原本缺 MCP 消费入口。消费者出现后先落基础薄壳；2026-09-28 又按外部 agent 与内部工作流的差距，补上安全文本读取、最近运行图像检查和工程报告写回。

顺序仍然没有颠倒 —— Agent面设计 §0 那六个动作（读懂 → 改动 → 运行 → 取数 → 定位错误 → 汇报）早已在 CLI 上立住，并被 `scripts/agent-blind.mjs` 的 25 步盲测钉住（不 import `src/`、不读界面）。所以此刻加壳是安全的：**它没有东西可以重新发明**。

一句话对照：

| | CLI（已交付） | MCP（本文） |
|---|---|---|
| 谁调用 | 人在终端、agent 用 shell | agent 用工具调用 |
| 传输 | argv + stdout/stderr + 退出码 | stdio 上的 JSON-RPC 2.0 |
| 动词 | `catalog` / `validate` / … | 同名工具，参数化 |
| 契约逻辑 | 在 `src/contract/*`、`src/kernel/*` | **一处都不许有** |

---

## 2. 三条不可让步的约束（每条都有机检）

| # | 约束 | 机检方式 | 破了会怎样 |
|---|---|---|---|
| **M1** | shell 的执行能力**只**能拿到 CLI 那一个入口；声明能力只读共享 `TOOLS`。实现上：`scripts/sciviz.mjs` 导出 `runCli(argv)`，`sciviz-mcp.mjs` 只 import 它与 `src/agent/tools.ts` | 静态检查 import：除 `node:*`、`./sciviz.mjs`、`../src/agent/tools.ts` 外一律红；`tools.ts` 自身为纯声明 | handler 里长出第二套 plan / 校验 / 指纹 —— 就是 `executor.ts` 那个错误的 MCP 版 |
| **M2** | MCP 工具集合等于 `TOOLS.filter(surfaces includes 'mcp')`，且每项都有对应 CLI 映射。不许另写 `EXPECTED_TOOLS` 数组、合并两个动词或暴露 chat-only 的源码写工具 | 单测比对共享注册表、CLI 帮助文本与 `tools/list` 三者 | 两边能力或权限面悄悄分叉，违反 S1 与 R1 |
| **M3** | **流程不写进代码**。"先分帧再接特征"这类编排只出现在工具描述、server instructions 与本文 §6 里 | 人工评审 + 判据：shell 里出现按算子名分支（`if (type === 'train…'`）即红 | 编排一旦进 handler，它就比契约更早知道"该怎么做"，而它错的时候不会报错 |

M3 有个直接后果，值得单独写出来，因为它看着像功能缺失：**不提供 `build_training_pipeline` 这种"一句话搭好训练流"的工具。** 那种工具是第二套真相最舒服的藏身处（它必须知道算子清单、端口名、参数默认值），而且它会剥夺中间可见性 —— 人看不见它到底接了哪几条线，也就没法审。

反面做法一并登记：把 `patch` 做成"agent 传一张完整图，shell 差分成一串 op"。差分逻辑 = 第二处图语义。

---

## 3. 实现形态

### 3.1 一个壳文件，零新增依赖

```
sciviz-web/scripts/sciviz-mcp.mjs      ← 唯一新增文件，约 250 行
sciviz-web/src/agent/tools.ts           ← 与对话栏共用的纯声明注册表（由对话栏 C0 建立）
```

这里的“零依赖”指不增加 npm 包，不是把工具名复制回壳里。**不引入 `@modelcontextprotocol/sdk`。** 理由不是嫌麻烦：

- stdio 上的 MCP 就是"按行分隔的 JSON-RPC 2.0 + 三个方法"（`initialize` / `tools/list` / `tools/call`），手写约 90 行，且协议里没有我们需要发挥的部分；
- 装了 SDK 就要回答"锁哪个版本、离线机器怎么装"—— 这个项目的交付前提是纯本地可复现（方案V3 §0），多一条 npm 依赖就多一处装不上的可能；
- SDK 会诱导我们用它的 schema 去**再声明一遍**参数含义，而那层含义的真源是 `catalog`（算子参数）与 `src/contract/ops.ts`（动作字段）。

反方理由登记在案：SDK 自带 schema 校验与协议版本兼容，将来若要做 HTTP 传输层，换 SDK 的成本比现在手写低。**当前传输是 stdio + 本机 + 单消费者，不值得。**

### 3.2 对 `sciviz.mjs` 的改动（约 6 行）

现在文件末尾是"import 即执行 `main()`"。改成具名入口 + 守卫：

```js
// 直接当命令行跑时才自动执行
const invokedDirectly =
  !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) runAsCli()

/** MCP 用的入口：argv（不含程序名）→ { code, stdout, stderr }，不抛异常 */
export async function runCli(argv) { /* 复用同一个 main()，收 stdout 与 exitCode */ }
```

`runCli` 内部仍然是那个 `main()`：`parseArgs`、`die()`、退出码、`--json` 的"stdout 是纯 JSON"承诺，**一行都不复制**。

> Windows 提醒（AGENTS.md §6.2）：守卫里的比较必须两边都是 `file://` URL。直接拿 `process.argv[1]`（`e:\...`）和 `import.meta.url` 比会永远不等，症状是"MCP 跑起来了，但子命令行为不对"。

### 3.3 生命周期

```
agent 客户端 ── spawn ──→ node scripts/sciviz-mcp.mjs        （常驻一个进程）
                              │
                              ├─ initialize / tools/list       纯本地，不碰契约
                              └─ tools/call ──→ runCli(argv)   同进程调用，等价于跑一次命令行
```

| 事项 | 决定 | 为什么 |
|---|---|---|
| 传输 | MCP 仍只有 stdio；实时画布由本机宿主作受限桥接 | MCP 客户端仍只连 stdio。浏览器主动连回环宿主；CLI 通过已认证的 `/agent/canvas/call` 请求浏览器执行白名单动作，不开放 Edge CDP，也不接收任意 JavaScript |
| 每次调用开销 | 进程内转发（约 0 ms）+ CLI 自身耗时 | 逐次 spawn 子进程要为每次调用付 2–4 s 的 tsx 冷启动（实测 `catalog --json` 2.1 s、`doctor --json` 3.9 s），而 agent 一轮闭环要调十几次 |
| 并发 | **串行**：一条 promise 队列，一次只跑一个调用 | `run` / `inspect` 抢同一个宿主；`patch` 就地写同一个工程文件。并发得到的不是加速，是两边互相覆盖 |
| 取消 | 现状：只能等它跑完（缺口 G-3） | CLI 没有 cancel 入口，Agent面设计 G6 里的 `status` / `cancel` 也还没实现 |
| **重启** | 分两条，别混：① 改了 `src/**`（契约、核、算子清单）→ **重启 MCP server**；② 改了共享算子 `src/engine/python/*.py` → **重启本地宿主**（`run-host.ps1`），重启壳没用 | ① 是真的：`load()` 用动态 `import()` 加载运行所需模块，常驻进程会把它们缓在内存里。② 是 AGENTS.md §6.4 那条既有规则（宿主侧 `shared_operators()` 是 `@functools.cache`），壳不改变它。两处症状一样："文件里明明有了，工具说没有" —— 判据也一样：① 看 `catalog` 里有没有你新加的类型，② 看 `GET /health` 的 `operators` 列表 |

### 3.4 实时画布桥接

实时画布不是 CLI 对 `.sciviz` 的无头投影：它操作当前浏览器页内的 Zustand store，并把页面实际渲染的画布截图以 MCP image 内容回给外部 Agent。

```
外部 Agent → MCP stdio → sciviz canvas CLI → POST /agent/canvas/call（宿主令牌）
                                                        ↓ 请求/响应
活动 SciViz 页面 ← WS /agent/canvas ← 本地宿主
```

- 页面连接时用 `/agent/config` 提供的进程令牌完成 WebSocket 首帧认证；HTTP 调用继续校验同一令牌与 Origin。服务只监听回环地址。
- 页面报告可见与焦点状态；宿主优先选择当前聚焦的可见页面，否则选择最近聚焦的可见页面。没有可见页面、令牌无效或页面未响应时返回明确失败，不退回磁盘文件模式。
- 浏览器只接受固定动作：`status`、`new`、`inspect`、`patch`、`undo`、`run`、`screenshot`。`patch` 与 `undo` 仍走共享 `runGraphPatch` / `runGraphUndo`、`applyPatchGuarded`、工程基线、写入档位、反向动作与现有写回；桥接不接收脚本、DOM 选择器或任意方法名。
- `new` 在当前页面新建未保存草稿。若当前工程含已有内容，必须由页面给出确认；成功后先解除旧文件句柄，避免新画布的自动保存写进旧工程。
- `inspect` 和 `patch` 使用当前内存工程与 `projectEditFingerprint`；MCP 返回截图时捕获当前可见画布，不从运行清单或另一个文件重绘。
- `new`、`patch`、`undo` 与 `run` 默认附带更新后的画布 PNG；`screenshot` 可单独请求。图片像素仅在本次 MCP 响应中返回，不持久化到工程或宿主状态目录。

`tools/call` 之外只回应 `ping`；其余方法统一回 `-32601`。收到 `notifications/initialized` 不做任何事。**不注册 resources、不注册 prompts** —— 工程文件与报告都是磁盘上的纯文本，agent 用文件工具读更合适（§4.1）。

---

## 4. 工具清单（15 个）

一个工具 = 一条 CLI 动词。返回负载 = 那条命令 `--json` 的原样 stdout（§5）。

| # | 工具 | CLI | 入参（★=必填） | 返回（`data`） | agent 什么时候用它 |
|---|---|---|---|---|---|
| T0 | `sciviz_new` | `new` | `file`★, `name?`, `description?`, `force?` | `{ok, file, projectId, name, created}` | 没有现成工程时创建空 `.sciviz` |
| T1 | `sciviz_catalog` | `catalog` | `type?` | `{catalogVersion, operatorCount, operators[], errorCodes[], notes[]}` | **做任何事之前**。端口名、参数键、`runtime`、`requires` 都从这里取，不许猜 |
| T2 | `sciviz_validate` | `validate` | `file`★, `columns?`{id:"列1,列2"}, `time?`{id:列} | `{file, ok, errors[], warnings[], nodeCount, edgeCount, notChecked[], datasetRefs[]}` | 每次改动之后。`notChecked` 说明**哪些契约没查**，别把 `ok` 读成"全过" |
| T3 | `sciviz_explain` | `explain` | `code`★, `context?`{nodeId,portId} 或 `list:true` | 单码：`{code, level, when, action, fixes[]}`，`fixes[]` 是 op 名 | 拿到任何错误码之后、动手修之前 |
| T4 | `sciviz_plan` | `plan` | `file`★, `data?`{名:路径} | `{ok, workflow, datasets[], unbound[], evaluate[], blocked[], missing[], unchanged[], manual[], validation}` | **花算力之前的自检**：要算什么、为什么跳过、缺什么输入。不需要宿主 |
| T5 | `sciviz_patch` | `patch --ops` | `file`★, `patch:{baseFingerprint★, ops[]★, reason?}` 或顶层 `baseFingerprint★` + `ops[]`★, `reason?`, `dryRun?`, `out?`, `upgrade?` | `{ok, changes[], incomplete[], rejections[], diff, validation}` | 改图的**唯一**方式。机器补丁必须带当前 `project.editFingerprint`；CLI 与 inspect 一样保留工程数据集 ID，再经 `applyPatchGuarded` 核对后应用。旧 CLI ops 数组仍可不带基线 |
| T6 | `sciviz_undo` | `patch --undo` | `file`★ | 同 T5 | 改错了，或人要求回退。反向动作记在工程文件里，不记在 shell 里 |
| T7 | `sciviz_run` | `run` | `file`★, `data`★{名:路径}, `out?`, `host?`, `includeFigures?` | `{status, runId, nodes[], figures[], figureCapture, manifestPath, reportPath, drift, graphFingerprint}`；请求捕获时 MCP content 还带 PNG | 真跑一遍。需要视觉核对时设 `includeFigures: true`，会捕获 Matplotlib 图和标准图表；需要本地宿主与可用 Chromium |
| T8 | `sciviz_inspect` | `inspect --canvas` | `file`★, `node?`/`nodeId?`, `groupPath?`, `port?`/`portId?`, `rows?`, `rowOffset?`, `code?`, `codeOffset?`, `offset?`, `limit?`, `from?`, `data?`, `host?` | 不带节点时分页返回整张（含嵌套组）画布的节点、连线、参数、可编辑参数、运行状态与输出摘要；带节点时返回完整节点自述；`code=true` 列出代码目录或分页读正文；`rows` 显式读取表格行值并支持 `rowOffset` | 探查画布结构和某个节点的所有可读细节；结果基于指定的已保存 `.sciviz`，运行状态/摘要取匹配的最近运行；需要新鲜行值时重新运行并按页读取 |
| T9 | `sciviz_doctor` | `doctor` | `host?` | `{ok, host{up,engine,device,operators[]}, checks[], note}` | 想知道"为什么跑不了"。比对 `requires` 之前先看它 |
| T10 | `sciviz_verify` | `verify` | `fixtureId?`, `host?` | `{ok, results[]:{fixture, cells[]:{key,expected,actual,tol,from}}}` | **区分"跑通了"与"算对了"**。改了算子实现、或要给人一个可信数字时 |
| T11 | `sciviz_read` | `code --action read` | `path`★, `startLine?`, `endLine?` | 安全文本页、SHA-256 与 `complete` / `nextStartLine` | 读取工作区说明或源码；遵守 CLI-11 路径围栏 |
| T12 | `sciviz_inspect_figure` | `inspect --image` | `file`★, `nodeId`★, `from?`（默认 `latest`）, `portId?` | 图像元信息；MCP content 带 PNG image block | 读取最近一次或指定运行中已捕获的图像给外部模型看 |
| T13 | `sciviz_report` | `report` | `file`★, `action`★=`list\|read\|save\|delete`, `expectedSha256`（写操作必填）, `reportId?`, `title?`, `markdown?`, `figures?`, `offset?`, `limit?` | 项目报告列表、分页正文或保存/删除结果；写操作回新工程 SHA-256 | 把结果与最近运行图像保存到 `.sciviz`；要求基线匹配，不提供任意文件写入 |
| T14 | `sciviz_canvas` | `canvas` | `action`★=`status\|new\|inspect\|patch\|undo\|run\|screenshot`, `patch?`, `baseFingerprint?`, `includeScreenshot?`, `host?` | 当前前台浏览器画布状态、投影、补丁/运行结果；`new/patch/undo/run` 默认附带 MCP PNG 图像内容 | 直接检查/修改/运行当前打开页面中的图，立即视觉核对结果；要求 SciViz 页面与本地宿主在线 |

参数命名一律 camelCase，shell 把它翻成 CLI 的 `--kebab-case`；这条翻译表属于传输而不是契约。`patch`、`report` 的结构化负载会写到 `.tmp/mcp/` 再传给 CLI；`patch` 必须完整保留 `reason`、`baseFingerprint` 与 `ops`，基线核对由 CLI/内核完成。`addDataset.path` 是相对于 `.sciviz` 工程文件的 CSV 路径，不是子图寻址路径。MCP shell 只把 CLI 指定的 PNG 字节包装成 image content，不重新绘制或解释图像。

`sciviz_inspect` 的输入来自共享 ToolSpec；CLI 的 `--canvas` 分支复用 `src/agent` 中的纯逻辑画布投影，与 Chat 探针使用相同的字段投影、参数过滤、组路径解析和分页判据。它读的是 `file` 指向的**已保存**工程：未保存的浏览器内存修改不会自动同步到 MCP 进程。节点输出与状态通过运行时 id 对应最近一次匹配该工程的 `run.json`；文件没有匹配运行时则如实返回空输出/未知状态。`code=true` 和 `rows` 都是显式外发请求，代码按 `nextCodeOffset`、整图/代码目录按 `nextOffset`、行值按 `nextRowOffset` 续读；任何响应被 MCP 64 KiB 上限截断时，以截断标记给出的完整文件为准。

`sciviz_canvas` 与上述 `inspect --canvas` 是两个不同的读取面：前者寻址当前获得焦点的浏览器页面，后者寻址 `file` 指定的已保存工程。实时补丁由页面持有当前状态并经现有图写闸门落地；写回已打开文件仍由 `ProjectFileBar` 的权限与磁盘基线规则管理。没有活跃页面时，实时工具应失败并要求用户先在 SciViz 中打开画布。

### 4.1 明确不做的工具（以及为什么）

| 看着顺手的诱惑 | 不做的原因 |
|---|---|
| `sciviz_open` / 独立的 `project_read`（读一张图） | 不增加第二个工具动词：现有 `sciviz_inspect` 的 `--canvas` 模式从 `.sciviz` 读取结构，并复用内部纯投影；文件文本仍可用安全 `read` 工具读取，图结构的字段与解释只由共享投影生成 |
| `sciviz_save_report`（任意文本写回） | 不提供任意文件写入。项目实验报告通过 CLI-14 `report` 做基线校验后的结构化写回 |
| `sciviz_build_training_flow` | 违反 M3，见 §2 |
| `sciviz_apply_yaml`（整份覆盖工程） | 违反 Agent面设计 G2/G3（补丁式改动）的立意：agent 的改动必须是"能看出动了哪几处"的一批 op。`patch` 的 `diff` 就是这个用途 |
| `sciviz_eval` / `sciviz_predict` | 没有对应 CLI 动词。**这条同时暴露一个真实缺口，见 §6.5** |
| `sciviz_write_file`（代读代写） | agent 自己就有文件工具；壳提供它只会绕开 git 审计 |

---

## 5. 返回封装与退出码（最容易做错的一条）

每次 `tools/call` 的返回：

```jsonc
{
  "content": [{ "type": "text", "text": "<CLI 的 stdout；图像工具追加 MCP image 内容>" }],
  "structuredContent": { /* 同一份 JSON，给支持它的客户端（协议 2025-06-18 起） */ },
  "isError": false,
  "_meta": { "command": "run", "exitCode": 1, "ok": false, "durationMs": 3210 }
}
```

三条判据，逐条都是踩过才写的：

**① 退出码 1 不是工具失败。** `run` 的 `status` 有 `failed` / `partial` / `cancelled` 三种非成功值，退出码都是 1 —— 而**此时那份清单里往往已经有真实数值**。实测：一张 数据→划分→训练MLP→评估 的图，训练成功、评估报错、退出码 1；如果 shell 把它报成"调用失败"，agent 就看不见 `最终验证准确率 0.9722` 这个数，只能重跑或瞎猜。所以：

| CLI 退出码 | 含义（CLI-0） | MCP 映射 |
|---|---|---|
| 0 | 通过 | `isError: false`，正常负载 |
| 1 | 有问题：契约违约 / 节点失败 / 有节点没算 | **`isError: false`** + `_meta.ok = false` + 完整负载。这属于业务结果，agent 要拿它去修 |
| 2 | 用法或环境错误：参数写错、文件不存在、宿主没起 | `isError: true` + CLI 的原文 stderr。这是调用方写错了，得让人看见原文 |

**② 不重新格式化。** CLI 的 `--json` 已经保证 stdout 是纯 JSON。shell 只把解析后的结果塞进 `structuredContent`。`run(includeFigures=true)` 和 `inspect_figure` 会额外把 CLI 指定的 PNG 字节包装成 MCP image block；`inspect_figure` 的 base64 不重复塞进文本结果。解析失败（CLI 崩了、输出被截断）→ 保留原文，**不猜内容**。

**③ 大负载要截，但必须留下截断标记。** `inspect --rows` 天然有界；`catalog --json` 实测 61 KB，`run` 的清单在长了 history 表之后会更大。规则：> 64 KB 时截到 64 KB 并追加 `{"truncated": true, "full": "<落盘文件绝对路径>"}`，完整原文写到 `sciviz-web/.tmp/mcp/<调用号>.json`。CLI 本来就把清单和报告落盘，所以"截断"永远有退路 —— 这也是为什么壳不许自己攒状态。

进度：`run` 的进度打点全走 stderr（NDJSON，实测形如 `↻ mlp 87% · 第 26/30 轮 · 训练损失 0.1072`）。第一阶段先原样收着、结束时随结果给一小段尾巴；**下一步**转成 `notifications/progress`（要客户端在 `tools/call` 里带 `progressToken`）。真训练是分钟级的（4 GB 显存边界见 `sciviz-local/README.md`），没有进度回传时客户端会以为调用挂死了。

---

## 6. 模型训练这条线：实测能做什么、不能做什么

这一节是本文件存在的另一半理由：**要的是"跑模型训练"，训练、预测与评估的边界必须写成机器可读的动作。壳不能替契约做隐式编排。**

### 6.1 先分清真算与模拟（28 个算子里的分布）

`catalog` 的 `runtime` 字段来自算子自己的声明（`NodeTypeDef.runtimeClass`，必填 —— `ENGINE_NODES` 白名单已在 2026-09-13 删除）。训练相关的：

| 算子 | `runtime` | `execClass` | `requires` | 无头跑会得到什么 |
|---|---|---|---|---|
| `train.mlp` | **engine** | background | host + torch | **真数值**（每轮损失 / 准确率 / 参数量 / 实际设备） |
| `train.cnn1d` | **engine** | background | host + torch | **真数值**（用户准备的多通道定长样本表 → 1D-CNN） |
| `train.custom` | **engine** | background | host + torch | **真数值**（用户 `build_model` + 可选 Dataset / DataLoader / loss） |
| `model.predict` | **engine** | background | host + torch | 训练模型在 val / test 上生成预测表 |
| `data.columns` / `data.collect` / `data.preview` | engine | interactive | — | 真表 |
| `viz.chart` / `viz.density` | engine | interactive | — | 必须连接 `data : table`；输出 `figure` 表并在节点框内直接绘制，不提供独立数据集回退 |
| `custom.script` / `custom.chart` | **engine** | interactive | — | 用户函数返回的表、`figure` 或 `scaler`；返回 `figure` 的绘图函数必须接收上游数据，figure 在节点框内统一预览 |
| `eval.score` | engine | interactive | — | 真指标（**但要的是一张"真实列 + 预测列"都在的表**，见 §6.5） |
| `model.define` / `model.train` / `model.hpo` / `eval.metrics` / `eval.compare` / `eval.explain` / `custom.model` | **simulated** | interactive / background | — | **不产出任何数值**。`run.status = 'partial'`，清单里如实标 `simulated: true` |

`viz.density` 的 `sampleRatio` 是 `0~1` 的取点比例：`1` 使用所有输入点，`0` 不产出可估计的点数，
中间值按比例等间隔取点。概率密度估计会使用该参数对应的实际点数，不再被固定的 6000 点上限覆盖。

两条必须进 server instructions 的话：

1. **`simulated` 不是"跑通了"，是"这里没有数"。** 无头侧刻意不编占位数值（接口文档 §6 #8：编一个数比不产出更糟）。
2. **`requires.runtime = 'host'` 的节点，宿主没起就是跑不了**，不回落、不假装算过。先看 `doctor` 的 `host.up`，别先 `run`。

### 6.2 今天真跑得通的训练形状

实测过的最小一条（2026-09-14，本机 RTX 3050 Laptop 4 GB / torch 2.13.0+cu126 / CUDA 12.6）：

```
data.source ──__table__──→ custom.script(准备 train/val/test) ──train──→ train.custom / train.mlp
                                      ├─ val ────────────────────────→ train.mlp.val
                                      ├─ test ───────────────────────→ model.predict ──→ eval.score
                                      └─ scaler ────────────────────→ 后续 custom.script
```

数据划分、信号分帧、数据增强、特征工程与标准化不再由内置节点隐式完成。需要这些步骤时，
请在工作流外准备好数据，或用 `custom.script` 显式返回 `train`、`val`、`test` 与 `scaler`；
标准化器只在 `train` 上 `fit`，再对三份数据调用同一个 `transform`。

调用序列（每步都是 §4 的工具）：

| 步 | 工具 | 参数要点 | 实测结果 |
|---|---|---|---|
| 1 | `doctor` | `host=http://127.0.0.1:8765` | `ok=true`，`host.up=true`，设备 `cuda` |
| 2 | `catalog` | — | 从 `operators[]` 读端口与参数名，**不猜** |
| 3 | 建种子工程 | **见 §9 G-1**：CLI 不吃"不存在的文件" | — |
| 4 | `patch` `dryRun` | `ops[]` + `reason` | `changes[]` 14 处，文件没动 |
| 5 | `patch` | 去掉 `dryRun` | `ok=true changes=14`；反向动作进工程文件的 `patches` 段 |
| 6 | `validate` | `file` | `ok=true`，4 节点 / 4 边 |
| 7 | `plan` | `data={…}` | `evaluate[]` 列出该算的，`blocked[]` 空 |
| 8 | `run` | `data`★、`out`、`host` | 划分 168/36/36；训练节点输出 `model`、`metrics`、`history`、`curve`；`model.predict` 生成留出集预测表 |
| 9 | `inspect` | `node='mlp'`, `from=<run.json>` | `metrics` 指标：参数量、最终验证损失 / 准确率、耗时、实际设备；`predictions` 表可继续接 `eval.score` |
| 10 | `explain` | 报错码 / `rejections[].code` | 给出 `action` 与 `fixes[]`（可用 op 名） |

一次真实训练还会落盘产物：`artifacts[] = {kind:'model', path:'<repo>\\.artifacts\<指纹前16>\model.pt', bytes:21077}` 与同目录 `meta.json`（参数、指标、逐轮 history、环境）。**跨机器可比的是指纹，不是路径。**

### 6.3 参数与种子（agent 最常错的三处）

| 坑 | 症状 | 正确做法 |
|---|---|---|
| 端口名 | 拿 `data.source` 的 `data` 当输出端口去接 | 整表端口叫 **`__table__`**，另外每个数值列各自还是一个端口（`f1` / `quality`）。列名从 `validate` / `inspect` 的实际输出读，别背 |
| 参数字符串化 | `features` 传成数组 | `train.mlp.features` / `label` 是 **text**，写法 `"f1,f2"`；`task` 是 `select`（`auto`/`分类`/`回归`）。判据一律是 `catalog` 里的 `params[].type` |
| 随机种子 | `E_UNSEEDED_STOCHASTIC`，或事后不可复现 | 自定义函数中的随机源由用户自行固定；`train.*.seed` 仍按清单声明。清单的 `unreproducible[]` 会列出 `custom.*` 与训练节点 |

顺带一条读数约定：`drift` 现在会把 **`耗时秒`** 报成"数值变化"（实测同图两次重跑，`0.284 → 0.283`，被提示"要么这一步不可复现，要么有别的东西在变"）。**这不是漂移。** 读法：只看科学量，把墙钟字段当噪声（缺口 G-4）。

### 6.4 想跑更大的模型

`train.cnn1d`（用户准备的多通道定长样本表 → 1D-CNN）是真实场景那条；显存边界已量过，记在 `sciviz-local/README.md`。超参搜索（`model.hpo`）**还是模拟**，无头跑不出数 —— 要调参今天只有两条路：agent 自己按短名单反复 `patch` + `run`（每一步都留 op 与 diff，可审），或者先实现模拟适配器（缺口 G-2）。

### 6.5 训练后的留出集评估

训练节点现在统一输出四类结果：`model` 是宿主内真实模型句柄，`metrics` 是数值指标，
`history` 是逐轮宽表，`curve` 是可直接绘制的长表。`model.predict` 接收 `model` 与
任意 `table`，在同一个宿主会话里生成 `predictions` 表；该表带有真实标签（如果输入表中
存在）和 `预测_<标签名>` 列，可以直接连接 `eval.score`。

自定义模型的代码协议是：必须提供 `build_model(spec, params)`。普通模型可以让训练器
按 `(x, y)` 创建 Dataset、DataLoader；复杂模型可提供 `make_spec(data, split, params, scaler)`、
`build_dataloader(data, split, params, scaler)`，再用 `train_step(model, batch, device, spec)`、
`validation_step(...)`、`predict_step(...)` 自己解析任意 batch。需要多优化器或完全自定义
训练循环时，可实现 `fit_model(model, train_loader, val_loader, device, spec, params, env)`。
`make_dataset`、`make_dataloader`、`loss_fn` 与 `decode_predictions` 仍作为兼容入口保留。
此时宿主不再猜测 batch 结构或模型调用方式。`Dataset` / `DataLoader` 是宿主运行时对象，
不作为画布端口传输。

---

## 7. 汇报：事实与叙述分开，支持回写项目报告

`run` 已经落 `run.json`（事实，机器生成）与 `report.md`（事实段 + 留空的叙述段）。MCP 通过 CLI-14 `report` 管理 `.sciviz` 顶层 `reports:`，不提供任意路径写入。报告保存用读取时返回的 `projectSha256` 作基线；磁盘文件在编辑期间变化就拒绝覆盖。

- `sciviz_run` 返回里的 `manifestPath` / `reportPath` 是**绝对路径**，agent 可用文件工具读取；需要读图时设 `includeFigures: true`，PNG 存在该运行目录；
- `sciviz_inspect` 带 `from=<manifestPath>` 时**不再跑一遍**；`sciviz_inspect_figure` 从同一运行目录读取已捕获的图像；
- `sciviz_report` 的 `figures[]` 只能引用本 MCP 进程先前经 `run` 或 `inspect_figure` 捕获的图像。CLI 复用报告图片校验与嵌入逻辑，正文保留图源、节点、端口和 SHA-256。

叙述段的纪律照旧：**只能引用事实段里出现过的数字**。壳不校验这条（那是 agent 与人之间的约定），但 server instructions 要把它说一遍。

---

## 8. 客户端接入

### 8.1 Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.sciviz]
command = 'node'
args = ['E:\科研数据图帮助\sciviz-web\scripts\sciviz-mcp.mjs']
startup_timeout_sec = 30

[mcp_servers.sciviz.env]
SCIVIZ_HOST = 'http://127.0.0.1:8765'
SCIVIZ_MCP_ROOT = 'E:\科研数据图帮助'
```

`tsx` 平时只在跑测试与 CLI 脚本时经 `node --import tsx` 注入；`sciviz-mcp.mjs` 本身是纯 `.mjs`，而 `runCli` 里原有的动态 import 已经带着那层加载 —— 所以 `command` 直接写 `node`。**如果接入后发现 `runCli` 里那些 `src/**.ts` import 报未知语法**，就把 `args` 换成 `['--import','tsx','scripts/sciviz-mcp.mjs']` 并把工作目录定到 `sciviz-web`。这条要在 §11 V1 里真验掉，不凭想象定稿。

### 8.2 Claude Desktop（`claude_desktop_config.json`）

```json
{
  "mcpServers": {
    "sciviz": {
      "command": "node",
      "args": ["E:\\科研数据图帮助\\sciviz-web\\scripts\\sciviz-mcp.mjs"],
      "env": { "SCIVIZ_HOST": "http://127.0.0.1:8765" }
    }
  }
}
```

### 8.3 两个本机特有的坑

1. **路径含非 ASCII**（`E:\科研数据图帮助`，`doctor` 已经 warn 过）。配置里一律写**绝对路径**，别指望相对路径；壳内部一律经 `pathToFileURL` 走 import（AGENTS.md §6.2）。换机器时它是第一嫌疑。
2. **宿主是前置条件，不是可选项**。`train.*` 全部 `requires: host + torch`。agent 面对此的正确姿势是"先 `doctor`"，而**不是**壳去自动拉起宿主 —— 那会把一条本不该由工具面拥有的进程生命周期（`run-host.ps1` 钉死了 `.venv`）塞进 handler。壳顶多在报错里复读 CLI 给的那句启动命令。

---

## 9. 已知缺口

分两类：**壳要等 CLI 的**（先改 CLI，壳再转发）与**壳自己的**。别把第一类当壳的 bug 修。

| # | 缺口 | 归属 | 建议 |
|---|---|---|---|
| **G-1** | **没有"从零建一份工程"的入口。** `patch` 要求文件已存在（`工程文件不存在：…`），`validate` 同理。`agent-blind.mjs` 第 3 步就是手写字面 YAML 塞进去的，脚本自己的注释写着"这本身是 agent 面的一个真实摩擦" | **CLI** | 加 `CLI-10 sciviz new <路径> [--name …] [--dataset 名=文件.csv]`，产出**只含一个 `data.source` 节点的最小合法工程**，且必须走 `src/workflow/project.ts` 那份唯一序列化器。在那之前壳不假装能做，把这条写进 server instructions 与 §6.2 第 3 步 |
| **G-2** | 模拟适配器未接入无头核：`model.train` / `model.hpo` / `eval.metrics` 在 `run` 里不产出数值（接口文档 §6 #8） | 契约 / P1 | 不阻塞壳。列在这里是因为 agent 十有八九会先撞 `model.train`（名字最像"训练"） |
| **G-3** | 无头长任务不能取消（Agent面设计 G6 的 `status` / `cancel` 未实现） | **CLI** | 壳先不做 cancel 工具；CLI 实现之后自动多一个 T 即可 |
| **G-4** | `drift` 把 `耗时秒` 这类墙钟字段当数值漂移报（实测见 §6.3） | 契约（`kernel/drift.ts`） | 让算子给指标标 `volatile`，漂移比对跳过它。在那之前壳的说明里写明"读数时忽略墙钟字段" |
| **G-5** | **训练 → 留出集评估在图上不成立**（§6.5） | 契约 / 算子 | 训练节点补一个携带预测的 `table` 输出，或新增 `predict` 算子。**这条是"跑模型训练"这个诉求真正的阻塞点** |
| **G-6** | `catalog` 的 `notes` 里写着"要拿某个具体图的端口清单，用 `sciviz open <project>`" —— **CLI 里没有 `open` 这个动词** | 文档 | 要么删掉那句（读图 = 读文件，§4.1），要么 G-1 落地时一并给一个真 `open`。第二处真相，按 R1 记这笔 |
| **G-7** | `接口文档.md` §2.8 把动作全集写成 11 个 op，而 `PATCH_OPS` 是 12 个（漏 `removeDataset`） | 文档 | 一行订正。R3：文档是判据，判据少一个动作就是缺陷 |
| **G-8** | 进度只在 stderr，客户端看不到分钟级训练的中间态 | 壳（第二阶段） | `notifications/progress` + `progressToken`，见 §5 末 |
| **G-9** | `verify` 的注册式真值只覆盖 28 个算子里的 9 个（10 条夹具，见[待办](./待办.md) §9）—— 图表、标准化器、自定义函数这些仍没有独立真值 | 契约 | 与壳无关，但 §6.5 修完之后**必须**补一条"预测列的手算真值"夹具，否则评估链路仍然只是"跑通了" |

---

## 10. 实现文件映射（文件级）

| 文件 | 动作 | 量 |
|---|---|---|
| `sciviz-web/scripts/sciviz-mcp.mjs` | JSON-RPC stdio、共享工具映射、串行调用；安全解析运行图像并包装 MCP image 内容；图像只在 MCP 进程内暂存供报告保存 | 薄传输壳 |
| `sciviz-web/src/agent/tools.ts` | 唯一 MCP ToolSpec 注册表，与内部工具声明共用 | 共享声明 |
| `sciviz-web/scripts/sciviz.mjs` | 唯一 CLI Facade；运行图像捕获、`inspect --image`、`report` 的读取与基线校验写入 | CLI 执行面 |
| `sciviz-web/src/agent/run.ts` / `src/kernel/manifest.ts` | 受大小与数量限制的运行图像制品及清单元数据 | 运行事实 |
| `sciviz-web/src/workflow/report.ts` / `src/workflow/project.ts` | 报告图片校验、占位引用物化与 `.sciviz` 序列化 | 报告契约 |
| `sciviz-web/scripts/mcp-smoke.mjs` / `check-mcp-shell.mjs` | MCP 启动冒烟与薄壳静态边界检查；随仓库既有脚本执行 | 现有回归入口 |
| `docs/接口文档.md` / `docs/Agent面设计.md` | CLI、MCP 工具与 G4 状态登记 | 接口真相 |

**不动的边界**：MCP 壳不复制 `src/**` 的契约、核、宿主或算子实现。`src/agent/tools.ts`
是跨 surface 的纯声明，不得 import契约或核；报告保存与图像制品由 CLI / 既有报告模块负责。

---

## 11. 验收判据

可执行的部分进 `mcp-smoke.mjs`，语义部分进人工评审。

| # | 判据 | 怎么验 |
|---|---|---|
| V1 | 客户端起得来：`initialize` 协商成功，`tools/list` 回 15 个工具，每个都有 `description` + `inputSchema` | smoke：真起子进程走握手 |
| V2 | **工具集合 == 共享注册表的 mcp surface == 有 CLI 映射的子命令集合** | `check-mcp-shell.mjs` 三方比对（M2） |
| V3 | **壳里没有第二处真相** | `check-mcp-shell.mjs`：import 只允许 `node:*`、`./sciviz.mjs` 与 `../src/agent/tools.ts`（M1）；壳里不出现工具清单或算子名字符串（M3 的代理判据） |
| V4 | 同一个动作两条路**逐字同结果** | 同一份工程、同一批 op：`sciviz patch … --json` 的 stdout 与 `sciviz_patch` 的负载**字符串相等**（`run` / `validate` / `inspect` 各比一组）。这条最重要 —— 它一次性否掉"壳顺手补了点东西" |
| V5 | 退出码 1 不被报成调用失败 | 故意把 `eval.score` 接错（§6.5 那次就是这个形状），断言 `isError=false` 且负载里读得到 `mlp` 的真实指标 |
| V6 | 用法错误给原文 | 传不存在的 `file`，断言 `isError=true` 且 stderr 里有 CLI 那句"工程文件不存在" |
| V7 | 改契约要重启（§3.3 ①） | 往 `src/workflow/nodeRegistry.ts` 加一个算子、不重启 server，断言 `sciviz_catalog` 仍然看不到它（证明缓存属实、这条纪律不是编的）；重启之后能看到。**注意别拿 `operators.py` 验这条** —— 那是 §3.3 ② 的宿主重启，症状相同、药不一样 |
| V8 | 训练闭环 | 只走工具：`doctor`→`catalog`→建种子（G-1 之前按 §6.2 第 3 步用文件工具）→`patch --dry-run`→`patch`→`validate`→`plan`→`run`→`inspect` 拿到 val 准确率→故意错改拿码→`explain`→`patch` 改对→重跑→`undo`。**全程不读源码、不开界面、不提问** |
| V9 | 数值不是抄的 | V8 拿到的准确率与按公式独立算的那一份对上（同一判据已在 `truthFixtures.ts` 与 `agent-blind.mjs` 里用） |
| V10 | CI | `check-mcp-shell.mjs` 进 `npm test`；`mcp-smoke.mjs` 进 `.github/workflows/ci.yml` 的 `agent-face` job（要宿主的那几步沿用该 job 现有处理 —— 那份 workflow 还没推上 GitHub，见 Agent面设计 §11 的凭据注记） |

---

## 12. 待拍板

| # | 问题 | 建议 |
|---|---|---|
| 1 | 逐次 spawn CLI 子进程 vs 进程内 `runCli`？ | **进程内**（§3.3）。代价是"改契约要重启"这条纪律（V7 钉住它）；换子进程则每次多付 2–4 s，agent 一轮十几步就是半分钟纯等 |
| 2 | 工程文件路径由谁给？ | 工具参数一律**绝对路径**，壳用 `SCIVIZ_MCP_ROOT` 校验不越界后原样传给 CLI。**不做"按名字在内部找工程"** —— 那是替 agent 造一个它看不见的状态 |
| 3 | 一个进程服务一个工程还是多个？ | 多个（工具参数带路径）。无状态转发才谈得上"同一核、两种入口" |
| 4 | 先做完 G-1（`sciviz new`）再上壳，还是壳先上、种子那步仍用文件工具？ | **壳先上**。G-1 是独立的一条 CLI 改动，把它当壳的前置只会让两件事互相等；期间 §6.2 第 3 步走文件工具，并在 server instructions 里写明原因 |
| 5 | 要不要现在就补 G-5（评估断链）？ | 不。它是契约侧的新增算子，走自己的流程（先改数据契约规格 → 实现 → 补真值夹具）。壳里不许有任何临时替代 |

---

## 13. 一句话收尾

**壳的价值在于它不持有业务规则：十五个工具，统一转发，零契约判断。**
凡是让壳"更聪明"的请求（帮我建工程、帮我接线、帮我算指标），正确回答都是同一句：那件事该长在 CLI 或算子上 —— 见 §9。那才是这次调研真正挖出来的东西。
