import type { ParamSpec } from './types'
import { parseSignature, type FnParamSpec } from './functionSignature'

/**
 * 自定义模型代码里的模型超参数声明。
 *
 * 这里不执行 Python。模型代码可以包含任意 import 和类定义，画布只读取一个
 * 安全的 Python 字面量 `MODEL_PARAMS = {...}`，这样用户输入代码时就能即时看到
 * 参数控件，也不会为了渲染右栏而在浏览器里执行用户代码。
 */
export interface ModelParamParseResult {
  specs: ParamSpec[]
  /** MODEL_PARAMS 存在但不是支持的字面量时给用户提示 */
  error?: string
  /** 区分"没有声明"和"明确声明了空字典" */
  declared?: boolean
}

type Scalar = string | number | boolean | null

export class PythonLiteralParser {
  private index = 0

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skipSpace()
    const value = this.value()
    this.skipSpace()
    if (this.index !== this.text.length) throw new Error('MODEL_PARAMS 后面还有无法识别的内容')
    return value
  }

  private skipSpace(): void {
    while (this.index < this.text.length) {
      const ch = this.text[this.index]
      if (/\s/.test(ch)) {
        this.index++
        continue
      }
      if (ch === '#') {
        while (this.index < this.text.length && this.text[this.index] !== '\n') this.index++
        continue
      }
      break
    }
  }

  private value(): unknown {
    this.skipSpace()
    const ch = this.text[this.index]
    if (ch === '{') return this.dict()
    if (ch === '[') return this.list(']')
    if (ch === '(') return this.list(')')
    if (ch === '"' || ch === "'") return this.string()

    const rest = this.text.slice(this.index)
    const number = rest.match(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)
    if (number) {
      this.index += number[0].length
      const parsed = Number(number[0])
      if (!Number.isFinite(parsed)) throw new Error(`数值「${number[0]}」不是有限数字`)
      return parsed
    }

    const identifier = rest.match(/^[A-Za-z_]\w*/)
    if (identifier) {
      this.index += identifier[0].length
      if (identifier[0] === 'True') return true
      if (identifier[0] === 'False') return false
      if (identifier[0] === 'None') return null
      return identifier[0]
    }
    throw new Error(`第 ${this.index + 1} 个字符不是支持的 Python 字面量`)
  }

  private string(): string {
    const quote = this.text[this.index++]
    let out = ''
    while (this.index < this.text.length) {
      const ch = this.text[this.index++]
      if (ch === quote) return out
      if (ch !== '\\') {
        out += ch
        continue
      }
      if (this.index >= this.text.length) throw new Error('字符串转义没有结束')
      const escaped = this.text[this.index++]
      const escapes: Record<string, string> = {
        n: '\n',
        r: '\r',
        t: '\t',
        '\\': '\\',
        "'": "'",
        '"': '"',
      }
      out += escapes[escaped] ?? escaped
    }
    throw new Error('字符串没有闭合')
  }

  private dict(): Record<string, unknown> {
    this.index++
    const out: Record<string, unknown> = {}
    this.skipSpace()
    if (this.text[this.index] === '}') {
      this.index++
      return out
    }
    for (;;) {
      this.skipSpace()
      const key = this.value()
      if (typeof key !== 'string') throw new Error('MODEL_PARAMS 的键必须是字符串或标识符')
      this.skipSpace()
      if (this.text[this.index++] !== ':') throw new Error(`参数「${key}」缺少冒号`)
      out[key] = this.value()
      this.skipSpace()
      const separator = this.text[this.index++]
      if (separator === '}') return out
      if (separator !== ',') throw new Error('字典项之间必须使用逗号')
      this.skipSpace()
      if (this.text[this.index] === '}') {
        this.index++
        return out
      }
    }
  }

  private list(end: ']' | ')'): unknown[] {
    this.index++
    const out: unknown[] = []
    this.skipSpace()
    if (this.text[this.index] === end) {
      this.index++
      return out
    }
    for (;;) {
      out.push(this.value())
      this.skipSpace()
      const separator = this.text[this.index++]
      if (separator === end) return out
      if (separator !== ',') throw new Error('列表项之间必须使用逗号')
      this.skipSpace()
      if (this.text[this.index] === end) {
        this.index++
        return out
      }
    }
  }
}

