import { create } from 'zustand'
import type { EngineStatus, NodeRuntime, OutputRef, OutputRefBody, PreviewTable } from '../engine/protocol'
import type { ProjectModelArtifactRef } from '../workflow/project'

/**
 * 节点输出索引。
 *
 * 刻意与工作流状态分开：工作流的每次编辑都会重建对象，而输出是按节点累积的，
 * 混在一起会让"改了一个参数"波及所有节点的订阅。
 *
 * 这里只放"目录卡片"和前 N 行的小表 —— 全表在 Python 侧，不进这个 store。
 */

export const headKey = (nodeId: string, portId: string, version: number, n: number): string =>
  `${nodeId}|${portId}|${version}|${n}`

const IDLE: NodeRuntime = { status: 'idle', outputVersion: 0, inputsFingerprint: null }

interface NodeOutputState {
  runtimes: Record<string, NodeRuntime>
  /** 当前打开工程保存的训练制品引用；与易失的输出缓存分开 */
  modelArtifacts: ProjectModelArtifactRef[]
  refs: Record<string, Record<string, OutputRef>>
  /** key = headKey()。缓存键含 version，上游重算后自动失效 */
  heads: Record<string, PreviewTable>
  engine: { status: EngineStatus; detail: string }
  /**
   * 调度器级别的失败：**整张图**现在算不了（比如组块结构有坏绑定）。
   *
   * 与节点自己的 `runtime.error` 分开：那种是"这一步算错了"，这个是"这一轮根本没开始算"。
   * 没有它的时候，图上所有块都停在空状态，谁也不说为什么 —— 实测踩到过：
   * 一条悬空的组块参数绑定让整张画布再也不出数，界面上一句解释都没有。
   */
  graphError: { message: string } | null

  setRuntime: (nodeId: string, runtime: NodeRuntime) => void
  setModelArtifacts: (artifacts: ProjectModelArtifactRef[]) => void
  recordModelArtifact: (artifact: ProjectModelArtifactRef) => void
  setProgress: (nodeId: string, ratio: number, message: string) => void
  setRefs: (nodeId: string, refs: Record<string, OutputRefBody>, version: number) => void
  putHead: (key: string, table: PreviewTable) => void
  setEngine: (status: EngineStatus, detail: string) => void
  setGraphError: (error: { message: string } | null) => void
  forget: (nodeId: string) => void
  reset: (nodeIds?: string[]) => void
}

export const useNodeOutputStore = create<NodeOutputState>((set, get) => ({
  runtimes: {},
  modelArtifacts: [],
  refs: {},
  heads: {},
  engine: { status: 'cold', detail: '' },
  graphError: null,

  setRuntime: (nodeId, runtime) =>
    set((s) => ({ runtimes: { ...s.runtimes, [nodeId]: runtime } })),

  setModelArtifacts: (modelArtifacts) => set({ modelArtifacts: [...modelArtifacts] }),
  recordModelArtifact: (artifact) =>
    set((s) => ({
      // 同一份制品可以被多个训练节点引用；去重键必须包含节点。
      // 同一节点再次收到同一制品时只更新引用，重训产生的新 artifactId 则保留为最新候选。
      modelArtifacts: s.modelArtifacts.some(
        (entry) => entry.nodeId === artifact.nodeId && entry.artifactId === artifact.artifactId,
      )
        ? s.modelArtifacts.map((entry) =>
            entry.nodeId === artifact.nodeId && entry.artifactId === artifact.artifactId
              ? artifact
              : entry,
          )
        : [...s.modelArtifacts, artifact],
    })),

  /**
   * 长任务的进度。**只给正在算的节点写**：
   *
   * - 一条迟到的进度不该把一个已经结束的节点叫醒（它会显示成"还在跑"）；
   * - 也不该凭空造出一个运行时 —— 界面上会出现一个从没开始过的节点。
   */
  setProgress: (nodeId, ratio, message) => {
    const current = get().runtimes[nodeId]
    if (!current || current.status !== 'computing') return
    set((s) => ({
      runtimes: {
        ...s.runtimes,
        [nodeId]: { ...s.runtimes[nodeId], progress: { ratio, message } },
      },
    }))
  },

  setRefs: (nodeId, refs, version) =>
    set((s) => {
      const withVersion: Record<string, OutputRef> = {}
      for (const [portId, body] of Object.entries(refs)) {
        withVersion[portId] = { ...body, version }
      }
      return { refs: { ...s.refs, [nodeId]: withVersion } }
    }),

  putHead: (key, table) => set((s) => ({ heads: { ...s.heads, [key]: table } })),

  setEngine: (status, detail) => set({ engine: { status, detail } }),

  setGraphError: (graphError) => set({ graphError }),

  forget: (nodeId) =>
    set((s) => {
      const runtimes = { ...s.runtimes }
      const refs = { ...s.refs }
      delete runtimes[nodeId]
      delete refs[nodeId]
      return { runtimes, refs }
    }),

  /** 引擎重置时清空一切 —— 旧输出已经不可信了 */
  reset: (nodeIds) =>
    set((s) => {
      if (!nodeIds) return { runtimes: {}, refs: {}, heads: {} }
      const runtimes = { ...s.runtimes }
      const refs = { ...s.refs }
      for (const id of nodeIds) {
        runtimes[id] = IDLE
        delete refs[id]
      }
      return { runtimes, refs }
    }),
}))

/* ---------------- 选择器 ---------------- */

export function useNodeRuntime(nodeId: string): NodeRuntime {
  return useNodeOutputStore((s) => s.runtimes[nodeId]) ?? IDLE
}

export function useNodeRefs(nodeId: string): Record<string, OutputRef> | undefined {
  return useNodeOutputStore((s) => s.refs[nodeId])
}

export function useEngineInfo(): { status: EngineStatus; detail: string } {
  return useNodeOutputStore((s) => s.engine)
}

/** 调度器级别的失败（整张图算不了）。非 null 时画布上常驻显示原因 */
export function useGraphError(): { message: string } | null {
  return useNodeOutputStore((s) => s.graphError)
}

export function useHead(key: string | null): PreviewTable | undefined {
  return useNodeOutputStore((s) => (key ? s.heads[key] : undefined))
}

export { IDLE as IDLE_RUNTIME }
