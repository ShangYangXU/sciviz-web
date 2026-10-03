/**
 * 从 Python 代码里解析函数签名。
 *
 * 设计意图：函数签名就是节点接口。用户写
 *     def envelope_peak_detect(signal, min_prominence=0.1):
 *         return {"peaks": peaks}
 * 节点就自动长出 signal / min_prominence 两个输入端口和 peaks 一个输出端口，
 * 不需要再去别的地方配一遍签名。
 *
 * 解析规则（刻意保守，解析不了就退化而不是报错）：
 * - 无默认值的形参 → 必接的数据输入
 * - 有字面量默认值的形参 → 可选的标量旋钮，不接线就用字面量
 * - `self` / `*args` / `**kwargs` 跳过
 */

export interface FnParamSpec {
  name: string
  /** 有字面量默认值 → 可以不接线 */
  hasDefault: boolean
  /** 默认值的字面量；字符串保留引号内的内容 */
  defaultLiteral: string | number | boolean | null
  /** 原始类型注解文本，仅用于展示 */
  annotation?: string
  /** `Literal["a", "b"]` 中的字符串选项；用于右侧栏的下拉控件 */
  options?: string[]
}

interface FnOutputSpec {
  name: string
}

interface FnSignature {
  fnName: string
  params: FnParamSpec[]
  outputs: FnOutputSpec[]
  /** 解析失败时的说明；此时 params/outputs 会退化成空/out */
  error?: string
}

/** 训练函数由宿主注入的上下文和固定数据端口，不生成动态参数端口。 */
export const TRAINING_FUNCTION_RESERVED_PARAMS: ReadonlySet<string> = new Set([
  'model_factory',
  'train_data',
  'test_data',
  'val_data',
  'model',
  'train',
  'val',
  'scaler',
  'train_loader',
  'val_loader',
  'device',
  'spec',
  'params',
  'env',
])

/** 0.1.0 训练块曾把这些数据适配字段固定写进节点；仅用于旧工程保值。 */
export const LEGACY_TRAINING_PARAM_KEYS: ReadonlySet<string> = new Set([
  'label',
  'features',
  'task',
  'batch',
  'seed',
])

/** 新协议由这些注入参数明确声明“我要拿原始表”，不靠节点版本猜。 */
export function usesRawTableTrainingProtocol(code: string): boolean {
  const signature = parseSignature(code)
  if (signature.error) return false
  return signature.params.some((param) =>
    ['model_factory', 'train_data', 'test_data', 'val_data'].includes(param.name),
  )
}

/** 从 openIndex 处的开括号找到配对的闭括号，跳过字符串与嵌套 */
function matchParen(text: string, openIndex: number): number {
  const open = text[openIndex]
  const close = open === '(' ? ')' : open === '{' ? '}' : ']'
  let depth = 0
  let quote: string | null = null
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  void close
  return -1
}

