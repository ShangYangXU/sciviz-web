import { useEffect, useRef, useState } from 'react'
import { ChartRenderer } from '../charts/ChartRenderer'
import { resolveFigureUpstreamTable } from '../workflow/ports'
import { useEditingWorkflow, useWorkflowStore } from '../store/useWorkflowStore'
import { useNodeRefs, useNodeRuntime } from '../store/nodeOutputStore'
import { figurePortId, resolveNodeChartAtPath, type NodeChart } from '../store/nodeChart'
import type { WorkflowNode } from '../workflow/types'
import { useAnnotationStore } from '../store/useAnnotationStore'
import { fitImageSize, svgSize, svgToDataUrl } from './canvasMedia'
import { FigureImageView, figureImageUrl } from '../charts/FigureImageView'
import { runtimeNodeIdForPath } from '../workflow/groups'

/**
 * 图表节点框上的实时预览。
 *
 * 存在的理由：**接上数据就该看见图**。在此之前"这张图长什么样"只存在于资产库里，
 * 而资产库要一次「运行」才有条目 —— 于是"连上线 → 点运行 → 切 tab → 点开条目"
 * 成了看一眼图的固定成本。数据面其实早就算好了（图表节点是引擎节点，改一根线
 * 300ms 后就重算），缺的只是把它当场画出来。
 *
 * 三条约定：
 *
 * 1. 画法只有一份：走 `resolveNodeChart` 与 `ChartRenderer mini` —— 与资产库那张
 *    同一份取数、同一套分箱/KDE/箱线图统计。缩略图与大图不一致，比没有缩略图更糟。
 * 2. **图只来自上游实际产物**。尚未接线或尚未算出点时就给出状态说明，不会另取
 *    一份数据集临时画图。
 * 3. 不接管 hover：这格位置回答的是"形状对不对"，读数去资产库那张大图。
 */

const noop = () => {}

