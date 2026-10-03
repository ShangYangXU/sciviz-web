import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCollectAsset } from './runAssets'
import type { WorkflowNode } from '../workflow/types'

const collect: WorkflowNode = { id: 'joined', type: 'data.collect', label: 'Joined', params: {}, position: { x: 0, y: 0 } }

test('拼表资产使用实际结果规模，支持上游经过函数且输出多列的情况', () => {
  const asset = buildCollectAsset(collect, { kind: 'table', rowCount: 7, columns: ['a', 'b', 'c'] })
  assert.deepEqual(asset?.table, { rows: 7, cols: 3 })
  assert.equal(asset?.summary?.列, 'a、b、c')
})

test('没有真实表输出时不伪造拼表资产；空表仍可登记', () => {
  assert.equal(buildCollectAsset(collect, undefined), null)
  assert.equal(buildCollectAsset(collect, { kind: 'figure' }), null)
  assert.deepEqual(buildCollectAsset(collect, { kind: 'table', rowCount: 0, columns: ['a'] })?.table, { rows: 0, cols: 1 })
})
