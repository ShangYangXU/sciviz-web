import test from 'node:test'
import assert from 'node:assert/strict'
import { parseModelInterface } from './modelInterface'
import { resolvePorts } from './ports'
import type { WorkflowNode } from './types'

const code = `
MODEL_INTERFACE = {
  "inputs": [
    {"id": "features", "label": "特征", "type": "tensor", "shape": ["batch", "feature"], "axes": ["sample", "feature"], "dtype": "float32"},
    {"id": "mask", "type": "tensor", "optional": True},
    {"id": "context", "type": "table", "multiple": True},
  ],
  "outputs": {"prediction": {"type": "tensor", "shape": ["batch", "target"]}},
}
`

test('MODEL_INTERFACE 支持列表、字典简写与端口元数据', () => {
  const result = parseModelInterface(code)
  assert.equal(result.error, undefined)
  assert.equal(result.declared, true)
  assert.deepEqual(result.interface?.inputs.map((port) => [port.id, port.type, port.optional, port.multiple]), [
    ['features', 'tensor', false, false],
    ['mask', 'tensor', true, false],
    ['context', 'table', false, true],
  ])
  assert.deepEqual(result.interface?.inputs[0].shape, ['batch', 'feature'])
  assert.deepEqual(result.interface?.inputs[0].axes, ['sample', 'feature'])
  assert.equal(result.interface?.outputs[0].id, 'prediction')
})

test('MODEL_INTERFACE 不执行表达式，且拒绝非法声明', () => {
  assert.equal(parseModelInterface('MODEL_INTERFACE: dict = {"inputs": []}').error, undefined)
  assert.equal(parseModelInterface('MODEL_INTERFACE = make_interface()').error !== undefined, true)
  assert.match(
    parseModelInterface('MODEL_INTERFACE = {"inputs": [{"id": "x", "type": "unknown"}]}').error ?? '',
    /不受支持/,
  )
  assert.match(
    parseModelInterface('MODEL_INTERFACE = {"outputs": [{"id": "model", "type": "model"}]}').error ?? '',
    /保留名称/,
  )
  assert.match(
    parseModelInterface('MODEL_INTERFACE = {"inputs": [{"id": "x", "type": "tensor", "shape": [1], "axes": []}]}').error ?? '',
    /axes 长度/,
  )
})

test('custom.model 端口由显式接口生成，同时保留 model 句柄', () => {
  const node: WorkflowNode = {
    id: 'm',
    type: 'custom.model',
    label: '模型',
    params: { code },
    position: { x: 0, y: 0 },
  }
  const ports = resolvePorts(node, {
    featuresOf: () => [],
    timeColumnOf: () => null,
  })
  assert.deepEqual(ports.inputs.map((port) => port.id), ['features', 'mask', 'context'])
  assert.deepEqual(ports.outputs.map((port) => port.id), ['model', 'prediction'])
  assert.equal(ports.inputs[2].multiple, true)
  assert.equal(ports.outputs[1].type, 'tensor')
})