function matchingBracket(text: string, openIndex: number): number {
  const open = text[openIndex]
  const close = open === '{' ? '}' : open === '[' ? ']' : ')'
  let depth = 0
  let quote: string | null = null
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') {
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth++
    if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 读取代码中某个赋值的安全 Python 字面量；不会执行表达式或 import。 */
export function parsePythonLiteralAssignment(
  code: string,
  name: string,
): { value?: unknown; declared: boolean; error?: string } {
  const match = code.match(new RegExp(`(?:^|\\n)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:[ \\t]*:[^=\\n]+)?[ \\t]*=[ \\t]*`))
  if (!match || match.index === undefined) return { declared: false }
  const start = match.index + match[0].length
  const open = code.slice(start).search(/[\\[{(]/)
  if (open < 0) return { declared: true, error: `${name} 必须是一个 Python 字面量` }
  const openIndex = start + open
  const closeIndex = matchingBracket(code, openIndex)
  if (closeIndex < 0) return { declared: true, error: `${name} 的字面量没有闭合` }
  try {
    return {
      declared: true,
      value: new PythonLiteralParser(code.slice(openIndex, closeIndex + 1)).parse(),
    }
  } catch (error) {
    return {
      declared: true,
      error: error instanceof Error ? `${name} 解析失败：${error.message}` : `${name} 解析失败`,
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function scalar(value: unknown): Scalar | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  return finiteNumber(value)
}

export type ModelListItemType = 'int' | 'float' | 'text' | 'boolean'

export const MAX_MODEL_LIST_ITEMS = 64

export interface ParsedModelListValue {
  values: unknown[]
  error?: string
}

/** 工作流节点只保存 JSON 字符串；解析器与静态校验共用此入口。 */
export function parseModelListValue(value: unknown): ParsedModelListValue {
  if (typeof value !== 'string') return { values: [], error: '期望以 JSON 字符串保存的列表' }
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? { values: parsed }
      : { values: [], error: 'JSON 内容必须是一维列表' }
  } catch {
    return { values: [], error: '不是有效的 JSON 列表' }
  }
}

export function serializeModelListValue(values: readonly unknown[]): string {
  return JSON.stringify(values)
}

export function validateModelListParamValue(
  spec: Pick<ParamSpec, 'label' | 'listItemType' | 'minItems' | 'maxItems' | 'itemMin' | 'itemMax'>,
  value: unknown,
): string | null {
  const parsed = parseModelListValue(value)
  if (parsed.error) return parsed.error
  const values = parsed.values
  const itemType = spec.listItemType
  if (!itemType) return '缺少列表元素类型声明'
  if (values.length < (spec.minItems ?? 0)) return `至少需要 ${spec.minItems ?? 0} 项`
  if (values.length > (spec.maxItems ?? MAX_MODEL_LIST_ITEMS)) return `最多允许 ${spec.maxItems ?? MAX_MODEL_LIST_ITEMS} 项`
  for (const [index, item] of values.entries()) {
    const valid = itemType === 'int'
      ? typeof item === 'number' && Number.isSafeInteger(item)
      : itemType === 'float'
        ? typeof item === 'number' && Number.isFinite(item)
        : itemType === 'text'
          ? typeof item === 'string'
          : typeof item === 'boolean'
    if (!valid) return `第 ${index + 1} 项不是有效的 ${itemType} 值`
    if ((itemType === 'int' || itemType === 'float') && typeof item === 'number') {
      if (spec.itemMin !== undefined && item < spec.itemMin) return `第 ${index + 1} 项小于下限 ${spec.itemMin}`
      if (spec.itemMax !== undefined && item > spec.itemMax) return `第 ${index + 1} 项大于上限 ${spec.itemMax}`
    }
  }
  return null
}

function inferType(value: Scalar): ParamSpec['type'] {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  return 'text'
}

function normalizeType(raw: unknown, defaultValue: Scalar, options: unknown[]): ParamSpec['type'] {
  if (options.length > 0) return 'select'
  const text = String(raw ?? '').trim().toLowerCase()
  if (['int', 'integer', 'float', 'number', 'double'].includes(text)) return 'number'
  if (['bool', 'boolean'].includes(text)) return 'boolean'
  if (['select', 'enum', 'choice'].includes(text)) return 'select'
  if (['str', 'string', 'text'].includes(text)) return 'text'
  return inferType(defaultValue)
}

function listItemType(raw: unknown): ModelListItemType | null {
  const match = String(raw ?? '').trim().toLowerCase().match(/^list\[(int|float|str|bool)\]$/)
  if (!match) return null
  return match[1] === 'str' ? 'text' : match[1] === 'bool' ? 'boolean' : match[1] as ModelListItemType
}

function parseListBound(config: Record<string, unknown>, key: string, name: string, fallback: number): number {
  const raw = config[name]
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`参数「${key}」的 ${name} 必须是非负整数`)
  }
  return raw
}

function parseOptionalFinite(config: Record<string, unknown>, key: string, name: string): number | undefined {
  const raw = config[name]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`参数「${key}」的 ${name} 必须是有限数字`)
  }
  return raw
}

function makeListParamSpec(key: string, config: Record<string, unknown>): ParamSpec {
  if (!Array.isArray(config.default)) {
    throw new Error(`参数「${key}」的列表 default 必须是一维列表`)
  }
  const rawType = config.type === undefined || config.type === null ? '' : String(config.type).trim().toLowerCase()
  const declaredItemType = listItemType(config.type)
  if (rawType && !declaredItemType) {
    throw new Error(`参数「${key}」的列表 type 必须是 list[int]、list[float]、list[str] 或 list[bool]`)
  }
  if (!declaredItemType) throw new Error(`参数「${key}」必须显式声明列表 type`)
  const itemType = declaredItemType
  const validDefault = config.default.every((item) => {
    if (itemType === 'int') return typeof item === 'number' && Number.isSafeInteger(item)
    if (itemType === 'float') return typeof item === 'number' && Number.isFinite(item)
    if (itemType === 'text') return typeof item === 'string'
    return typeof item === 'boolean'
  })
  if (!validDefault) throw new Error(`参数「${key}」的 default 必须全部是 ${itemType} 类型`)

  const minItems = parseListBound(config, key, 'minItems', 0)
  const maxItems = parseListBound(config, key, 'maxItems', MAX_MODEL_LIST_ITEMS)
  if (maxItems > MAX_MODEL_LIST_ITEMS) throw new Error(`参数「${key}」的 maxItems 不能超过 ${MAX_MODEL_LIST_ITEMS}`)
  if (minItems > maxItems) throw new Error(`参数「${key}」的 minItems 不能大于 maxItems`)
  if (config.default.length < minItems || config.default.length > maxItems) {
    throw new Error(`参数「${key}」的 default 项数必须在 ${minItems}–${maxItems} 之间`)
  }

  const itemMin = parseOptionalFinite(config, key, 'itemMin')
  const itemMax = parseOptionalFinite(config, key, 'itemMax')
  if (itemType !== 'int' && itemType !== 'float' && (itemMin !== undefined || itemMax !== undefined)) {
    throw new Error(`参数「${key}」只有数值列表可以设置 itemMin / itemMax`)
  }
  if (itemMin !== undefined && itemMax !== undefined && itemMin > itemMax) {
    throw new Error(`参数「${key}」的 itemMin 不能大于 itemMax`)
  }
  if (itemType === 'int' && itemMin !== undefined && itemMax !== undefined) {
    if (Math.ceil(itemMin) > Math.floor(itemMax)) {
      throw new Error(`参数「${key}」的整数 itemMin / itemMax 之间没有可用值`)
    }
  }
  for (const item of config.default) {
    if (typeof item !== 'number') continue
    if (itemMin !== undefined && item < itemMin) throw new Error(`参数「${key}」的 default 含有小于 itemMin 的值`)
    if (itemMax !== undefined && item > itemMax) throw new Error(`参数「${key}」的 default 含有大于 itemMax 的值`)
  }

  return {
    key,
    label: typeof config.label === 'string' ? config.label : key,
    type: 'text',
    default: serializeModelListValue(config.default),
    widget: 'list',
    listItemType: itemType,
    minItems,
    maxItems,
    itemMin,
    itemMax,
    hint: typeof config.hint === 'string' ? config.hint : undefined,
    portable: false,
  }
}

function normalizedDefault(value: Scalar, type: ParamSpec['type']): string | number | boolean {
  if (type === 'boolean') return Boolean(value)
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0
    return value
  }
  return value === null ? '' : String(value)
}

