import { useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { NODE_DND_MIME } from '../canvas/WorkflowCanvas'
import { ANNOTATION_DND_MIME } from '../canvas/WorkflowCanvas'
import { nextAnnotationPosition, nextNodePosition } from '../canvas/placement'
import { useAnnotationStore } from '../store/useAnnotationStore'
import { ANNOTATION_NOMINAL, annotationsInGroupPath, type AnnotationKind } from '../workflow/annotations'
import { allNodeDefs } from '../workflow/nodeRegistry'
import { WORKFLOW_GROUP_TYPE } from '../workflow/groups'
import { categoryMeta, type NodeCategory, type NodeTypeDef } from '../workflow/types'
import { useEditingWorkflow, useWorkflowStore } from '../store/useWorkflowStore'
import { useModuleStore } from '../store/useModuleStore'
import { isUserModuleType } from '../workflow/userModules'
import { useBackendKind } from '../engine/useBackendKind'
import type { BackendKind } from '../engine/backend'

const categoryOrder: NodeCategory[] = ['data', 'feature', 'model', 'eval', 'viz', 'custom']

/**
 * 画布批注的入口。
 *
 * 这些内容**不在这里被登记成算子节点**：它们不进 `nodeRegistry`，因此不进清单、不进求值。
 * 卡片与算子卡片长得几乎一样是刻意的（同一套交互：拖到画布或点一下），
 * 但描述里必须说清"它不参与计算"，否则有人会去给它接一根线，然后问为什么连不上。
 */
const NOTE_TOOLS: { kind: AnnotationKind; label: string; icon: string; desc: string }[] = [
  {
    kind: 'table',
    label: '表格',
    icon: '▦',
    desc: '记读数：一行一个样本，一列一个量。存的是文字，要参与计算请走数据源节点',
  },
  {
    kind: 'mindmap',
    label: '思维图',
    icon: '⑂',
    desc: '把假设与证据摊开。在一支上按 Tab 加子支，或点支上的 ＋',
  },
]

/**
 * 节点库条目的提示语。
 *
 * 需要本地宿主的节点必须**在点下去之前**就说清楚：拖到画布上才发现算不了，
 * 比不让拖更糟（用户会以为是自己的参数填错了）。判据来自清单的 `requires`，
 * 不在这里写类型名。
 */
function libraryTitle(def: NodeTypeDef, backend: BackendKind | null): string {
  const lines = [def.description, '', '拖到画布上，或点击添加到画布中央']
  if (def.requires?.runtime === 'host') {
    if (backend === 'local') {
      lines.push('', `当前选择本地执行模式（运行时需宿主保持在线）：${def.requires.reason}`)
    } else if (backend === 'pyodide') {
      lines.push('', `⚠ 需要本地宿主：${def.requires.reason}`)
      lines.push(
        '当前跑在浏览器引擎上，这个节点现在算不了。启动宿主（sciviz-local\\run-host.ps1）后刷新页面。',
      )
    } else {
      lines.push('', `正在检查可用执行模式；此节点需要本地宿主：${def.requires.reason}`)
    }
  }
  return lines.join('\n')
}

export function NodeLibrary() {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const addNode = useWorkflowStore((s) => s.addNode)
  const workflow = useEditingWorkflow()
  const activeGroupPath = useWorkflowStore((s) => s.activeGroupPath)
  const nodes = workflow.nodes
  const allAnnotations = useAnnotationStore((s) => s.annotations)
  const annotations = useMemo(
    () => annotationsInGroupPath(allAnnotations, activeGroupPath),
    [allAnnotations, activeGroupPath],
  )
  const addAnnotation = useAnnotationStore((s) => s.add)
  const customModules = useModuleStore((s) => s.modules)
  const favorites = useModuleStore((s) => s.favorites)
  const toggleFavorite = useModuleStore((s) => s.toggleFavorite)
  const openEditor = useModuleStore((s) => s.openEditor)
  const backend = useBackendKind()
  const { screenToFlowPosition } = useReactFlow()

  const grouped = useMemo(() => {
    // allNodeDefs() 是现取的（自建模块随用户增删变化），所以要在依赖里显式挂上它，
    // 否则新建/删除模块之后这一栏不会重算
    void customModules
    const defs = allNodeDefs().filter(
      (def) => def.lifecycle !== 'legacy' && def.type !== WORKFLOW_GROUP_TYPE,
    )
    const q = query.trim().toLowerCase()
    const match = (d: NodeTypeDef) =>
      !q ||
      d.label.toLowerCase().includes(q) ||
      d.type.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q)
    return categoryOrder
      .map((cat) => ({
        cat,
        items: defs.filter((d) => d.category === cat && match(d)),
      }))
      .filter((g) => g.items.length > 0)
  }, [query, customModules])

  /*
   * 新落点。
   *
   * 工作流节点与批注都参与避让。批注优先取当前 DOM 的真实外框（图片可被用户调整尺寸，
   * 标题也会换行）；尚未渲染时再用保存的图片尺寸或其他批注的名义尺寸估算。
   */
  const nextPosition = (incoming?: { w: number; h: number }) => {
    const rendered = new Map(
      Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).map((element) => [
        element.dataset.id,
        element,
      ]),
    )
    const annotationFootprints = annotations.map((a) => {
      const element = rendered.get(a.id)
      if (element) {
        const rect = element.getBoundingClientRect()
        const topLeft = screenToFlowPosition({ x: rect.left, y: rect.top })
        const bottomRight = screenToFlowPosition({ x: rect.right, y: rect.bottom })
        return {
          position: a.position,
          size: {
            w: Math.abs(bottomRight.x - topLeft.x),
            h: Math.abs(bottomRight.y - topLeft.y),
          },
        }
      }
      return {
        position: a.position,
        size:
          a.kind === 'image'
            ? { w: a.width, h: a.height + 40 }
            : ANNOTATION_NOMINAL[a.kind],
      }
    })
    return nextNodePosition(
      screenToFlowPosition,
      [...nodes.map((n) => ({ position: n.position })), ...annotationFootprints],
      incoming,
    )
  }

  /**
   * 批注的落点：量上一条批注的**真实**尺寸往下/往右排。
   *
   * 上一条此刻已经在 DOM 里（它渲染完才会被点第二条），所以量得到。
   * 只有第一条（或还没渲染出来时）才退回格子摆放。
   */
  const nextAnnotationSpot = (kind: AnnotationKind) =>
    nextAnnotationPosition(
      screenToFlowPosition,
      annotations.length ? annotations[annotations.length - 1].id : null,
      ANNOTATION_NOMINAL[kind],
      () => nextPosition(ANNOTATION_NOMINAL[kind]),
    )

  const visibleCount = grouped.reduce((n, g) => n + g.items.length, 0)

  return (
    <aside className="panel left">
      <div className="section">
        <div className="section-head">
          <span>实验记录</span>
        </div>
        <div className="section-body">
          {NOTE_TOOLS.map((t) => (
            <div
              key={t.kind}
              className="lib-node"
              draggable
              title={`${t.desc}\n\n拖到画布上，或点击添加到画布中央`}
              onDragStart={(e) => {
                e.dataTransfer.setData(ANNOTATION_DND_MIME, t.kind)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onClick={() => addAnnotation(t.kind, nextAnnotationSpot(t.kind), activeGroupPath)}
            >
              <div className="lib-node-top">
                {/*
                  图标与名字同在一个左组里，但**不是** `.lib-node-name` 的后代：
                  那个元素的文本一旦变成"▦表格"，e2e 的 `libCard()` 精确匹配就落空
                  （它存在的理由正是"数据源"三个字也出现在别的卡描述里，不能靠模糊文本挑卡片）。
                */}
                <span className="lib-node-left">
                  <span className="lib-node-icon" aria-hidden="true">{t.icon}</span>
                  <span className="lib-node-name">{t.label}</span>
                </span>
              </div>
              <div className="lib-node-desc">{t.desc}</div>
            </div>
          ))}
          <div className="field-note">
            这些不是算子：不参与计算、不能被连线，因此也不会出现在给 agent 的算子清单里。
            它们与图一起存进工程文件，所以记下的读数会跟着这份工程走。
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <span>节点库</span>
          <button
            className="link-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openEditor(null)}
            title="定义一个自己的模块：起个名字、写一段 Python，形参自动成为输入端口"
          >
            ＋ 新建模块
          </button>
        </div>
        <div className="section-body">
          <input
            type="text"
            placeholder="搜索节点…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="field-note">
            共 {visibleCount} 种。点 ★ 钉到画布左上角的常用工具栏，点条目直接加进画布。
          </div>
        </div>
      </div>

      {grouped.map(({ cat, items }) => {
        const meta = categoryMeta[cat]
        const isCollapsed = collapsed[cat]
        return (
          <div className="section" key={cat}>
            <div
              className="section-head clickable"
              onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="cat-dot" style={{ background: meta.color }} />
                {meta.label}
              </span>
              <span style={{ textTransform: 'none', fontWeight: 400 }}>
                {isCollapsed ? '▸' : '▾'} {items.length}
              </span>
            </div>
            {!isCollapsed && (
              <div className="section-body">
                {items.map((d) => {
                  const mine = isUserModuleType(d.type)
                  const starred = favorites.includes(d.type)
                  const hostOnly = d.requires?.runtime === 'host'
                  return (
                    <div
                      key={d.type}
                      className="lib-node"
                      draggable
                      title={libraryTitle(d, backend)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(NODE_DND_MIME, d.type)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onClick={() => addNode(d.type, nextPosition())}
                    >
                      <div className="lib-node-top">
                        <span className="lib-node-name">
                          {d.label}
                          {mine && <span className="lib-node-tag">自建</span>}
                          {hostOnly && (
                            <span
                              className={`lib-node-tag host ${backend === 'local' ? 'host-local' : backend === null ? 'host-pending' : ''}`}
                              title={
                                backend === 'local'
                                  ? `当前选择本地模式；运行时需宿主保持在线。${d.requires?.reason ?? ''}`
                                  : backend === 'pyodide'
                                    ? `${d.requires?.reason ?? '需要本地宿主'}。当前浏览器引擎不能运行此节点`
                                    : `正在检查执行模式。${d.requires?.reason ?? '需要本地宿主'}`
                              }
                            >
                              {backend === 'local' ? '本地模式' : backend === 'pyodide' ? '需宿主' : '检查中'}
                            </span>
                          )}
                        </span>
                        <span className="lib-node-actions">
                          {mine && (
                            <button
                              className="lib-icon-btn"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => {
                                e.stopPropagation()
                                openEditor(d.type)
                              }}
                              title={`编辑「${d.label}」的名称、分类与代码`}
                            >
                              ✎
                            </button>
                          )}
                          <button
                            className={`lib-icon-btn star ${starred ? 'on' : ''}`}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleFavorite(d.type)
                            }}
                            title={
                              starred
                                ? `把「${d.label}」移出常用工具栏`
                                : `把「${d.label}」钉到常用工具栏`
                            }
                          >
                            {starred ? '★' : '☆'}
                          </button>
                        </span>
                      </div>
                      <div className="lib-node-desc">{d.description}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {grouped.length === 0 && <div className="empty-hint">没有匹配「{query}」的节点</div>}

      <div className="section">
        <div className="section-body">
          <div className="hint-box" style={{ marginBottom: 0 }}>
            拖拽节点到画布，从右侧端口拉线连接。连线会校验端口类型并阻止成环。
            选中节点或连线后按 <kbd>Delete</kbd> 删除。拖空白平移画布，
            按住 <kbd>Shift</kbd> 拖空白框选多个内容。可把步骤和批注组合为子空间，也可把图片、表格、便签或思维图移入已有组块；双击组块，或选中后点「进入组块」打开内部画布。
          </div>
        </div>
      </div>
    </aside>
  )
}
