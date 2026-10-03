import test from 'node:test'
import assert from 'node:assert/strict'
import { humanizePatch } from './humanizePatch'
import { applyPatch } from '../kernel/patch'
import { emptyProject } from '../workflow/project'
import { emptyWorkflow } from '../workflow/defaultWorkflow'
import { defaultParams, getNodeTypeDef } from '../workflow/nodeRegistry'
import type { Project } from '../workflow/project'
import type { PatchFile } from '../contract/ops'

function projectWithNamedNodes(): Project {
  const base = emptyProject(emptyWorkflow('human-readable'))
  const source = {
    id: 'n1',
    type: 'data.source',
    label: '输入数据',
    params: { ...defaultParams(getNodeTypeDef('data.source')), datasetId: 'ds-1' },
    position: { x: 0, y: 0 },
  }
  return {
    ...base,
    datasets: [{ id: 'ds-1', name: '锅炉测试集', timeColumn: null, columns: [{ name: '液位', type: 'number', role: 'continuous', enabled: true }] }],
    graph: { ...base.graph, nodes: [source], edges: [] },
  }
}

test('补丁给模型的摘要使用画布名称，不把内部节点 id 和端口 id 当正文', () => {
  const project = projectWithNamedNodes()
  const patch: PatchFile = {
    reason: '测试',
    ops: [
      { op: 'addNode', id: 'n2', type: 'data.preview', label: '测试集预览' },
      { op: 'connect', source: 'n1', sourcePort: '__table__', target: 'n2', targetPort: 'data' },
    ],
  }
  const applied = applyPatch(project, patch)
  assert.equal(applied.ok, true, JSON.stringify(applied.rejections))
  const changes = humanizePatch(applied.project, patch)

  assert.match(changes[0], /新增图块「测试集预览」/)
  assert.doesNotMatch(changes[0], /n2/)
  assert.match(changes[1], /输入数据/)
  assert.match(changes[1], /测试集预览/)
  assert.doesNotMatch(changes[1], /n1|n2|__table__|output:/)
})
