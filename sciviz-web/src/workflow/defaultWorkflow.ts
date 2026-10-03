import type { Workflow } from './types'

/** 默认工作流保持空白，所有节点和数据都由用户显式添加。 */
export const defaultWorkflow: Workflow = {
  id: 'wf-blank',
  name: '未命名工作流',
  description: '',
  nodes: [],
  edges: [],
}

export function emptyWorkflow(id: string, name = '未命名工作流'): Workflow {
  return { id, name, description: '', nodes: [], edges: [] }
}
