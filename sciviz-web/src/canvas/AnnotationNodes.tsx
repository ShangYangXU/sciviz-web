import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type NodeProps } from '@xyflow/react'
import {
  ANNOTATION_IMAGE_SIZE_LIMITS,
  mindRemoved,
  mindText,
  tableCell,
  tableColumnAdded,
  tableColumnLabel,
  tableColumnRemoved,
  tableRowAdded,
  tableRowRemoved,
  type Annotation,
  type MindBranch,
  type MindmapAnnotation,
  type ImageAnnotation,
  type TableAnnotation,
} from '../workflow/annotations'
import { useAnnotationStore } from '../store/useAnnotationStore'

/**
 * 画布上的批注：表格、思维图、图片。
 *
 * 便签不在其中了（2026-09-20）：记录搬到了独立的「实验笔记」栏，画布只留结构与少数大件。
 * 原因见 `workflow/annotations.ts` 的头部注释。
 *
 * 三条贯穿全部三个视图的约定：
 *
 * 1. **形状不由视图拼**。改一格、加一列、删一支，都走 `workflow/annotations.ts` 里那些
 *    纯函数 —— 界面只负责"把点击翻译成一次调用"。规则有两份的那天，就是往返丢数据的那天。
 * 2. **每个可输入的控件都带 `nodrag` / `nowheel`**。React Flow 默认把节点上的按下-拖动
 *    当成"移动这个节点"，把滚轮当成"缩放画布"；不加这两个类，在格子里选文字就会把整张
 *    表拖走 —— 那种体验会让人以为软件坏了。
 * 3. **常态下没有装饰**。删除、加行这类按钮平时收着，选中或悬停才露出来（Excalidraw 那套）。
 *    记数据的地方该像纸，不该像工具栏。
 */

interface AnnotationData extends Record<string, unknown> {
  annotation: Annotation
}

const pick = (data: NodeProps['data']): Annotation => (data as AnnotationData).annotation

/** 改一条批注：把纯函数交给 store 的 replace。id 就是 React Flow 的节点 id */
function edit<T extends Annotation>(id: string, fn: (a: T) => T) {
  useAnnotationStore.getState().replace(id, (a) => fn(a as T))
}

/** 删掉整条批注。`stopPropagation`：不然这一下会顺带把节点拖走 */
function DeleteButton({ id, label }: { id: string; label: string }) {
  return (
    <button
      type="button"
      className="an-del nodrag"
      title={label}
      aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        useAnnotationStore.getState().remove([id])
      }}
    >
      ×
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* 图片                                                                */
/* ------------------------------------------------------------------ */

function ImageTitleEditor({
  id,
  title,
  width,
}: {
  id: string
  title: string
  width: number
}) {
  const [draft, setDraft] = useState(title)
  const [editing, setEditing] = useState(false)
  const draftRef = useRef(title)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const updateDraft = (value: string) => {
    draftRef.current = value
    setDraft(value)
  }
  const commit = () => {
    const latest = useAnnotationStore.getState().annotations.find((x) => x.id === id)
    if (latest?.kind === 'image' && latest.title !== draftRef.current) {
      edit<ImageAnnotation>(id, (image) => ({ ...image, title: draftRef.current }))
    }
  }

  useEffect(() => {
    if (!editing) {
      draftRef.current = title
      setDraft(title)
    }
  }, [title, editing])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [draft, width])

  useEffect(
    () => () => {
      // 若图片在标题输入框仍聚焦时被删除或切层，也先把草稿写进批注状态。
      const latest = useAnnotationStore.getState().annotations.find((x) => x.id === id)
      if (latest?.kind === 'image' && latest.title !== draftRef.current) {
        edit<ImageAnnotation>(id, (image) => ({ ...image, title: draftRef.current }))
      }
    },
    [id],
  )

  return (
    <textarea
      ref={textareaRef}
      className="an-image-title-edit nodrag nowheel"
      rows={1}
      value={draft}
      placeholder="添加图片标题，可换行"
      aria-label="图片标题"
      onFocus={() => setEditing(true)}
      onBlur={() => {
        commit()
        setEditing(false)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => updateDraft(e.target.value)}
    />
  )
}

export function ImageView({ id, data, selected }: NodeProps) {
  const a = pick(data) as ImageAnnotation
  return (
    <div
      className={`an-image-card${selected ? ' selected' : ''}`}
      style={{ width: a.width }}
    >
      <div className="an-image-head">
        <span className="an-image-label">图片</span>
        {a.source && <span className="an-image-source">· {a.source}</span>}
        <DeleteButton id={id} label="删掉这张图片" />
      </div>
      {selected ? (
        <ImageTitleEditor id={id} title={a.title} width={a.width} />
      ) : (
        a.title && <div className="an-image-caption">{a.title}</div>
      )}
      {selected && (
        <div className="an-image-size-controls nodrag nowheel" aria-label="图片尺寸">
          <label className="an-image-size-row">
            <span>宽度 {a.width}px</span>
            <input
              type="range"
              min={ANNOTATION_IMAGE_SIZE_LIMITS.min}
              max={ANNOTATION_IMAGE_SIZE_LIMITS.max}
              step={10}
              value={a.width}
              aria-label="图片宽度"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const width = Number(e.target.value)
                edit<ImageAnnotation>(id, (image) => ({ ...image, width }))
              }}
            />
          </label>
          <label className="an-image-size-row">
            <span>高度 {a.height}px</span>
            <input
              type="range"
              min={ANNOTATION_IMAGE_SIZE_LIMITS.min}
              max={ANNOTATION_IMAGE_SIZE_LIMITS.max}
              step={10}
              value={a.height}
              aria-label="图片高度"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const height = Number(e.target.value)
                edit<ImageAnnotation>(id, (image) => ({ ...image, height }))
              }}
            />
          </label>
        </div>
      )}
      <img
        className="an-image"
        src={a.src}
        alt={a.alt}
        width={a.width}
        height={a.height}
        style={{ height: a.height }}
        draggable={false}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */

