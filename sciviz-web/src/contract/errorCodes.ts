/**
 * 错误码表 —— 契约规格 §8 的唯一代码实现。
 *
 * 为什么要单独成文件：这份表有三个消费者（界面、CLI、agent），而在此之前它只以
 * Markdown 表格的形式存在于 `docs/数据契约规格.md` 里。文档写得再准，代码也不可能
 * 从表格里读出"这个码该怎么修"——于是每个消费者都会各自编一套说辞。
 *
 * 所以这里是**同一份数据的两种呈现**：文档给人看，本文件给程序看。
 * 改一处必须改另一处，`errorCodes.test.ts` 会盯住这条。
 *
 * 与契约规格的对应关系：
 * - L1 静态：连线时 / 加载工程时阻断
 * - L2 抽样：首次求值后告警
 * - L3 运行清单：每次 Run 结束记录
 */

/** 校验级别，对应契约规格 §7 的三级校验 */
export type CheckLevel = 'L1' | 'L2' | 'L3'

/**
 * 严重度。
 *
 * 错误码统一用 `E_` / `W_` 前缀，但前缀只是给人读的冗余信息 ——
 * 判据一律取这个字段，别让调用方靠字符串前缀猜。
 */
export type Severity = 'error' | 'warning'

export interface ErrorCodeDef {
  code: string
  severity: Severity
  level: CheckLevel
  /** 什么情况下触发。写给"判断这个码对不对"的人 */
  trigger: string
  /** 建议动作。写给"看到这个码之后做什么"的人 */
  action: string
  /**
   * 能修掉它的有界动作（补丁 op 名）。
   *
   * 这一项是 agent 面的关键：有了它，"出错 → 查码 → 改图"是一条不需要人介入的闭环，
   * 而不是让 agent 自己猜该动哪一步。空数组表示"改图改不好，要改环境或数据"。
   */
  fixes: string[]
}

/**
 * 错误码全集。
 *
 * 前 13 条来自契约规格 §8 原表；带 `G0` 标记的若干条是 G0 实现静态校验器时新增的
 * ——文件与图的结构性问题同样需要稳定的码，否则校验器只能吐散文。
 */
