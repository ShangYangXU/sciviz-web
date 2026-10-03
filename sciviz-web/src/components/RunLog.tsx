import { useEffect, useRef, useState } from 'react'
import { useActiveRun } from '../store/useWorkflowStore'

export function RunLog() {
  const run = useActiveRun()
  const [open, setOpen] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [run?.logs.length, open])

  const logs = run?.logs ?? []

  const toggle = () => setOpen((v) => !v)

  return (
    <footer className={`runlog ${open ? '' : 'collapsed'}`}>
      <div
        className="runlog-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? '收起执行日志' : '展开执行日志'}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <span className="runlog-title">
          <span className={`runlog-caret ${open ? 'open' : ''}`}>▸</span>
          执行日志
        </span>
        {run && (
          <span className="runlog-meta">
            {run.id} · {run.status === 'running' ? '运行中' : run.status === 'done' ? '完成' : run.status === 'cancelled' ? '已中断' : '有失败'}
            {run.finishedAt && ` · ${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`}
            {` · ${run.assets.length} 项资产`}
          </span>
        )}
      </div>
      {open && (
        <div className="runlog-body">
          {logs.length === 0 && <div className="runlog-empty">还没有执行记录。点顶部「运行」开始。</div>}
          {logs.map((l, i) => (
            <div key={i} className={`runlog-line lv-${l.level}`}>
              <span className="runlog-time">
                {new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              <span>{l.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </footer>
  )
}
