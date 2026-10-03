import { useMemo, useRef, useState } from 'react'
import { compressImageForNotebook } from '../canvas/canvasMedia'
import { useNotebookStore } from '../store/useNotebookStore'
import { useEditingWorkflow, useWorkflowStore } from '../store/useWorkflowStore'
import { useCanvasFocusStore } from '../store/useCanvasFocusStore'
import {
  nodeReference,
  notebookLength,
  notebookOutline,
  renderNotebook,
} from '../workflow/notebook'

/**
 * 实验笔记栏。
 *
 * 三条设计取舍（都是"让它少挡路"）：
 * 1. **一整篇 Markdown**，大纲由标题自动生成 —— 记之前不用先想"放哪一节"。
 * 2. **图片内嵌**（粘贴时压到 1600 长边）—— 浏览器里拿不到工程旁边的目录，内嵌是唯一
 *    能跨机器带走的做法，代价是工程文件会变大。
 * 3. **引用节点**：把块选中后点「引用选中的块」，或直接写 `@[块名](node:节点id)`；
 *    点笔记里的引用，画布聚焦到那个块（记录与图因此仍然互相追得上）。
 */
export function NotebookPanel() {
  const markdown = useNotebookStore((s) => s.markdown)
  const setMarkdown = useNotebookStore((s) => s.setMarkdown)
  const workflow = useEditingWorkflow()
  const selectedNodeIds = useWorkflowStore((s) => s.selectedNodeIds)
  const setFocusedNodeId = useCanvasFocusStore((s) => s.setFocusedNodeId)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [showOutline, setShowOutline] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  const outline = useMemo(() => notebookOutline(markdown), [markdown])
  const labelOf = useMemo(() => {
    const byId = new Map(workflow.nodes.map((node) => [node.id, node.label]))
    return (id: string) => byId.get(id) ?? null
  }, [workflow.nodes])
  const preview = useMemo(
    () => (mode === 'preview' ? renderNotebook(markdown, labelOf) : ''),
    [mode, markdown, labelOf],
  )

  /** 在光标处插入一段文本（引用、图片都走这儿），插完把光标放到它后面 */
  const insert = (text: string) => {
    const editor = editorRef.current
    const at = editor ? editor.selectionStart : markdown.length
    const next = `${markdown.slice(0, at)}${text}${markdown.slice(at)}`
    setMarkdown(next)
    if (editor) {
      requestAnimationFrame(() => {
        editor.focus()
        editor.setSelectionRange(at + text.length, at + text.length)
      })
    }
  }

  const referenceSelected = () => {
    const id = selectedNodeIds[selectedNodeIds.length - 1]
    const label = id ? labelOf(id) : null
    if (!id || !label) {
      setNotice('先在画布上点一个块，再回来点这里')
      window.setTimeout(() => setNotice(null), 2000)
      return
    }
    insert(`${nodeReference(id, label)}`)
    setMode('edit')
  }

  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const item = Array.from(event.clipboardData.items).find((x) => x.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (!file) return
    event.preventDefault()
    insert(`\n![实验图片](${await compressImageForNotebook(file)})\n`)
  }

  const jumpTo = (offset: number) => {
    setMode('edit')
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      editor.setSelectionRange(offset, offset)
      // 光标移过去之后滚动到那一行附近
      const ratio = markdown.length ? offset / markdown.length : 0
      editor.scrollTop = ratio * editor.scrollHeight
    })
  }

  const onPreviewClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest('button.nb-node') as HTMLElement | null
    const id = button?.dataset.node
    if (id) setFocusedNodeId(id)
  }

  return (
    <div className="nb-panel">
      <div className="nb-toolbar">
        <div className="nb-seg">
          <button
            type="button"
            className={mode === 'edit' ? 'active' : ''}
            onClick={() => setMode('edit')}
          >
            编辑
          </button>
          <button
            type="button"
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => setMode('preview')}
          >
            预览
          </button>
        </div>
        <button type="button" className="nb-btn" onClick={referenceSelected} title="把画布上选中的块写成一条引用">
          @ 引用选中的块
        </button>
        <span className="nb-count">{notebookLength(markdown)} 字</span>
      </div>

      {outline.length > 0 && (
        <div className="nb-outline">
          <button type="button" className="nb-outline-head" onClick={() => setShowOutline((v) => !v)}>
            {showOutline ? '▾' : '▸'} 大纲（{outline.length} 节）
          </button>
          {showOutline && (
            <ul>
              {outline.map((item) => (
                <li key={`${item.offset}-${item.title}`} style={{ paddingLeft: (item.level - 1) * 10 }}>
                  <button type="button" onClick={() => jumpTo(item.offset)}>
                    {item.title || '（空标题）'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mode === 'edit' ? (
        <textarea
          ref={editorRef}
          className="nb-editor"
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
          onPaste={(e) => void onPaste(e)}
          placeholder={
            '实验笔记：想记就记。\n\n## 实验 1：原始信号\n换了 3 号泵的密封，振动峰值从 0.71 降到 0.42（上游见 @[时域特征](node:节点id)）。\n\n图片直接粘进来就行。'
          }
          spellCheck={false}
        />
      ) : (
        <div className="nb-preview" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: preview }} />
      )}

      {notice && <div className="nb-notice">{notice}</div>}
      <div className="nb-hint">
        记的是"为什么"（读数、判断、下次要验什么）；图片直接粘贴；`##` 开头的标题会自动进大纲。
      </div>
    </div>
  )
}