export const ERROR_CODES: ErrorCodeDef[] = [
  /* ---------------- 契约规格 §8 原表 ---------------- */
  {
    code: 'E_TYPE_MISMATCH',
    severity: 'error',
    level: 'L1',
    trigger: '端口 kind 不兼容',
    action: '换端口或插入适配算子',
    fixes: ['disconnect', 'connect', 'addNode'],
  },
  {
    code: 'E_RANK_MISMATCH',
    severity: 'error',
    level: 'L1',
    trigger: '张量轴数不同',
    action: '检查是否需要 reshape 算子',
    fixes: ['addNode', 'connect'],
  },
  {
    code: 'E_AXIS_ROLE_MISMATCH',
    severity: 'error',
    level: 'L1',
    trigger: '轴语义不同（如 (s,c,t) 接 (s,t,c)）',
    action: '插入转置并确认语义',
    fixes: ['addNode', 'connect'],
  },
  {
    code: 'E_DTYPE_DOWNCAST',
    severity: 'error',
    level: 'L1',
    trigger: '需要降低精度',
    action: '显式 cast',
    fixes: ['addNode'],
  },
  {
    code: 'E_UNIT_MISMATCH',
    severity: 'error',
    level: 'L1',
    trigger: '量纲不同',
    action: '插入单位换算算子',
    fixes: ['addNode', 'connect'],
  },
  {
    code: 'E_SPLIT_LEAK',
    severity: 'error',
    level: 'L1',
    trigger: '拟合类输入非 train',
    action: '把拟合移到训练分支',
    fixes: ['disconnect', 'connect'],
  },
  {
    code: 'E_UNSEEDED_STOCHASTIC',
    severity: 'error',
    level: 'L1',
    trigger: '随机算子缺 seed',
    action: '补种子',
    fixes: ['setParam'],
  },
  {
    code: 'E_MISSING_INPUT',
    severity: 'error',
    level: 'L1',
    trigger: '必需输入未接线且没有字面量',
    action: '接线，或给该参数填一个字面量',
    fixes: ['connect', 'setParam'],
  },
  {
    code: 'E_OPERATOR_VERSION_CHANGED',
    severity: 'error',
    level: 'L1',
    trigger: '工程记录的算子版本 ≠ 当前',
    action: '显式迁移或锁定旧版本',
    fixes: [],
  },
  {
    code: 'E_SHAPE_DRIFT',
    severity: 'warning',
    level: 'L2',
    trigger: '实际形状与声明不符',
    action: '检查上游或更新声明',
    fixes: [],
  },
  {
    code: 'E_DTYPE_DRIFT',
    severity: 'warning',
    level: 'L2',
    trigger: '实际 dtype 与声明不符',
    action: '检查上游或更新声明',
    fixes: [],
  },
  {
    code: 'E_UNIT_DRIFT',
    severity: 'warning',
    level: 'L2',
    trigger: '实际单位与声明不符',
    action: '检查上游或更新声明',
    fixes: [],
  },
  {
    code: 'E_EXECUTION_FAILED',
    severity: 'error',
    level: 'L3',
    trigger: '运行期异常（含 traceback）',
    action: '查看 traceback',
    fixes: ['setParam'],
  },
  {
    code: 'E_PATCH_BASE_MISMATCH',
    severity: 'error',
    level: 'L1',
    trigger: '机器生成的图补丁基线与当前 editFingerprint 不同，或未提供基线',
    action: '重新读取当前工程、重新 plan 与 dry-run，不要套用旧 op',
    fixes: [],
  },

  /* ---------------- G0：文件与图的结构性校验 ---------------- */
  {
    code: 'E_YAML_INVALID',
    severity: 'error',
    level: 'L1',
    trigger: 'G0 · 文件不是合法 YAML，或缺少 nodes 等必需结构',
    action: '修 YAML 语法或补齐必需字段',
    fixes: [],
  },
  {
    code: 'E_UNKNOWN_OPERATOR',
    severity: 'error',
    level: 'L1',
    trigger: 'G0 · 节点类型不在算子清单里（含拼写错误、自建模块缺失）',
    action: '用 catalog 查可用算子；自建模块需先在界面里导入',
    fixes: ['addNode', 'removeNode'],
  },
  {
    code: 'E_DUPLICATE_NODE_ID',
    severity: 'error',
    level: 'L1',
    trigger: 'G0 · 两个节点用了同一个 id',
    action: '给其中一个换 id；连线也要跟着改',
    fixes: ['removeNode', 'addNode'],
  },
  {
    code: 'E_DANGLING_EDGE',
    severity: 'error',
    level: 'L1',
    trigger: 'G0 · 连线引用了不存在的节点',
    action: '删掉这条连线，或把节点补回来',
    fixes: ['disconnect'],
  },
  {
    code: 'E_UNKNOWN_PORT',
    severity: 'error',
    level: 'L1',
    trigger: 'G0 · 连线引用了该节点上不存在的端口',
    action: '按 catalog 里的端口清单重接',
    fixes: ['disconnect', 'connect'],
  },
  {
    code: 'E_CYCLE',
    severity: 'error',
    level: 'L1',
    trigger: 'G0 · 图里有环；求值顺序不存在',
    action: '断开环上的一条连线',
    fixes: ['disconnect'],
  },
  {
    code: 'E_PARAM_INVALID',
    severity: 'error',
    level: 'L1',
    trigger: 'G0 · 参数不是声明过的键、类型不符、或超出 min/max 与选项范围',
    action: '按 catalog 里的参数 spec 改值',
    fixes: ['setParam', 'resetParams'],
  },
  {
    code: 'W_DATASET_UNRESOLVED',
    severity: 'warning',
    level: 'L1',
    trigger: 'G0 · 动态端口上下文暂不可得（如函数签名未完成、拆列节点尚未得到上游列名）',
    action: '补全函数签名或拆列列名，必要时先运行上游；CLI --columns 只声明数据集列视图。此时不判连线错误',
    fixes: [],
  },
  {
    code: 'W_IMPORT',
    severity: 'warning',
    level: 'L1',
    trigger: 'G0 · 导入时的非阻断提示（数据集重新绑定、暂时接不上的连线等）',
    action: '读提示内容；不影响继续校验',
    fixes: [],
  },

  /* ---------------- G2：补丁动作的错误码 ---------------- */
  {
    code: 'E_UNKNOWN_REF',
    severity: 'error',
    level: 'L1',
    trigger: 'G2 · 补丁里的 id 在本工程里不存在（节点 / 连线 / 数据集）',
    action: '用正确的 id；或者先用 addNode / addDataset 把它建出来',
    fixes: ['addNode', 'addDataset'],
  },
  {
    code: 'E_PORT_OCCUPIED',
    severity: 'error',
    level: 'L1',
    trigger:
      'G2 · 要连的输入端口已经被别的连线占用。声明 `multiple: true` 的多入端口不算占用（契约规格 R13）',
    action: '先 disconnect 那条旧连线，再 connect —— 不自动替换，替换会静默丢掉别人接的线',
    fixes: ['disconnect', 'connect'],
  },
  {
    code: 'E_GROUP_INVALID',
    severity: 'error',
    level: 'L1',
    trigger: '组块的端口或参数绑定引用了不存在的内部节点/端口，或映射与内部契约不兼容',
    action: '双击组块检查内部逻辑与边界映射；必要时解散后重新组合',
    fixes: ['removeNode', 'addNode', 'connect'],
  },

  /* ---------------- C2–C4：对话、并发与源码闸门 ---------------- */
  {
    code: 'E_PROJECT_FILE_CHANGED',
    severity: 'error',
    level: 'L1',
    trigger: '计划之后磁盘工程被其他窗口或进程修改',
    action: '重新读取工程、重新装配上下文并重新 dry-run；不要套用旧计划',
    fixes: [],
  },
  {
    code: 'E_TOOL_LIMIT_EXCEEDED',
    severity: 'error',
    level: 'L3',
    trigger: '单轮模型往返或工具调用超过上限',
    action: '使用已取得的证据总结，或开启新一轮对话',
    fixes: [],
  },
  {
    code: 'E_TOOL_TIMEOUT',
    severity: 'error',
    level: 'L3',
    trigger: '工具、provider 或固定闸门超过规定时限',
    action: '查看进度与错误证据；不要用新 callId 自动重试写动作',
    fixes: [],
  },
  {
    code: 'E_TOOL_PAYLOAD_VERSION',
    severity: 'error',
    level: 'L1',
    trigger: '消费者不支持工具、上下文或会话负载版本',
    action: '升级兼容的客户端；不得猜测字段继续执行',
    fixes: [],
  },
  {
    code: 'W_CHAT_ABORTED',
    severity: 'warning',
    level: 'L3',
    trigger: '用户停止了本轮对话或工具循环',
    action: '查看停止前已提交的写入，并用带基线校验的撤销入口处理',
    fixes: [],
  },
  {
    code: 'E_CHAT_CONFIG_MISSING',
    severity: 'error',
    level: 'L1',
    trigger: 'provider、密钥、base URL 或模型配置不完整',
    action: '按 doctor 给出的步骤配置宿主；未配置时只允许查看已有会话',
    fixes: [],
  },
  {
    code: 'E_CHAT_PROVIDER_FAILED',
    severity: 'error',
    level: 'L3',
    trigger: 'provider 鉴权、限流、协议或网络请求失败',
    action: '检查 provider 返回的脱敏错误与模型配置；不要盲目换 provider',
    fixes: [],
  },
  {
    code: 'E_AGENT_NO_ACTION',
    severity: 'error',
    level: 'L3',
    trigger: '明确要求工程动作，但一次强制工具续接后仍没有收到结构化工具调用',
    action: '本轮没有执行工程工具；检查所选模型的工具调用能力后重试',
    fixes: [],
  },
  {
    code: 'E_CHAT_CONTEXT_TOO_LARGE',
    severity: 'error',
    level: 'L1',
    trigger: '必保上下文仍超过单轮预算',
    action: '缩小引用、证据或显式行值范围后重新发送',
    fixes: [],
  },
  {
    code: 'E_CHAT_SESSION_IO',
    severity: 'error',
    level: 'L3',
    trigger: '会话审计无法在外发前可靠写入状态目录',
    action: '修复状态目录权限或磁盘空间；审计恢复前阻止外发',
    fixes: [],
  },
  {
    code: 'E_CODE_PATH_OUTSIDE',
    severity: 'error',
    level: 'L1',
    trigger: '源码动作目标越过允许的项目路径围栏、符号链接或文件类型限制',
    action: '只选择源码、测试、脚本、文档或依赖清单中的相对路径',
    fixes: [],
  },
  {
    code: 'E_CODE_BASE_MISMATCH',
    severity: 'error',
    level: 'L1',
    trigger: '源码文件摘要不符，或回滚前发现第三方修改',
    action: '重新 read/plan；不得覆盖第三方改动',
    fixes: [],
  },
  {
    code: 'E_CODE_GATE_FAILED',
    severity: 'error',
    level: 'L3',
    trigger: '源码固定验证闸门失败',
    action: '查看闸门输出；确认失败后已回滚，再单独修复并重新 plan',
    fixes: [],
  },
]

