import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

interface FloatingReportWindowProps {
  mode: ReportWindowMode
  onModeChange: (mode: ReportWindowMode) => void
  children: ReactNode
}

export type ReportWindowMode = 'closed' | 'normal' | 'minimized' | 'maximized'

interface WindowPosition {
  left: number
  top: number
}

interface DragState {
  pointerId: number
  offsetX: number
  offsetY: number
}

/** A non-modal report window that leaves the canvas usable around it. */
export function FloatingReportWindow({ mode, onModeChange, children }: FloatingReportWindowProps) {
  const windowRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const restoreModeRef = useRef<'normal' | 'maximized'>('normal')
  const [position, setPosition] = useState<WindowPosition | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (mode === 'closed' || mode === 'minimized') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onModeChange('closed')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode, onModeChange])

  useEffect(() => {
    if (mode !== 'normal') {
      dragRef.current = null
      setDragging(false)
    }
  }, [mode])

  const minimize = () => {
    if (mode === 'normal' || mode === 'maximized') restoreModeRef.current = mode
    onModeChange('minimized')
  }

  const toggleMaximize = () => {
    onModeChange(mode === 'maximized' ? 'normal' : 'maximized')
  }

  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (mode !== 'normal') return
    const target = event.target
    if (event.button !== 0 || (target instanceof Element && target.closest('button, input, textarea, a'))) return
    const rect = windowRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    setPosition({ left: rect.left, top: rect.top })
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveWindow = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const width = windowRef.current?.offsetWidth ?? 0
    const left = Math.max(8, Math.min(event.clientX - drag.offsetX, window.innerWidth - Math.min(width, 160)))
    const top = Math.max(8, Math.min(event.clientY - drag.offsetY, window.innerHeight - 48))
    setPosition({ left, top })
  }

  const stopDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const visible = mode !== 'closed'
  const minimized = mode === 'minimized'
  const maximized = mode === 'maximized'

  return (
    <div className="report-floating-layer" hidden={!visible} aria-hidden={!visible}>
      {minimized && (
        <button
          type="button"
          className="report-minimized-dock"
          title="还原项目报告"
          aria-label="还原项目报告"
          onClick={() => onModeChange(restoreModeRef.current)}
        >
          <span className="report-minimized-icon" aria-hidden="true">▣</span>
          <span>项目报告</span>
          <span className="report-minimized-restore">还原</span>
        </button>
      )}
      <section
        ref={windowRef}
        className={`report-floating-window${dragging ? ' dragging' : ''}${maximized ? ' maximized' : ''}`}
        hidden={minimized}
        role="dialog"
        aria-label="项目报告浮窗"
        style={!maximized && position ? { left: position.left, top: position.top, transform: 'none' } : undefined}
      >
        <header
          className="report-floating-titlebar"
          onPointerDown={startDrag}
          onPointerMove={moveWindow}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
        >
          <span>项目报告</span>
          <span className="report-floating-hint">拖动标题栏移动 · 拖动右下角调整大小</span>
          <div className="report-window-controls" aria-label="窗口控制">
            <button type="button" aria-label="最小化项目报告" title="最小化" onClick={minimize}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
            </button>
            <button
              type="button"
              aria-label={maximized ? '还原项目报告窗口' : '最大化项目报告窗口'}
              title={maximized ? '还原' : '最大化'}
              onClick={toggleMaximize}
            >
              {maximized
                ? <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M8 4H2v6h6z" /></svg>
                : <svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.25" y="2.25" width="7.5" height="7.5" rx="0.5" /></svg>}
            </button>
            <button type="button" className="close" aria-label="关闭项目报告" title="关闭" onClick={() => onModeChange('closed')}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
            </button>
          </div>
        </header>
        <div className="report-floating-content">{children}</div>
      </section>
    </div>
  )
}
