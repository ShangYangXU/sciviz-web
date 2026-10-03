# 万能数据探针：浏览器内真实执行引擎（设计）

- 日期：2026-09-12
- 状态：已实现并验证（含数据变换算子；e2e 35/35 真跑，无跳过）
- 影响范围：`sciviz-web/`

## 1. 问题

现在「数据预览」节点只能显示**数据源**和**列拼表**的数据。`src/workflow/preview.ts` 的 `resolvePreview` 沿连线反查，只认 `data.source` / `data.collect`，其余一律报"上游「X」的输出要运行后才能取到"。

根因不是预览节点写得不够好，而是**画布上根本没有数据在流动**：`src/workflow/executor.ts` 是纯 mock —— 每个节点按 `mockDurationMs` 睡一会儿、吐出一张写死的资产卡片，节点之间不传数据。

所以"探针插在任意一步都能看数据"这件事不可能靠改预览节点实现，必须先让节点之间真的有数据。

## 2. 目标与非目标

**目标**

- G1 任一节点的输出是**真实算出来的值**；探针节点插在其后即可查看（表看前 N 行，指标看数值，图直接出图）。
- G2 数据面实时：连线 / 改参数后自动重算受影响的部分，探针自动更新。
- G3 自定义函数节点里的 Python 代码**原样真跑**，报错给出完整 traceback。
- G4 重算子（训练 / 评估）不进实时路径，按需在节点上触发；其产物明确标注"模拟"。

**非目标（本切片不做）**

- N1 训练 / 评估真跑（仍是模拟实现，但接口是真的）
- N2 模型的折叠分组与子画布（模型 = 原子节点 + 超参）
- N3 划分 / 分窗 / 增强 / 时域特征 / 频域特征 / 标准化等算子 —— 每个单独一个迭代加入
- N4 图表改从 Python 侧取数（图表继续用现有 `columnStore` + D3）

## 3. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 运行时用 **Pyodide（CPython→WASM）跑在 Web Worker 里** | 函数节点里是任意 Python 逻辑，只有真解释器能算；避免用 TS 重写一套算子，导致两边结果早晚对不上 |
| D2 | **全表（DataFrame）留在 Python 侧**，只回传 schema + 统计 + 行数，前 N 行按需拉取 | 1M 行不做来回搬运；探针要的本来就是 head |
| D3 | 训练 / 评估节点 **模拟 + 按需触发**，不进实时重算 | 训练慢且吃资源；实时重算的前提是算子够快 |
| D4 | 模型 = **原子节点 + 超参**，不做折叠 | 折叠是纯视觉层，随时可加；判据是先观察"平均每个模型的独有链路是否 ≥3 个节点" |
| D5 | 引擎消息协议对齐原方案 V2 §6.5 的前端↔执行引擎协议（该文档已从工作区删除，见 git 历史） | 将来把 Worker 换成 Python 进程只改传输层，前端与探针不动 |

## 4. 架构

```
主线程                                      Worker（Pyodide）
┌────────────────┐                          ┌───────────────────────────┐
│ React 画布 / 面板 │                          │ pyodide + numpy / pandas   │
│   ↑ 订阅        │                          │                           │
│ nodeOutputStore │◀──── 摘要(JSON) ─────────│ 数据集缓存 (DataFrame)     │
│   ↑             │                          │ 节点输出 (DataFrame / 值)  │
│ graphRunner     │───── 求值指令 ──────────▶│ 算子 source / collect /    │
│ (脏传播 + 调度)  │                          │      userfn / preview     │
└────────────────┘────── 拉 head(n) ────────▶│                           │
                                             └───────────────────────────┘
```

新增模块：

| 文件 | 职责 |
|---|---|
| `src/engine/protocol.ts` | 主线程 ↔ Worker 消息类型（唯一的接口契约） |
| `src/engine/engineWorker.ts` | Worker 入口：加载 Pyodide、分发消息 |
| `src/engine/python/runtime.py` | Pyodide 侧胶水：数据集装载、算子分发、异常捕获 |
| `src/engine/python/operators/*.py` | 逐个算子。用 Vite 的 `?raw` 导入成字符串，由 runtime 写入 Pyodide 虚拟文件系统，不另起一份拷贝 |
| `src/engine/client.ts` | 主线程 API：`init()` / `evalNode()` / `head()` / `dropNode()` |
| `src/engine/graphRunner.ts` | 脏传播、拓扑调度、防抖、手动节点队列 |
| `src/store/nodeOutputStore.ts` | 节点输出索引（版本 / 状态 / schema / 统计）+ 订阅 |

