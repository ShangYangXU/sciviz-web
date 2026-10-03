import { useCanvasHistory } from '../store/canvasHistory'

export function HistoryBar() {
  const canUndo = useCanvasHistory((s) => s.canUndo)
  const canRedo = useCanvasHistory((s) => s.canRedo)
  const undo = useCanvasHistory((s) => s.undo)
  const redo = useCanvasHistory((s) => s.redo)

  return (
    <div className="canvas-history-bar" aria-label="画布历史操作">
      <button
        type="button"
        className="canvas-tool-btn"
        disabled={!canUndo}
        onMouseDown={(e) => e.preventDefault()}
        onClick={undo}
        title="撤回上一步（Ctrl+Z）"
      >
        ↶ 撤回
      </button>
      <button
        type="button"
        className="canvas-tool-btn"
        disabled={!canRedo}
        onMouseDown={(e) => e.preventDefault()}
        onClick={redo}
        title="重做上一步（Ctrl+Y）"
      >
        ↷ 重做
      </button>
    </div>
  )
}

