import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCanvasHistory, useCanvasHistory, type CanvasSnapshot } from './canvasHistory'
import type { Annotation } from '../workflow/annotations'
import type { Workflow } from '../workflow/types'

const workflow = (name: string): Workflow => ({
  id: 'wf-test',
  name,
  description: '',
  nodes: [],
  edges: [],
})

test('画布撤回同时恢复工作流和批注，并支持重做', () => {
  let current: CanvasSnapshot = { workflow: workflow('初始'), annotations: [] as Annotation[] }
  const unregister = registerCanvasHistory({
    read: () => current,
    restore: (snapshot) => {
      current = snapshot
    },
  })
  useCanvasHistory.getState().clear()

  useCanvasHistory.getState().record('add')
  current = {
    workflow: workflow('修改后'),
    annotations: [
      {
        id: 'a1',
        kind: 'table',
        position: { x: 0, y: 0 },
        title: '',
        columns: ['读数'],
        rows: [['0.42']],
      },
    ],
  }
  useCanvasHistory.getState().undo()
  assert.equal(current.workflow.name, '初始')
  assert.equal(current.annotations.length, 0)
  assert.equal(useCanvasHistory.getState().canRedo, true)

  useCanvasHistory.getState().redo()
  assert.equal(current.workflow.name, '修改后')
  assert.equal(current.annotations.length, 1)
  unregister()
  useCanvasHistory.getState().clear()
})
