import { useEffect, useState, type ReactNode } from 'react'
import { useEditingWorkflow, useWorkflowStore, useSelectedNode } from '../store/useWorkflowStore'
import { getNodeTypeDef } from '../workflow/nodeRegistry'
import {
  isFunctionNode,
  resolvePorts,
  resolveFigureUpstreamTable,
  resolveUpstreamTable,
} from '../workflow/ports'
import { autoMapColumns, columnsFromNames } from '../workflow/chartFromTable'
import { useNodeOutputStore, useNodeRefs } from '../store/nodeOutputStore'
import { parseSignature, parseTrainingSignature } from '../workflow/functionSignature'
import {
  parseModelListValue,
  parseModelParams,
  serializeModelListValue,
  validateModelListParamValue,
} from '../workflow/modelParams'
import { listDatasetRefs, localDatasetIdFor, useImportedDatasets } from '../store/useDataStore'
import { usePortContext } from '../engine/portContext'
import { categoryMeta, portTypeMeta, type ParamSpec, type PortSpec } from '../workflow/types'
import { chartTypes } from '../charts/chartTypes'
import { palettes } from '../charts/palettes'
import type { ChartType, Column, SlotKey } from '../types'
import { WORKFLOW_GROUP_TYPE, runtimeNodeIdForPath } from '../workflow/groups'

const roleLabel: Record<string, string> = {
  continuous: '连续',
  categorical: '分类',
  time: '时间',
  identifier: '标识',
}

/** 常见英文参数的简短释义；用户填写的节点注释始终优先。 */
const PARAM_MEANINGS: Readonly<Record<string, string>> = {
  data: '输入数据',
  padding: '片段前后留白',
  gap_factor: '间隔倍率',
  min_segment_points: '最短片段点数',
  burner_load_on: '燃烧器负荷开启值',
  pressure_high: '压力上限',
  pressure_low: '压力下限',
  level_high: '液位上限',
  level_low: '液位下限',
  level_hold_minutes: '液位保持分钟数',
  flue_temp_alarm: '烟温报警值',
  flue_temp_high: '烟温上限',
  setpoint_low: '设定值下限',
  setpoint_clock: '设定时间',
  work_segment: '工作段编号',
  batch_size: '每批样本数',
  learning_rate: '学习率',
  epochs: '训练轮数',
  seed: '随机种子',
}

function ParamNote({
  name,
  note,
  onChange,
}: {
  name: string
  note: string
  onChange: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note)
  const suggested = PARAM_MEANINGS[name] ?? ''
  const save = () => {
    onChange(draft.trim())
    setEditing(false)
  }
  return (
    <div className="param-note">
      {editing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          maxLength={48}
          aria-label={`${name} 的中文说明`}
          placeholder="一句话说明变量含义"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setDraft(note)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="param-note-edit"
          title="点击修改中文说明"
          onClick={() => {
            setDraft(note || suggested)
            setEditing(true)
          }}
        >
          {note || suggested || '添加中文说明'} <span aria-hidden="true">✎</span>
        </button>
      )}
    </div>
  )
}

/** 图表节点的字段映射：只列出当前图表类型能接受的列 */
function MappingSelect({
  slot,
  value,
  chartType,
  columns,
  onChange,
}: {
  slot: SlotKey
  value: string
  chartType: string
  /** 只用绘图节点实际连接/输出的数据列；没有结果时不提供虚构的数据集候选 */
  columns: Column[] | null
  onChange: (v: string) => void
}) {
  const meta = chartTypes.find((c) => c.type === chartType)
  const accepts = meta?.accepts[slot]
  const slotLabel = { x: 'X 轴', y: 'Y 轴', color: '颜色' }[slot]

  if (!columns) {
    return (
      <div className="field">
        <label>{slotLabel}</label>
        <div className="field-note">接入数据并生成绘图结果后，这里会显示可选列</div>
      </div>
    )
  }

  const options: Column[] = accepts ? columns.filter((c) => accepts.includes(c.role)) : []

  return (
    <div className="field">
      <label>
        {slotLabel}
        <span className="field-note">{accepts ? accepts.map((r) => roleLabel[r]).join(' / ') : '—'}</span>
      </label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">（不映射）</option>
        {/* 接了上游之后，原来的列名可能在这张表里并不存在。留一个显式占位项，便于修正映射。 */}
        {value && !options.some((c) => c.name === value) ? (
          <option value={value}>{value}（当前数据里没有这一列）</option>
        ) : null}
        {options.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
            {c.unit ? ` (${c.unit})` : ''}
          </option>
        ))}
      </select>
      {!accepts && <div className="field-note warn">当前图表类型不支持{slotLabel}映射</div>}
    </div>
  )
}

