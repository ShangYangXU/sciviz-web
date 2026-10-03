/**
 * 补丁动作（ops）—— **人与 agent 共用的那套动作词汇表**。
 *
 * 这是"轮流干活"能成立的核心：只要人拖一根线和 agent 执行一条 `connect` 是同一个动作，
 * 谁做的就不影响产物的一致性；反过来，只要 agent 能改的东西人改不了（或反过来），
 * 这份工程就会慢慢裂成两半。
 *
 * 三条刻意的约束：
 *
 * 1. **有界**。ops 里没有"执行任意代码"这一条。节点内部的 Python 仍然自由（`custom.script`），
 *    但图这一层只能通过这些动作改 —— agent 不能凭空造一个算子出来。
 * 2. **可校验**。每条 op 的失败都带稳定错误码，不懂错误码含义时用 `sciviz explain` 查。
 * 3. **可 diff**。op 是纯数据，一批 op 就是一份能看、能存、能回放的改动单。
 *
 * 动作清单与 `useWorkflowStore` 上那批动作一一对应（见接口文档 §8 的 S1 规则）：
 * 界面上能做的图级操作，都要能写成一条 op。
 */

import type { WorkflowGroupDefinition } from '../workflow/types'

export type ParamValue = string | number | boolean

/**
 * 一条 op 作用在哪一层子图上。
 *
 * 缺省 / 空数组 = 根图。给出一串组块节点 id 时，op 作用在**那个子空间内部**，
 * 与界面上的 `activeGroupPath` 是同一个含义（双击进入子空间后编辑的就是那一层）。
 *
 * 之所以要有它：组块内部节点 id 只在它自己那一层唯一，"把很多子实验放进一个子空间"
 * 之后，根图里根本找不到 `n7` —— 此前所有 op 都只认根图，于是 agent 对子空间
 * **一个动作都做不了**（全被拒成 E_UNKNOWN_REF）。
 */
export type OpPath = string[]

/** 给人看的路径前缀："在子空间「g1」/「g2」里："，根图上是空串 */
export function pathPrefix(path: OpPath | undefined, labelOf?: (id: string) => string | undefined): string {
  if (!path || path.length === 0) return ''
  const text = path.map((id) => `「${labelOf?.(id) ?? id}」`).join('/')
  return `在子空间${text}里：`
}

export interface AddNodeOp {
  op: 'addNode'
  /** 往哪一层子图里加。缺省是根图 */
  path?: OpPath
  /** 不给就自动生成。给了就必须不撞车 */
  id?: string
  type: string
  label?: string
  params?: Record<string, ParamValue>
  /** 不给就放在空白处（按已有节点自动排）。版面是人摆的，agent 尽量别乱动 */
  position?: { x: number; y: number }
  /**
   * 插到这一层的第几个位置（0 开始；缺省追加到末尾）。
   *
   * 只有反向动作用它：撤掉"删了一个块"时，光把块加回来会落到末尾 ——
   * 图等价，但工程文本与删之前不再逐字相同。给个位置就回到原处。
   */
  index?: number
  /**
   * 子空间的内部定义（内部子图 + 边界映射 + 对外参数）。
   *
   * 两种来路：① 新建一个子空间时**可以**省略，内核会补一个空的合法定义（组块节点
   * 没有 `group` 字段就是个坏块）；② 撤销"删掉一个子空间"时由反向动作原样带回 ——
   * 少了它，撤销出来的是一个空壳，里面的实验全没了。
   *
   * 这里只查形状（是不是一份完整的定义）；边界映射自不自洽是 L1 的事（`E_GROUP_INVALID`），
   * 报告，但不否决这次写入。
   */
  group?: WorkflowGroupDefinition
}

export interface RemoveNodeOp {
  op: 'removeNode'
  path?: OpPath
  id: string
}

export interface RenameNodeOp {
  op: 'renameNode'
  path?: OpPath
  id: string
  label: string
}

