import { useRef, useState } from 'react'
import { importCsvFile, type ImportProgress } from '../data/importCsv'
import { FIXED_DATASET_ID } from '../data/fixedDataset'
import { estimateBytes, formatBytes } from '../data/columnStore'
import { useDataStore } from '../store/useDataStore'

interface Props {
  onClose: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; fileName: string; progress: ImportProgress }
  | { kind: 'error'; message: string }

export function ImportDialog({ onClose }: Props) {
  const imported = useDataStore((s) => s.imported)
  const addImported = useDataStore((s) => s.addImported)
  const removeImported = useDataStore((s) => s.removeImported)
  const setColumnEnabled = useDataStore((s) => s.setColumnEnabled)

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const editing = imported.find((d) => d.id === editingId) ?? imported[imported.length - 1] ?? null

  /** 统一的本地文件解析入口：文件拖入和文件选择都汇到这里。 */
  const runImport = async (file: File, displayName: string) => {
    setPhase({ kind: 'working', fileName: displayName, progress: { phase: '准备', ratio: 0 } })
    try {
      const ds = await importCsvFile(file, (progress) =>
        setPhase({ kind: 'working', fileName: displayName, progress }),
      )
      addImported(ds)
      setEditingId(ds.id)
      setPhase({ kind: 'idle' })
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleFile = (file: File) => runImport(file, file.name)

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) void handleFile(f)
    e.target.value = ''
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) void handleFile(f)
  }

  const busy = phase.kind === 'working'

  return (
    <div className="modal-mask" onClick={busy ? undefined : onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">导入数据</div>

        <div className="modal-body">
          {/* ---------- 选择文件 ---------- */}
          <div
            className={`dropzone ${dragOver ? 'over' : ''} ${busy ? 'busy' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              if (!busy) setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => !busy && fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,.tsv,text/csv"
              style={{ display: 'none' }}
              onChange={onPick}
            />
            {busy ? (
              <div className="dropzone-progress">
                <div className="dropzone-file">{phase.fileName}</div>
                <div className="progress-track">
                  <div className="progress-bar" style={{ width: `${Math.round(phase.progress.ratio * 100)}%` }} />
                </div>
                <div className="dropzone-hint">
                  {phase.progress.phase} · {Math.round(phase.progress.ratio * 100)}%
                </div>
                <div className="dropzone-hint">
                  在 Web Worker 里流式解析，界面不会卡。1000 万行的文件会慢一些，请勿关闭页面。
                </div>
              </div>
            ) : (
              <>
                <div className="dropzone-title">拖入 CSV 文件，或点击选择</div>
                <div className="dropzone-hint">
                  解析在后台线程进行。支持 UTF-8 / GBK，自动识别分隔符、表头、时间列与采样步长。
                </div>
              </>
            )}
          </div>

          {phase.kind === 'error' && <div className="dialog-error">{phase.message}</div>}

          {/* ---------- 已导入的数据集 ---------- */}
          {imported.length > 0 && (
            <div className="dataset-tabs">
              {imported.map((d) => (
                <button
                  key={d.id}
                  className={`dataset-tab ${d.id === editing?.id ? 'active' : ''}`}
                  onClick={() => setEditingId(d.id)}
                >
                  {d.name}
                  <span className="dataset-tab-rows">{d.rowCount.toLocaleString('en-US')} 行</span>
                </button>
              ))}
            </div>
          )}

          {/* ---------- 列选择与统计 ---------- */}
          {editing && (
            <>
              <div className="import-summary">
                <div>
                  <strong>{editing.source}</strong>
                </div>
                <div className="import-summary-grid">
                  <span>
                    行数 <b>{editing.rowCount.toLocaleString('en-US')}</b>
                  </span>
                  <span>
                    时间列 <b>{editing.timeColumn ?? '未识别'}</b>
                  </span>
                  <span>
                    采样步长 <b>{editing.stepSeconds ? `${editing.stepSeconds} s` : '不规则'}</b>
                  </span>
                  <span>
                    内存 <b>{formatBytes(estimateBytes(editing))}</b>
                  </span>
                </div>
                {editing.time && editing.rowCount > 0 && (
                  <div className="import-summary-range">
                    {new Date(editing.time[0] * 1000).toLocaleString('zh-CN', { hour12: false })} →{' '}
                    {new Date(editing.time[editing.rowCount - 1] * 1000).toLocaleString('zh-CN', {
                      hour12: false,
                    })}
                  </div>
                )}
              </div>

              <div className="col-table-head">
                <span>启用</span>
                <span>列名</span>
                <span className="num">最小</span>
                <span className="num">最大</span>
                <span className="num">均值</span>
                <span className="num">零值</span>
              </div>
              <div className="col-table">
                {editing.columns.map((c) => {
                  const isTime = c.role === 'time'
                  const zeroPct = editing.rowCount > 0 ? (c.stats.zeros / editing.rowCount) * 100 : 0
                  return (
                    <label
                      key={c.name}
                      className={`col-row ${isTime ? 'is-time' : ''} ${c.enabled ? '' : 'off'}`}
                    >
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        disabled={isTime}
                        onChange={(e) => setColumnEnabled(editing.id, c.name, e.target.checked)}
                      />
                      <span className="col-row-name" title={c.name}>
                        {c.name}
                        {isTime && <em>时间轴</em>}
                      </span>
                      <span className="num">{fmt(c.stats.min)}</span>
                      <span className="num">{fmt(c.stats.max)}</span>
                      <span className="num">{fmt(c.stats.mean)}</span>
                      <span className={`num ${zeroPct > 50 ? 'zero-high' : ''}`}>
                        {zeroPct >= 0.05 ? `${zeroPct.toFixed(1)}%` : '—'}
                      </span>
                    </label>
                  )
                })}
              </div>

              <div className="hint-box">
                关掉的列不会占用数据源节点的输出端口，也不参与下游计算。
                {editing.columns.some((c) => c.stats.zeros / Math.max(1, editing.rowCount) > 0.5) && (
                  <>
                    {' '}
                    <b>注意</b>：标红的列零值占比超过一半，多半是停机段。
                    本工具不做隐式清洗，需要的话请在工作流里用函数节点处理。
                  </>
                )}
              </div>

              {editing.id === FIXED_DATASET_ID ? (
                <div className="hint-box">
                  这是桌面版启动时自动读取的固定数据集，当前工作区内不能删除；修改固定文件路径后重启即可切换。
                </div>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                  <button
                    className="danger"
                    onClick={() => {
                      removeImported(editing.id)
                      setEditingId(null)
                    }}
                  >
                    删除这个数据集
                  </button>
                </div>
              )}
            </>
          )}

          {imported.length === 0 && phase.kind === 'idle' && (
            <div className="hint-box">
              还没有导入任何数据。请先选择一个本地 CSV 文件。
            </div>
          )}

          {imported.length > 0 && (
            <div className="hint-box">
              数据已加入当前工作区。请在画布的数据源节点中明确选择它，数据集会保留在本地工作区。
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="primary" onClick={onClose} disabled={busy}>
            {busy ? '解析中…' : '完成'}
          </button>
        </div>
      </div>
    </div>
  )
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e6 || (abs > 0 && abs < 1e-3)) return v.toExponential(2)
  if (abs >= 1000) return v.toFixed(1)
  if (abs >= 1) return v.toFixed(3)
  return v.toFixed(4)
}
