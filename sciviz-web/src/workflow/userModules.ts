/**
 * 自建模块：用户自己命名、自己分类的一个 Python 函数。
 *
 * 它与内置节点共用同一个 `NodeTypeDef` 结构，端口一律由代码签名解析 ——
 * 这正是「模块定义」不需要第二份端口声明的理由：代码是唯一真相，
 * 不会出现"面板上声明了 A、代码里写的是 B"这种必然对不上的状态。
 *
 * 本文件刻意保持纯逻辑（不碰 React、不碰 DOM、不碰存储），
 * 这样 type 生成与草稿校验能被 `node --test` 直接跑。
 */

import { parseSignature } from './functionSignature'
import { categoryMeta, type NodeCategory, type NodeTypeDef } from './types'

/** 自建模块的 type 前缀。引擎与端口解析都靠它认人，不能改 */
export const USER_MODULE_PREFIX = 'custom.user.'

/** 初学者的起手代码：签名里放一个必接输入，返回一个同名输出 */
export const DEFAULT_MODULE_CODE =
  'def run(data, scale=1.0):\n' +
  '    """形参自动变成输入端口，return 的 key 变成输出端口。"""\n' +
  '    return {"out": data}\n'

export interface UserModuleDraft {
  label: string
  category: NodeCategory
  description: string
  code: string
}

/** 该 type 是不是自建模块 */
export function isUserModuleType(type: string): boolean {
  return type.startsWith(USER_MODULE_PREFIX)
}

export function isNodeCategory(v: unknown): v is NodeCategory {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(categoryMeta, v)
}

/** djb2。只用来生成短后缀，不承担任何身份/校验职责 */
function shortHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36).slice(-4).padStart(4, '0')
}

/**
 * 由名称推一个可读的 slug。
 *
 * 中文名推不出拼音（不引第三方库），所以这种情况一律退到 `mod` ——
 * 与其用一串编码去猜，不如承认它只是给人看的一个前缀，真正的唯一性由短哈希兜底。
 */
function slugOf(label: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return ascii.length >= 2 ? ascii.slice(0, 20) : 'mod'
}

/**
 * 生成一个新模块的 type。
 *
 * 生成之后**不再随名称变化**：画布上的节点、YAML、常用栏记的都是它，
 * 改个名字就把它们全部作废是不可接受的。
 */
export function moduleTypeId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const slug = slugOf(label)
  // 加时间戳再哈希：同一名称定义两次也要拿到不同的 type，否则第二次会覆盖第一次
  const base = shortHash(`${label}|${Date.now()}|${used.size}`)
  for (let i = 0; i < 64; i++) {
    const suffix = i === 0 ? base : `${base}${i}`
    const candidate = `${USER_MODULE_PREFIX}${slug}_${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `${USER_MODULE_PREFIX}${slug}_${base}${used.size}`
}

export interface DraftCheck {
  error?: string
}

/**
 * 草稿校验。返回的是给人看的中文原因，不抛异常 ——
 * 弹窗要把它显示在表单上，而不是让整个界面崩掉。
 */
export function checkUserModuleDraft(draft: UserModuleDraft): DraftCheck {
  const label = draft.label.trim()
  if (!label) return { error: '模块名称不能为空' }
  if (label.length > 40) return { error: '模块名称请控制在 40 个字以内' }
  if (!isNodeCategory(draft.category)) return { error: `未知的分类「${String(draft.category)}」` }
  if (draft.description.length > 200) return { error: '说明请控制在 200 个字以内' }
  if (!draft.code.trim()) return { error: '函数代码不能为空' }

  const sig = parseSignature(draft.code)
  if (sig.error) return { error: `函数代码解析失败：${sig.error}` }
  return {}
}

/** 草稿 → 节点定义。端口留空，交给 resolvePorts 按签名解析 */
export function buildUserModule(draft: UserModuleDraft, type: string): NodeTypeDef {
  const label = draft.label.trim()
  return {
    type,
    // 自建模块的代码每次保存都可能不一样，所以版本号对它意义有限；
    // 真正的判据是代码本身（它进 params，因此进指纹）
    version: '0.1.0',
    /*
     * 自建模块的依赖要求**声明不了**：代码是用户写的，只有代码自己知道它 import 什么。
     * 所以这里写 null（= 边界之内），溢出的代价由运行时兜底：用户若 import 了 torch，
     * 报错必须直接说"启动本地宿主后重试"（待办 T14），而不是一段 traceback。
     */
    requires: null,
    // 自建模块就是用户写的函数，走真引擎（与 custom.script 同一条路）
    runtimeClass: 'engine',
    // 用户代码，不替它承诺可复现（与 custom.script 同一条规矩）
    determinism: 'stochastic',
    execClass: 'interactive',
    label,
    category: draft.category,
    description: draft.description.trim() || '自建模块（形参即输入端口）',
    // 空数组不是遗漏：函数类节点的端口来自代码签名，写死在这里反而会和代码打架
    inputs: [],
    outputs: [],
    params: [
      {
        key: 'code',
        label: '函数代码',
        type: 'code',
        default: draft.code,
        hint: '形参自动成为输入端口，return 的 key 成为输出端口。改代码即改接口',
      },
    ],
    assetRecipes: [{ kind: 'dataset', nameTemplate: label }],
  }
}

/** 从草稿里读出端口，供弹窗做实时预览 */
export function previewPorts(code: string): {
  inputs: { name: string; optional: boolean }[]
  outputs: string[]
  error?: string
} {
  const sig = parseSignature(code)
  if (sig.error) return { inputs: [], outputs: [], error: sig.error }
  return {
    inputs: sig.params.map((p) => ({ name: p.name, optional: p.hasDefault })),
    outputs: sig.outputs.map((o) => o.name),
  }
}

/** 从存下来的 params **数组**里取 code 参数 —— 这里容易想当然地按对象取，那就永远读不回来 */
function storedCode(params: unknown): string | null {
  if (!Array.isArray(params)) return null
  for (const p of params) {
    if (!p || typeof p !== 'object') continue
    const spec = p as Record<string, unknown>
    if (spec.key === 'code' && typeof spec.default === 'string') return spec.default
  }
  return null
}

/**
 * 从本地存储读回来的东西一律不可信：结构不对就丢掉这一条，而不是让整份清单作废。
 * 用户的自建模块是他自己写的东西，能救一条是一条。
 */
export function sanitizeStoredModules(raw: unknown): NodeTypeDef[] {
  if (!Array.isArray(raw)) return []
  const out: NodeTypeDef[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const type = typeof o.type === 'string' ? o.type : ''
    const label = typeof o.label === 'string' ? o.label : ''
    const code = storedCode(o.params)
    if (!isUserModuleType(type) || !label || !code || !code.trim()) continue
    if (seen.has(type)) continue
    seen.add(type)
    out.push(
      buildUserModule(
        {
          label,
          category: isNodeCategory(o.category) ? o.category : 'custom',
          description: typeof o.description === 'string' ? o.description : '',
          code,
        },
        type,
      ),
    )
  }
  return out
}