export interface MoveNodeOp {
  op: 'moveNode'
  path?: OpPath
  id: string
  position: { x: number; y: number }
}

export interface ConnectOp {
  op: 'connect'
  path?: OpPath
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

export interface DisconnectOp {
  op: 'disconnect'
  path?: OpPath
  edgeId: string
}

export interface SetParamOp {
  op: 'setParam'
  path?: OpPath
  id: string
  key: string
  value: ParamValue
}

export interface ResetParamsOp {
  op: 'resetParams'
  path?: OpPath
  id: string
}

/**
 * 把同一层里选中的几个节点封装成一个子空间（组块）。
 *
 * 与界面上的"框选 → 封装"是同一个动作（`createGroupFromSelection`），边界输入/输出
 * 映射、对外参数都由它一处生成。反向动作是 `ungroup`（带 `restoreOrder`，保证撤销后
 * 工程文本一字不差）。
 */
export interface CreateGroupOp {
  op: 'createGroup'
  /** 在**哪一层**里封装。缺省是根图 */
  path?: OpPath
  /** 新组块节点的 id */
  id: string
  label?: string
  /** 要封装进去的节点 id（必须在同一层里存在） */
  nodeIds: string[]
}

/** 解散一个子空间：内部节点与边回到这一层，边界连线接回内部端点 */
export interface UngroupOp {
  op: 'ungroup'
  path?: OpPath
  /** 要解散的组块节点 id */
  id: string
  /**
   * 解散后把这一层的节点重排成这个 id 顺序。
   *
   * 只有 `createGroup` 的反向动作会带它：不重排的话，所选块在原层里不相邻时，
   * 内部节点会被恢复成一整段连续的块，工程文本与封装前就不再逐字相同 ——
   * 图等价，但"撤销后一字不差"这条判据会破。
   */
  restoreOrder?: string[]
}

export interface SetMetaOp {
  op: 'setMeta'
  name?: string
  description?: string
}

/**
 * 数据集视图：启用哪些列、哪一列是时间轴。
 *
 * 这条 op 存在的原因：这些决定是**人在数据面板上做的**，此前只活在浏览器里。
 * 不把它做成动作，agent 就没法接手"人做了一半的图"，人也没法改 agent 做出来的视图。
 */
export interface SetDatasetViewOp {
  op: 'setDatasetView'
  datasetId: string
  /** 给全量：只有这里列出的列是启用的。不给就不动 */
  enabled?: string[]
  timeColumn?: string | null
}

/** 把数据集登记进工程。数据本身不在工程里，这里记的是身份与位置 */
export interface AddDatasetOp {
  op: 'addDataset'
  id: string
  name: string
  /** 相对工程文件的路径。给了的话两边都不用再传 --data */
  path?: string
  contentHash?: string
  rowCount?: number
  sampleRate?: number | null
  timeColumn?: string | null
  /**
   * 列清单。类型写成宽字符串而不是联合类型：op 是从 JSON 读进来的，
   * 判据在 `project.ts` 的解析器里（它会归一化成有限集合），不在这里重复一遍。
   */
  columns?: { name: string; type: string; role: string; enabled: boolean }[]
}

/** 把一份数据集从工程里摘掉。只删记录，不动磁盘上的 CSV */
export interface RemoveDatasetOp {
  op: 'removeDataset'
  id: string
}

export type PatchOp =
  | AddNodeOp
  | RemoveNodeOp
  | RenameNodeOp
  | MoveNodeOp
  | ConnectOp
  | DisconnectOp
  | SetParamOp
  | ResetParamsOp
  | CreateGroupOp
  | UngroupOp
  | SetMetaOp
  | SetDatasetViewOp
  | AddDatasetOp
  | RemoveDatasetOp

export type PatchOpName = PatchOp['op']

export const PATCH_OPS: PatchOpName[] = [
  'addNode',
  'removeNode',
  'renameNode',
  'moveNode',
  'connect',
  'disconnect',
  'setParam',
  'resetParams',
  'createGroup',
  'ungroup',
  'setMeta',
  'setDatasetView',
  'addDataset',
  'removeDataset',
]

/** JSON Schema node for the machine-facing representation of patch actions. */
export interface OpJsonSchema {
  type: string | string[]
  description?: string
  enum?: readonly string[]
  items?: OpJsonSchema
  properties?: Record<string, OpJsonSchema>
  required?: readonly string[]
  additionalProperties?: boolean
}

/**
 * The shared serialized schema for every patch action. The UI agent and MCP wrapper
 * consume this declaration so model-visible field names stay aligned with PatchOp.
 */
export const PATCH_OP_SCHEMA: OpJsonSchema = {
  type: 'object',
  description: '一条图修改动作。一个 PatchFile 的 ops 按数组顺序应用到同一份草稿图；connect 的字段名必须是 source/sourcePort/target/targetPort。',
  properties: {
    op: { type: 'string', enum: PATCH_OPS },
    path: {
      type: ['array', 'string'],
      items: { type: 'string' },
      description: '寻址路径：多数动作是组块节点 id 数组；addDataset 的 path 是相对 CSV 文件路径。',
    },
    id: {
      type: 'string',
      description: '节点 id。addNode 可省略并由内核自动生成；如果同批后续 op 要引用新节点，必须在 addNode 中显式给出当前 path 层唯一 id，并把 addNode 放在引用它的 op 之前。',
    },
    type: { type: 'string', description: 'addNode 的算子类型，使用 catalog 返回的 type。' },
    label: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
    position: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    index: { type: 'number' },
    group: { type: 'object', additionalProperties: true },
    source: { type: 'string', description: 'connect 的源节点 id。' },
    sourcePort: { type: 'string', description: 'connect 的源输出端口 id。' },
    target: { type: 'string', description: 'connect 的目标节点 id。' },
    targetPort: { type: 'string', description: 'connect 的目标输入端口 id。' },
    edgeId: { type: 'string' },
    key: { type: 'string' },
    value: { type: ['string', 'number', 'boolean'] },
    nodeIds: { type: 'array', items: { type: 'string' } },
    restoreOrder: { type: 'array', items: { type: 'string' } },
    name: { type: 'string' },
    description: { type: 'string' },
    datasetId: { type: 'string' },
    enabled: { type: 'array', items: { type: 'string' } },
    timeColumn: { type: ['string', 'null'] },
    contentHash: { type: 'string' },
    rowCount: { type: 'number' },
    sampleRate: { type: ['number', 'null'] },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          role: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['name', 'type', 'role', 'enabled'],
        additionalProperties: false,
      },
    },
  },
  required: ['op'],
  additionalProperties: false,
}

export interface PatchFile {
  /** 给人看的一句话：这批改动是干什么的。review 时先看它 */
  reason?: string
  /** 机器生成的对话/MCP 补丁必须带；CLI 旧 ops 文件可暂时省略。 */
  baseFingerprint?: string
  ops: PatchOp[]
}

/** Machine-facing schema for PatchFile; the guarded chat entry additionally requires a baseline. */
export const PATCH_FILE_SCHEMA: OpJsonSchema = {
  type: 'object',
  description: 'PatchFile：机器调用必须带当前 project.editFingerprint 作为 baseFingerprint。ops 按数组顺序执行；addNode 指定 id 后可在同批后续 op 中引用。',
  properties: {
    baseFingerprint: { type: 'string' },
    reason: { type: 'string' },
    ops: { type: 'array', items: PATCH_OP_SCHEMA },
  },
  required: ['ops'],
  additionalProperties: false,
}

/** 一条 op 的拒绝理由。码要能在错误码表里查到 */
export interface OpRejection {
  /** 在 ops 数组里的下标，从 0 开始。方便定位是哪一条 */
  index: number
  op: string
  code: string
  message: string
  nodeId?: string
  portId?: string
}