const AUTO_MODEL_ARGUMENTS = new Set([
  'self',
  'cls',
  'spec',
  'model_spec',
  'input_shape',
  'output_shape',
  'input_dim',
  'output_dim',
  'input_size',
  'output_size',
  'in_features',
  'out_features',
  'in_channels',
  'out_channels',
  'num_classes',
  'n_classes',
  'task',
])

function constructorParamSpec(param: FnParamSpec): ParamSpec | null {
  if (AUTO_MODEL_ARGUMENTS.has(param.name)) return null
  const annotation = (param.annotation ?? '').toLowerCase()
  let type: ParamSpec['type']
  let defaultValue: string | number | boolean
  let required = false
  if (typeof param.defaultLiteral === 'number') {
    type = 'number'
    defaultValue = param.defaultLiteral
  } else if (typeof param.defaultLiteral === 'boolean') {
    type = 'boolean'
    defaultValue = param.defaultLiteral
  } else if (typeof param.defaultLiteral === 'string') {
    type = 'text'
    defaultValue = param.defaultLiteral
  } else if (!param.hasDefault && /bool/.test(annotation)) {
    type = 'boolean'
    defaultValue = false
    required = true
  } else if (!param.hasDefault && /int|float|number|double/.test(annotation)) {
    type = 'number'
    defaultValue = 0
    required = true
  } else if (!param.hasDefault) {
    type = 'text'
    defaultValue = ''
    required = true
  } else {
    // tuple/list/Sequence 等复杂默认值无法安全地塞进节点的标量参数，
    // 继续由用户用 MODEL_PARAMS 显式声明，避免把 Python 表达式当成字符串传错。
    return null
  }
  return {
    key: param.name,
    label: param.name,
    type,
    default: defaultValue,
    required,
    hint: param.annotation,
    step: type === 'number' && Number.isInteger(defaultValue) ? 1 : undefined,
    portable: false,
  }
}