改动：

| 文件 | 改动 |
|---|---|
| `src/workflow/preview.ts` | **删除** `resolvePreview` 那套反查；只保留 `previewRows()` |
| `src/workflow/executor.ts` | 数据面节点不再 mock 睡时间；recipe 分支保留给手动节点 |
| `src/workflow/nodeRegistry.ts` | `data.preview` 的输入端口类型 `table` → `any` |
| `src/canvas/WorkflowNodeView.tsx` | 预览渲染改为按 `NodeOutput.kind` 分支；训练节点加触发按钮 |
| `src/canvas/WorkflowCanvas.tsx` | 不再在渲染期调 `resolvePreview`，改为订阅 `nodeOutputStore` |
| `src/components/TopBar.tsx` | 展示引擎状态；「运行」语义改为"执行手动节点" |
| `src/store/useWorkflowStore.ts` | 图 / 参数变更时通知 graphRunner；`运行` 改为只跑手动节点 |

Worker 的创建方式沿用 `src/data/importCsv.ts` 的写法（`new Worker(new URL(...), { type: 'module' })`）。

## 5. 核心数据结构

```ts
/** 一个节点可能有多个输出端口，所以按端口索引 */
type NodeOutputMap = Map<string /* nodeId */, Map<string /* portId */, OutputRef>>

interface OutputRefBody {
  kind: 'table' | 'metrics' | 'figure' | 'model'
  columns?: string[] // table：列名（沿用 workflow/types 里的 PreviewTable 形状）
  rowCount?: number // table
  timeColumn?: string | null // table：哪一列是时间（epoch 秒）
  /** metrics。值为 null 表示算出来是 NaN/Inf，界面显示"—"而不是编一个数 */
  values?: Record<string, number | null>
  chart?: ChartSpec // figure
  /** true = 该值来自模拟实现（训练 / 评估节点），UI 必须带"模拟"徽标 */
  simulated?: boolean
}

/** 版本号由主线程在收到结果时补：Python 侧不知道版本 */
interface OutputRef extends OutputRefBody {
  version: number
}

interface NodeRuntime {
  status: 'idle' | 'computing' | 'ready' | 'error' | 'blocked' | 'manual'
  outputVersion: number
  /** null = 从未求值 */
  inputsFingerprint: string | null
  error?: { message: string; traceback: string }
}
```

**不变量：`head` 不在 `OutputRef` 里。** 它按需拉取（`head(nodeId, portId, n)`），缓存键 = `nodeId + portId + version + n`。这样**改探针的「行数」参数只触发一次轻量拉取，不会重算上游**。

吞吐策略：每个输出另记 `bytes` 估算；全局预算默认 512MB，超出按 LRU 逐出，被逐出的输出标 `evicted`，被查看时重算。

> **实现时未做的**：列统计（min/max/mean/zeros）。本切片没有任何界面展示它 ——
> 探针只需要列名与前 N 行，而"列统计"在数据集的详情面板里早就有了（导入时在 Worker 里算好的）。
> 为 1M 行每次求值都白算一遍统计，是纯成本。等真有按列画像的需求再加。

## 6. 求值协议

主线程 → Worker：

| 消息 | 返回 |
|---|---|
| `init()` | `{ type: 'ready' }` / `{ type: 'initError', message }` |
| `setDataset({ datasetId, rowCount, timeColumn, columns, time, data })` | `{ type: 'datasetReady' }` |
| `loadFn({ nodeId, code })` | `{ type: 'fnLoaded' }` / `{ type: 'fnError', message }` |
| `evalNode({ nodeId, type, params, inputs })` | `{ type: 'nodeResult', refs }` / `{ type: 'nodeError', message, traceback }` |
| `head({ nodeId, portId, n })` | `{ type: 'head', columns, rows }` |
| `dropNode({ nodeId })` | — |