const BY_CODE = new Map(ERROR_CODES.map((d) => [d.code, d]))

/** 按码查定义。查不到返回 undefined —— 调用方必须自己决定怎么处置未知码 */
export function getErrorCode(code: string): ErrorCodeDef | undefined {
  return BY_CODE.get(code)
}

export function allErrorCodes(): ErrorCodeDef[] {
  return ERROR_CODES.map((d) => ({ ...d }))
}

/**
 * 一个码的"怎么修"。
 *
 * `explain` 与界面上的错误提示都走这里，避免两处各写一套建议。
 */
export function explainCode(
  code: string,
  ctx: { nodeId?: string; portId?: string; detail?: string } = {},
): string {
  const def = getErrorCode(code)
  if (!def) return `未知错误码「${code}」。用 \`sciviz explain --list\` 看全部可用码。`
  const where = [ctx.nodeId ? `节点 ${ctx.nodeId}` : '', ctx.portId ? `端口 ${ctx.portId}` : '']
    .filter(Boolean)
    .join(' · ')
  const lines = [
    `${code}（${def.level} · ${def.severity === 'error' ? '阻断' : '告警'}）${where ? ` — ${where}` : ''}`,
    `触发：${def.trigger}`,
    `动作：${def.action}`,
  ]
  if (def.fixes.length > 0) lines.push(`可用动作：${def.fixes.join(' / ')}`)
  if (ctx.detail) lines.push(`本次上下文：${ctx.detail}`)
  return lines.join('\n')
}