/** 按顶层逗号切分（忽略括号与引号内部的逗号） */
function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      cur += ch
      if (ch === '\\') {
        cur += text[i + 1] ?? ''
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 把字面量文本转成值；不是字面量则返回 null */
function parseLiteral(raw: string): string | number | boolean | null {
  const t = raw.trim()
  if (!t) return null
  if (/^(True|true)$/.test(t)) return true
  if (/^(False|false)$/.test(t)) return false
  if (/^None$|^null$/.test(t)) return null
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t)
  const q = t.match(/^(['"])([\s\S]*)\1$/)
  if (q) return q[2]
  return null
}

/** 仅解析全由字符串字面量组成的 Literal 注解；复杂注解保守退化为普通参数。 */
function parseStringLiteralOptions(annotation?: string): string[] | undefined {
  if (!annotation) return undefined
  const match = annotation.match(/^(?:(?:typing)\.)?Literal\s*\[([\s\S]*)\]\s*$/)
  if (!match) return undefined
  const values = splitTopLevel(match[1]).map(parseLiteral)
  if (values.length === 0 || values.some((value) => typeof value !== 'string')) return undefined
  return [...new Set(values as string[])]
}

function parseParams(paramText: string): FnParamSpec[] {
  const params: FnParamSpec[] = []
  for (const piece of splitTopLevel(paramText)) {
    // 跳过 *args / **kwargs / self
    if (piece.startsWith('*')) continue
    const nameMatch = piece.match(/^(\w+)/)
    if (!nameMatch) continue
    const name = nameMatch[1]
    if (name === 'self' || name === 'cls') continue

    // 切出注解与默认值。注意默认值里可能有冒号（如 dict 字面量），
    // 所以先找顶层 '='，再在它左边找注解。
    let rest = piece.slice(name.length)
    let annotation: string | undefined
    let defaultRaw: string | null = null

    const eqIdx = findTopLevelEqual(rest)
    if (eqIdx >= 0) {
      defaultRaw = rest.slice(eqIdx + 1)
      rest = rest.slice(0, eqIdx)
    }
    const annoMatch = rest.match(/^\s*:\s*([\s\S]+)$/)
    if (annoMatch) annotation = annoMatch[1].trim()

    const literal = defaultRaw === null ? null : parseLiteral(defaultRaw)
    const options = parseStringLiteralOptions(annotation)
    params.push({
      name,
      // 默认值不是简单字面量（比如调用了函数）时，仍按"有默认值"处理，
      // 但要接线才能拿到真实值 —— 这里保守地当作可选，由用户自己判断。
      hasDefault: defaultRaw !== null,
      defaultLiteral: literal,
      annotation,
      options,
    })
  }
  return params
}

/** 在顶层找 '=' 的位置（跳过 ==、>=、<=、!= 等比较运算符与嵌套结构） */
function findTopLevelEqual(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++
    if (ch === ')' || ch === '}' || ch === ']') depth--
    if (ch === '=' && depth === 0) {
      const prev = text[i - 1]
      const next = text[i + 1]
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>' || prev === ':') continue
      if (next === '=') continue
      return i
    }
  }
  return -1
}

/** 从 return {...} 里抠出输出名 */
function parseOutputs(code: string): FnOutputSpec[] {
  const retRe = /return\s*\{/g
  let m: RegExpExecArray | null
  let last: string | null = null
  while ((m = retRe.exec(code)) !== null) {
    const openIdx = m.index + m[0].length - 1
    const closeIdx = matchParen(code, openIdx)
    if (closeIdx > openIdx) last = code.slice(openIdx + 1, closeIdx)
  }
  if (!last) return []

  const names: string[] = []
  const keyRe = /(?:^|[,{\s])\s*(?:["']([^"']+)["']|([A-Za-z_]\w*))\s*:/g
  let k: RegExpExecArray | null
  while ((k = keyRe.exec(last)) !== null) {
    const name = k[1] ?? k[2]
    if (name && !names.includes(name)) names.push(name)
  }
  return names.map((name) => ({ name }))
}

export function parseSignature(code: string): FnSignature {
  if (!code || !code.trim()) {
    return { fnName: '', params: [], outputs: [], error: '代码为空' }
  }

  const defMatch = code.match(/(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
  if (!defMatch) {
    return { fnName: '', params: [], outputs: [], error: '没找到 def 语句' }
  }
  const fnName = defMatch[1]
  const openIdx = code.indexOf('(', defMatch.index ?? 0)
  const closeIdx = matchParen(code, openIdx)
  if (openIdx < 0 || closeIdx < 0) {
    return { fnName, params: [], outputs: [], error: 'def 的括号不配对' }
  }

  const params = parseParams(code.slice(openIdx + 1, closeIdx))
  const outputs = parseOutputs(code)

  return {
    fnName,
    params,
    outputs: outputs.length > 0 ? outputs : [{ name: 'out' }],
  }
}

/** 训练入口必须名为 fit_model；其余可解析参数才是用户声明的训练参数。 */
export function parseTrainingSignature(code: string): FnSignature {
  const signature = parseSignature(code)
  if (signature.error) return signature
  if (signature.fnName !== 'fit_model') {
    return { ...signature, error: '训练函数必须命名为 fit_model' }
  }
  return {
    ...signature,
    params: signature.params.filter(
      (param) =>
        !TRAINING_FUNCTION_RESERVED_PARAMS.has(param.name) &&
        // Python 能处理复杂默认表达式；轻量解析器无法安全提供对应 UI 控件，故保留原默认值。
        !(param.hasDefault && param.defaultLiteral === null),
    ),
  }
}
