import { create } from 'zustand'

/**
 * 画布聚焦（点一个块看清它在流程里的位置）。
 *
 * 为什么单独一个 store 而不是画布里的 useState：实验笔记里的节点引用也要能点亮它
 * （点笔记里的 @块名 → 画布聚焦到那个块）。状态留在画布里，笔记就得反向去够画布，
 * 那是个假依赖；放这里，两边都只是读写同一个值。
 */
interface FocusState {
  focusedNodeId: string | null
  setFocusedNodeId: (id: string | null) => void
}

export const useCanvasFocusStore = create<FocusState>((set) => ({
  focusedNodeId: null,
  setFocusedNodeId: (id) => set({ focusedNodeId: id }),
}))
