/**
 * 对话栏与 MCP 共用的工具注册表。
 *
 * 这里只声明“能调用什么”和工具级负载，不执行工具；图补丁字段 schema 复用契约层声明。
 * 这样两个壳可以各自注入执行器，却不会各自维护一份会慢慢漂移的清单。
 */

import { PATCH_FILE_SCHEMA, PATCH_OP_SCHEMA, type OpJsonSchema } from '../contract/ops'

export type ToolSurface = 'chat' | 'sidebar' | 'mcp'
export type ToolExecution = 'client' | 'host'
export type ToolEffect = 'read' | 'compute' | 'interaction' | 'graph-write' | 'code-write'
export type ToolRisk = 'none' | 'reversible' | 'destructive' | 'source'

export type JsonSchemaProperty = OpJsonSchema

export interface JsonSchema {
  type: 'object'
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolSpec {
  readonly name: string
  readonly command: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly payloadVersion: 1
  readonly execution: ToolExecution
  readonly effect: ToolEffect
  readonly risk: ToolRisk
  readonly surfaces: readonly ToolSurface[]
}

const emptyInput = (): JsonSchema => ({ type: 'object', additionalProperties: false })
const argsInput = (properties: JsonSchema['properties'], required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

export const TOOLS = [
  {
    name: 'ask_user',
    command: 'ask_user',
    description: '只有在缺少的信息会实质改变结果、且无法从上下文推断时，才暂停向用户提问。选择题提供 2–5 个简短选项，并可标出推荐项；没有有限选项时省略 options，让用户补充文字。用户回复后本轮会自动继续。',
    inputSchema: argsInput({
      question: { type: 'string', description: '简短、具体的问题。' },
      options: { type: 'array', items: { type: 'string' }, description: '选择题提供 2–5 个简短选项；开放式补充时省略。' },
      recommended: { type: 'string', description: '可选；必须与 options 中的一项完全相同，用于标出推荐项。' },
    }, ['question']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'interaction',
    risk: 'none',
    surfaces: ['chat'],
  },
  {
    name: 'task_checkpoint',
    command: 'task_checkpoint',
    description: '管理跨消息的长程任务计划。多阶段修改、实验验证和报告任务先调用 plan；每步开始 / 完成 / 受阻时调用 update，新完成步骤至少引用一条未被其它步骤用过的成功工具结果 callId；按结果追加后续步骤用 replan；finish 默认新建项目报告；修改已有项目报告时必须传入先前 project_report.read 返回的 reportId 与 updatedAt(expectedUpdatedAt)，并先读到 complete=true。省略 evidenceRefs 时自动汇总各步骤引用。callId 只证明工具运行成功，不证明该结果支持因果解释；报告仍须核对同口径对照。简单的一步请求不需要规划。',
    inputSchema: argsInput({
      action: { type: 'string', enum: ['plan', 'update', 'replan', 'finish'], description: 'plan 新建；update 记步骤状态；replan 只追加步骤并保留旧证据；finish 生成带证据的最终报告。' },
      goal: { type: 'string', description: 'plan 的用户目标。' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '本计划内稳定、唯一的短 id。' },
            title: { type: 'string', description: '面向用户的步骤名称。' },
            successCriteria: { type: 'string', description: '可以用工具结果判断的完成条件。' },
          },
          required: ['id', 'title', 'successCriteria'],
          additionalProperties: false,
        },
        description: 'plan 提交完整步骤；replan 提交要追加的新步骤。',
      },
      stepId: { type: 'string', description: 'update 时要更新的步骤 id。' },
      status: { type: 'string', enum: ['pending', 'running', 'blocked', 'completed'], description: 'update 的新状态。' },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: '成功工具结果的 callId；步骤完成必须给出，finish 可省略并自动汇总步骤引用。' },
      note: { type: 'string', description: 'update 的新观察或阻塞原因。' },
      rationale: { type: 'string', description: 'replan 根据哪些新证据调整后续步骤。' },
      summary: { type: 'string', description: 'finish 的简短结论。' },
      report: { type: 'string', description: 'finish 的简短 Markdown 实验报告；按任务需要交代基线、改动、条件、关键结果/比较、结论与实质局限，不盘点或重复介绍当前工程已有状态；只写有证据且与用户目标相关的内容。可使用 report_figure 返回的 Markdown 图片引用。' },
      reportId: { type: 'string', description: '可选：修改已有项目报告时使用 project_report.list/read 找到的原 reportId；不传表示新建。' },
      expectedUpdatedAt: { type: 'string', description: '修改已有项目报告时必须提供 project_report.read 返回的 updatedAt；用于阻止覆盖读完后发生的更改。' },
    }, ['action']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'compute',
    risk: 'none',
    surfaces: ['chat'],
  },
  {
    name: 'new',
    command: 'new',
    description: '从零创建一个带稳定工程身份的 .sciviz 工作区文件。默认不覆盖已有文件。',
    inputSchema: argsInput({ file: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, force: { type: 'boolean' } }, ['file']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'graph-write',
    risk: 'reversible',
    surfaces: ['mcp'],
  },
  {
    name: 'canvas',
    command: 'canvas',
    description: '直接操作当前前台 SciViz 页面中的实时画布。需要 Edge 中有可见的 SciViz 页面且本地宿主在线。支持 status/new/inspect/patch/undo/run/screenshot；patch 使用当前 projectEditFingerprint 并沿用画布写入档位；new/patch/undo/run 默认把页面实际画布截图作为 MCP image 返回。new 会先询问是否创建空白草稿，并解除旧工程文件绑定。不会通过 Edge 调试端口执行任意脚本。',
    inputSchema: argsInput({
      action: { type: 'string', enum: ['status', 'new', 'inspect', 'patch', 'undo', 'run', 'screenshot'], description: 'status 查找前台画布；new 创建空白草稿；inspect 读取实时图；patch/undo 修改；run 执行当前图；screenshot 返回当前画布截图。' },
      name: { type: 'string', description: 'new 的可选工程名。' },
      patch: PATCH_FILE_SCHEMA,
      baseFingerprint: { type: 'string', description: 'patch/undo 的当前画布 editFingerprint；先 inspect 获取。' },
      includeScreenshot: { type: 'boolean', description: 'new/patch/undo/run 是否把实时截图作为 MCP image 返回，默认 true。' },
      host: { type: 'string', description: '本地宿主地址；省略时使用 127.0.0.1:8765。' },
    }, ['action']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'graph-write',
    risk: 'reversible',
    surfaces: ['mcp'],
  },
  {
    name: 'catalog',
    command: 'catalog',
    description: '读取算子、端口、参数与能力清单。',
    inputSchema: emptyInput(),
    payloadVersion: 1,
    execution: 'client',
    effect: 'read',
    risk: 'none',
    surfaces: ['chat', 'sidebar', 'mcp'],
  },
  {
    name: 'validate',
    command: 'validate',
    description: '检查当前工程的结构与连接问题。',
    inputSchema: argsInput({ columns: { type: 'object' } }),
    payloadVersion: 1,
    execution: 'client',
    effect: 'read',
    risk: 'none',
    surfaces: ['chat', 'sidebar', 'mcp'],
  },
  {
    name: 'explain',
    command: 'explain',
    description: '解释一个稳定错误码及其修复动作。',
    inputSchema: argsInput({ code: { type: 'string' } }, ['code']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'read',
    risk: 'none',
    surfaces: ['chat', 'sidebar', 'mcp'],
  },
  {
    name: 'plan',
    command: 'plan',
    description: '生成执行计划或图修改计划，不写入工程。',
    inputSchema: argsInput({ file: { type: 'string' }, data: { type: 'object' }, patch: PATCH_FILE_SCHEMA }),
    payloadVersion: 1,
    execution: 'client',
    effect: 'compute',
    risk: 'none',
    surfaces: ['chat', 'mcp'],
  },
  {
    name: 'patch',
    command: 'patch',
    description:
      '改当前工程：加块 / 删块 / 改名 / 挪位置 / 连线 / 断开 / 改参数（含块里的 code）/ ' +
      '把几个块封装成子空间（createGroup）/ 解散子空间（ungroup）/ 登记数据集。' +
      '每条 op 可以用 path（组块节点 id 的列表）指向某一层子空间，不写就是根图。' +
      'Chat 的规范格式是 patch: { baseFingerprint, ops }，也接受顶层 baseFingerprint + ops；' +
      'ops 按数组顺序在同一份草稿图上应用；若同批新增图块后还要连它或改它，必须先在 addNode 中显式指定该层唯一 id，再在后续 op 中复用，addNode 与 connect 可以原子地放在同一批；' +
      'connect 必须使用 source（源节点 id）、sourcePort（源输出端口 id）、target（目标节点 id）、targetPort（目标输入端口 id）。' +
      '必须带 baseFingerprint，且它要等于本轮上下文里的 project.editFingerprint；' +
      '整图静态校验的问题只如实回报，不阻断这次改动。',
    inputSchema: argsInput({
      file: { type: 'string' },
      ops: { type: 'array', items: PATCH_OP_SCHEMA, description: '兼容的顶层 PatchFile 写法；Chat 调用还需提供顶层 baseFingerprint。' },
      reason: { type: 'string' },
      dryRun: { type: 'boolean', description: '为 true 时只预览补丁，不弹确认、不写回；Chat 建议优先使用 plan 工具预演。' },
      patch: PATCH_FILE_SCHEMA,
      baseFingerprint: { type: 'string', description: 'MCP 的 patch 必填；先通过 inspect 获取当前 editFingerprint，过期或缺失时补丁会被拒绝。' },
    }),
    payloadVersion: 1,
    execution: 'client',
    effect: 'graph-write',
    risk: 'reversible',
    surfaces: ['chat', 'mcp'],
  },
  {
    name: 'undo',
    command: 'patch --undo',
    description: '撤销最近一次有记录的图改动（用文件里记的反向动作），要带当前 editFingerprint。',
    inputSchema: argsInput({ file: { type: 'string' }, patchId: { type: 'string' }, baseFingerprint: { type: 'string' }}),
    payloadVersion: 1,
    execution: 'client',
    effect: 'graph-write',
    risk: 'reversible',
    surfaces: ['chat', 'mcp'],
  },
  {
    name: 'run',
    command: 'run',
    description: '使用当前 Runtime 执行工程；MCP 可选择捕获本次运行的图表图像供模型查看或写入项目报告。标准图表捕获需要本机可用 Chromium。',
    inputSchema: argsInput({ file: { type: 'string' }, data: { type: 'object' }, out: { type: 'string' }, host: { type: 'string' }, includeFigures: { type: 'boolean', description: '仅 MCP：捕获本次运行生成的 PNG，并作为图像内容返回；标准图表需要 Chromium。' }}),
    payloadVersion: 1,
    execution: 'client',
    effect: 'compute',
    risk: 'none',
    surfaces: ['chat', 'mcp'],
  },
  {
    name: 'inspect',
    command: 'inspect',
    description:
      '不传 nodeId 时分页查看工程全部节点、连线与运行状态，按 nextOffset 续读到 complete=true；传 nodeId 时返回该块的参数、所在层级与所有输出端口摘要（列名、行数、统计量、血缘；补丁的 path 用它）。MCP 从 file 指向的已保存工程读取，输出摘要来自匹配的最近运行；Chat 从当前画布读取。' +
      '显式带 rows 才读取表格行值，用 rowOffset 续读到 rowsComplete=true；带 code=true 且不传 nodeId 可分页列出整张图所有代码块，按 nextOffset 继续直到 codeIndexComplete=true；' +
      '指定 nodeId + groupPath + code=true 后每次取最多 8000 字符，必须用返回的 nextCodeOffset 续读到 codeComplete=true。codeLimit 是兼容旧调用方的字段，小值不会缩小页面。Chat 遵守工程代码/行值授权；MCP 由调用方显式发起代码或行值读取。修改代码前必须取得完整原文。',
    inputSchema: argsInput({ file: { type: 'string' }, node: { type: 'string' }, nodeId: { type: 'string' }, groupPath: { type: 'array', items: { type: 'string' } }, port: { type: 'string' }, portId: { type: 'string' }, rows: { type: 'number' }, rowOffset: { type: 'number', description: '表格输出从零开始的行偏移；需同时传 rows，每页最多 100 行。' }, code: { type: 'boolean' }, codeOffset: { type: 'number', description: '代码正文从零开始的字符偏移；使用上次返回的 nextCodeOffset。' }, codeLimit: { type: 'number', description: '兼容旧请求；页面固定按最多 8000 字符返回，避免过小页面。' }, offset: { type: 'number', description: '整图或代码目录的下一页偏移；使用上次返回的 nextOffset。' }, limit: { type: 'number', description: '整图每页 10–25 个节点，代码目录每页 25–50 项。' }, from: { type: 'string' }, data: { type: 'object' }, host: { type: 'string' }}),
    payloadVersion: 1,
    execution: 'client',
    effect: 'read',
    risk: 'none',
    surfaces: ['chat', 'sidebar', 'mcp'],
  },
  {
    name: 'report_figure',
    command: 'report_figure',
    description: '将一个图表块当前参数下最新运行的图像保存为当前长程任务的项目报告附件。图像像素留在本机，不发送给模型；返回来源、SHA-256 和可放入报告的 Markdown 图片引用。需要活动的 task_checkpoint 计划。',
    inputSchema: argsInput({
      nodeId: { type: 'string', description: '图表节点 id。' },
      groupPath: { type: 'array', items: { type: 'string' }, description: '节点位于子空间时的组块 id 路径。' },
      caption: { type: 'string', description: '报告里的图片说明，留空时使用画布块名。' },
    }, ['nodeId']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'compute',
    risk: 'none',
    surfaces: ['chat'],
  },
  {
    name: 'project_report',
    command: 'project_report',
    description: '管理当前 .sciviz 工程里的项目报告。list 查看报告身份；read 按字符偏移分页，必须续读到 complete=true；update 只修改已有报告，必须使用 read 得到的 reportId 与 updatedAt(expectedUpdatedAt)，并保留未改动的图像引用。此工具没有新建或删除动作：新报告走 task_checkpoint.finish。工程报告与工作区里的 .md 文件是两种目标。',
    inputSchema: argsInput({
      action: { type: 'string', enum: ['list', 'read', 'update'], description: 'list 列出工程报告；read 分页取全文；update 原位修订已有报告。' },
      reportId: { type: 'string', description: 'read/update 的已有报告 id。' },
      offset: { type: 'number', description: 'read 的正文字符偏移；续读时使用上次返回的 nextOffset。' },
      limit: { type: 'number', description: 'read 每页字符数，默认 10000，最多 12000。' },
      expectedUpdatedAt: { type: 'string', description: 'update 必填：read 返回的版本基线。' },
      title: { type: 'string', description: 'update 时可选的新标题；省略则保留原标题。' },
      markdown: { type: 'string', description: 'update 必填：修订后的完整 Markdown。未改动的原报告图像应保留 read 返回的 report-figure 引用。' },
    }, ['action']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'compute',
    risk: 'reversible',
    surfaces: ['chat'],
  },
  {
    name: 'inspect_figure',
    command: 'inspect_figure',
    description: '读取图表图像。Chat 从当前画布取最新结果；MCP 从已捕获的最近一次运行清单取图（运行时用 includeFigures=true 捕获；可传 from=latest 或 run.json 路径），成功后以 PNG 图像内容返回。',
    inputSchema: argsInput({ nodeId: { type: 'string' }, groupPath: { type: 'array', items: { type: 'string' } }, file: { type: 'string', description: 'MCP：工程文件路径。' }, from: { type: 'string', description: 'MCP：运行清单路径，或 latest。' }, portId: { type: 'string', description: 'MCP：图像输出端口；节点有多个图像输出时必填。' } }, ['nodeId']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'read',
    risk: 'none',
    surfaces: ['chat', 'mcp'],
  },
  {
    name: 'doctor',
    command: 'doctor',
    description: '检查宿主、provider、状态目录与能力。',
    inputSchema: argsInput({ host: { type: 'string' }}),
    payloadVersion: 1,
    execution: 'host',
    effect: 'read',
    risk: 'none',
    surfaces: ['chat', 'mcp'],
  },
  {
    name: 'verify',
    command: 'verify',
    description: '运行注册式真值夹具并返回可追溯证据。',
    inputSchema: argsInput({ fixtureId: { type: 'string' }, host: { type: 'string' }}),
    payloadVersion: 1,
    execution: 'host',
    effect: 'compute',
    risk: 'none',
    surfaces: ['chat', 'mcp'],
  },
  {
    name: 'read',
    command: 'code --action read',
    description: '分段读取整个工作区内的安全文本文件。必须提供 path；可用 startLine / endLine 指定行范围，最多返回 500 行。若 complete 为 false，使用 nextStartLine 继续读取。此工具只读，不执行代码。',
    inputSchema: argsInput({
      path: { type: 'string', description: '工作区内的相对文件路径。' },
      startLine: { type: 'number', description: '从 1 开始的起始行，默认 1。' },
      endLine: { type: 'number', description: '可选的结束行，包含该行；单页最多 500 行。' },
    }, ['path']),
    payloadVersion: 1,
    execution: 'host',
    effect: 'read',
    risk: 'none',
    surfaces: ['chat', 'sidebar', 'mcp'],
  },
  {
    name: 'report',
    command: 'report',
    description: '管理 .sciviz 工程内的 Markdown 项目报告：列出、分页读取、保存或删除。写操作须带 list/read 返回的工程 SHA-256；保存可引用本 MCP 会话中先前 run(includeFigures=true) 或 inspect_figure 捕获的图像，图片会连同来源信息内嵌到报告。',
    inputSchema: argsInput({
      file: { type: 'string', description: '.sciviz 工程文件路径。' },
      action: { type: 'string', enum: ['list', 'read', 'save', 'delete'] },
      reportId: { type: 'string', description: '读取、更新或删除时的报告 id；save 不传则新建。' },
      expectedSha256: { type: 'string', description: '写操作的工程 SHA-256 基线，用于避免覆盖他人刚写入的更改。' },
      title: { type: 'string', description: 'save 时的报告标题。' },
      markdown: { type: 'string', description: 'save 时的 Markdown 正文。' },
      figures: { type: 'array', items: { type: 'object', properties: { sha256: { type: 'string' }, caption: { type: 'string' } }, required: ['sha256'], additionalProperties: false }, description: 'save 时要内嵌的图像引用，sha256 必须来自本会话先前 run 或 inspect_figure 的结果。' },
      offset: { type: 'number', description: 'read 的正文字符偏移；使用上次返回的 nextOffset 续读。' },
      limit: { type: 'number', description: 'read 每页字符数，默认 12000，最多 24000。' },
    }, ['file', 'action']),
    payloadVersion: 1,
    execution: 'client',
    effect: 'graph-write',
    risk: 'reversible',
    surfaces: ['mcp'],
  },
  {
    name: 'sciviz_code',
    command: 'code',
    description: '在整个仓库的安全文本文件（包括 CSV/TSV）中列出、搜索、分段读取；运行固定检查项 web-test、web-typecheck、web-build、agent-blind、browser-e2e、operator-truth、shared-operator-deps、host-unittest；规划和应用文本或源码补丁。修改已有 Markdown 必须在原路径上更新；纯 `.md` 计划按文档写判定，源码和混合计划按源码写判定。',
    inputSchema: argsInput({
      action: { type: 'string', enum: ['list', 'search', 'read', 'check', 'plan', 'apply', 'undo'] },
      path: { type: 'string' },
      glob: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
      caseSensitive: { type: 'boolean' },
      checks: { type: 'array', items: { type: 'string', enum: ['web-test', 'web-typecheck', 'web-build', 'agent-blind', 'browser-e2e', 'operator-truth', 'shared-operator-deps', 'host-unittest'] } },
      startLine: { type: 'number' },
      endLine: { type: 'number' },
      operations: { type: 'array' },
      plan: { type: 'object' },
      approvalToken: { type: 'string' },
      planId: { type: 'string' },
    }, ['action']),
    payloadVersion: 1,
    execution: 'host',
    effect: 'code-write',
    risk: 'source',
    surfaces: ['chat'],
  },
] as const satisfies readonly ToolSpec[]

export type ToolName = (typeof TOOLS)[number]['name']

export function toolsForSurface(surface: ToolSurface): readonly ToolSpec[] {
  return TOOLS.filter((tool) => (tool.surfaces as readonly ToolSurface[]).includes(surface))
}

export function toolSpecOf(name: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

export function toolNamesForSurface(surface: ToolSurface): ToolName[] {
  return toolsForSurface(surface).map((tool) => tool.name as ToolName)
}

export function modelToolsForSurface(surface: ToolSurface, names?: readonly string[]): unknown[] {
  return toolsForSurface(surface)
    .filter((tool) => !names || names.includes(tool.name))
    .map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
}