export function ChartPreview({ node }: { node: WorkflowNode }) {
  const workflow = useEditingWorkflow()
  const activeGroupPath = useWorkflowStore((s) => s.activeGroupPath)
  const runtimeNodeId = runtimeNodeIdForPath(activeGroupPath, node.id)
  const ownRefs = useNodeRefs(runtimeNodeId)
  const runtime = useNodeRuntime(runtimeNodeId)
  const upstream = resolveFigureUpstreamTable(workflow, node.id)
  const upstreamRuntimeId = upstream ? runtimeNodeIdForPath(activeGroupPath, upstream.nodeId) : ''
  const upstreamRefs = useNodeRefs(upstreamRuntimeId)
  const upstreamRuntime = useNodeRuntime(upstreamRuntimeId)
  const [resolvedPreview, setResolvedPreview] = useState<{
    chart: NodeChart | null
    requestKey: string
    figureVersion: number | null
  } | null>(null)
  const resolved = resolvedPreview?.chart ?? null
  const previewRef = useRef<HTMLDivElement>(null)
  const addImage = useAnnotationStore((s) => s.addImage)
  const figureImage = resolved?.chart.image

  const figurePort = figurePortId(node)
  const figure = figurePort ? ownRefs?.[figurePort] : undefined
  const figureVersion = figure?.version ?? null
  const upstreamVersion = upstream ? upstreamRefs?.[upstream.portId]?.version ?? -1 : -2
  const paramsKey = JSON.stringify(node.params)
  const requestKey = JSON.stringify([
    paramsKey,
    upstream ? [upstreamRuntimeId, upstream.portId, upstreamVersion] : null,
  ])

  /*
   * 生效的那一套输入。参数要整个进去：改图型、改映射、改带宽都**不会**改输出摘要的
   * 版本号，只盯版本的话，"把散点换成折线"或"把密度曲线调平滑一点"在框上毫无反应 ——
   * 而那正是用户改完立刻想看的东西。
   */
  const signature = JSON.stringify([
    runtimeNodeId,
    figure?.version ?? null,
    upstream ? [upstreamRuntimeId, upstream.portId, upstreamVersion] : null,
    node.params,
  ])

  useEffect(() => {
    let cancelled = false
    /*
     * 自定义图表的 figure 是引擎输出。参数变了但旧 figure 版本还在时，不能把旧图
     * 用新参数签名重新登记成最新预览；先等求值产出新的 figure 版本。
     */
    const paramsChangedWithoutNewFigure =
      node.type === 'custom.chart' &&
      resolvedPreview !== null &&
      resolvedPreview.requestKey !== requestKey &&
      resolvedPreview.figureVersion === figureVersion

    if (!paramsChangedWithoutNewFigure) {
      void resolveNodeChartAtPath(node, workflow, activeGroupPath, `preview:${runtimeNodeId}`).then((r) => {
        if (!cancelled) setResolvedPreview({ chart: r, requestKey, figureVersion })
      })
    }
    return () => {
      cancelled = true
    }
    // 依赖是上面那一项：workflow / node 每次编辑都是新对象，直接进依赖会白算一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  const note = (text: string, tone = '') => (
    <div className={`wf-node-chart-note${tone ? ` ${tone}` : ''}`} title={text}>
      {text}
    </div>
  )

  const pasteToCanvas = () => {
    if (figureImage) {
      addImage(
        figureImageUrl(figureImage),
        { x: node.position.x + 250, y: node.position.y },
        fitImageSize(figureImage.width, figureImage.height),
        `${resolved?.chart.name ?? node.label} 图表`,
        'Matplotlib 图像',
        activeGroupPath,
      )
      return
    }
    const svg = previewRef.current?.querySelector('svg.chart-svg')
    if (!(svg instanceof SVGElement)) return
    const size = svgSize(svg)
    addImage(
      svgToDataUrl(svg),
      { x: node.position.x + 250, y: node.position.y },
      size,
      `${resolved?.chart.name ?? node.label} 图表`,
      '图表快照',
      activeGroupPath,
    )
  }

  if (!upstream) {
    if (node.type === 'viz.chart') return note('把一张表接到「数据」输入端口，节点会立即绘图')
    if (node.type === 'viz.density') {
      return note('把数据表或拆列后的单列接到「数据列」，节点会立即绘制概率密度图')
    }
    return note(
      figurePort
        ? '把数据接到函数输入端口，函数返回的 figure 会在这里直接显示'
        : '把要画的那一列接到「数据列」上 —— 是哪一列由这根线决定，不在这里选',
    )
  }
  if (node.type === 'custom.chart' && runtime.status === 'computing') {
    return note('正在按当前配置重绘图表…')
  }
  if (upstream && !figure) {
    /*
     * 拿不到值要说清**为什么**拿不到 —— 与探针同一条规矩。
     *
     * "等上游算出点来"只在引擎确实还在计算时使用；如果上游失败或被阻断，直接展示真实原因。
     */
    if (runtime.status === 'error') return note(runtime.error?.message ?? '这一步出错了', 'err')
    if (runtime.status === 'blocked') {
      return note(runtime.error?.message ?? `上游「${upstream.label}」这次没有产出`)
    }
    if (runtime.status === 'cancelled') return note('这次被取消了，没有产出。点节点上的「重跑」')
    /*
     * 自己这一格没有图，而且自己也不在算 —— 那原因就在上游。
     *
     * **按上游实际处于什么状态说话**，不要一律说"等上游算出点来"：
     * "还没开始（训练块等你点开始训练）"和"从没算过"这两种情况下，
     * 再等多久都不会有结果，而那句话听起来像"快好了"。
     */
    if (upstreamRuntime.status === 'computing') return note(`等上游「${upstream.label}」算出点来…`)
    if (upstreamRuntime.status === 'manual') {
      return note(`上游「${upstream.label}」还没开始 —— 它要你显式启动（比如点「开始训练」）`)
    }
    if (upstreamRuntime.status === 'error') {
      return note(upstreamRuntime.error?.message ?? `上游「${upstream.label}」出错`, 'err')
    }
    if (upstreamRuntime.status === 'blocked') {
      return note(upstreamRuntime.error?.message ?? `上游「${upstream.label}」这次被跳过`)
    }
    if (upstreamRuntime.status === 'cancelled') return note(`上游「${upstream.label}」这次被取消了`)
    if (runtime.status === 'ready') {
      return note(`这一步算完了，但没有可画的产出（上游「${upstream.label}」那一侧没有图）`)
    }
    return note(`上游「${upstream.label}」还没算过`)
  }
  if (
    node.type === 'custom.chart' &&
    (!resolvedPreview ||
      resolvedPreview.requestKey !== requestKey ||
      resolvedPreview.figureVersion !== figureVersion)
  ) {
    return note('配置或输入已更新，正在等待新图表…')
  }
  if (!resolved || (!resolved.dataset && !figureImage)) {
    return note('绘图节点的实际输出暂时无法读取；请检查上游计算状态')
  }

  return (
    <div className="wf-node-chart" ref={previewRef}>
      {figureImage ? (
        <FigureImageView image={figureImage} alt={`${node.label} 的 Matplotlib 绘图`} />
      ) : resolved.dataset ? (
        <ChartRenderer chart={resolved.chart} dataset={resolved.dataset} onHover={noop} mini />
      ) : null}
      <div className="wf-node-chart-cap">
        {figureImage
          ? 'Matplotlib 绘图'
          : `${resolved.points.toLocaleString('en-US')} 点${
              resolved.totalRows && resolved.totalRows > resolved.points
                ? ` · 原表 ${resolved.totalRows.toLocaleString('en-US')} 行`
                : ''
            }`}
        {upstream ? ` · 来自「${upstream.label}」` : ''}
      </div>
      <button
        type="button"
        className="wf-chart-paste nodrag"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={pasteToCanvas}
        title="把当前图表作为图片贴到画布上"
      >
        贴到画布
      </button>
    </div>
  )
}