function ListParamEditor({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec
  value: string | number | boolean
  onChange: (v: string) => void
}) {
  const parsed = parseModelListValue(value)
  const values = parsed.values
  const itemType = spec.listItemType ?? 'text'
  const validationError = parsed.error ?? validateModelListParamValue(spec, value)
  const save = (next: unknown[]) => onChange(serializeModelListValue(next))
  const updateItem = (index: number, nextValue: unknown) => {
    const next = [...values]
    next[index] = nextValue
    save(next)
  }
  const newItem = (): unknown => {
    if (itemType === 'text') return ''
    if (itemType === 'boolean') return false
    const candidate = spec.itemMin ?? 0
    const bounded = spec.itemMax !== undefined ? Math.min(candidate, spec.itemMax) : candidate
    return itemType === 'int' ? Math.ceil(bounded) : bounded
  }

  return (
    <div className="field list-param-field">
      <label>
        {spec.label}
        <span className="field-note">{values.length}/{spec.maxItems ?? 64} 项</span>
      </label>
      {values.map((item, index) => (
        <div className="list-param-row" key={`${index}`}>
          {itemType === 'boolean' ? (
            <label className="list-param-boolean">
              <input
                type="checkbox"
                checked={item === true}
                aria-label={`${spec.label}第 ${index + 1} 项`}
                onChange={(event) => updateItem(index, event.target.checked)}
              />
              第 {index + 1} 项
            </label>
          ) : (
            <input
              type={itemType === 'int' || itemType === 'float' ? 'number' : 'text'}
              value={typeof item === 'string' || typeof item === 'number' ? item : String(item)}
              min={itemType === 'int' || itemType === 'float' ? spec.itemMin : undefined}
              max={itemType === 'int' || itemType === 'float' ? spec.itemMax : undefined}
              step={itemType === 'int' ? 1 : 'any'}
              aria-label={`${spec.label}第 ${index + 1} 项`}
              onChange={(event) => {
                if (itemType === 'text') {
                  updateItem(index, event.target.value)
                  return
                }
                const number = Number(event.target.value)
                if (Number.isFinite(number)) updateItem(index, number)
              }}
            />
          )}
          <button
            type="button"
            className="icon-btn list-param-remove"
            aria-label={`删除${spec.label}第 ${index + 1} 项`}
            disabled={values.length <= (spec.minItems ?? 0)}
            onClick={() => save(values.filter((_, itemIndex) => itemIndex !== index))}
          >
            −
          </button>
        </div>
      ))}
      <div className="list-param-actions">
        <button
          type="button"
          onClick={() => save([...values, newItem()])}
          disabled={values.length >= (spec.maxItems ?? 64)}
        >
          新增一项
        </button>
        {validationError && (
          <button type="button" className="icon-btn" onClick={() => onChange(String(spec.default))}>
            恢复默认
          </button>
        )}
      </div>
      {validationError && <div className="field-note warn">{validationError}</div>}
      {spec.hint && <div className="field-note">{spec.hint}</div>}
    </div>
  )
}