`setDataset` 用**拷贝语义**（不放进 `transfer` 列表）：主线程的 `columnStore` 之后还要用这些 `Float32Array`，transfer 会把它们 detach。

调度器组装出的 `inputs` 形状：

```ts
type InputBinding =
  | { kind: 'port'; nodeId: string; portId: string } // 接了线
  | { kind: 'literal'; value: string | number | boolean } // 未接线，用参数字面量

type Inputs = Record<string /* 目标端口 id */, InputBinding>
```

算子（Python）统一签名：

```python
def run(op, ctx, inputs: dict, params: dict) -> dict:
    """inputs: 端口 id -> DataFrame | np.ndarray | 标量
       params: 节点参数
       返回:    输出端口 id -> DataFrame | np.ndarray | 标量
    """
```

**类型协调规则**（写在 `runtime.py` 里，避免每个算子各判断一次）：

1. 上游输出是**单列表** → 降级为 `np.ndarray` 传入（形参名就是列名时最自然）
2. 上游输出是**多列表** → 传 `DataFrame`
3. 未接线且有默认值 → 传字面量

本切片的算子：

| 算子 | 对应节点 | 输入 | 输出 |
|---|---|---|---|
| `source` | `data.source` | 无（读 Worker 侧数据集缓存） | 每个启用特征一个端口（单列）+ `__table__`（整表）+ `__time__`（时间轴） |
| `collect` | `data.collect` | 按槽位的多路 | `data`（按槽位顺序拼列） |
| `userfn` | `custom.script`（函数节点） | `parseSignature` 解析出的形参 | `return {...}` 的每个 key |
| `preview` | `data.preview` | `data` | `head` = 输入原样透传（同一对象，不复制） |

`userfn` 细节：用户代码用 `exec` 进该节点专属命名空间，**只执行一次**（在 `loadFn` 阶段）；参数变化只重新调用函数。`import` 到 Pyodide 里没有的模块（如 `torch`）要给出明确中文报错，不能静默失败。

**端口 id 的唯一来源是 `src/workflow/ports.ts`**：输出端口的 id 由 `resolvePorts` 决定（特征端口 id 就是列名，合成端口用 `WHOLE_TABLE_PORT` / `TIME_PORT`，列拼表槽位用 `collectSlotId(i)`）。engine 侧不自己拼端口 id，一律从前端传下来的 `inputs` / `params` / `resolvePorts` 结果里取，避免两处各拼一套后悄悄错位。

## 7. 调度：脏子图增量重算

```
节点输入指纹 = node.type + 自身参数 + 排序后的 [(端口id, 上游nodeId, 上游端口id, 上游outputVersion)]
```

指纹**不取哈希**：几十个节点、每条几百字节，直接比字符串比算哈希还便宜，而哈希碰撞会静默漏掉一次重算 —— 那是最难查的一类错。

**数据源节点是例外**：它的参数里只有 `datasetId`，而"启用哪些列"和"时间列是哪一列"存在 `useDataStore` 里。所以 `data.source` 的指纹必须额外并入 `featuresOf(datasetId)`（有序）与 `timeColumnOf(datasetId)`，否则用户在数据面板里开关一列，画布上这条链路不会重算。

**判定顺序（实现时定死，见 `src/engine/plan.ts`）**：

1. 非引擎节点 → 走"按需触发"，并算作"坏源"。
2. **上游现在就是坏的 → 本步 `blocked`。** 必须排在"指纹变了就重算"之前：上游拿不到值，下游重算注定失败，直接说清原因比让它报一个含糊的错有用得多。
3. **指纹变了 → 重算。** 这是从错误里恢复的唯一出口：改好上游的代码，上游指纹变了才会重跑；重跑成功、版本 +1，下游指纹跟着变，整条链自动活过来。
4. 指纹没变、上游也好 → `unchanged`，一个字节都不重算；但自己上次就是错的，仍算坏源，否则下游会拿旧值当新值。

求值失败时**不能**给输出加版本 —— 没有新输出，加版本会让整条下游无谓重算，然后各自报同样的错。

