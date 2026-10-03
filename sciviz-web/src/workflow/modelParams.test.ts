import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultParams, getNodeTypeDef } from './nodeRegistry'
import {
  modelParamKeys,
  parseModelListValue,
  parseModelParams,
  serializeModelListValue,
  validateModelListParamValue,
} from './modelParams'

test('自定义模型从 MODEL_PARAMS 自动生成可编辑参数', () => {
  const result = parseModelParams(`
MODEL_PARAMS = {
  "hidden_dim": {"type": "int", "default": 64, "min": 1, "label": "隐藏层"},
  'dropout': {'type': 'float', 'default': 0.2, 'min': 0, 'max': 0.9, 'step': 0.05},
  'activation': {'options': ['relu', 'gelu'], 'default': 'relu'},
  'bias': True,
}
`)

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.specs.map((spec) => [spec.key, spec.type, spec.default]),
    [
      ['hidden_dim', 'number', 64],
      ['dropout', 'number', 0.2],
      ['activation', 'select', 'relu'],
      ['bias', 'boolean', true],
    ],
  )
  assert.deepEqual(result.specs[2].options, [
    { value: 'relu', label: 'relu' },
    { value: 'gelu', label: 'gelu' },
  ])
})

test('没有声明 MODEL_PARAMS 时模型节点仍然只有代码参数', () => {
  const result = parseModelParams('def build_model(spec, params):\n    return None\n')
  assert.deepEqual(result.specs, [])
  assert.deepEqual(modelParamKeys('def build_model(spec, params):\n    return None\n'), new Set())
})

test('没有 MODEL_PARAMS 时自动读取 Model 构造函数的标量参数', () => {
  const result = parseModelParams(`
import torch
from torch import nn

class Model(nn.Module):
    def __init__(self, input_dim: int, hidden_dim: int = 64, dropout: float = 0.2, bias: bool = True):
        super().__init__()
`)
  assert.deepEqual(
    result.specs.map((spec) => [spec.key, spec.type, spec.default]),
    [
      ['hidden_dim', 'number', 64],
      ['dropout', 'number', 0.2],
      ['bias', 'boolean', true],
    ],
  )
})

test('没有默认值的模型构造参数会标记为必填', () => {
  const result = parseModelParams(`
import torch
from torch import nn

class Model(nn.Module):
    def __init__(self, input_dim, window_size: int, hidden_dim: int = 64):
        super().__init__()
`)
  assert.equal(result.specs.find((spec) => spec.key === 'window_size')?.required, true)
  assert.equal(result.specs.find((spec) => spec.key === 'hidden_dim')?.required, false)
})

test('新增模型节点的默认参数包含代码里声明的模型超参数', () => {
  const params = defaultParams(getNodeTypeDef('custom.model'))
  assert.equal(params.hidden_dim, 64)
  assert.equal(params.depth, 3)
  assert.equal(params.width_multiplier, 1)
  assert.equal(params.dropout, 0.1)
  assert.equal(params.code !== undefined, true)
})

test('自定义训练节点由输入模式决定表格或时序 DataLoader', () => {
  const params = defaultParams(getNodeTypeDef('train.custom'))
  assert.equal(params.inputMode, '表格')
  assert.equal(params.window, 48)
  assert.equal(params.horizon, 1)
  assert.equal(params.stride, 1)
})

test('MODEL_PARAMS 写到一半时只给出提示，不执行用户代码', () => {
  const result = parseModelParams('MODEL_PARAMS = {"hidden_dim": {"default": 64}')
  assert.equal(result.specs.length, 0)
  assert.match(result.error ?? '', /没有闭合|解析失败/)
})

test('MODEL_PARAMS 列表生成带元素类型与边界的逐项控件声明', () => {
  const result = parseModelParams(`
MODEL_PARAMS = {
  'channels': {'type': 'list[int]', 'default': [16, 32], 'minItems': 1, 'maxItems': 8, 'itemMin': 1, 'itemMax': 128},
  'dropouts': {'type': 'list[float]', 'default': [0.1, 0.2]},
  'names': {'type': 'list[str]', 'default': ['conv', 'relu']},
  'enabled': {'type': 'list[bool]', 'default': [True, False]},
}
`)
  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.specs.map((spec) => [spec.key, spec.widget, spec.listItemType, spec.default]),
    [
      ['channels', 'list', 'int', '[16,32]'],
      ['dropouts', 'list', 'float', '[0.1,0.2]'],
      ['names', 'list', 'text', '["conv","relu"]'],
      ['enabled', 'list', 'boolean', '[true,false]'],
    ],
  )
  assert.equal(result.specs[0].maxItems, 8)
  assert.equal(result.specs[0].itemMax, 128)
})

test('列表值以 JSON 保存并严格校验类型、项数和范围', () => {
  const spec = parseModelParams(`MODEL_PARAMS = {
    'dilations': {'type': 'list[int]', 'default': [1, 2, 4], 'minItems': 1, 'maxItems': 4, 'itemMin': 1, 'itemMax': 16}
  }`).specs[0]
  const edited = serializeModelListValue([1, 4, 8])
  assert.deepEqual(parseModelListValue(edited), { values: [1, 4, 8] })
  assert.equal(validateModelListParamValue(spec, edited), null)
  assert.match(validateModelListParamValue(spec, '[1,"4"]') ?? '', /第 2 项/)
  assert.match(validateModelListParamValue(spec, '[]') ?? '', /至少需要 1 项/)
  assert.match(validateModelListParamValue(spec, '[1,2,4,8,16]') ?? '', /最多允许 4 项/)
  assert.match(validateModelListParamValue(spec, '[1,2,32]') ?? '', /大于上限/)
  assert.match(validateModelListParamValue(spec, '[9007199254740992]') ?? '', /有效的 int/)
})

test('不接受混合、嵌套或超过硬上限的模型列表声明', () => {
  for (const code of [
    `MODEL_PARAMS = {'items': {'type': 'list[int]', 'default': [1, '2']}}`,
    `MODEL_PARAMS = {'items': {'type': 'list[int]', 'default': [[1], [2]]}}`,
    `MODEL_PARAMS = {'items': {'type': 'list[int]', 'default': [1], 'maxItems': 65}}`,
    `MODEL_PARAMS = {'items': {'default': [1, 2]}}`,
    `MODEL_PARAMS = {'items': {'type': 'list[int]', 'default': [9007199254740992]}}`,
  ]) {
    const result = parseModelParams(code)
    assert.equal(result.specs.length, 0)
    assert.ok(result.error)
  }
})
