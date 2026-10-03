import test from 'node:test'
import assert from 'node:assert/strict'
import { captureCurrentFigure, FigureCaptureError } from './reportFigure'
import { useNodeOutputStore } from '../store/nodeOutputStore'
import { emptyWorkflow } from '../workflow/defaultWorkflow'
import { emptyProject } from '../workflow/project'

function chartProject() {
  const project = emptyProject(emptyWorkflow('figure-test'))
  project.graph.nodes = [{ id: 'plot', type: 'viz.chart', label: '结果图', params: {}, position: { x: 0, y: 0 } }]
  return project
}

test('报告配图必须指向当前工程里唯一的 figure 节点', async () => {
  const project = chartProject()
  await assert.rejects(captureCurrentFigure(project, ''), (error: unknown) => error instanceof FigureCaptureError && error.code === 'E_PARAM_INVALID')
  await assert.rejects(captureCurrentFigure(project, 'absent'), (error: unknown) => error instanceof FigureCaptureError && error.code === 'E_UNKNOWN_REF')
  await assert.rejects(captureCurrentFigure(project, 'plot', ['wrong-group']), (error: unknown) => error instanceof FigureCaptureError && error.code === 'E_UNKNOWN_REF')

  project.graph.nodes.push({ id: 'source', type: 'data.source', label: '数据源', params: {}, position: { x: 100, y: 0 } })
  await assert.rejects(captureCurrentFigure(project, 'source'), (error: unknown) => error instanceof FigureCaptureError && error.code === 'E_PARAM_INVALID')
})

test('同一节点 id 出现在两层时需要明确组路径', async () => {
  const project = chartProject()
  project.graph.nodes.push({
    id: 'group', type: 'workflow.group', label: '子空间', params: {}, position: { x: 200, y: 0 },
    group: {
      workflow: { id: 'inner', name: 'inside', description: '', nodes: [{ id: 'plot', type: 'viz.chart', label: '子图', params: {}, position: { x: 0, y: 0 } }], edges: [] },
      inputs: [], outputs: [], parameters: [],
    },
  })
  await assert.rejects(captureCurrentFigure(project, 'plot'), (error: unknown) => error instanceof FigureCaptureError && error.code === 'E_PARAM_INVALID' && /groupPath/.test(error.message))
})

test('运行时声称 ready 但当前连线未完成时拒绝保存旧图', async () => {
  const project = chartProject()
  const output = useNodeOutputStore.getState()
  output.reset()
  output.setRuntime('plot', { status: 'ready', outputVersion: 1, inputsFingerprint: 'old-inputs' })
  try {
    await assert.rejects(captureCurrentFigure(project, 'plot'), (error: unknown) => error instanceof FigureCaptureError && error.code === 'E_EXECUTION_FAILED' && /缺少必需输入/.test(error.message))
  } finally {
    useNodeOutputStore.getState().reset()
  }
})