- 图 / 参数变更 → 防抖 300ms → 从**参数或连线发生变化的节点**起，指纹与上次不同即为脏
- 脏节点按拓扑序**串行**发给 Worker（Pyodide 单线程，串行既自然又避免互相打断）
- 节点完成 → `version + 1` → 写入 `nodeOutputStore` → 订阅者（节点视图 / 探针）重渲染
- 调度器（`graphRunner`）**反复 plan → 求值 → 再 plan** 直到没有要算的：版本号在求值中才变化，
  一轮只能推进一层，所以级联要靠定点循环推到底
- 状态为 `manual` 的节点（训练 / 评估）不参与传播，除非用户点节点上的触发按钮或顶栏「运行」
- 手动节点被触发并执行完成后，**同样写入 `nodeOutputStore`**：`kind: 'metrics'`，值取自现有 recipe 的 `summary`，并置 `simulated: true`。否则探针在训练节点之后就永远无话可说

**「运行」按钮的语义**：按拓扑序执行**手动节点**（当前 = 特征 / 划分 / 模型 / 评估的模拟实现）。实现方式是把整张图交给执行器、再由 `skip` 集合排除掉引擎负责的节点 —— 图必须完整传进去，因为**输入校验看的是连线**，摘掉上游会让手动节点误报"缺少必需输入"（这是第一版写成"只传手动节点子图"时踩到的坑）。

数据面节点不需要"运行"——它们永远是算好的。但运行结束后要**按真实规模给它们补登资产**（数据源 → 数据集资产，列拼表 → 表资产）：否则资产库会凭空少掉"数据集"条目，而那条目的详情里有整套时序总览 / 列统计 / 时间轴校验，等于把一个功能藏起来。补登的行数列数取自引擎的真实输出，不是资产配方里写死的模拟值。

## 8. 探针节点（万能数据预览）

节点本身不变：输入端口 `data`（类型从 `table` **放宽为 `any`**，因为它现在要接表 / 指标 / 图），输出端口 `head`，参数 `rows`。

渲染改为读**上游的输出**（不是自己的）。下表的"行"分三类：上游输出的 `kind`、上游节点的 `status`、输出的逐出标志：

| 上游情况 | 显示 |
|---|---|
| kind = `table` | 列头 + 前 `rows` 行原值 + "共 M 行"（复用现有 `wf-preview-table` 样式） |
| kind = `metrics` | 指标卡片（键值对）。本切片里唯一的来源是手动节点（训练 / 评估）执行后的模拟摘要 |
| kind = `figure` | 直接渲染 `ChartSpec` |
| status = `manual`（上游是训练 / 划分这类模拟节点，且还没触发） | "上游「X」是模拟实现，不进实时重算 —— 点节点上的「运行」后才出指标" |
| status = 未算（引擎节点，还没轮到） | "等待上游求值…" |
| status = `computing` | 保留上一次值 + 角标"重算中"（不闪空） |
| status = `error` | 红色显示 `message`，可展开看完整 `traceback` |
| status = `blocked` | "上游出错，本步未计算" |
| 输出 `simulated` | 表头 / 卡片上带"模拟"徽标（与 §9.2 同一条规则） |
| 输出被逐出 | 显示"重算中"并自动触发重算 |
| 引擎未就绪 | "执行引擎未就绪" + 原因（加载中 / 失败） |

## 9. 诚实的边界

沿用现有原则（`preview.ts` 注释里那条"绝不拿上游原始行冒充下游输出"），扩展为三条：

1. **真算就显示真值**，并在表头标"来自 <上游节点名>"（已实现）。
2. **没真算就明说**：训练 / 评估节点的产物带 `模拟` 徽标，探针显示时沿用同一个徽标。
3. **算不出来就不装**：Python 报错显示 traceback；引擎没起来显示"未就绪"；被逐出显示"重算中"。任何情况下不拿别的数据顶替。

## 10. 错误处理

| 失败 | 处理 |
|---|---|
| Pyodide 初始化失败（离线 / 资源缺失） | 顶栏常驻"引擎不可用"；数据面节点标 `idle`；探针显示原因；mock 的「运行」仍可用 |
| 用户函数语法错误 | `loadFn` 返回编译错误 → 节点标 `error`，红框 + traceback |
| 求值运行时异常 | 节点标 `error`，`OutputRef.error` 带 traceback；下游标 `blocked`（不计算） |
| import 到 Pyodide 没有的模块 | 专门的中文提示（列出可用模块与 `micropip` 安装方式） |
| Worker 崩溃 | `onerror` → 重建 Worker、清空所有输出与缓存、全图重新求值 |
| 内存超预算 | LRU 逐出 + `evicted` 标记；被查看时重算 |

