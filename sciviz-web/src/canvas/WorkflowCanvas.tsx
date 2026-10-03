import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WorkflowNodeView, type ScivizNodeData } from './WorkflowNodeView'
import { DotNodeView } from './DotNodeView'
import { ImageView, MindmapView, TableView } from './AnnotationNodes'
import { FavoriteBar } from './FavoriteBar'
import { HistoryBar } from './HistoryBar'
import {
  useActiveRun,
  useEditingWorkflow,
  useWorkflowStore,
} from '../store/useWorkflowStore'
import {
  annotationIdSet,
  registerWorkflowSelectionClearer,
  useAnnotationStore,
} from '../store/useAnnotationStore'
import { useGraphError } from '../store/nodeOutputStore'
import {
  annotationsInGroupPath,
  isAnnotationKind,
} from '../workflow/annotations'
import { getNodeTypeDef } from '../workflow/nodeRegistry'
import { buildUpstreamLabels } from '../workflow/ports'
import { useImportedDatasets } from '../store/useDataStore'
import { usePortContext } from '../engine/portContext'
import { categoryMeta } from '../workflow/types'
import { checkConnection } from '../contract/validate'
import { registerCanvasHistory, useCanvasHistory } from '../store/canvasHistory'
import { blobToDataUrl, fitImageSize, imageSize, isImeKey, isTextEditingTarget } from './canvasMedia'
import { WORKFLOW_GROUP_TYPE, runtimeNodeIdForPath } from '../workflow/groups'
import { graphFocus } from '../workflow/graph'
import { useCanvasFocusStore } from '../store/useCanvasFocusStore'
import {
  CLIPBOARD_TEXT_LIMIT,
  clipboardPayloadText,
  looksLikeClipboardPayload,
  parseClipboardPayload,
  type ClipboardPayload,
} from '../workflow/clipboard'
import {
  memoryClipboardPayload,
  readSystemClipboardText,
  rememberClipboardPayload,
  writeSystemClipboard,
} from './blockClipboard'

export const NODE_DND_MIME = 'application/x-sciviz-nodetype'
/**
 * 批注用**另一个** MIME。
 *
 * 复用同一个类型名的话，落点处理就得先问"这串字符串是个算子吗，不是就当批注" ——
 * 那是一处靠猜的分派。两条通道各说各的，落不下就是落不下，不会错认成另一类。
 */
export const ANNOTATION_DND_MIME = 'application/x-sciviz-annotation'

/** 剪贴板载荷里有什么，用一句话说清（提示与日志共用，两处各写一遍迟早对不上） */
function describePayload(payload: ClipboardPayload): string {
  const parts: string[] = []
  if (payload.nodes.length) parts.push(`${payload.nodes.length} 个块`)
  if (payload.edges.length) parts.push(`${payload.edges.length} 条内部连线`)
  if (payload.annotations.length) parts.push(`${payload.annotations.length} 条批注`)
  return parts.join(' · ') || '空'
}

/**
 * 批注走另外的 type。
 *
 * 为什么不用一个 `annotation` 类型再在组件里 switch：分成三个 type 之后，"这是一条批注"
 * 这件事写在 React Flow 的节点数据里，`connectable: false` 与"不参与求值"的筛选都按类型判，
 * 不必在每个用到节点的地方记一遍"如果 data 里有 annotation 就跳过"。
 */
const nodeTypes: NodeTypes = {
  sciviz: WorkflowNodeView,
  // 注册表里 `shape: 'dot'` 的那几个（现在是列拼表）画成圆点
  dot: DotNodeView,
  table: TableView,
  mindmap: MindmapView,
  image: ImageView,
}

type RFNode = Node<ScivizNodeData, 'sciviz' | 'dot'>

