import { create } from 'zustand'
import {
  createAnnotation,
  createImageAnnotation,
  mindChild,
  type Annotation,
  type AnnotationKind,
  type AnnotationPosition,
} from '../workflow/annotations'
import { recordCanvasHistory } from './canvasHistory'

/**
 * 画布批注的状态。
 *
 * 为什么单独一个 store 而不是塞进 `useWorkflowStore`：执行引擎订阅的是工作流的变化
 * （`graphRunner` 里 `useWorkflowStore.subscribe(schedule)`）。批注若住在同一个对象里，
 * **每敲一个字都会触发一次全图重算规划** —— 而那批计算与便签上的字毫无关系。
 * 分开之后"改批注不惊动引擎"是结构给的，不是靠记得在哪个回调里加判断。
 *
 * 批注与工作流共用画布级撤回历史：删除便签、图片或表格后都能按 Ctrl+Z 恢复。
 */

/**
 * id 前缀与节点 id 分开（节点是 `n1_ab12`，批注是 `a1_ab12`、思维图分支是 `m1_ab12`）。
 * 两者会一起进 React Flow 的 nodes 数组，撞了 id 就是"两个节点变成一个"，
 * 而那不会有报错，只会有一块画布行为诡异。
 */
let seq = 0
const nextId = (prefix: 'a' | 'm'): string => `${prefix}${++seq}_${Date.now().toString(36).slice(-4)}`

/**
 * 「清掉工作流节点的选中」由画布在挂载时注入。
 *
 * 为什么不直接 import 工作流 store：两边的依赖方向是单向的（工作流 → 批注），反过来引会成环。
 * 而"新加的东西成为唯一选中"这条规则必须两边都成立：两套选中会一起进 React Flow 的同一份
 * 选中集合，留着上一条的选中，拖动新加的那条就会**把上一条也拖走** —— 在磁吸场景里这尤其要命
 * （拖便签去吸块，结果把块也拖跑了，而屏幕上看起来像是吸附算错了）。
 */
let clearWorkflowSelection: (() => void) | null = null

export function registerWorkflowSelectionClearer(fn: (() => void) | null): () => void {
  clearWorkflowSelection = fn
  return () => {
    if (clearWorkflowSelection === fn) clearWorkflowSelection = null
  }
}

interface AnnotationState {
  annotations: Annotation[]
  /** 与节点选中分开存：两套选中互不干扰（点空白要一起清，见 `clearSelection`） */
  selectedIds: string[]

  add: (kind: AnnotationKind, position: AnnotationPosition, groupPath?: readonly string[]) => string
  addImage: (
    src: string,
    position: AnnotationPosition,
    size?: { width?: number; height?: number },
    alt?: string,
    source?: string,
    groupPath?: readonly string[],
  ) => string
  /** 唯一的改动入口：具体规则在 `workflow/annotations.ts` 那层（纯函数、可单测） */
  replace: (id: string, updater: (a: Annotation) => Annotation) => void
  /**
   * 给思维图加一支。
   *
   * 为什么不放在视图里 `replace(id, m => mindChild(...))`：那样分支 id 就得由视图生成，
   * 而"id 长什么样、会不会跟节点 id 撞"这条规则只该有一处（见上面 nextId 的注释）。
   */
  addChild: (mapId: string, parentId: string) => void
  /**
   * 拖动的每一帧写一次位置。
   *
   * 拖谁就动谁：批注之间不再有吸附关系（2026-09-20 去掉），所以这里只管这一条的位置。
   */
  move: (id: string, position: AnnotationPosition) => void
  remove: (ids: string[]) => void
  setSelection: (ids: string[]) => void
  clearSelection: () => void
  /** 打开工程时用文件里那份整体替换 */
  setAll: (list: Annotation[]) => void
}

export const useAnnotationStore = create<AnnotationState>((set) => ({
  annotations: [],
  selectedIds: [],

  add: (kind, position, groupPath = []) => {
    const id = nextId('a')
    const created = createAnnotation(kind, id, position, () => nextId('m'), groupPath)
    recordCanvasHistory(`annotation:add:${id}`)
    clearWorkflowSelection?.()
    set((s) => ({ annotations: [...s.annotations, created], selectedIds: [id] }))
    return id
  },

  addImage: (src, position, size, alt, source, groupPath = []) => {
    const id = nextId('a')
    const created = createImageAnnotation(id, position, src, size, alt, source, groupPath)
    recordCanvasHistory(`annotation:add-image:${id}`)
    clearWorkflowSelection?.()
    set((s) => ({ annotations: [...s.annotations, created], selectedIds: [id] }))
    return id
  },

  replace: (id, updater) => {
    recordCanvasHistory(`annotation:edit:${id}`)
    set((s) => ({
      annotations: s.annotations.map((a) => (a.id === id ? updater(a) : a)),
    }))
  },

  addChild: (mapId, parentId) => {
    recordCanvasHistory(`annotation:child:${mapId}`)
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === mapId && a.kind === 'mindmap'
          ? { ...a, root: mindChild(a.root, parentId, nextId('m')) }
          : a,
      ),
    }))
  },

  move: (id, position) => {
    recordCanvasHistory(`annotation:move:${id}`)
    set((s) => ({
      annotations: s.annotations.map((a) => (a.id === id ? { ...a, position } : a)),
    }))
  },

  remove: (ids) => {
    if (!ids.some((id) => useAnnotationStore.getState().annotations.some((a) => a.id === id))) return
    recordCanvasHistory(`annotation:remove:${[...ids].sort().join(',')}`)
    set((s) => {
      const gone = new Set(ids)
      return {
        annotations: s.annotations.filter((a) => !gone.has(a.id)),
        selectedIds: s.selectedIds.filter((x) => !gone.has(x)),
      }
    })
  },

  setSelection: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [] }),
  setAll: (list) => {
    recordCanvasHistory('annotations:set')
    set({ annotations: list, selectedIds: [] })
  },
}))

/* ---------------- 选择器 ---------------- */

export function useAnnotations(): Annotation[] {
  return useAnnotationStore((s) => s.annotations)
}

/** 某一类批注的 id 集合。画布用它把 React Flow 的变更分派回正确的 store */
export function annotationIdSet(list: Annotation[]): Set<string> {
  return new Set(list.map((a) => a.id))
}

/** 不触发渲染地读一次当前批注（给非组件代码用：导出、体检、测试） */
export function allAnnotations(): Annotation[] {
  return useAnnotationStore.getState().annotations
}