function inferredConstructorParams(code: string): ParamSpec[] {
  const classes = [...code.matchAll(/(?:^|\n)[ \t]*class[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]*)\)[ \t]*:/g)]
    .filter((match) => /(?:^|[., (])(?:torch\.)?nn\.Module(?:$|[., )])/.test(match[2]))
  if (classes.length === 0) return []
  const explicit = code.match(/(?:^|\n)[ \t]*MODEL_CLASS[ \t]*=[ \t]*([A-Za-z_]\w*)/)
  const selected = explicit
    ? classes.find((match) => match[1] === explicit[1])
    : classes.find((match) => match[1] === 'Model') ??
      [...classes].reverse().find((match) => !match[1].startsWith('_'))
  if (!selected || selected.index === undefined) return []
  const nextClass = classes.find((match) => (match.index ?? 0) > selected.index!)
  const body = code.slice(selected.index, nextClass?.index ?? code.length)
  const initOffset = body.search(/(?:^|\n)[ \t]*def[ \t]+__init__[ \t]*\(/)
  if (initOffset < 0) return []
  const signature = parseSignature(body.slice(initOffset))
  return signature.params.map(constructorParamSpec).filter((spec): spec is ParamSpec => spec !== null)
}

/** 读取 MODEL_PARAMS 字面量并转成右栏通用 ParamSpec。 */
export function parseModelParams(code: string): ModelParamParseResult {
  const match = code.match(/(?:^|\n)[ \t]*MODEL_PARAMS[ \t]*=[ \t]*/)
  if (!match || match.index === undefined) return { specs: inferredConstructorParams(code) }
  const start = match.index + match[0].length
  const open = code.slice(start).search(/[\[{(]/)
  if (open < 0) return { specs: [], declared: true, error: 'MODEL_PARAMS 必须是一个字典，例如 MODEL_PARAMS = {...}' }
  const openIndex = start + open
  if (code[openIndex] !== '{') return { specs: [], declared: true, error: 'MODEL_PARAMS 必须是一个字典，例如 MODEL_PARAMS = {...}' }
  const closeIndex = matchingBracket(code, openIndex)
  if (closeIndex < 0) return { specs: [], declared: true, error: 'MODEL_PARAMS 的字典没有闭合' }

  let raw: unknown
  try {
    raw = new PythonLiteralParser(code.slice(openIndex, closeIndex + 1)).parse()
  } catch (error) {
    return { specs: [], declared: true, error: error instanceof Error ? error.message : 'MODEL_PARAMS 解析失败' }
  }
  if (!isRecord(raw)) return { specs: [], declared: true, error: 'MODEL_PARAMS 必须是一个字典' }

  const specs: ParamSpec[] = []
  for (const [key, declaration] of Object.entries(raw)) {
    if (!/^[A-Za-z_]\w*$/.test(key)) {
      return { specs: [], declared: true, error: `参数名「${key}」不是合法的 Python 标识符` }
    }
    const config = isRecord(declaration) ? declaration : { default: declaration }
    const declaredType = String(config.type ?? '').trim().toLowerCase()
    if (Array.isArray(config.default) || declaredType.startsWith('list')) {
      try {
        specs.push(makeListParamSpec(key, config))
      } catch (error) {
        return {
          specs: [],
          declared: true,
          error: error instanceof Error ? error.message : `参数「${key}」的列表声明无效`,
        }
      }
      continue
    }
    const rawDefault = scalar(config.default)
    if (rawDefault === undefined) return { specs: [], declared: true, error: `参数「${key}」的 default 必须是数字、文字或布尔值` }
    const rawOptions = Array.isArray(config.options) ? config.options : []
    const options = rawOptions
      .map((option) => scalar(option))
      .filter((option): option is Exclude<Scalar, null> => option !== undefined && option !== null)
    const type = normalizeType(config.type, rawDefault, options)
    const defaultValue = normalizedDefault(rawDefault, type)
    const spec: ParamSpec = {
      key,
      label: typeof config.label === 'string' ? config.label : key,
      type,
      default: defaultValue,
      hint: typeof config.hint === 'string' ? config.hint : undefined,
      min: finiteNumber(config.min),
      max: finiteNumber(config.max),
      step:
        finiteNumber(config.step) ??
        (type === 'number' && typeof defaultValue === 'number' && Number.isInteger(defaultValue)
          ? 1
          : undefined),
      portable: false,
    }
    if (type === 'select') {
      const values = options.length > 0 ? options : [defaultValue]
      spec.options = values.map((option) => ({ value: String(option), label: String(option) }))
    }
    specs.push(spec)
  }
  return { specs, declared: true }
}

/** 只返回声明过的模型参数名，供静态校验器允许动态字段。 */
export function modelParamKeys(code: string): Set<string> {
  return new Set(parseModelParams(code).specs.map((spec) => spec.key))
}
