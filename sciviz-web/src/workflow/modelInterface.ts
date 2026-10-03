import { parsePythonLiteralAssignment } from './modelParams'
import type { PortSpec, PortType } from './types'

/** 端口接口中允许的描述元数据。类型兼容仍由 PortSpec 的统一规则决定。 */
export interface ModelInterfacePort extends Pick<PortSpec, 'id' | 'label' | 'type' | 'optional' | 'multiple' | 'shape' | 'axes' | 'dtype' | 'unit' | 'description'> {}

export interface ModelInterface {
  inputs: ModelInterfacePort[]
  outputs: ModelInterfacePort[]
}

export interface ModelInterfaceParseResult {
  interface?: ModelInterface
  declared?: boolean
  error?: string
}

const PORT_TYPES = new Set<PortType>(['any', 'table', 'tensor', 'model', 'metrics', 'figure', 'scaler'])
const MAX_PORTS = 64
const PORT_ID = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const RESERVED_OUTPUTS = new Set(['model'])

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function shape(value: unknown, key: string): (number | string)[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 16) throw new Error(`接口端口「${key}」的 shape 必须是不超过 16 项的列表`)
  const result = value.map((item) => {
    if (typeof item === 'string' && item.trim()) return item.trim()
    const integer = finiteInteger(item)
    if (integer !== undefined && integer >= 0) return integer
    throw new Error(`接口端口「${key}」的 shape 只能包含非负整数或非空字符串`)
  })
  return result
}

function stringList(value: unknown, name: string, key: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`接口端口「${key}」的 ${name} 必须是字符串列表`)
  }
  return value.map((item) => String(item).trim())
}

function normalizePort(raw: unknown, shorthandId: string | undefined, direction: 'inputs' | 'outputs'): ModelInterfacePort {
  const config = typeof raw === 'string' ? { type: raw } : record(raw) ? raw : { type: raw }
  const idValue = config.id ?? shorthandId
  if (typeof idValue !== 'string' || !PORT_ID.test(idValue)) {
    throw new Error(`${direction} 端口 id 必须是合法标识符（字母、数字、下划线、点或短横线）`)
  }
  const id = idValue
  const type = String(config.type ?? '').trim().toLowerCase() as PortType
  if (!PORT_TYPES.has(type)) throw new Error(`接口端口「${id}」的 type「${String(config.type ?? '')}」不受支持`)
  if (direction === 'outputs' && RESERVED_OUTPUTS.has(id)) {
    throw new Error(`接口输出端口「${id}」是保留名称；模型句柄固定使用 model`)
  }
  if (config.optional !== undefined && typeof config.optional !== 'boolean') {
    throw new Error(`接口端口「${id}」的 optional 必须是布尔值`)
  }
  if (config.multiple !== undefined && typeof config.multiple !== 'boolean') {
    throw new Error(`接口端口「${id}」的 multiple 必须是布尔值`)
  }
  const portShape = shape(config.shape, id)
  const axes = stringList(config.axes, 'axes', id)
  if (portShape !== undefined && axes !== undefined && portShape.length !== axes.length) {
    throw new Error(`接口端口「${id}」的 axes 长度必须与 shape 一致`)
  }
  const text = (key: string): string | undefined => {
    if (config[key] === undefined) return undefined
    if (typeof config[key] !== 'string') throw new Error(`接口端口「${id}」的 ${key} 必须是文字`)
    return String(config[key])
  }
  return {
    id,
    label: text('label') || id,
    type,
    optional: config.optional === true,
    multiple: config.multiple === true,
    shape: portShape,
    axes,
    dtype: text('dtype'),
    unit: text('unit'),
    description: text('description'),
  }
}

function normalizeDirection(value: unknown, direction: 'inputs' | 'outputs'): ModelInterfacePort[] {
  if (value === undefined) return []
  const items: [string | undefined, unknown][] = Array.isArray(value)
    ? value.map((item) => [undefined, item])
    : record(value)
      ? Object.entries(value)
      : []
  if (items.length === 0 && !Array.isArray(value) && !record(value)) {
    throw new Error(`${direction} 必须是端口列表或字典`)
  }
  if (items.length > MAX_PORTS) throw new Error(`${direction} 最多允许 ${MAX_PORTS} 个端口`)
  const seen = new Set<string>()
  return items.map(([shorthandId, item]) => {
    const port = normalizePort(item, shorthandId, direction)
    if (seen.has(port.id)) throw new Error(`${direction} 存在重复端口「${port.id}」`)
    seen.add(port.id)
    return port
  })
}

/** 解析 MODEL_INTERFACE；浏览器端只接受字面量，绝不执行模型代码。 */
export function parseModelInterface(code: string): ModelInterfaceParseResult {
  const parsed = parsePythonLiteralAssignment(code, 'MODEL_INTERFACE')
  if (!parsed.declared) return { interface: { inputs: [], outputs: [] }, declared: false }
  if (parsed.error) return { declared: true, error: parsed.error }
  if (!record(parsed.value)) return { declared: true, error: 'MODEL_INTERFACE 必须是一个字典' }
  try {
    return {
      declared: true,
      interface: {
        inputs: normalizeDirection(parsed.value.inputs, 'inputs'),
        outputs: normalizeDirection(parsed.value.outputs, 'outputs'),
      },
    }
  } catch (error) {
    return { declared: true, error: error instanceof Error ? error.message : 'MODEL_INTERFACE 声明无效' }
  }
}

/** 转成注册表使用的 PortSpec，同时保留接口元数据。 */
export function interfacePorts(nodeInterface: ModelInterface): { inputs: PortSpec[]; outputs: PortSpec[] } {
  const map = (port: ModelInterfacePort): PortSpec => ({ ...port, kind: 'data' })
  return { inputs: nodeInterface.inputs.map(map), outputs: nodeInterface.outputs.map(map) }
}
