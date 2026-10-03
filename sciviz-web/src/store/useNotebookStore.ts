import { create } from 'zustand'

/**
 * 实验笔记：一份 Markdown 正文，跟着工程文件走。
 *
 * 为什么不进"画布撤回历史"：它是**文本编辑器**，Ctrl+Z 该由输入框自己管（浏览器原生撤销），
 * 混进画布历史会出现"Ctrl+Z 撤掉了刚才那条连线，而不是我刚打错的那个字"。笔记的内容
 * 存在工程文件里，本来就有版本管理（git）。
 */
interface NotebookState {
  markdown: string
  setMarkdown: (text: string) => void
  /** 打开工程时用文件里那份整体替换 */
  setAll: (text: string) => void
}

export const useNotebookStore = create<NotebookState>((set) => ({
  markdown: '',
  setMarkdown: (text) => set({ markdown: text }),
  setAll: (text) => set({ markdown: text }),
}))

export function notebookText(): string {
  return useNotebookStore.getState().markdown
}