function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec
  value: string | number | boolean
  onChange: (v: string | number | boolean) => void
}) {
  if (spec.widget === 'list') {
    return <ListParamEditor spec={spec} value={value} onChange={(next) => onChange(next)} />
  }

  switch (spec.type) {
    case 'boolean':
      return (
        <label className="checkbox-row">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {spec.label}
          {spec.required && <span className="field-note warn">必填</span>}
        </label>
      )

    case 'select':
      return (
        <div className="field">
          <label>
            {spec.label}
            {spec.required && <span className="field-note warn">必填</span>}
          </label>
          <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {(spec.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {spec.hint && <div className="field-note">{spec.hint}</div>}
        </div>
      )

    case 'code':
      return (
        <div className="field">
          <label>
            {spec.label}
            {spec.required && <span className="field-note warn">必填</span>}
          </label>
          <textarea
            className="code-area"
            rows={7}
            value={String(value)}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
          {spec.hint && <div className="field-note warn">{spec.hint}</div>}
        </div>
      )

    case 'number':
      return (
        <div className="field">
          <label>
            {spec.label}
            {spec.required && <span className="field-note warn">必填</span>}
            {spec.unit && <span className="field-note">{spec.unit}</span>}
          </label>
          <input
            type="number"
            value={Number(value)}
            min={spec.min}
            max={spec.max}
            step={spec.step ?? 1}
            onChange={(e) => {
              const n = Number(e.target.value)
              onChange(Number.isFinite(n) ? n : 0)
            }}
          />
          {spec.hint && <div className="field-note">{spec.hint}</div>}
        </div>
      )

    default:
      return (
        <div className="field">
          <label>
            {spec.label}
            {spec.required && <span className="field-note warn">必填</span>}
          </label>
          <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />
          {spec.hint && <div className="field-note">{spec.hint}</div>}
        </div>
      )
  }
}

function ParameterControls({
  spec,
  value,
  port,
  connected,
  expanded,
  note,
  onChange,
  onTogglePort,
  onNoteChange,
  showNote = false,
}: {
  spec: ParamSpec
  value: string | number | boolean
  port?: PortSpec
  connected: boolean
  expanded: boolean
  note: string
  onChange: (value: string | number | boolean) => void
  onTogglePort: () => void
  onNoteChange: (note: string) => void
  showNote?: boolean
}) {
  return (
    <div className="param-control">
      {connected || (port && !port.optional) ? (
        <div className="field">
          <label>{spec.label}</label>
          <div className="field-note">
            {connected ? `由上游连线提供；断开后使用默认值 ${String(value)}` : '必需从上游连线输入'}
          </div>
        </div>
      ) : (
        <ParamField spec={spec} value={value} onChange={onChange} />
      )}
      {(showNote || spec.label === spec.key || note) && (
        <ParamNote name={spec.key} note={note} onChange={onNoteChange} />
      )}
      {port?.optional && (
        <button type="button" className="param-port-toggle" onClick={onTogglePort} disabled={connected}>
          {connected ? '已接线' : expanded ? '收起接线口' : '需要接线？显示接线口'}
        </button>
      )}
    </div>
  )
}

/** 数据源节点的数据集选择 + 该数据集的特征清单 */
function DatasetPicker({
  datasetId,
  onPick,
}: {
  datasetId: string
  onPick: (id: string) => void
}) {
  const imported = useImportedDatasets()
  void imported
  const refs = listDatasetRefs()
  const selectedLocalId = localDatasetIdFor(datasetId)
  const current = refs.find((r) => r.id === selectedLocalId)

  if (refs.length === 0) {
    return <div className="hint-box warn">还没有数据集。先在顶栏「导入数据」里添加本地 CSV。</div>
  }

  return (
    <div className="field">
      <label>数据集</label>
      <select value={current ? selectedLocalId : datasetId} onChange={(e) => onPick(e.target.value)}>
        <option value="">（未选择）</option>
        {datasetId && !current && <option value={datasetId}>工程引用：等待匹配数据集</option>}
        {refs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      {current && (
        <div className="field-note">
          本地导入 ·{' '}
          {current.rowCount.toLocaleString('en-US')} 行 · {current.featureCount} 个可用特征
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 可折叠的段                                                          */
/* ------------------------------------------------------------------ */

/** 右栏里能折起来的段。目前两段：节点信息、参数 */
type SectionId = 'info' | 'params'

const SECTIONS_KEY = 'sciviz.panelSections'

const defaultSections = (): Record<SectionId, boolean> => ({ info: false, params: true })

/**
 * 读折叠状态。
 *
 * 为什么落在 localStorage 而不是就放在组件 state 里：右栏的「节点参数 / 资产库」是
 * 条件渲染，切一次 tab 这个组件就重新挂载一次，组件 state 会跟着清零 —— 用户刚折好的
 * 那一节在他眼里成了"自己弹开的"。
 *
 * 参数优先展开，较长的节点说明默认收起；已保存的显式折叠状态继续沿用。
 * 读写都包 try/catch —— 隐私模式下的 localStorage 会直接抛异常，那种情况
 * 降级成"本次挂载之内有效"（与 `useModuleStore` 同一处理）。
 */
function readSections(): Record<SectionId, boolean> {
  const fallback = defaultSections()
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(SECTIONS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<Record<SectionId, unknown>>
    return {
      info: parsed.info === true,
      params: parsed.params !== false,
    }
  } catch {
    return fallback
  }
}

function writeSections(next: Record<SectionId, boolean>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(next))
  } catch {
    // 存不下就算了：折叠是便利，不是数据
  }
}

/**
 * 一段可以折起来的内容：一个三角箭头 + 标题 +（可选）身份摘要 +（可选）右侧动作。
 *
 * 三条刻意的选择：
 *
 * - **整行都是按钮**（右侧动作除外），不是只有标题那几个字能点 —— 用户对着一条
 *   分隔线上的小字瞄准，点十次漏三次，比没有这个功能更烦。
 * - **箭头是个真 `button`**：Tab 能得到它、Enter / Space 能按，读屏软件也知道这里
 *   可以操作。画布上那些 `div onClick` 的段头做不到这件事。
 * - **折起来仍保留类别与 type**：收起「节点信息」之后还得看得出这是哪种节点，
 *   否则折叠就变成"把上下文藏起来"，用户只能展开→看清→再收起。
 */
function Fold({
  title,
  open,
  onToggle,
  id,
  action,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  /** 标题右侧的身份摘要（类别点 + 算子 type） */
  id?: ReactNode
  /** 标题行最右侧的动作按钮。它在折叠按钮**之外**，点它不会连带把这一节折起来 */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <div className="section-head inset">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          title={open ? '收起这一节' : '展开这一节'}
          onClick={onToggle}
        >
          <span className={`section-caret${open ? ' open' : ''}`}>▸</span>
          <span>{title}</span>
          {id && <span className="section-id">{id}</span>}
        </button>
        {action}
      </div>
      {open && children}
    </>
  )
}

export function ParamPanel() {
  const node = useSelectedNode()
  const setParam = useWorkflowStore((s) => s.setParam)
  const setParamNote = useWorkflowStore((s) => s.setParamNote)
  const toggleParamPort = useWorkflowStore((s) => s.toggleParamPort)
  const visibleParamPorts = useWorkflowStore((s) => s.visibleParamPorts)
  const syncModelParams = useWorkflowStore((s) => s.syncModelParams)
  const syncTrainingFunctionParams = useWorkflowStore((s) => s.syncTrainingFunctionParams)
  const resetParams = useWorkflowStore((s) => s.resetParams)
  const renameNode = useWorkflowStore((s) => s.renameNode)
  const removeNode = useWorkflowStore((s) => s.removeNode)
  // 注意：所有 hook 必须在下面的提前 return 之前调用，
  // 否则"没选中节点"和"选中节点"两种渲染之间 hook 数量会变，React 直接报错。
  const workflow = useEditingWorkflow()
  const activeGroupPath = useWorkflowStore((s) => s.activeGroupPath)
  // 图表节点可能接了一张上游表：上游是谁要先在这里算出来，因为下一个 hook 要用它。
  // 放进提前 return 之后就是这个文件顶上那句警告的下场 —— 实测崩过一次。
  const upstreamOfChart =
    node && (node.type === 'viz.chart' || node.type === 'custom.chart')
      ? resolveFigureUpstreamTable(workflow, node.id)
      : null
  const upstreamRefs = useNodeRefs(
    upstreamOfChart ? runtimeNodeIdForPath(activeGroupPath, upstreamOfChart.nodeId) : '',
  )
  // 节点自己的输出摘要（密度图要用它说"画的是哪一列"）。同样是 hook，必须在提前 return 之前
  const ownRefs = useNodeRefs(node ? runtimeNodeIdForPath(activeGroupPath, node.id) : '')
  const allRefs = useNodeOutputStore((s) => s.refs)
  // 端口上下文也是一个 hook（要订阅上游输出来重算动态端口），必须在提前 return 之前
  const portContext = usePortContext()
  /*
   * 折叠状态同理：它在"没选中节点"的提前 return 之前，所以切到空白再切回来不会重置，
   * 也只有真的重新挂载才会回落默认值（展开）。
   */
  const [sections, setSections] = useState<Record<SectionId, boolean>>(readSections)
  const toggleSection = (id: SectionId) => {
    const next = { ...sections, [id]: !sections[id] }
    setSections(next)
    writeSections(next)
  }

  // 自定义模型的 MODEL_PARAMS 是代码的一部分。它变化时把新增参数补进节点、
  // 把已经删掉的参数移除；解析暂时失败（用户正在输入半截字典）时保留旧值，
  // 避免每敲一个字符就把右栏的输入清空。
  const modelSchema =
    node?.type === 'custom.model'
      ? parseModelParams(String(node.params.code ?? ''))
      : { specs: [] }
  const modelSchemaSignature = JSON.stringify(
    modelSchema.specs.map((spec) => ({
      key: spec.key,
      label: spec.label,
      type: spec.type,
      required: spec.required,
      default: spec.default,
      options: spec.options,
      min: spec.min,
      max: spec.max,
      step: spec.step,
      widget: spec.widget,
      listItemType: spec.listItemType,
      minItems: spec.minItems,
      maxItems: spec.maxItems,
      itemMin: spec.itemMin,
      itemMax: spec.itemMax,
      hint: spec.hint,
    })),
  )
  const trainingSignature =
    node?.type === 'train.function'
      ? parseTrainingSignature(String(node.params.code ?? ''))
      : null
  const trainingParamSpecs =
    node?.type === 'train.function' && !trainingSignature?.error
      ? resolvePorts(node, portContext).inputs
          .filter((port) => port.kind === 'param')
          .map((port) => port.paramSpec)
          .filter((spec): spec is ParamSpec => !!spec)
      : []
  const trainingParamSignature = JSON.stringify(
    trainingParamSpecs.map((spec) => ({
      key: spec.key,
      type: spec.type,
      required: spec.required,
      default: spec.default,
    })),
  )
  useEffect(() => {
    if (node?.type === 'custom.model' && !modelSchema.error) {
      syncModelParams(node.id, modelSchema.specs)
    }
    // schema signature 已经包含了所有会影响同步的字段；不把每次渲染都会新建的数组放进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id, node?.type, String(node?.params.code ?? ''), modelSchemaSignature, modelSchema.error])

  useEffect(() => {
    if (node?.type === 'train.function' && !trainingSignature?.error) {
      syncTrainingFunctionParams(node.id, trainingParamSpecs)
    }
    // 保留仍存在的用户值，仅清除已从当前签名删除的动态参数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id, node?.type, String(node?.params.code ?? ''), trainingParamSignature, trainingSignature?.error])

  if (!node) {
    return (
      <div className="panel-body">
        <div className="empty-hint">
          选中画布上的节点，这里会显示它的参数。
          <br />
          <br />
          每个节点的参数都有合理默认值，可以直接连好线就运行。
        </div>
      </div>
    )
  }

  const def = getNodeTypeDef(node.type)
  const cat = categoryMeta[def.category]
  const resolvedPorts = resolvePorts(node, portContext)
  const connectedPortIds = new Set(workflow.edges.filter((edge) => edge.target === node.id).map((edge) => edge.targetPort))
  const portExpanded = (key: string) => visibleParamPorts.includes(JSON.stringify([...activeGroupPath, node.id, key]))

  if (node.type === WORKFLOW_GROUP_TYPE && node.group) {
    return (
      <div className="panel-body">
        <div className="field">
          <label>组块名称</label>
          <input type="text" value={node.label} onChange={(e) => renameNode(node.id, e.target.value)} />
        </div>

        <Fold
          title="组块信息"
          open={sections.info}
          onToggle={() => toggleSection('info')}
          id={
            <>
              <span className="cat-dot" style={{ background: cat.color }} />
              <span style={{ color: cat.color, fontWeight: 600 }}>复合组块</span>
              <code>{node.group.workflow.nodes.length} 个步骤</code>
            </>
          }
        >
          <div className="hint-box">
            {node.group.workflow.name || node.label}。在画布上双击组块可编辑内部步骤；这里的参数会传给对应的内部节点。
          </div>
          <div className="ports-table">
            <div className="ports-row">
              <span className="ports-kind">输入</span>
              <span>
                {node.group.inputs.length
                  ? node.group.inputs.map((port) => (
                      <span key={port.id} className="port-chip" style={{ borderColor: portTypeMeta[port.port.type].color }}>
                        {port.label}
                      </span>
                    ))
                  : <span className="field-note">无数据输入</span>}
              </span>
            </div>
            <div className="ports-row">
              <span className="ports-kind">输出</span>
              <span>
                {node.group.outputs.length
                  ? node.group.outputs.map((port) => (
                      <span key={port.id} className="port-chip" style={{ borderColor: portTypeMeta[port.port.type].color }}>
                        {port.label}
                      </span>
                    ))
                  : <span className="field-note">无数据输出</span>}
              </span>
            </div>
          </div>
        </Fold>

        <Fold
          title="组块参数"
          open={sections.params}
          onToggle={() => toggleSection('params')}
          action={
            <button
              className="icon-btn"
              style={{ fontSize: 11 }}
              onClick={() => node.group!.parameters.forEach((parameter) => setParam(node.id, parameter.key, parameter.spec.default))}
              disabled={node.group.parameters.length === 0}
            >
              恢复默认
            </button>
          }
        >
          {node.group.parameters.length === 0 ? (
            <div className="field-note">这个组块没有可公开编辑的参数。</div>
          ) : (
            node.group.parameters.map((parameter) => {
              const innerNode = node.group!.workflow.nodes.find((candidate) => candidate.id === parameter.nodeId)
              const innerUpstream = innerNode
                ? resolveFigureUpstreamTable(node.group!.workflow, innerNode.id)
                : null
              const innerUpstreamId = innerUpstream
                ? runtimeNodeIdForPath([...activeGroupPath, node.id], innerUpstream.nodeId)
                : ''
              const innerUpstreamRef = innerUpstream
                ? allRefs[innerUpstreamId]?.[innerUpstream.portId]
                : undefined
              const innerColumns =
                innerUpstreamRef?.columns && innerUpstreamRef.columns.length > 0
                  ? columnsFromNames(innerUpstreamRef.columns, innerUpstreamRef.timeColumn ?? null)
                  : null
              const spec = { ...parameter.spec, key: parameter.key, label: parameter.label }
              const value = node.params[parameter.key] ?? parameter.spec.default
              const onChange = (next: string | number | boolean) => setParam(node.id, parameter.key, next)

              if (spec.widget === 'datasetRef') {
                return (
                  <DatasetPicker
                    key={parameter.key}
                    datasetId={String(value)}
                    onPick={(id) => onChange(id)}
                  />
                )
              }
              if (spec.widget === 'chartType') {
                return (
                  <div className="field" key={parameter.key}>
                    <label>{spec.label}</label>
                    <select value={String(value)} onChange={(event) => onChange(event.target.value)}>
                      {chartTypes.map((chart) => (
                        <option key={chart.type} value={chart.type}>{chart.label}</option>
                      ))}
                    </select>
                  </div>
                )
              }
              if (spec.widget === 'mapping') {
                return (
                  <MappingSelect
                    key={parameter.key}
                    slot={parameter.paramKey as SlotKey}
                    value={String(value)}
                    chartType={String(innerNode?.params.chartType ?? 'scatter')}
                    columns={innerColumns}
                    onChange={onChange}
                  />
                )
              }
              if (spec.widget === 'palette') {
                return (
                  <div className="field" key={parameter.key}>
                    <label>{spec.label}</label>
                    <select value={String(value)} onChange={(event) => onChange(event.target.value)}>
                      {palettes.map((palette) => (
                        <option key={palette.id} value={palette.id}>{palette.name}</option>
                      ))}
                    </select>
                  </div>
                )
              }
              return (
                <ParameterControls
                  key={parameter.key}
                  spec={spec}
                  value={value}
                  port={resolvedPorts.inputs.find((port) => port.id === parameter.key && port.kind === 'param')}
                  connected={connectedPortIds.has(parameter.key)}
                  expanded={portExpanded(parameter.key)}
                  note={node.paramNotes?.[parameter.key] ?? ''}
                  showNote
                  onChange={onChange}
                  onTogglePort={() => toggleParamPort(node.id, parameter.key)}
                  onNoteChange={(note) => setParamNote(node.id, parameter.key, note)}
                />
              )
            })
          )}
        </Fold>

        <div style={{ marginTop: 14 }}>
          <button className="danger" style={{ width: '100%' }} onClick={() => removeNode(node.id)}>
            删除该组块
          </button>
        </div>
      </div>
    )
  }

  const chartType = String(node.params.chartType ?? 'scatter')
  const datasetId = String(node.params.datasetId ?? '')
  const isDataSource = node.type === 'data.source'
  /*
   * 密度图画的是哪一列。**不能**拿连线去反查一个数据集（旧代码走的就是那条路）：
   * 那个反查只认"上游直接是数据源节点"，隔着函数或拆列节点就查不到，于是面板上说
   * "还没接上游数据列"，而框上明明挂着一张刚算出来的图 —— 两处各说一套。
   *
   * 现在读引擎自己给出的输出摘要：列名与时间列都在里面，挑哪一列用的还是画图那份
   * `autoMapColumns`（同一份规则，不在这儿第三次实现）。
   */
  const densityRef = node.type === 'viz.density' ? ownRefs?.figure : undefined
  const densityCols =
    densityRef?.columns && densityRef.columns.length > 0
      ? columnsFromNames(densityRef.columns, densityRef.timeColumn ?? null)
      : null
  const densityCol = densityCols ? autoMapColumns(densityCols, 'density').x : ''
  const densityFrom = node.type === 'viz.density' ? resolveUpstreamTable(workflow, node.id, 'data') : null
  // 图表节点接了上游表时，X/Y 的候选列来自那一步的输出，而不是节点上选的数据集。
  // 从上游的输出摘要里取列名 —— 行列数由引擎算，这里不用重新拉一遍行值。
  const upstream = upstreamOfChart
  const upstreamRef = upstream ? upstreamRefs?.[upstream.portId] : undefined
  const upstreamCols =
    upstreamRef?.columns && upstreamRef.columns.length > 0
      ? columnsFromNames(upstreamRef.columns, upstreamRef.timeColumn ?? null)
      : null
  const chartOutputRef = node.type === 'custom.chart' ? ownRefs?.figure : undefined
  const chartOutputCols =
    chartOutputRef?.columns && chartOutputRef.columns.length > 0
      ? columnsFromNames(chartOutputRef.columns, chartOutputRef.timeColumn ?? null)
      : null
  // 自定义图表可以改变列结构，因此映射候选来自函数实际返回的 figure；普通图表直接消费输入表。
  const mappingCols = node.type === 'custom.chart' ? chartOutputCols : upstreamCols
  // 函数节点的端口来自代码签名，这里解析出来给用户看
  const sig = isFunctionNode(node.type)
    ? node.type === 'train.function'
      ? parseTrainingSignature(String(node.params.code ?? ''))
      : parseSignature(String(node.params.code ?? ''))
    : null

  const { inputs, outputs } = resolvedPorts

  const remap = (nextChartType: string) => {
    // 自定义绘图按函数返回的 figure 表自动映射；切换图型时也不写回隐藏的旧映射参数。
    if (node.type === 'custom.chart') return
    // 换图型时只按这张图实际消费的列重挑映射；尚未接入数据时清空旧映射。
    const m = mappingCols
      ? autoMapColumns(mappingCols, nextChartType as ChartType)
      : { x: '', y: '', color: '' }
    setParam(node.id, 'x', m.x)
    setParam(node.id, 'y', m.y)
    setParam(node.id, 'color', m.color)
  }

  return (
    <div className="panel-body">
      <div className="field">
        <label>节点名称</label>
        <input type="text" value={node.label} onChange={(e) => renameNode(node.id, e.target.value)} />
      </div>

      {/*
        选数据集是**操作**，不是信息，所以它不进「节点信息」这一折：
        否则收起一节就等于把用户唯一能换数据的下拉框藏起来，而那一节看起来只是"说明文字"。
      */}
      {isDataSource && (
        <DatasetPicker
          datasetId={datasetId}
          onPick={(id) => setParam(node.id, 'datasetId', id)}
        />
      )}

      {/* 「恢复默认」在折叠按钮**之外**：点它是想恢复参数，不该顺手把整节折起来 */}
      <Fold
        title="参数"
        open={sections.params}
        onToggle={() => toggleSection('params')}
        action={
          <button className="icon-btn" style={{ fontSize: 11 }} onClick={() => resetParams(node.id)}>
            恢复默认
          </button>
        }
      >
        {def.params.filter((spec) => spec.type !== 'code').map((spec) => {
          const value = node.params[spec.key] ?? spec.default

          if (spec.widget === 'datasetRef') {
            // 数据源节点已用 DatasetPicker 单独渲染过了
            return null
          }

          if (spec.widget === 'chartType') {
            return (
              <div className="field" key={spec.key}>
                <label>图表类型</label>
                <select
                  value={String(value)}
                  onChange={(e) => {
                    setParam(node.id, spec.key, e.target.value)
                    remap(e.target.value)
                  }}
                >
                  {chartTypes.map((c) => (
                    <option key={c.type} value={c.type}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )
          }

          if (spec.widget === 'mapping') {
            return (
              <MappingSelect
                key={spec.key}
                slot={spec.key as SlotKey}
                value={String(value)}
                chartType={chartType}
                columns={mappingCols}
                onChange={(v) => setParam(node.id, spec.key, v)}
              />
            )
          }

          if (spec.widget === 'palette') {
            return (
              <div className="field" key={spec.key}>
                <label>配色方案</label>
                <select value={String(value)} onChange={(e) => setParam(node.id, spec.key, e.target.value)}>
                  {palettes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )
          }

          return (
            <ParameterControls
              key={spec.key}
              spec={spec}
              value={value}
              port={inputs.find((port) => port.kind === 'param' && port.paramKey === spec.key)}
              connected={connectedPortIds.has(spec.key)}
              expanded={portExpanded(spec.key)}
              note={node.paramNotes?.[spec.key] ?? ''}
              onChange={(v) => setParam(node.id, spec.key, v)}
              onTogglePort={() => toggleParamPort(node.id, spec.key)}
              onNoteChange={(note) => setParamNote(node.id, spec.key, note)}
            />
          )
        })}

        {inputs.filter((port) => port.kind === 'param' && port.paramSpec &&
          !def.params.some((spec) => spec.key === port.paramKey)).map((port) => {
          const spec = port.paramSpec!
          return (
            <ParameterControls
              key={port.id}
              spec={spec}
              value={node.params[spec.key] ?? spec.default}
              port={port}
              connected={connectedPortIds.has(port.id)}
              expanded={portExpanded(port.id)}
              note={node.paramNotes?.[spec.key] ?? ''}
              onChange={(value) => setParam(node.id, spec.key, value)}
              onTogglePort={() => toggleParamPort(node.id, port.id)}
              onNoteChange={(note) => setParamNote(node.id, spec.key, note)}
            />
          )
        })}

        {node.type === 'custom.model' && modelSchema.specs.length > 0 && (
          <>
            <div className="field-note" style={{ margin: '10px 0 6px' }}>
              模型基础参数（从 MODEL_PARAMS 或 Model.__init__ 自动读取）
            </div>
            {modelSchema.specs.map((spec) => (
              <ParamField
                key={spec.key}
                spec={spec}
                value={node.params[spec.key] ?? spec.default}
                onChange={(value) => setParam(node.id, spec.key, value)}
              />
            ))}
          </>
        )}
        {node.type === 'custom.model' && modelSchema.error && (
          <div className="field-note warn">{modelSchema.error}。完成字典后会自动生成模型参数控件。</div>
        )}
        {def.params.filter((spec) => spec.type === 'code').map((spec) => (
          <ParamField
            key={spec.key}
            spec={spec}
            value={node.params[spec.key] ?? spec.default}
            onChange={(value) => setParam(node.id, spec.key, value)}
          />
        ))}
      </Fold>

      <Fold
        title="节点信息"
        open={sections.info}
        onToggle={() => toggleSection('info')}
        id={
          <>
            <span className="cat-dot" style={{ background: cat.color }} />
            <span style={{ color: cat.color, fontWeight: 600 }}>{cat.label}</span>
            <code>{node.type}</code>
          </>
        }
      >
        <div className="hint-box">{def.description}</div>

        {node.type === 'viz.density' && (
          <div className="ports-table">
            <div className="ports-row">
              <span className="ports-kind">数据列</span>
              <span>
                {densityCol ? (
                  <span className="port-chip">{densityCol}</span>
                ) : (
                  <span className="field-note">
                    {densityFrom ? '等这一列算出结果' : '还没接上游数据列'}
                  </span>
                )}
              </span>
            </div>
            <div className="field-note">
              {densityFrom
                ? `画的是上游「${densityFrom.label}」实际输出的数据。数据源提供整表；要精确指定某一列时，在上游用「拆列」选好列再接入。`
                : '先把数据源整表接到「拆列」，选出要画的列，再连接到这里。函数输出的单列表也可以直接连接。'}
            </div>
          </div>
        )}

        {(node.type === 'viz.chart' || node.type === 'custom.chart') && upstream && (
          <div className="ports-table">
            <div className="ports-row">
              <span className="ports-kind">数据来自</span>
              <span>
                <span className="port-chip">上游「{upstream.label}」</span>
                {upstreamCols ? (
                  <span className="field-note"> · {upstreamCols.length} 列</span>
                ) : (
                  <span className="field-note"> · 等上游算出结果后显示列名</span>
                )}
              </span>
            </div>
            <div className="field-note">
              {node.type === 'custom.chart'
                ? '绘图函数读取这一步接入的数据并返回 figure；绘图列按返回表自动识别，不需要手选 X/Y 轴。'
                : '图上的点由引擎从这一步的实际输出中抽稀，字段映射候选只来自这张上游表。'}
              {' '}改上游参数后图上会跟着变；「运行」只负责把当前图收进资产库。
            </div>
          </div>
        )}

        {node.type === 'custom.model' && (
          <div className="ports-table">
            <div className="ports-row">
              <span className="ports-kind">模型参数</span>
              <span>
                {modelSchema.error ? (
                  <span className="field-note warn">正在等待 MODEL_PARAMS 完成</span>
                ) : modelSchema.specs.length > 0 ? (
                  <span className="field-note">已自动读取 {modelSchema.specs.length} 个基础参数</span>
                ) : (
                  <span className="field-note">未声明模型超参数</span>
                )}
              </span>
            </div>
            <div className="field-note">
              这里是模型结构模板，不会单独创建已初始化的网络。下方可修改模型基础参数；训练节点拿到数据后会注入输入/输出形状，并据此创建带初始权重的模型实例。训练轮数、批大小和训练算法由训练函数决定。
            </div>
          </div>
        )}

        {sig && (
          <div className="ports-table">
            <div className="ports-row">
              <span className="ports-kind">签名</span>
              <span>
                <code>
                  {sig.fnName || '—'}({sig.params.map((p) => p.name).join(', ')})
                </code>
              </span>
            </div>
            <div className="ports-row">
              <span className="ports-kind">输入</span>
              <span>
                {sig.params.length === 0 ? (
                  <span className="field-note">无参数</span>
                ) : (
                  sig.params.map((p) => (
                    <span key={p.name} className="port-chip">
                      {p.name}
                      {!p.hasDefault && <em>必接</em>}
                    </span>
                  ))
                )}
              </span>
            </div>
            <div className="ports-row">
              <span className="ports-kind">输出</span>
              <span>
                {sig.outputs.map((o) => (
                  <span key={o.name} className="port-chip">
                    {o.name}
                  </span>
                ))}
              </span>
            </div>
            <div className="field-note">
              {sig.error
                ? `解析提示：${sig.error}`
                : `端口由代码签名决定。改「参数」里的函数代码，画布上的端口会跟着增减。`}
            </div>
          </div>
        )}

        {!isDataSource &&
          def.inputs.length + def.outputs.length > 0 && (
            <div className="ports-table">
              {inputs.length > 0 && (
                <div className="ports-row">
                  <span className="ports-kind">输入</span>
                  <span>
                    {inputs.map((p) => (
                      <span key={p.id} className="port-chip" style={{ borderColor: portTypeMeta[p.type].color }}>
                        {p.label}
                        {p.optional && <em>可选</em>}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {outputs.length > 0 && (
                <div className="ports-row">
                  <span className="ports-kind">输出</span>
                  <span>
                    {outputs.map((p) => (
                      <span key={p.id} className="port-chip" style={{ borderColor: portTypeMeta[p.type].color }}>
                        {p.label}
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </div>
          )}

        {isDataSource && (
          <div className="ports-table">
            <div className="ports-row">
              <span className="ports-kind">输出</span>
              <span>
                {outputs.map((p) => (
                    <span key={p.id} className="port-chip" style={{ borderColor: portTypeMeta[p.type].color }}>
                      {p.label}
                    </span>
                  ))}
              </span>
            </div>
            <div className="field-note">
              整表包含时间列和已启用的数值特征；列开关控制表格内容。需要单列时使用「拆列」。
            </div>
          </div>
        )}

      </Fold>

      <div style={{ marginTop: 14 }}>
        <button className="danger" style={{ width: '100%' }} onClick={() => removeNode(node.id)}>
          删除该节点
        </button>
      </div>
    </div>
  )
}
