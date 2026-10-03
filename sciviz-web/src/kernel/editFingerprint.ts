import type { Project } from '../workflow/project'
import { sha256Hex, stableStringify } from '../agent/context'

/**
 * 对“补丁可以改变的工程状态”取摘要。
 * runs、patch 历史、批注、笔记、项目报告、模型制品与会话都明确排除，避免审计或展示状态
 * 让一份仍然可安全应用的图补丁失效（写完一份报告，不该等于图上被人动过手）。
 */
export function editableProjectView(project: Project): Record<string, unknown> {
  return {
    name: project.name,
    description: project.description,
    graph: project.graph,
    datasets: project.datasets,
  }
}

export async function projectEditFingerprint(project: Project): Promise<string> {
  return `sha256:${await sha256Hex(stableStringify(editableProjectView(project)))}`
}

/**
 * 对“保存到 .sciviz 的完整工作区状态”取摘要。
 *
 * 它和 projectEditFingerprint 刻意是两件事：补丁基准不应因批注/笔记变化而失效，
 * 但自动保存必须把这些内容视为工程的一部分，否则会出现“画布保存了，笔记却丢了”。
 */
export function persistedProjectView(project: Project): Record<string, unknown> {
  return {
    version: project.version,
    projectId: project.projectId,
    name: project.name,
    description: project.description,
    graph: project.graph,
    annotations: project.annotations,
    notebook: project.notebook,
    reports: project.reports,
    datasets: project.datasets,
    modelArtifacts: project.modelArtifacts,
    patches: project.patches,
  }
}

export async function projectPersistenceFingerprint(project: Project): Promise<string> {
  return `sha256:${await sha256Hex(stableStringify(persistedProjectView(project)))}`
}
