import assert from 'node:assert/strict'
import test from 'node:test'
import type { StoredDataset } from './columnStore'
import { FIXED_DATASET_ID, FixedDatasetLoader } from './fixedDataset'

const storedDataset: StoredDataset = {
  id: 'temporary-id',
  name: 'temporary-name',
  source: 'temporary.csv',
  importedAt: 1,
  rowCount: 2,
  timeColumn: null,
  time: null,
  stepSeconds: null,
  columns: [],
  data: {},
}

test('fixed dataset loader shares concurrent startup reads and assigns a stable identity', async () => {
  let requests = 0
  let parses = 0
  let requestedUrl = ''
  const loader = new FixedDatasetLoader(
    async (input) => {
      requests += 1
      requestedUrl = String(input)
      return new Response('time,value\n0,1\n', { status: 200, headers: { 'content-type': 'text/csv' } })
    },
    async (file) => {
      parses += 1
      assert.equal(file.name, 'Sheet1.csv')
      assert.equal(await file.text(), 'time,value\n0,1\n')
      return storedDataset
    },
    () => 'http://127.0.0.1:8765/fixed-dataset/sheet1.csv',
  )

  const [first, second] = await Promise.all([loader.load(), loader.load()])

  assert.strictEqual(first, second)
  assert.equal(requests, 1)
  assert.equal(parses, 1)
  assert.equal(requestedUrl, 'http://127.0.0.1:8765/fixed-dataset/sheet1.csv')
  assert.equal(first.id, FIXED_DATASET_ID)
  assert.equal(first.name, 'Sheet1')
  assert.equal(first.source, 'Sheet1.csv')
})

test('fixed dataset loader can retry after the configured file is missing', async () => {
  let requests = 0
  const loader = new FixedDatasetLoader(
    async () => {
      requests += 1
      if (requests === 1) {
        return new Response(JSON.stringify({ detail: '固定数据集不存在' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('x\n1\n', { status: 200 })
    },
    async () => storedDataset,
    () => 'http://local/fixed-dataset/sheet1.csv',
  )

  await assert.rejects(loader.load(), /固定数据集不存在/)
  const dataset = await loader.load()

  assert.equal(requests, 2)
  assert.equal(dataset.id, FIXED_DATASET_ID)
})