export function WorkflowCanvas() {
  const workflow = useEditingWorkflow()
  const rootWorkflow = useWorkflowStore((s) => s.workflow)
  const activeGroupPath = useWorkflowStore((s) => s.activeGroupPath)
  const portContext = usePortContext()
  const selectedNodeIds = useWorkflowStore((s) => s.selectedNodeIds)
  const selectedEdgeIds = useWorkflowStore((s) => s.selectedEdgeIds)
  const setNodeSelection = useWorkflowStore((s) => s.setNodeSelection)
  const setEdgeSelection = useWorkflowStore((s) => s.setEdgeSelection)
  const enterGroup = useWorkflowStore((s) => s.enterGroup)
  const setActiveGroupPath = useWorkflowStore((s) => s.setActiveGroupPath)
  const groupSelection = useWorkflowStore((s) => s.groupSelection)
  const moveAnnotationsIntoGroup = useWorkflowStore((s) => s.moveAnnotationsIntoGroup)
  const ungroupSelection = useWorkflowStore((s) => s.ungroupSelection)
  const copySelection = useWorkflowStore((s) => s.copySelection)
  const pasteClipboard = useWorkflowStore((s) => s.pasteClipboard)
  const moveNode = useWorkflowStore((s) => s.moveNode)
  const removeNode = useWorkflowStore((s) => s.removeNode)
  const connect = useWorkflowStore((s) => s.connect)
  const disconnect = useWorkflowStore((s) => s.disconnect)
  const addNode = useWorkflowStore((s) => s.addNode)
  const pruneInvalidEdges = useWorkflowStore((s) => s.pruneInvalidEdges)
  const run = useActiveRun()

  /*
   * 批注订阅的是另一个 store —— 这是刻意的：`graphRunner` 订阅的是工作流的变化，
   * 在便签上敲一个字都不该让全图重新规划一遍。
   */
  const annotations = useAnnotationStore((s) => s.annotations)
  const visibleAnnotations = useMemo(
    () => annotationsInGroupPath(annotations, activeGroupPath),
    [annotations, activeGroupPath],
  )
  const annotationSelected = useAnnotationStore((s) => s.selectedIds)
  const setAnnotationSelection = useAnnotationStore((s) => s.setSelection)
  const moveAnnotation = useAnnotationStore((s) => s.move)
  const removeAnnotations = useAnnotationStore((s) => s.remove)
  const addAnnotation = useAnnotationStore((s) => s.add)
  const addImage = useAnnotationStore((s) => s.addImage)
  const undo = useCanvasHistory((s) => s.undo)
  const redo = useCanvasHistory((s) => s.redo)

  // 订阅数据集：列开关变化后，指向已消失端口的连线要清掉
  const imported = useImportedDatasets()

  const { screenToFlowPosition, fitView } = useReactFlow()
  const hostRef = useRef<HTMLDivElement>(null)
  const prevWorkflowId = useRef(workflow.id)
  const prevNodeCount = useRef(workflow.nodes.length)

  useEffect(
    () =>
      registerCanvasHistory({
        read: () => ({
          workflow: useWorkflowStore.getState().workflow,
          annotations: useAnnotationStore.getState().annotations,
        }),
        restore: (snapshot) => {
          useWorkflowStore.getState().setWorkflow(snapshot.workflow)
          useAnnotationStore.getState().setAll(snapshot.annotations)
        },
      }),
    [],
  )

  /*
   * 新加一条批注时，把工作流节点的选中清掉（反方向在 `useWorkflowStore.addNode` 里）。
   * 两套选中都会进 React Flow 的同一份选中集合：不清，拖动刚加的东西会把它前面选中的
   * 那条也拖走，而屏幕上看不出为什么。
   */
  useEffect(
    () => registerWorkflowSelectionClearer(() => useWorkflowStore.getState().setNodeSelection([])),
    [],
  )

  /*
   * 画布底部那一句一闪而过的提示（粘贴结果、磁吸结果）。两者共用一条状态：
   * 它们都是"刚才那一下做了什么"，同时出现两句只会互相盖住。
   */
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  // 整张图算不了的原因（调度器报的），非空时画布上常驻一句话
  const graphError = useGraphError()
  const flashStatus = useCallback((text: string) => {
    setStatusMessage(text)
    // 只在还是这一句时才清掉：中途来了新的提示，不能被旧的那条定时器抹掉
    window.setTimeout(
      () => setStatusMessage((current) => (current === text ? null : current)),
      2400,
    )
  }, [])

  /*
   * 聚焦：点一个块，看清它在流程里的位置。
   *
   * **只淡化、不隐藏、不改布局** —— 藏起来会让画面跳，也会让人失去上下文。
   * 刻意不做"鼠标划过就预览"：那会让画布在指针每次移动时重渲染，而重渲染正好撞上
   * "拖端口连线"和"双击进组块"这两种需要指针稳住的操作。
   */
  /*
   * 聚焦状态住在 `useCanvasFocusStore` 里，而不是这里：**实验笔记里的节点引用也要能点亮它**
   * （点笔记里的 @块名 → 画布聚焦到那个块）。状态留在画布里，笔记就得反向去够画布。
   */
  const focused = useCanvasFocusStore((s) => s.focusedNodeId)
  const setFocused = useCanvasFocusStore((s) => s.setFocusedNodeId)

  /**
   * 卡片密度：紧凑 = 只留名字 + 端口（参数与预览都收起来）。
   *
   * 为什么不进工程文件：它是**看画布时的偏好**，不是这张图的内容 —— 同一个人今天想看结构、
   * 明天想看参数，不该因此让工程文件变脏；换台机器也只想带着自己的习惯。所以进 localStorage。
   */
  const [compact, setCompact] = useState(() => localStorage.getItem('sciviz.cardDensity') === 'compact')
  const toggleCompact = useCallback(() => {
    setCompact((current) => {
      localStorage.setItem('sciviz.cardDensity', current ? 'standard' : 'compact')
      return !current
    })
  }, [])
  /** 挂起的"单击聚焦"定时器：双击进组块要先把它取消（见 onNodeClick 的注释） */
  const focusClick = useRef<number | null>(null)
  const focus = useMemo(
    () => (focused ? graphFocus(workflow, focused) : null),
    [workflow, focused],
  )
  const cancelPendingFocus = useCallback(() => {
    if (focusClick.current === null) return
    window.clearTimeout(focusClick.current)
    focusClick.current = null
  }, [])

  const addClipboardImage = useCallback(
    async (blob: Blob, source = '剪贴板截图') => {
      try {
        const src = await blobToDataUrl(blob)
        const intrinsic = await imageSize(src)
        const size = fitImageSize(intrinsic.width, intrinsic.height)
        const rect = hostRef.current?.getBoundingClientRect()
        const center = rect
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
        const position = screenToFlowPosition(center)
        addImage(
          src,
          { x: position.x - size.width / 2, y: position.y - size.height / 2 },
          size,
          source,
          source,
          activeGroupPath,
        )
        flashStatus('图片已贴到画布中央')
      } catch (error) {
        flashStatus(error instanceof Error ? error.message : '粘贴图片失败')
      }
    },
    [addImage, screenToFlowPosition, activeGroupPath, flashStatus],
  )

  /* ---------------- 块的复制粘贴（CANVAS-9） ----------------
   *
   * 载荷怎么算全在 `workflow/clipboard.ts`（纯逻辑、可单测），这里只做三件界面的事：
   * 记住鼠标在画布上的位置（粘贴落点）、把载荷送上系统剪贴板、把结果说出来。
   */

  /**
   * 鼠标在**画布坐标**里的位置，用于粘贴落点。
   *
   * 只写 ref 不写 state：它每次移动都变，进了 state 就等于指针每动一下重渲染一次画布 ——
   * 而"指针每次移动都重渲染"正是当年把"从端口拉线"打成失败的那个原因（见上面聚焦那段注释）。
   */
  const pointerFlow = useRef<{ x: number; y: number } | null>(null)
  /** 同一处连续粘贴要逐次错开，否则第二次粘贴与第一次完全重合，看着像没反应 */
  const pasteCascade = useRef(0)
  /** 内存里有没有载荷（决定工具条上「粘贴」要不要出现）。系统剪贴板的内容读不到，只能记自己做过什么 */
  const [clipboardReady, setClipboardReady] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onMove = (event: MouseEvent) => {
      pointerFlow.current = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    }
    host.addEventListener('mousemove', onMove)
    return () => host.removeEventListener('mousemove', onMove)
  }, [screenToFlowPosition])

  /**
   * 复制当前选择。返回"有没有东西被复制" —— Ctrl+C 据此决定要不要 `preventDefault`：
   * 画布上一个块都没选时按 Ctrl+C，不该把用户刚在别处复制的内容冲掉。
   */
  const copyToClipboard = useCallback((): boolean => {
    const payload = copySelection()
    if (!payload) return false
    const what = describePayload(payload)
    const hint = payload.droppedEdges > 0 ? `（${payload.droppedEdges} 条跨边界连线不跟随）` : ''
    const text = clipboardPayloadText(payload)
    setClipboardReady(true)
    pasteCascade.current = 0
    if (text.length > CLIPBOARD_TEXT_LIMIT) {
      rememberClipboardPayload(payload, true)
      flashStatus(`已复制 ${what}${hint}：内容较大，只放进应用内剪贴板（Ctrl+V 可用）`)
      return true
    }
    rememberClipboardPayload(payload, false)
    void writeSystemClipboard(text).then((written) => {
      if (!written) rememberClipboardPayload(payload, true)
      flashStatus(
        written
          ? `已复制 ${what}${hint}，Ctrl+V 粘贴`
          : `已复制 ${what}${hint}：系统剪贴板不可用，本应用里 Ctrl+V 仍可用`,
      )
    })
    return true
  }, [copySelection, flashStatus])

  /** 落点：优先鼠标位置（内容居中于指针），没有指针信息时退回"来源位置 + 48"，两者都逐次错开 */
  const nextPasteOrigin = (payload: ClipboardPayload) => {
    const step = pasteCascade.current++
    const offset = step * 28
    const pointer = pointerFlow.current
    if (!pointer) return { x: payload.at.x + 48 + offset, y: payload.at.y + 48 + offset }
    return {
      x: pointer.x - payload.size.width / 2 + offset,
      y: pointer.y - payload.size.height / 2 + offset,
    }
  }

  const pastePayload = useCallback(
    (payload: ClipboardPayload) => {
      try {
        const summary = pasteClipboard(payload, nextPasteOrigin(payload))
        if (!summary) {
          flashStatus('这段剪贴板内容里没有可粘贴的块')
          return
        }
        const parts: string[] = []
        if (summary.nodes) parts.push(`${summary.nodes} 个块`)
        if (summary.edges) parts.push(`${summary.edges} 条内部连线`)
        if (summary.annotations) parts.push(`${summary.annotations} 条批注`)
        flashStatus(`已粘贴 ${parts.join(' · ') || '空'}`)
      } catch (error) {
        flashStatus(error instanceof Error ? error.message : '粘贴失败')
      }
    },
    [pasteClipboard, flashStatus],
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      // 便签、表格和搜索框里的文字粘贴必须原样交给输入控件；尤其不能拦截中文标点。
      if (isTextEditingTarget(event.target) || isTextEditingTarget(document.activeElement)) return
      // 载荷优先：上次复制没能进系统剪贴板时（超大 / 写不进去），Ctrl+V 仍然该是"粘贴块"，
      // 但剪贴板里真有图片时图片优先 —— 那说明用户刚复制的是图，不是在粘块。
      const text = event.clipboardData?.getData('text/plain') ?? ''
      const payload = parseClipboardPayload(text)
      // 是我们的载荷却读不出来（版本对不上、被改坏、条目太多）：**说出来**，
      // 否则用户按了 Ctrl+V、屏幕上什么都没有，也没人告诉他为什么
      if (!payload && looksLikeClipboardPayload(text)) {
        event.preventDefault()
        flashStatus('剪贴板里这段块读不出来（可能来自另一个版本），没有粘贴')
        return
      }
      const items = Array.from(event.clipboardData?.items ?? [])
      const image = items.find((x) => x.type.startsWith('image/'))
      const memory = memoryClipboardPayload()
      const fromMemory = !payload && memory?.memoryOnly && !image ? memory.payload : null
      if (payload || fromMemory) {
        event.preventDefault()
        pastePayload(payload ?? fromMemory!)
        return
      }
      const file = image?.getAsFile()
      if (!file) return
      event.preventDefault()
      void addClipboardImage(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addClipboardImage, pastePayload, flashStatus])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 输入法组合态和所有文本编辑控件都不进入画布快捷键分支。
      if (isImeKey(event) || isTextEditingTarget(event.target)) return
      // Esc：退出聚焦（它和"点空白"是同一件事的两个入口）
      if (event.key === 'Escape') {
        cancelPendingFocus()
        setFocused(null)
        return
      }
      const modifier = event.ctrlKey || event.metaKey
      if (!modifier || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'z' && event.shiftKey) {
        event.preventDefault()
        redo()
      } else if (key === 'z') {
        event.preventDefault()
        undo()
      } else if (key === 'y') {
        event.preventDefault()
        redo()
      } else if (key === 'c' && !event.shiftKey) {
        // 只有真的复制到了东西才拦下浏览器默认行为：没选中时 Ctrl+C 该是"什么都没发生"，
        // 而不是把系统剪贴板清成空
        if (copyToClipboard()) event.preventDefault()
      }
      // Ctrl+V 不在这里处理：粘贴事件带着剪贴板内容，由上面的 paste 监听分派
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [redo, undo, cancelPendingFocus, copyToClipboard])

  const pasteFromClipboard = useCallback(async () => {
    try {
      const clipboard = navigator.clipboard as Clipboard & {
        read?: () => Promise<ClipboardItems>
      }
      if (!clipboard.read) throw new Error('当前浏览器不支持按钮读取剪贴板，请直接按 Ctrl+V')
      const items = await clipboard.read()
      for (const item of items) {
        const type = item.types.find((x) => x.startsWith('image/'))
        if (type) {
          await addClipboardImage(await item.getType(type))
          return
        }
      }
      flashStatus('剪贴板里没有图片')
    } catch (error) {
      flashStatus(error instanceof Error ? error.message : '读取剪贴板失败，请直接按 Ctrl+V')
    }
  }, [addClipboardImage, flashStatus])

  useEffect(() => {
    pruneInvalidEdges(portContext)
  }, [imported, workflow.nodes, pruneInvalidEdges, portContext])

  /**
   * 工具条上的「粘贴」（块）。
   *
   * 只有在系统剪贴板里读到了本应用的载荷，或者本会话里复制过东西时才做事 ——
   * 这里是显式点击，"粘上一次复制的块"就是用户明确要的，所以内存副本优先于"什么都不做"；
   * 图片走旁边那个「粘贴图片」（读剪贴板里的图片需要另一套权限与格式）。
   */
  const pasteBlocksFromButton = useCallback(async () => {
    const text = await readSystemClipboardText()
    const fromSystem = parseClipboardPayload(text)
    if (fromSystem) {
      pastePayload(fromSystem)
      return
    }
    const memory = memoryClipboardPayload()
    if (memory) {
      pastePayload(memory.payload)
      return
    }
    flashStatus(
      looksLikeClipboardPayload(text)
        ? '剪贴板里这段块读不出来（可能来自另一个版本），没有粘贴'
        : '剪贴板里没有可粘贴的块（粘贴图片请用旁边的「粘贴图片」）',
    )
  }, [pastePayload, flashStatus])

  // 导入 YAML / 切换工作流后重新适配视图
  useEffect(() => {
    const switchedWorkflow = prevWorkflowId.current !== workflow.id
    const becameNonEmpty = prevNodeCount.current === 0 && workflow.nodes.length > 0
    prevWorkflowId.current = workflow.id
    prevNodeCount.current = workflow.nodes.length
    if (switchedWorkflow || becameNonEmpty) {
      // maxZoom: 1 —— 只有一两个节点时，"贴合内容"不该等于贴到 1.8 倍
      const t = setTimeout(() => fitView({ padding: 0.18, maxZoom: 1, duration: 300 }), 60)
      return () => clearTimeout(t)
    }
  }, [workflow.id, workflow.nodes.length, fitView])

  const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const selectedEdgeSet = useMemo(() => new Set(selectedEdgeIds), [selectedEdgeIds])

  const nodes: RFNode[] = useMemo(() => {
    // 每个节点已接线的输入端口，供节点框区分"接线中/手填"
    const connByNode = new Map<string, string[]>()
    for (const e of workflow.edges) {
      if (!connByNode.has(e.target)) connByNode.set(e.target, [])
      connByNode.get(e.target)!.push(e.targetPort)
    }
    // 数据源只提供整表；具体列名由下游「拆列」节点的端口表达。
    const upstream = buildUpstreamLabels(workflow)

    return workflow.nodes.map((n) => {
      const runtimeNodeId = runtimeNodeIdForPath(activeGroupPath, n.id)
      // 探针显示的是上游那一步的输出，所以要在这把"上游是谁、哪个端口"定下来。
      // 求值本身不在这里做 —— 它是引擎的职责，节点视图订阅引擎的输出。
      const edge = n.type === 'data.preview'
        ? workflow.edges.find((e) => e.target === n.id && e.targetPort === 'data')
        : undefined
      const upstreamNode = edge ? workflow.nodes.find((x) => x.id === edge.source) : undefined
      const upstreamRuntimeId = upstreamNode
        ? runtimeNodeIdForPath(activeGroupPath, upstreamNode.id)
        : undefined

      return {
        id: n.id,
        // 形状由注册表说了算，不在画布里按类型名硬编码 —— 否则"哪个节点该画成圆点"
        // 就有两处说法，加一个圆点节点要记得改两处
        type: getNodeTypeDef(n.type).shape === 'dot' ? ('dot' as const) : ('sciviz' as const),
        position: n.position,
        selected: selectedSet.has(n.id),
        className:
          [
            focus && !focus.nodes.has(n.id) ? 'focus-dim' : '',
            focused === n.id ? 'focus-anchor' : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
        data: {
          node: n,
          runtimeNodeId,
          compact,
          status: run?.nodeStatus[runtimeNodeId] ?? 'idle',
          durationMs: run?.durations[runtimeNodeId],
          connectedPorts: connByNode.get(n.id) ?? [],
          upstreamLabels: upstream.get(n.id) ?? {},
          probe:
            edge && upstreamNode
              ? {
                  upstreamNodeId: upstreamRuntimeId!,
                  upstreamPortId: edge.sourcePort,
                  upstreamLabel: upstreamNode.label,
                }
              : undefined,
        },
      }
    })
  }, [workflow, activeGroupPath, selectedSet, run, imported, focus, focused, compact])

  /**
   * 批注 → React Flow 节点。
   *
   * `connectable: false`：端口是"数据往哪儿流"的接口，而批注不流任何东西。允许在它身上
   * 起一根线，就会得到一根连到一张表格上的"数据流"—— 校验器要特判它、求值计划要跳过它、
   * 而用户只会看见一根永远连不上的线。
   */
  const annotationNodes: Node[] = useMemo(
    () =>
      visibleAnnotations.map((a) => ({
        id: a.id,
        type: a.kind,
        position: a.position,
        data: { annotation: a },
        selected: annotationSelected.includes(a.id),
        className:
          // 批注不在流程图里，所以聚焦时它们一律淡出：这时候要看的是流程，不是版面
          focus ? 'focus-dim' : undefined,
        connectable: false,
      })),
    [visibleAnnotations, annotationSelected, focus],
  )

  /** 画布上真正的全部节点：计算图 + 批注。两套选中各归各的 store，但共享一次点选 */
  const allNodes: Node[] = useMemo(() => [...nodes, ...annotationNodes], [nodes, annotationNodes])

  /** 这条变更是不是批注的。批注与节点共用一个 React Flow 实例，靠 id 分派 */
  const isAnnotationId = (id: string) => annotationIds.has(id)
  const annotationIds = useMemo(() => annotationIdSet(visibleAnnotations), [visibleAnnotations])

  const edges: Edge[] = useMemo(
    () =>
      workflow.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        animated: run?.nodeStatus[runtimeNodeIdForPath(activeGroupPath, e.source)] === 'running',
        // 受控模式下 React Flow 不自己存 selected：不打这行，边永远选不中，Delete 也就无从删起
        selected: selectedEdgeSet.has(e.id),
        /*
         * 聚焦时：链上的线加粗并给出方向箭头，链外的线淡到几乎看不见。
         * 只改样式不改结构 —— 淡化是"背景还在，主角清楚"，藏起来则会让人失去上下文。
         */
        ...(focus
          ? {
              style: focus.edges.has(e.id)
                ? { strokeWidth: 2.5, opacity: 1 }
                : { strokeWidth: 1.5, opacity: 0.12 },
              ...(focus.edges.has(e.id) ? { markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } } : {}),
            }
          : {}),
      })),
    [workflow.edges, activeGroupPath, run, selectedEdgeSet, focus],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          // 拖谁就动谁：位置写回各自的 store，没有第二种后果
          if (isAnnotationId(c.id)) moveAnnotation(c.id, c.position)
          else moveNode(c.id, c.position)
        } else if (c.type === 'remove') {
          if (isAnnotationId(c.id)) removeAnnotations([c.id])
          else removeNode(c.id)
        }
      }

      // 选择状态以 React Flow 为准。
      // 框选**只会**通过 select 变化冒出来（不会触发 onNodeClick），
      // 之前这里只处理 position/remove，把 select 丢掉了 —— 结果框选矩形画得再好也一个都选不中。
      if (changes.some((c) => c.type === 'select')) {
        const next = applyNodeChanges(changes, allNodes)
        const sel = next.filter((n) => n.selected).map((n) => n.id)
        // 一次框选可以同时盖住节点与批注：按 id 分回两个 store，各自只看见自己那部分
        setNodeSelection(sel.filter((x) => !annotationIds.has(x)))
        setAnnotationSelection(sel.filter((x) => annotationIds.has(x)))
      }
    },
    [
      allNodes,
      annotationIds,
      moveNode,
      removeNode,
      moveAnnotation,
      removeAnnotations,
      setNodeSelection,
      setAnnotationSelection,
    ],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      for (const c of changes) {
        if (c.type === 'remove') disconnect(c.id)
      }

      // 选中状态必须回写到 edges prop：受控模式下 React Flow 不自己维护边的 selected，
      // 之前这里只处理 remove、把 select 整批丢掉，于是边点了不亮、Delete 也删不掉。
      if (changes.some((c) => c.type === 'select')) {
        const next = applyEdgeChanges(changes, edges)
        setEdgeSelection(next.filter((e) => e.selected).map((e) => e.id))
      }
    },
    [edges, disconnect, setEdgeSelection],
  )

  /**
   * 拖线被拒时显示的原因（L1 校验器的错误码与那句话）。
   *
   * 为什么要有它：在此之前被拒是一条"什么都没发生"——用户拖过去、线弹回去，
   * 没有任何地方说为什么。而原因其实一直在算（类型不兼容 / 端口被占 / 会成环…），
   * 只是写在 `isValidConnection` 里、只以 `false` 的形式交出去。
   */
  const [rejected, setRejected] = useState<{ code: string; message: string } | null>(null)

  /**
   * 连线校验。
   *
   * 判据**不在这里**：走 L1 的 `checkConnection`（与 `sciviz validate`、补丁的
   * `connect` 同一份实现）。界面只负责"能不能连"与"不能连就说出原因"，
   * 自己不复述一遍规则 —— 复述过的那份与 CLI 的说法迟早会分叉，而分叉不会报错。
   */
  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      const { source, target, sourceHandle, targetHandle } = conn
      if (!source || !target || source === target) return false
      if (!sourceHandle || !targetHandle) return false
      return (
        checkConnection(
          workflow,
          { source, sourcePort: sourceHandle, target, targetPort: targetHandle },
          portContext,
        ) === null
      )
    },
    [workflow, portContext],
  )

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || !conn.sourceHandle || !conn.targetHandle) return
      setRejected(null)
      connect({
        source: conn.source,
        sourcePort: conn.sourceHandle,
        target: conn.target,
        targetPort: conn.targetHandle,
      })
    },
    [connect],
  )

  /**
   * 松手之后才说话。
   *
   * 拖动过程中 `isValidConnection` 会被问很多次（每经过一个端口问一次），
   * 在那里报错会变成一路刷屏；而**松手时**用户才真的"想做这件事"。
   * 落在空白处不算被拒 —— 那是放弃，不是不合法。
   */
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid !== false) return
      const from = state.fromNode
      const to = state.toNode
      const fromPort = state.fromHandle?.id
      const toPort = state.toHandle?.id
      if (!from || !to || !fromPort || !toPort) return
      const hit = checkConnection(
        workflow,
        { source: from.id, sourcePort: fromPort, target: to.id, targetPort: toPort },
        portContext,
      )
      setRejected(hit ? { code: hit.code, message: hit.message } : null)
    },
    [workflow, portContext],
  )

  /** 下一根线一开始拖，上一条被拒的说明就撤掉 —— 它讲的是上一次的意图 */
  const onConnectStart = useCallback(() => setRejected(null), [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      // 两条通道分开认：批注落在指针处（它要"贴在这儿"），算子按左上角摆（要留出可见的框）
      const kind = event.dataTransfer.getData(ANNOTATION_DND_MIME)
      if (isAnnotationKind(kind)) {
        addAnnotation(kind, { x: position.x - 20, y: position.y - 20 }, activeGroupPath)
        return
      }
      const type = event.dataTransfer.getData(NODE_DND_MIME)
      if (!type) return
      addNode(type, { x: position.x - 90, y: position.y - 30 })
    },
    [addNode, addAnnotation, screenToFlowPosition, activeGroupPath],
  )

  const onNodeDoubleClick = useCallback(
    (event: React.MouseEvent, flowNode: Node) => {
      // 双击的第一下已经挂起了"聚焦"，这里把它撤掉：用户要的是进组块，不是看链路
      cancelPendingFocus()
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, select, textarea, button, [contenteditable="true"], .react-flow__handle')
      ) return
      const node = workflow.nodes.find((candidate) => candidate.id === flowNode.id)
      if (node?.type === WORKFLOW_GROUP_TYPE && node.group) enterGroup(node.id)
    },
    [workflow, enterGroup, cancelPendingFocus],
  )

  /**
   * 点块 = 锁定"这个块在流程里的位置"；再点同一个块 = 取消。
   *
   * 点在输入框、按钮和端口上时不算（那些是要操作参数或拉线，不是在问"它连着谁"）——
   * 与双击进组块用的是同一条排除规则。
   *
   * **延迟 200ms 再动手**：一次双击会先送来一个单击，如果当场就聚焦，画布会重渲染，
   * 双击进组块就再也进不去了（实测：加了单击聚焦之后，两条"双击进入子空间"的回归全挂）。
   * 所以单击先挂起，双击进来时取消它 —— 这是"单击/双击共存"的标准做法。
   */
  const onNodeClick = useCallback(
    (event: React.MouseEvent, flowNode: Node) => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.closest('input, select, textarea, button, [contenteditable="true"], .react-flow__handle')
      ) return
      if (isAnnotationId(flowNode.id)) return
      cancelPendingFocus()
      focusClick.current = window.setTimeout(() => {
        focusClick.current = null
        const current = useCanvasFocusStore.getState().focusedNodeId
        setFocused(current === flowNode.id ? null : flowNode.id)
      }, 200)
    },
    [annotationIds, cancelPendingFocus, setFocused],
  )

  /** 焦点块被删掉（或撤回到没有它的那一步）时，聚焦状态跟着退出去，不留一个指向幽灵的提示 */
  useEffect(() => {
    if (focused && !workflow.nodes.some((node) => node.id === focused)) setFocused(null)
  }, [workflow.nodes, focused])

  const selectedGroup =
    selectedNodeIds.length === 1
      ? workflow.nodes.find((node) => node.id === selectedNodeIds[0] && node.type === WORKFLOW_GROUP_TYPE)
      : undefined
  const canCombineSelection =
    selectedNodeIds.length >= 2 ||
    (selectedNodeIds.length === 1 && annotationSelected.length > 0 && !selectedGroup) ||
    (selectedNodeIds.length === 0 && annotationSelected.length >= 2)

  const breadcrumbs = (() => {
    const items = [{ label: rootWorkflow.name || '主工作流', path: [] as string[] }]
    let current = rootWorkflow
    const path: string[] = []
    for (const id of activeGroupPath) {
      const groupNode = current.nodes.find((node) => node.id === id && node.group)
      if (!groupNode?.group) break
      path.push(id)
      items.push({ label: groupNode.label, path: [...path] })
      current = groupNode.group.workflow
    }
    return items
  })()

  const combineSelection = () => {
    try {
      const id = groupSelection(portContext)
      if (!id) flashStatus('请选择工作流节点或至少两条画布批注')
    } catch (error) {
      flashStatus(error instanceof Error ? error.message : '组合组块失败')
    }
  }

  // React Flow 的 pane 事件在某些覆盖层（缩放/小地图或浏览器合成层）下可能不冒泡到
  // `onPaneClick`。在画布壳上再守一层同样的语义，确保点空白永远能退出聚焦，
  // 但点节点、端口或工具控件不会误清掉当前焦点。
  const onCanvasHostClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target
      if (
        target instanceof Element &&
        !target.closest(
          '.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, button, input, select, textarea, [contenteditable="true"]',
        )
      ) {
        cancelPendingFocus()
        setFocused(null)
      }
    },
    [cancelPendingFocus, setFocused],
  )

  return (
    <div className="canvas-host" ref={hostRef} onClickCapture={onCanvasHostClick}>
      <ReactFlow
        nodes={allNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnectStart={onConnectStart}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeClick={onNodeClick}
        onPaneClick={() => {
          cancelPendingFocus()
          setFocused(null)
        }}
        isValidConnection={isValidConnection}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        /*
         * 指针行为由"手放在哪儿"决定，不再有工具开关：
         * - 空白上拖动 = 平移画布（左/中/右键都行），光标是手
         * - 模块上拖动 = 移动模块，模块上光标是箭头
         * - 按住 Shift 拖空白 = 框选（React Flow 的 selectionKeyCode）
         * 另外始终可用：滚轮平移、按住空格临时平移
         */
        panOnDrag={[0, 1, 2]}
        selectionKeyCode="Shift"
        panOnScroll
        panActivationKeyCode="Space"
        multiSelectionKeyCode={['Meta', 'Control']}
        minZoom={0.001}
        maxZoom={1000}
        fitView
        /*
         * 空的或只有一两个节点的画布，"贴合内容"会把缩放推到上限（实测 1.8），
         * 于是可视区只剩 516×394 个画布单位 —— 一张 460 宽的表格就把它塞满了，
         * 接下来加的批注只能落到视口外：用户点了三下，只看见第一下。
         * 上限压到 1：宁可留白，也不要把画布变成一个贴脸的放大镜。
         */
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
      >
        <Background gap={18} size={1} color="#dfe4ea" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const d = (n as RFNode).data
            try {
              return categoryMeta[getNodeTypeDef(d.node.type).category].color
            } catch {
              return '#999'
            }
          }}
          style={{ width: 150, height: 100 }}
        />
        <Panel position="top-left">
          {/*
            常用工具栏。按钮一律 onMouseDown preventDefault：
            否则点完按钮焦点留在按钮上，Delete 删节点的快捷键就失效了。
          */}
          {activeGroupPath.length > 0 && (
            <nav className="canvas-breadcrumb" aria-label="组块路径">
              {breadcrumbs.map((item, index) => (
                <span className="canvas-breadcrumb-item" key={item.path.join('/') || 'root'}>
                  {index > 0 && <span className="canvas-breadcrumb-sep">›</span>}
                  <button
                    type="button"
                    className="canvas-tool-btn canvas-breadcrumb-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setActiveGroupPath(item.path)}
                    aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
                  >
                    {item.label}
                  </button>
                </span>
              ))}
            </nav>
          )}
          <div className="canvas-tool-row">
            <HistoryBar />
            {canCombineSelection && (
              <button
                type="button"
                className="canvas-tool-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={combineSelection}
                title="把选中的工作流节点和画布批注收进一个子空间"
              >
                ▣ 组合为子空间
              </button>
            )}
            {selectedGroup && annotationSelected.length > 0 && (
              <button
                type="button"
                className="canvas-tool-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => moveAnnotationsIntoGroup(selectedGroup.id)}
                title="将所选图片、便签、表格或思维图移入该组块"
              >
                ▣ 移入所选组块
              </button>
            )}
            {selectedGroup && (
              <>
                <button
                  type="button"
                  className="canvas-tool-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => enterGroup(selectedGroup.id)}
                  title="进入所选组块的内部画布"
                >
                  进入组块
                </button>
                <button
                  type="button"
                  className="canvas-tool-btn"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => ungroupSelection()}
                  title="展开这个组块并恢复其中的节点"
                >
                  展开组块
                </button>
              </>
            )}
            {(selectedNodeIds.length > 0 || annotationSelected.length > 0) && (
              <button
                type="button"
                className="canvas-tool-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => copyToClipboard()}
                title="复制选中的块与批注（内部连线一起带走，Ctrl+C）"
              >
                ⧉ 复制
              </button>
            )}
            {clipboardReady && (
              <button
                type="button"
                className="canvas-tool-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pasteBlocksFromButton()}
                title="把上次复制的块粘到鼠标位置（Ctrl+V）"
              >
                ⧉ 粘贴
              </button>
            )}
            <button
              type="button"
              className="canvas-tool-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void pasteFromClipboard()}
              title="把剪贴板里的截图或图片贴到画布中央"
            >
              ▧ 粘贴图片
            </button>
            <button
              type="button"
              className={`canvas-tool-btn${compact ? ' on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleCompact}
              title={
                compact
                  ? '紧凑：卡片只留名字与端口（参数与预览收起）—— 点一下回到标准档'
                  : '标准：卡片显示参数与预览 —— 点一下切成紧凑档，画布立刻省地'
              }
            >
              {compact ? '▤ 紧凑' : '▥ 标准'}
            </button>
          </div>
          <FavoriteBar />
          {activeGroupPath.length > 0 && (
            <div className="canvas-group-hint">当前在组块内部编辑；点面包屑返回，双击子组块可继续进入。</div>
          )}
        </Panel>
      </ReactFlow>

      {/*
        被拒的连线：说出原因与错误码。
        `pointer-events: none`（见 CSS）—— 它只是句话，不该挡住底下的节点和线；
        下一根线一开拖就撤掉。
      */}
      {rejected && (
        <div className="canvas-reject" role="status">
          <span className="canvas-reject-code">{rejected.code}</span>
          <span className="canvas-reject-text">{rejected.message}</span>
        </div>
      )}

      {statusMessage && <div className="canvas-paste-message" role="status">{statusMessage}</div>}

      {/*
        整张图算不了时常驻显示原因。

        与上面那两条"刚才那一下做了什么"的闪一下提示不同：这一条**不能消失** ——
        它说的是"现在这张图一个块都算不了"，而在它出现之前，用户看到的是所有块都空着、
        却没有一句话解释（实测：一条悬空的组块参数绑定让整张画布再也不出数）。
      */}
      {graphError && (
        <div className="canvas-graph-error" role="alert" title={graphError.message}>
          <span className="canvas-graph-error-title">这张图现在算不了</span>
          <span className="canvas-reject-text">{graphError.message}</span>
        </div>
      )}

      {/*
        聚焦时在画布上说清楚"现在看的是谁、这一条链有多大"。
        光靠淡化，人还得自己数；一句话把上游下游的规模报出来，就等于回答了"它的结构长什么样"。
      */}
      {focused && focus && (
        <div className="canvas-focus" role="status">
          <span className="canvas-focus-title">
            聚焦「{workflow.nodes.find((node) => node.id === focused)?.label ?? '已删除的块'}」
          </span>
          <span className="canvas-focus-count">
            链上 {focus.nodes.size} 个块 · {focus.edges.size} 条连线
          </span>
          <span className="canvas-focus-hint">点空白或按 Esc 退出</span>
        </div>
      )}

      {/* 只在真正空白时给出起手提示；节点与数据都由用户显式添加。 */}
      {workflow.nodes.length === 0 && visibleAnnotations.length === 0 && (
        <div className="canvas-empty">
          <div className="canvas-empty-title">画布是空的</div>
          <div className="canvas-empty-hint">
            从左侧节点库拖节点进来开始搭，或先导入数据再连接数据源。
          </div>
        </div>
      )}
    </div>
  )
}