## 11. 测试策略

**纯逻辑单测**（用 Node 24 的类型剥离直接跑 TS，不引新依赖；必要时加 `--experimental-strip-types`）：

- 输入哈希的稳定性与敏感性：改参数 / 改上游版本必须变；无关节点变化必须不变
- 脏传播：给定变更节点，算出正确的重算集合；菱形依赖只算一次
- 端口 → 输入绑定的组装：接线 / 未接线用字面量 / 单列降级为 ndarray

**E2E**（扩 `scripts/e2e.mjs`，playwright-core）：

- 源 → 列拼表 → 预览：表头来自上游、行数正确（现有能力不回归）
- 源 → 自定义函数 → 预览：**函数返回一个可辨认的值，断言探针显示了它**（截图里那个空节点的回归测试）
- 改函数代码 → 防抖后探针自动更新
- 改探针 `rows` → 行数变化，且**上游未重算**（断言上游 `outputVersion` 不变）
- 函数语法错误 / `raise` → 节点显示 traceback，探针显示失败
- 训练节点不进实时重算；点触发按钮后才有结果，且探针此时能显示指标（带"模拟"徽标）

## 12. 验收标准

1. 截图里那个"上游是函数"的预览节点**出真数**。
2. 数据面节点连线 / 改参后自动重算，探针自动更新；重算范围限于脏子图。
3. 改探针行数不触发上游重算。
4. 函数报错给出完整 traceback。
5. 训练 / 评估节点按需触发：**没触发时**探针明说上游是模拟实现、要点「运行」才出指标（不糊弄成"等待中"），**触发后**能显示其指标且带"模拟"徽标。
6. 引擎不可用时不显示任何伪造数据。
7. 本机浏览器能取到 Pyodide 的 zip，引擎相关的 e2e 用例**真跑**，不靠 SKIP 过关。

## 13. 风险

| 风险 | 缓解 |
|---|---|
| Pyodide 首包约 10MB（+ numpy / pandas），首屏慢 | 懒加载：首次需要求值时才 `init`；顶栏显示加载进度；资源本地化到 `public/pyodide/`，不依赖 CDN |
| Worker 内存（1M 行 DataFrame + 中间产物） | 全表留 Python 侧 + head 按需 + LRU 逐出 + 预算监测 |
| 大表算子变慢，"实时"名不副实 | 每算子耗时预算；超预算的算子降级为手动触发（训练节点已按此设计） |
| 浏览器内没有 scipy / 需要额外包 | 明确可用模块清单；需要 `micropip` 时给中文提示，不静默失败 |
| 离线环境（最终交付形态） | v1.0 打包必须内联 wasm；本切片先把资源放 `public/` 走本地，不用 CDN |

## 14. 后续迭代

每个算子一个迭代，逐个接进引擎：数据划分 → 信号分帧 → 数据增强 → 时域特征 → 频域特征 → 标准化。每个都要单独确认公式与领域惯例（窗函数、包络谱带宽、划分是否分层），不和引擎骨架混在一起做。

**已全部完成**（标准化在第一批，其余五个见 §16）。领域惯例不必再单独拍板：节点注册表里
已经写死了它们 —— 窗长 2048 / 重叠 0.5、划分 0.7+0.15 且固定 seed、SNR 可控加噪、
时域统计量与频域方法的可选项。实现按这份既有的表来，没有另立一套默认值。

## 15. 实现记录（与设计的偏差）

已按本设计实现并通过验证。以下是实现过程中的实际偏差，连同踩到的坑一起记录：

**新增文件**