export function TableView({ id, data, selected }: NodeProps) {
  const a = pick(data) as TableAnnotation
  return (
    <div className={`an-table${selected ? ' selected' : ''}`}>
      <div className="an-table-head">
        <input
          className="an-title nodrag nowheel"
          value={a.title}
          placeholder="表名（例：三组工况的峰值读数）"
          aria-label="表名"
          onChange={(e) => edit<TableAnnotation>(id, (t) => ({ ...t, title: e.target.value }))}
        />
        <DeleteButton id={id} label="删掉这张表" />
      </div>

      <table className="an-grid">
        <thead>
          <tr>
            <th className="an-row-no" />
            {a.columns.map((c, ci) => (
              <th key={ci}>
                <input
                  className="an-cell an-cell-head nodrag nowheel"
                  value={c}
                  placeholder="列名"
                  aria-label={`第 ${ci + 1} 列的列名`}
                  onChange={(e) => edit<TableAnnotation>(id, (t) => tableColumnLabel(t, ci, e.target.value))}
                />
                <button
                  type="button"
                  className="an-mini nodrag"
                  title={a.columns.length <= 1 ? '只剩一列，没得删' : '删掉这一列'}
                  aria-label="删掉这一列"
                  disabled={a.columns.length <= 1}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => edit<TableAnnotation>(id, (t) => tableColumnRemoved(t, ci))}
                >
                  ×
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {a.rows.map((row, ri) => (
            <tr key={ri}>
              <td className="an-row-no">
                <span className="an-no">{ri + 1}</span>
                <button
                  type="button"
                  className="an-mini nodrag"
                  title="删掉这一行"
                  aria-label="删掉这一行"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => edit<TableAnnotation>(id, (t) => tableRowRemoved(t, ri))}
                >
                  ×
                </button>
              </td>
              {a.columns.map((_, ci) => (
                <td key={ci}>
                  <input
                    className="an-cell nodrag nowheel"
                    value={row[ci] ?? ''}
                    aria-label={`第 ${ri + 1} 行第 ${ci + 1} 列`}
                    onChange={(e) => edit<TableAnnotation>(id, (t) => tableCell(t, ri, ci, e.target.value))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="an-table-foot">
        <button
          type="button"
          className="an-add nodrag"
          title="在末尾加一行"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => edit<TableAnnotation>(id, (t) => tableRowAdded(t))}
        >
          ＋ 行
        </button>
        <button
          type="button"
          className="an-add nodrag"
          title="加一列"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => edit<TableAnnotation>(id, (t) => tableColumnAdded(t))}
        >
          ＋ 列
        </button>
        <span className="an-count">
          {a.rows.length} 行 · {a.columns.length} 列
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 思维图                                                              */
/* ------------------------------------------------------------------ */

/**
 * 一支（连着它的子支）。
 *
 * 连线用 CSS 画（子支那一列有左边框，每支再伸出一小截横线）：
 * 这样整张图仍然是一个 React Flow 节点，而不是一堆用边连起来的节点 ——
 * 那些边会被 L1 校验器看见、被求值计划当成数据流，而思维图的线只是排版。
 */
function Branch({ mapId, branch, isRoot }: { mapId: string; branch: MindBranch; isRoot: boolean }) {
  const add = () => useAnnotationStore.getState().addChild(mapId, branch.id)
  return (
    <div className="an-mm-row">
      <div className={`an-mm-node${isRoot ? ' root' : ''}`}>
        <input
          className="an-mm-text nodrag nowheel"
          value={branch.text}
          placeholder={isRoot ? '中心主题' : '写一支…'}
          aria-label={isRoot ? '中心主题' : '分支名'}
          onChange={(e) =>
            edit<MindmapAnnotation>(mapId, (m) => ({ ...m, root: mindText(m.root, branch.id, e.target.value) }))
          }
          onKeyDown={(e) => {
            // Tab 加子支：这是这类工具里最省动作的一条路径（想展开一支时手就在那个键上）
            if (e.key === 'Tab') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button
          type="button"
          className="an-mini nodrag"
          title="加一支（也可以按 Tab）"
          aria-label="加一支"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={add}
        >
          ＋
        </button>
        {!isRoot && (
          <button
            type="button"
            className="an-mini nodrag"
            title="删掉这一支（连着它的子支）"
            aria-label="删掉这一支"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() =>
              edit<MindmapAnnotation>(mapId, (m) => ({ ...m, root: mindRemoved(m.root, branch.id) }))
            }
          >
            ×
          </button>
        )}
      </div>
      {branch.children.length > 0 && (
        <div className="an-mm-children">
          {branch.children.map((c) => (
            <Branch key={c.id} mapId={mapId} branch={c} isRoot={false} />
          ))}
        </div>
      )}
    </div>
  )
}

export function MindmapView({ id, data, selected }: NodeProps) {
  const a = pick(data) as MindmapAnnotation
  return (
    <div className={`an-mm${selected ? ' selected' : ''}`}>
      <div className="an-mm-head">
        <span className="an-mm-kind">思维图</span>
        <DeleteButton id={id} label="删掉这张思维图" />
      </div>
      <Branch mapId={id} branch={a.root} isRoot />
    </div>
  )
}
