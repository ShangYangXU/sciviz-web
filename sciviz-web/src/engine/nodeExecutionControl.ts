/**
 * 画布里需要用户明确启动的节点请求。
 *
 * 这是会话态，不写进工作流参数：点击“开始训练”不是修改实验配置，刷新后也不该
 * 自动恢复一个尚未确认的 GPU 任务。CLI 的 run 本身就是显式请求，不经过这里。
 */

const requested = new Set<string>()
const forceTraining = new Set<string>()
const listeners = new Set<() => void>()

export function requestNodeExecution(nodeId: string, options: { force?: boolean } = {}): void {
  requested.add(nodeId)
  if (options.force) forceTraining.add(nodeId)
  else forceTraining.delete(nodeId)
  for (const listener of listeners) listener()
}

export function nodeExecutionRequested(nodeId: string): boolean {
  return requested.has(nodeId)
}

/** 本次显式请求是否必须跳过工程中已有的训练制品，真正重新训练。 */
export function nodeExecutionForcesTraining(nodeId: string): boolean {
  return forceTraining.has(nodeId)
}

export function finishNodeExecution(nodeId: string): void {
  requested.delete(nodeId)
  forceTraining.delete(nodeId)
}

export function forgetNodeExecution(nodeId: string): void {
  requested.delete(nodeId)
  forceTraining.delete(nodeId)
}

export function onNodeExecutionRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 仅供测试清理模块级会话态。 */
export function resetNodeExecutionRequests(): void {
  requested.clear()
  forceTraining.clear()
}