| 文件 | 作用 |
|---|---|
| `src/engine/protocol.ts` | 消息契约（前后端唯一接口） |
| `src/engine/plan.ts` | 输入绑定 / 指纹 / 求值计划（纯函数，可单测） |
| `src/engine/plan.test.ts` | 17 条单测：绑定兜底、指纹敏感性与稳定性、脏子图、阻断与恢复 |
| `src/engine/client.ts` | 主线程客户端（promise 化的 postMessage） |
| `src/engine/engineWorker.ts` | Worker：加载 Pyodide、装载 Python 模块、分发消息 |
| `src/engine/python/runtime.py` | Python 侧状态 + 求值胶水 + head |
| `src/engine/python/operators.py` | 四个算子 |
| `src/engine/graphRunner.ts` | 订阅变更、防抖、定点循环调度 |
| `src/store/nodeOutputStore.ts` | 节点输出索引（版本 / 状态 / 摘要 / 前 N 行缓存） |
| `src/canvas/ProbePanel.tsx` | 探针显示（按 kind 分支 + 三态） |
| `scripts/sync-pyodide.mjs` | 同步 Pyodide 运行时到 `public/pyodide/`（核心从 node_modules 拷，numpy/pandas 从同版本 CDN 拉，产物 gitignore） |
| `scripts/check-zip-fetch.mjs` | 环境诊断：Node 与浏览器各取一次本地 zip，用来分辨"被本机下载器拦掉"还是"应用出问题" |

**偏差**

1. **`preview.ts` 整个删除**（不是"只保留 `previewRows`"）：反查那套删掉后 `previewRows` 也没有调用方了，留着就是死代码。行数解析直接写在 `ProbePanel` 里。
2. **引擎只支持 `custom.script`**，不是所有 `custom.*`：自定义模型 / 图表 / 指标返回的是网络结构、图配置、指标函数，都不是数据变换，硬塞进数据引擎会让它们连原有的模拟产物一起丢掉。
3. **不计算列统计**（`stats` / `ColumnStatsLite` 从协议里去掉）：没有界面用它，为 1M 行每次求值白算一遍是纯成本。
4. **指纹用字符串而不是 sha1**：见 §7。
5. **新增三个开发依赖**：`pyodide`（运行时资源来源 + 类型）、`tsx` 与 `@types/node`（让 `node --test` 能直接跑 TS 单测）。原计划"不引新依赖"，但 Node 不解析无扩展名的 TS 导入，没有 `tsx` 就跑不了单测。
6. **Pyodide 不经打包器**，而是在 Worker 里从 `/pyodide/` 动态 import（`@vite-ignore`）：它的 asm 胶水依赖 `import.meta.url` 定位同目录的 `.wasm`，被打包器改写路径后容易炸；这样也让运行时资源与代码分离。

**踩到的坑（都已在代码注释里写明原因）**

- 函数节点的形参默认值**不在 `node.params` 里**，只挂在端口的 `paramSpec` 上；而且不能靠 `paramSpec.default` 是否存在判断"有没有默认值" —— `fnParamToSpec` 对没默认值的形参也会填 `''`，判据是端口的 `optional`。写错的话 `def f(x, y)` 里的 `y` 会被悄悄绑成空字符串。
- JS 的 `null` 传进 Python 是 `JsNull` 对象而不是 `None`，`x is not None` 会是真。时间列改成"有时间列才调用 `set_time`"从根上避开。
- `np.frombuffer(jsArray.to_py())` 拿到的是**指向 JS 内存的视图**，而 JS 侧只保留最近一次 `set` 的引用 —— 必须立刻拷一份，否则数据会时对时错。
- 裸 ndarray 没有列名，透传时下游会把**端口名**当列名看到（`head` 而不是 `y`）。透传时按上游端口名补一层 DataFrame。
- 探针的判定顺序必须**先看有没有输出、再看状态**：手动节点跑完后挂着指标，但它的下游在计划里是 `blocked`，反过来会明明有值却显示"跳过"。
- 求值计划里"上游坏 → `blocked`"必须排在"指纹变了 → 重算"之前，否则上游是模拟节点时下游会被丢去求值，报一个含糊的错。
- **手动节点光有 `manual` 类型还不够，必须被显式写进运行状态。** 计划里的 `plan.manual` 一开始只用来把它们算作"坏源"，没人给它们写 `runtime.status`，于是探针读到的是默认的 `idle`，落到兜底文案"等待上游求值…" —— 用户会一直等一个永远不会自动来的结果。现在 runner 每轮都给未跑过的手动节点置 `status: 'manual'`（跑过、挂着模拟产物的保持 `ready`，别把状态打回去），探针据此直说"是模拟实现、点运行才出指标"。这类"状态缺失被兜底文案悄悄掩盖"的错，只有在引擎真跑起来之后才暴露得出来 —— 也正是它让 32/32 变成过 31/32。

