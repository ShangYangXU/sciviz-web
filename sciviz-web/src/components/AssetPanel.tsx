import { useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useWorkflowStore } from '../store/useWorkflowStore'
import { assetKindMeta, type AssetKind, type RunAsset } from '../workflow/types'
import { decimateModeFor, storedRowCount, useImportedDatasets } from '../store/useDataStore'
import { chartDataset } from '../store/nodeChart'
import { ChartRenderer } from '../charts/ChartRenderer'
import { DatasetPreview } from './DatasetPreview'
import { formatNumber } from '../utils/stats'
import { useAnnotationStore } from '../store/useAnnotationStore'
import { fitImageSize, svgSize, svgToDataUrl } from '../canvas/canvasMedia'
import { FigureImageView, figureImageUrl } from '../charts/FigureImageView'

const kindOrder: AssetKind[] = ['dataset', 'feature', 'scaler', 'model', 'metric', 'figure']

function AssetDetail({ asset, onClose }: { asset: RunAsset; onClose: () => void }) {
  // 订阅导入数据集，列开关变化后视图要重算
  const imported = useImportedDatasets()
  void imported
  // 上游表直接画的那种图带着自己的抽样点（数据只在引擎侧，没有数据集可查）。
  // "先认 inline 再查数据集"这条判断与画布上那张缩略图共用 chartDataset()：
  // 两处画的必须同一张图
  const inline = asset.chart?.inline
  const figureImage = asset.chart?.image
  const decimateMode = asset.chart ? decimateModeFor(asset.chart.type) : 'envelope'
  const dataset = asset.chart ? chartDataset(asset.chart) : undefined
  const rawRows = asset.chart && !inline && !figureImage ? storedRowCount(asset.chart.datasetId) : null
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const addImage = useAnnotationStore((s) => s.addImage)
  const activeGroupPath = useWorkflowStore((s) => s.activeGroupPath)
  const { screenToFlowPosition } = useReactFlow()

  const pasteToCanvas = () => {
    if (figureImage) {
      const size = fitImageSize(figureImage.width, figureImage.height)
      const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      addImage(
        figureImageUrl(figureImage),
        { x: position.x - size.width / 2, y: position.y - size.height / 2 },
        size,
        `${asset.name} 图表`,
        'Matplotlib 图像',
        activeGroupPath,
      )
      onClose()
      return
    }
    const svg = previewRef.current?.querySelector('svg.chart-svg')
    if (!(svg instanceof SVGElement)) return
    const size = svgSize(svg)
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    addImage(
      svgToDataUrl(svg),
      { x: position.x - size.width / 2, y: position.y - size.height / 2 },
      size,
      `${asset.name} 图表`,
      '资产库图表',
      activeGroupPath,
    )
    onClose()
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className={`asset-icon k-${asset.kind}`}>{assetKindMeta[asset.kind].icon}</span>
          {asset.name}
          <span className="asset-sub">
            {assetKindMeta[asset.kind].label} · 由「{asset.nodeLabel}」产出
          </span>
        </div>
        <div className="modal-body">
          {asset.chart && (dataset || figureImage) && (
            <div className="preview-paper" ref={previewRef} onMouseLeave={() => setTip(null)}>
              {figureImage ? (
                <FigureImageView image={figureImage} alt={`${asset.name} 的 Matplotlib 绘图`} />
              ) : dataset ? (
                <ChartRenderer
                  chart={asset.chart}
                  dataset={dataset}
                  onHover={(e, lines) => setTip({ x: e.clientX, y: e.clientY, lines })}
                />
              ) : null}
            </div>
          )}
          {asset.kind === 'dataset' && asset.datasetId && (
            <DatasetPreview datasetId={asset.datasetId} />
          )}
          {asset.chart && dataset && rawRows !== null && (
            <div className="field-note" style={{ marginTop: 6 }}>
              原始 {rawRows.toLocaleString('en-US')} 行，图上按
              {decimateMode === 'envelope' ? ' min/max 包络' : '等距抽样'}抽稀到{' '}
              {dataset.rows.length.toLocaleString('en-US')} 行显示（
              {decimateMode === 'envelope'
                ? '保住单点毛刺'
                : '保证分布形状无偏，包络抽稀会扭曲直方图与密度图'}
              ）
            </div>
          )}
          {asset.chart && inline && (
            <div className="field-note" style={{ marginTop: 6 }}>
              这张图直接画上游那一步的表（不是导入的数据集）：图上 {inline.rows.length.toLocaleString('en-US')} 点，
              {typeof asset.summary?.原始行数 === 'number'
                ? `来自 ${asset.summary.原始行数.toLocaleString('en-US')} 行的抽稀`
                : '按图型抽稀'}
              。
            </div>
          )}
          {asset.chart && !dataset && !figureImage && (
            <div className="hint-box warn">找不到该图表引用的数据源「{asset.chart.datasetId}」</div>
          )}
          {!asset.chart && (
            <table className="asset-table">
              <tbody>
                {asset.table && (
                  <>
                    <tr>
                      <th>规模</th>
                      <td>
                        {asset.table.rows} 行 × {asset.table.cols} 列
                      </td>
                    </tr>
                  </>
                )}
                {asset.summary &&
                  Object.entries(asset.summary).map(([k, v]) => (
                    <tr key={k}>
                      <th>{k}</th>
                      <td>{String(v)}</td>
                    </tr>
                  ))}
                <tr>
                  <th>来源节点</th>
                  <td>
                    {asset.nodeLabel} <code>{asset.nodeType}</code>
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {asset.scaler && (
            <div className="dp-section">
              <div className="dp-title">
                逐列参数
                <span className="dp-sub">
                  (x − center) / scale · 拟合自 {asset.scaler.fittedRows.toLocaleString('en-US')} 行
                </span>
              </div>
              <div className="dp-table-scroll">
                <table className="dp-stats">
                  <thead>
                    <tr>
                      <th>列</th>
                      <th className="num">center</th>
                      <th className="num">scale</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {asset.scaler.columns.map((c) => (
                      <tr key={c.name}>
                        <td>{c.name}</td>
                        <td className="num">{formatNumber(c.center)}</td>
                        <td className="num">{formatNumber(c.scale)}</td>
                        <td>{c.constant ? '常值，未缩放' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="field-note">
                这份参数要随权重一起保存：评估和推理必须复用同一套 center/scale，各自重新拟合就不是同一个变换，指标也就不可比。
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {asset.chart && (dataset || figureImage) && (
            <button className="primary" onClick={pasteToCanvas}>
              贴到画布
            </button>
          )}
          <button onClick={onClose}>关闭</button>
        </div>
      </div>

      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AssetPanel() {
  const runs = useWorkflowStore((s) => s.runs)
  const activeRunId = useWorkflowStore((s) => s.activeRunId)
  const clearRuns = useWorkflowStore((s) => s.clearRuns)
  const [detail, setDetail] = useState<RunAsset | null>(null)

  const run = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null

  if (!run) {
    return (
      <div className="panel-body">
        <div className="empty-hint">
          还没有任何产出。
          <br />
          <br />
          点顶部「运行」执行工作流，节点产出的模型、指标、图会自动收进这里，不需要手动保存。
        </div>
      </div>
    )
  }

  const grouped = kindOrder
    .map((kind) => ({ kind, items: run.assets.filter((a) => a.kind === kind) }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="panel-body">
      <div className="run-picker">
        <label>本次运行</label>
        <div className="run-picker-value">
          <code>{run.id}</code>
          <span className={`run-status s-${run.status}`}>
            {run.status === 'running'
              ? '运行中'
              : run.status === 'done'
                ? '完成'
                : run.status === 'cancelled'
                  ? '已中断'
                  : '有失败'}
          </span>
        </div>
        {runs.length > 1 && (
          <div className="run-history">
            历史 {runs.length - 1} 次
            <button className="icon-btn" onClick={clearRuns} title="清空全部运行记录">
              清空
            </button>
          </div>
        )}
      </div>

      {run.assets.length === 0 && (
        <div className="empty-hint">
          {run.status === 'running' ? '正在产出…' : '这次运行没有产出资产'}
        </div>
      )}

      {grouped.map(({ kind, items }) => {
        const meta = assetKindMeta[kind]
        return (
          <div className="asset-group" key={kind}>
            <div className="asset-group-head">
              <span className={`asset-icon k-${kind}`}>{meta.icon}</span>
              {meta.label}
              <span className="asset-count">{items.length}</span>
            </div>
            {items.map((a) => (
              <button className="asset-row" key={a.id} onClick={() => setDetail(a)}>
                <div className="asset-row-main">
                  <span className="asset-name">{a.name}</span>
                  <span className="asset-src">← {a.nodeLabel}</span>
                </div>
              </button>
            ))}
          </div>
        )
      })}

      {detail && <AssetDetail asset={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}
