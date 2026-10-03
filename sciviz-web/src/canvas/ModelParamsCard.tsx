import { useEffect, useMemo } from 'react'
import { useWorkflowStore } from '../store/useWorkflowStore'
import {
  parseModelListValue,
  parseModelParams,
  serializeModelListValue,
  validateModelListParamValue,
} from '../workflow/modelParams'
import { parseModelInterface } from '../workflow/modelInterface'
import type { ParamSpec, WorkflowNode } from '../workflow/types'

function ModelParamControl({
  node,
  spec,
}: {
  node: WorkflowNode
  spec: ParamSpec
}) {
  const setParam = useWorkflowStore((state) => state.setParam)
  const value = node.params[spec.key] ?? spec.default
  const inputId = `model-param-${node.id}-${spec.key}`
  const change = (next: string | number | boolean) => setParam(node.id, spec.key, next)

  if (spec.widget === 'list') {
    const parsed = parseModelListValue(value)
    const items = parsed.values
    const itemType = spec.listItemType ?? 'text'
    const error = parsed.error ?? validateModelListParamValue(spec, value)
    const save = (next: unknown[]) => change(serializeModelListValue(next))
    const update = (index: number, nextValue: unknown) => {
      const next = [...items]
      next[index] = nextValue
      save(next)
    }
    const addValue = (): unknown => {
      if (itemType === 'text') return ''
      if (itemType === 'boolean') return false
      const candidate = spec.itemMin ?? 0
      const bounded = spec.itemMax === undefined ? candidate : Math.min(candidate, spec.itemMax)
      return itemType === 'int' ? Math.ceil(bounded) : bounded
    }

    return (
      <div className="wf-model-param wf-model-param-list" key={spec.key}>
        <div className="wf-model-param-label">
          <span>{spec.label}</span>
          <span className="wf-model-param-count">{items.length}/{spec.maxItems ?? 64}</span>
        </div>
        {items.map((item, index) => (
          <div className="wf-model-param-list-row" key={index}>
            {itemType === 'boolean' ? (
              <label className="wf-model-param-bool">
                <input
                  className="nodrag"
                  type="checkbox"
                  checked={item === true}
                  aria-label={`${spec.label}第 ${index + 1} 项`}
                  onChange={(event) => update(index, event.target.checked)}
                />
                第 {index + 1} 项
              </label>
            ) : (
              <input
                className="nodrag wf-model-param-input"
                type={itemType === 'int' || itemType === 'float' ? 'number' : 'text'}
                value={typeof item === 'string' || typeof item === 'number' ? item : String(item)}
                min={itemType === 'int' || itemType === 'float' ? spec.itemMin : undefined}
                max={itemType === 'int' || itemType === 'float' ? spec.itemMax : undefined}
                step={itemType === 'int' ? 1 : 'any'}
                aria-label={`${spec.label}第 ${index + 1} 项`}
                onChange={(event) => {
                  if (itemType === 'text') {
                    update(index, event.target.value)
                    return
                  }
                  const number = Number(event.target.value)
                  if (Number.isFinite(number)) update(index, number)
                }}
              />
            )}
            <button
              type="button"
              className="nodrag wf-model-param-remove"
              aria-label={`删除${spec.label}第 ${index + 1} 项`}
              disabled={items.length <= (spec.minItems ?? 0)}
              onClick={() => save(items.filter((_, itemIndex) => itemIndex !== index))}
            >
              −
            </button>
          </div>
        ))}
        <div className="wf-model-param-actions">
          <button
            type="button"
            className="nodrag"
            disabled={items.length >= (spec.maxItems ?? 64)}
            onClick={() => save([...items, addValue()])}
          >
            + 添加
          </button>
          {error && (
            <button type="button" className="nodrag" onClick={() => change(String(spec.default))}>
              默认值
            </button>
          )}
        </div>
        {error && <div className="wf-model-param-note warn">{error}</div>}
        {spec.hint && <div className="wf-model-param-note">{spec.hint}</div>}
      </div>
    )
  }

  return (
    <div className="wf-model-param" key={spec.key}>
      <label className="wf-model-param-label" htmlFor={inputId}>
        <span>{spec.label}{spec.required ? ' *' : ''}</span>
        {spec.unit && <span className="wf-model-param-count">{spec.unit}</span>}
      </label>
      {spec.type === 'boolean' ? (
        <input
          id={inputId}
          className="nodrag wf-model-param-checkbox"
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => change(event.target.checked)}
        />
      ) : spec.type === 'select' ? (
        <select
          id={inputId}
          className="nodrag wf-model-param-input"
          value={String(value)}
          onChange={(event) => change(event.target.value)}
        >
          {(spec.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : spec.type === 'number' ? (
        <input
          id={inputId}
          className="nodrag wf-model-param-input"
          type="number"
          value={Number(value)}
          min={spec.min}
          max={spec.max}
          step={spec.step ?? 1}
          onChange={(event) => {
            const number = Number(event.target.value)
            change(Number.isFinite(number) ? number : 0)
          }}
        />
      ) : (
        <input
          id={inputId}
          className="nodrag wf-model-param-input"
          type="text"
          value={String(value)}
          onChange={(event) => change(event.target.value)}
        />
      )}
      {spec.hint && <div className="wf-model-param-note">{spec.hint}</div>}
    </div>
  )
}

/** `custom.model` 的结构参数直接显示在卡片上；仍写入节点的同一 params 字段。 */
export function ModelParamsCard({ node }: { node: WorkflowNode }) {
  const syncModelParams = useWorkflowStore((state) => state.syncModelParams)
  const code = String(node.params.code ?? '')
  const schema = useMemo(() => parseModelParams(code), [code])
  const modelInterface = useMemo(() => parseModelInterface(code), [code])
  const signature = JSON.stringify(schema.specs)

  useEffect(() => {
    if (!schema.error) syncModelParams(node.id, schema.specs)
  }, [node.id, schema.error, signature, syncModelParams])

  return (
    <section className="wf-model-params-card nodrag" aria-label="节点卡片模型参数">
      <div className="wf-model-params-title">模型参数</div>
      <div className="wf-model-interface" aria-label="模型接口">
        <div className="wf-model-param-label">显式接口</div>
        {modelInterface.error ? (
          <div className="wf-model-param-note warn">接口声明暂时无法解析：{modelInterface.error}</div>
        ) : modelInterface.declared ? (
          <>
            <div className="wf-model-interface-line">
              <span className="wf-model-interface-direction">输入</span>
              {modelInterface.interface?.inputs.length ? modelInterface.interface.inputs.map((port) => (
                <span key={port.id} className="port-chip">
                  {port.label} · {port.type}{port.shape?.length ? ` [${port.shape.join('×')}]` : ''}{port.optional ? ' · 可选' : ''}{port.multiple ? ' · 多入' : ''}
                </span>
              )) : <span className="wf-model-param-note">无</span>}
            </div>
            <div className="wf-model-interface-line">
              <span className="wf-model-interface-direction">输出</span>
              <span className="port-chip">模型句柄</span>
              {modelInterface.interface?.outputs.map((port) => (
                <span key={port.id} className="port-chip">
                  {port.label} · {port.type}{port.shape?.length ? ` [${port.shape.join('×')}]` : ''}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="wf-model-param-note">未声明（保留 model 模型句柄输出）</div>
        )}
      </div>
      {schema.error ? (
        <div className="wf-model-param-note warn">参数声明暂时无法解析：{schema.error}</div>
      ) : schema.specs.length > 0 ? (
        schema.specs.map((spec) => <ModelParamControl key={spec.key} node={node} spec={spec} />)
      ) : (
        <div className="wf-model-param-note">当前模型没有可调基础参数。可在右侧面板编辑模型代码。</div>
      )}
    </section>
  )
}