**曾经的"环境限制"：根因已查明并解除**

前一版这里记的是"本机 Chromium 对 ZIP 内容的响应被安全组件拦成 `HTTP 204`，引擎起不来"，并把它当成不可控的环境限制，于是 6 条引擎相关的 e2e 用例长期处于 **SKIP**。

**那不是环境玄学，是本机装了一个带内核网络过滤驱动的下载器（IDM，`IDMWFP.sys`，开机自启）。** 它挂在网络层，把浏览器收到的 `application/zip` 响应换成空响应 —— 所以只有 zip 中招，`wasm` / `json` 正常；所以与 Vite、与本项目代码无关；所以换浏览器也不管用。

判据（`scripts/check-zip-fetch.mjs`，同一个本地服务、同一时刻、两种客户端）：

| 客户端 | 卸载前 | 卸载后 |
|---|---|---|
| Node fetch | 200 / 2,545,564 字节 | 200 / 2,545,564 字节 |
| Chromium（e2e 用的那个） | **204 / 0 字节** | 200 / 2,545,564 字节 |

卸载该下载器（停用并删除 `IDMWFP` 驱动服务、去掉开机自启、清掉浏览器集成）后，**同一台机器上 e2e 从"26 通过 / 2 失败 / 6 跳过"变成 32/32 全部真跑通过**，没有任何 SKIP。引擎此前只在 Electron 内嵌浏览器里验证过，现在是浏览器环境的常规回归。

`scripts/e2e.mjs` 的 SKIP 分支**保留**：在别人的机器上（装了什么我们不知道）它仍能把"环境被拦"与"产品缺陷"区分开，而不是把环境问题误报成产品缺陷。但在这台机器上再出现 SKIP，就该先跑一次 `check-zip-fetch.mjs` —— 大概率是下载器被装回来了。

**测试命令**

```bash
npm run sync-pyodide   # 首次或换机器后：同步 Pyodide 运行时（约 17MB，不进 git）
npm test               # 纯逻辑单测
npm run typecheck
npm run e2e            # 含探针与算子回归；本机 35/35 真跑（引擎相关用例不再跳过）
node scripts/check-zip-fetch.mjs   # 引擎起不来时先跑它：分辨"被下载器拦"还是"应用问题"
```

## 16. 第二批：数据变换算子接入引擎（§14 的后续迭代）

五个算子接进执行引擎，从"点运行出模拟产物"变成"接线即算真数"：数据划分 / 信号分帧 /
数据增强 / 时域特征 / 频域特征。

**改了什么**

| 文件 | 改动 |
|---|---|
| `src/engine/python/operators.py` | 五个算子 + 采样点列识别 + 每个算子的参数校验（错就说清哪个参数不对） |
| `src/engine/plan.ts` | `ENGINE_NODES` 白名单扩到这五个；新增 `needsUserFn` |
| `src/engine/graphRunner.ts` | 只有函数节点才去加载用户代码；阻断时把计划算出的原因写进运行时 |
| `src/engine/python/runtime.py` | NaN / ±Inf 出口统一转 `null`；Env 暴露 `time_columns` |
| `src/workflow/nodeRegistry.ts` | 数据增强补 `seed`；频域特征补 `fs` |
| `src/store/useWorkflowStore.ts` | 变换节点的资产按引擎真实规模补登（少了它资产库会凭空少条目） |
| `scripts/verify-operator-truth.mjs` | 独立扫 CSV / 独立 DFT，给出 e2e 断言用的真值 |

**算子口径**（都写在代码注释里，这里只列结论）

