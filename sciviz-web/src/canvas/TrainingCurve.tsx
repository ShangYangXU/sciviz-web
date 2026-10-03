import { useEffect, useRef } from 'react'
import { head as fetchHead } from '../engine/backend'
import { getPalette } from '../charts/palettes'
import {
  headKey,
  useEngineInfo,
  useHead,
  useNodeOutputStore,
  useNodeRefs,
  useNodeRuntime,
} from '../store/nodeOutputStore'
import { formatNumber } from '../utils/stats'
import { curveSeriesFromTable, seriesRange } from '../workflow/trainingCurve'
import { useAnnotationStore } from '../store/useAnnotationStore'
import { useWorkflowStore } from '../store/useWorkflowStore'
import { svgSize, svgToDataUrl } from './canvasMedia'

/**
 * 训练节点上的小曲线：**直出**，不必手工接一个图表节点。
 *
 * 为什么另外画一个小图，而不是复用 `ChartRenderer`：那个是详情面板那张 800×520 的
 * 画布（坐标轴、图例、hover），缩进 260px 的节点框里字会小到看不清。这个位置要回答的
 * 只是"走势对不对、有没有掉下去"，所以只画线，外加每个曲线的最后一个值。
 *
 * 行值仍然按需去引擎取（`head`），并按输出 `version` 缓存 —— 与探针同一条规矩：
 * 全表在 Python 侧，界面只拿它要显示的那几条。
 */

/** 取多少行。一次训练最多几百轮、几列曲线，2000 行足够覆盖；取多了也只是白搬 */
const CURVE_ROWS = 2000
const W = 208
const H = 56

export function TrainingCurve({ nodeId, position }: { nodeId: string; position: { x: number; y: number } }) {
  const ref = useNodeRefs(nodeId)?.curve
  const runtime = useNodeRuntime(nodeId)
  const engine = useEngineInfo()
  const cacheKey =
    ref && ref.kind === 'table' ? headKey(nodeId, 'curve', ref.version, CURVE_ROWS) : null
  const table = useHead(cacheKey)
  const curveRef = useRef<HTMLDivElement>(null)
  const addImage = useAnnotationStore((s) => s.addImage)
  const activeGroupPath = useWorkflowStore((s) => s.activeGroupPath)

  useEffect(() => {
    if (!cacheKey || table || runtime.status !== 'ready' || engine.status !== 'ready') return
    let cancelled = false
    fetchHead(nodeId, 'curve', CURVE_ROWS)
      .then((t) => {
        if (!cancelled) useNodeOutputStore.getState().putHead(cacheKey, t)
      })
      .catch(() => {
        // 取不到就不画：这里只是个缩略图，报错留给探针与运行日志去做
      })
    return () => {
      cancelled = true
    }
  }, [cacheKey, table, runtime.status, engine.status, nodeId])

  if (!table) return null
  const series = curveSeriesFromTable(table)
  if (series.length === 0) return null

  const xs = series.flatMap((s) => s.points.map((p) => p.x))
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const spanX = x1 - x0 || 1
  const colors = getPalette('okabe-ito').categorical

  const drawn = series.map((s, i) => {
    const [lo, hi] = seriesRange(s.points)
    const spanY = hi - lo || 1
    const d = s.points
      .map((p, j) => {
        const px = ((p.x - x0) / spanX) * W
        const py = H - ((p.y - lo) / spanY) * (H - 4) - 2
        return `${j === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`
      })
      .join(' ')
    return {
      name: s.name,
      color: colors[i % colors.length],
      d,
      last: s.points[s.points.length - 1]?.y,
      rounds: s.points.length,
    }
  })

  const pasteToCanvas = () => {
    const svg = curveRef.current?.querySelector('svg')
    if (!(svg instanceof SVGElement)) return
    const size = svgSize(svg)
    addImage(
      svgToDataUrl(svg),
      { x: position.x + 250, y: position.y + 250 },
      size,
      '训练曲线',
      '训练曲线快照',
      activeGroupPath,
    )
  }

  return (
    <div
      className="wf-node-curve"
      ref={curveRef}
      title={`训练曲线（${series[0]?.points[0]?.x ?? 0} → ${x1} 轮）。每条曲线各自缩放到自己的范围 —— 这里看走势，具体数值在指标与曲线表里`}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="训练曲线">
        {drawn.map((s) => (
          <path key={s.name} d={s.d} fill="none" stroke={s.color} strokeWidth={1.6} />
        ))}
      </svg>
      <button
        type="button"
        className="wf-chart-paste nodrag"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={pasteToCanvas}
        title="把训练曲线作为图片贴到画布上"
      >
        贴到画布
      </button>
      <div className="wf-node-curve-legend">
        {drawn.map((s) => (
          <span key={s.name} className="wf-node-curve-item">
            <i style={{ background: s.color }} />
            {s.name} {s.last === undefined ? '—' : formatNumber(s.last)}
          </span>
        ))}
      </div>
    </div>
  )
}
