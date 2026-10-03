import { create } from 'zustand'
import type { Annotation } from '../workflow/annotations'
import type { Workflow } from '../workflow/types'

/** 一次画布状态快照：工作流和画布批注一起撤回，避免出现只恢复一半的情况。 */
export interface CanvasSnapshot {
  workflow: Workflow
  annotations: Annotation[]
}

interface CanvasHistoryBridge {
  read: () => CanvasSnapshot
  restore: (snapshot: CanvasSnapshot) => void
}

interface HistoryState {
  past: CanvasSnapshot[]
  future: CanvasSnapshot[]
  canUndo: boolean
  canRedo: boolean
  record: (key?: string) => void
  undo: () => void
  redo: () => void
  clear: () => void
}

let bridge: CanvasHistoryBridge | null = null
let restoring = 0
let lastRecord: { key: string; at: number } | null = null

/** 由画布挂载时安装读写桥；历史模块本身不依赖两个业务 store，避免循环引用。 */
export function registerCanvasHistory(next: CanvasHistoryBridge): () => void {
  bridge = next
  return () => {
    if (bridge === next) bridge = null
  }
}

export const useCanvasHistory = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,

  record: (key = 'edit') => {
    if (!bridge || restoring > 0) return
    const now = Date.now()
    // 拖动节点、连续改表格单元格等属于一次连续操作，只保留操作开始前的快照。
    if (lastRecord && lastRecord.key === key && now - lastRecord.at < 650) {
      lastRecord.at = now
      return
    }
    const snapshot = bridge.read()
    lastRecord = { key, at: now }
    set((s) => {
      const past = [...s.past, snapshot].slice(-100)
      return { past, future: [], canUndo: past.length > 0, canRedo: false }
    })
  },

  undo: () => {
    if (!bridge) return
    const state = get()
    if (state.past.length === 0) return
    const current = bridge.read()
    const target = state.past[state.past.length - 1]
    lastRecord = null
    set({
      past: state.past.slice(0, -1),
      future: [current, ...state.future].slice(0, 100),
      canUndo: state.past.length > 1,
      canRedo: true,
    })
    restoring += 1
    try {
      bridge.restore(target)
    } finally {
      restoring -= 1
    }
  },

  redo: () => {
    if (!bridge) return
    const state = get()
    if (state.future.length === 0) return
    const current = bridge.read()
    const target = state.future[0]
    lastRecord = null
    set({
      past: [...state.past, current].slice(-100),
      future: state.future.slice(1),
      canUndo: true,
      canRedo: state.future.length > 1,
    })
    restoring += 1
    try {
      bridge.restore(target)
    } finally {
      restoring -= 1
    }
  },

  clear: () => {
    lastRecord = null
    set({ past: [], future: [], canUndo: false, canRedo: false })
  },
}))

/** 业务 store 在真正改动前调用；画布未挂载时自动忽略。 */
export function recordCanvasHistory(key?: string): void {
  useCanvasHistory.getState().record(key)
}

/** 批量载入工程时暂停单步记录，避免一次导入拆成“只恢复工作流/只恢复批注”两步。 */
export function suspendCanvasHistory<T>(fn: () => T): T {
  restoring += 1
  lastRecord = null
  try {
    return fn()
  } finally {
    restoring -= 1
  }
}