| 算子 | 口径 |
|---|---|
| 数据划分 | 带 seed 的置换后切分；比例向下取整，余数全给测试集（三份之和 == 原表行数） |
| 信号分帧 | 行 = 一个样本（一帧 × 一个通道），列 = `点0…点W-1`；另带 时间 / 通道 / 起点 供回溯 |
| 数据增强 | 加噪按**每行自己的 RMS** 定 σ（σ = RMS / 10^(SNR/20)）；缩放 0.8~1.25；平移为样内循环移位 |
| 时域特征 | 均值/标准差(ddof=0)/RMS/峰值/峰峰值/偏度/峭度(原始四阶矩)/峰值因子/波形因子/脉冲因子/裕度因子 |
| 频域特征 | 去直流；FFT / 功率谱 / 包络谱（包络用 FFT 手写 Hilbert，不引 scipy）；重心/均方频率/频率方差/谱偏度/谱峭度/谱熵等 14 项 |

**这轮踩到的坑**（都属于"看着对、其实错"）

1. **分帧的记账列被当成采样点。** 输出里的 `起点` 是数值列，下游按"所有数值列"取样本，
   于是第一帧的均值变成 `(起点0 + 2048 个点) / 2049` —— **67.2559 变成 67.2228**，只差 0.03，
   肉眼几乎看不出来，但这是把一个记账字段混进了信号。现在按列名前缀 `点0…点k-1` 认出真正的采样点。
2. **runner 用"不是列拼表/预览就去加载用户代码"来判**，新接进来的算子全被当成函数节点，
   报"函数代码解析失败：代码为空"。改成 `needsUserFn` 白名单，和 `ENGINE_NODES` 放在一起。
3. **阻断只改状态、不写原因**，界面显示的还是上一次的旧错误（比如"缺少必需输入"），
   与当前真实原因对不上。计划里早就算好了原因，只是被丢掉了。
4. **NaN / ±Inf 直接进了 JSON。** `json.dumps` 会写出裸的 `NaN` —— 那不是合法 JSON，
   浏览器 `JSON.parse` 直接抛错，表现成"探针无缘无故空白"。协议里写着"NaN 给 null"，实现时漏了。
   常值信号上算波形因子、峭度必然走到这条路。
5. **e2e 里改完参数立刻断言**，读到的是旧表：旧表还在，探针立刻就"有数"了。
   包络谱与 FFT 的峰值恰好落在同一根谱线上，只有幅值差 2.6 倍 —— 于是测试"稳定地"读到一个错值。
   改成等 `outputVersion` 真的 +1。

**已知未修（画布布局，另开一刀）**

写这批用例时发现的、**不属于算子**的两个布局问题，都写在 `NodeLibrary.tsx` 的注释里：

1. 点选新增节点的槽位只按世界坐标排，没考虑缩放。视口放大到 1.8 倍时一列四个槽位有三个在屏幕外 ——
   连点几次节点库就会有节点看不见（用户以为没反应，再点一次，两个都找不到）。
2. 列间距 260 是照普通节点（宽 216）定的，而数据预览宽约 380，两个预览节点并排时会横向重叠一百多像素。

试过一版"落点出视野就平移视口 + 放大槽位搜索范围"，结果把 6 条既有交互用例带崩（新增节点时视口平移，
打乱了其它用例对画布位置的前提），已回退。正确做法要按**实测尺寸**排布，属于画布布局的独立改动，
不在这批算子里混着做。

**验证**

| 项 | 结果 |
|---|---|
| 纯逻辑单测 | 18 条（新增"只有函数节点才加载用户代码"这条回归） |
| e2e | **35/35 全部真跑**，新增 3 组用例 |

新增用例的真值不是从引擎抄的：

| 断言 | 独立真值来源 | 实测 |
|---|---|---|
| 分帧帧数 | `floor((1,048,575 − 2048) / 1024) + 1` | 1,022 帧 ✓ |
| 首帧时域统计 | 独立扫 CSV 的前 2048 点 | 均值 67.2559 / RMS 67.3074 / 峭度 2.0763 ✓ |
| 首帧频域特征 | 独立 DFT（fs = 1000 Hz, nfft = 2048） | 峰值 25.87890625 Hz / 幅值 986.10 ✓ |
| 划分规模 | 1,048,575 × 0.7 / 0.15 向下取整 | 734,002 / 157,286 / 157,287（和为原表） ✓ |
| 增强规模 | 3 × 1,048,575 | 3,145,725 行 ✓ |
