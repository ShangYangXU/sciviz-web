import { useMemo, useState } from 'react'
import { allNodeDefs } from '../workflow/nodeRegistry'
import { categoryMeta, type NodeCategory } from '../workflow/types'
import { useModuleStore } from '../store/useModuleStore'
import {
  DEFAULT_MODULE_CODE,
  moduleTypeId,
  previewPorts,
  type UserModuleDraft,
} from '../workflow/userModules'

const categoryOrder: NodeCategory[] = ['custom', 'data', 'feature', 'model', 'eval', 'viz']

/**
 * 定义 / 编辑一个自建模块。
 *
 * 表单只有四样东西：名字、分类、说明、代码。端口**不给填** ——
 * 它由代码签名解析出来，填两遍必然有一天对不上。所以这个弹窗下半部分是
 * 只读的端口预览，改代码即改接口。
 */
export function ModuleDialog() {
  const editingType = useModuleStore((s) => s.editingType)
  const modules = useModuleStore((s) => s.modules)
  const favorites = useModuleStore((s) => s.favorites)
  const storageOk = useModuleStore((s) => s.storageOk)
  const saveModule = useModuleStore((s) => s.saveModule)
  const removeModule = useModuleStore((s) => s.removeModule)
  const closeEditor = useModuleStore((s) => s.closeEditor)

  const editing = editingType ? (modules.find((m) => m.type === editingType) ?? null) : null

  const [label, setLabel] = useState(editing?.label ?? '')
  const [category, setCategory] = useState<NodeCategory>(editing?.category ?? 'custom')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [code, setCode] = useState(
    String(editing?.params.find((p) => p.key === 'code')?.default ?? DEFAULT_MODULE_CODE),
  )
  const [pin, setPin] = useState(editing ? favorites.includes(editing.type) : true)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const ports = useMemo(() => previewPorts(code), [code])

  const onSave = () => {
    setError(null)
    const draft: UserModuleDraft = { label, category, description, code }
    // type 创建时定下、编辑时沿用：画布上的节点与 YAML 记的都是它
    const type = editing?.type ?? moduleTypeId(label, allNodeDefs().map((d) => d.type))
    const res = saveModule(type, draft, pin)
    if (!res.ok) {
      setError(res.error ?? '保存失败')
      return
    }
    closeEditor()
  }

  const onDelete = () => {
    if (!editing) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    removeModule(editing.type)
    closeEditor()
  }

  return (
    <div className="modal-mask" onClick={closeEditor}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{editing ? `编辑模块 · ${editing.label}` : '定义新模块'}</div>

        <div className="modal-body">
          <div className="hint-box">
            自建模块就是<b>一个 Python 函数</b>：形参自动成为输入端口（有默认值的可以不接线），
            <code>return</code> 字典的 key 成为输出端口。保存后它会出现在左侧节点库里，
            接线后由浏览器里的真 Python 执行。
          </div>

          <div className="field">
            <label>模块名称</label>
            <input
              type="text"
              value={label}
              placeholder="例：带通滤波"
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="field">
            <label>分类</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as NodeCategory)}>
              {categoryOrder.map((c) => (
                <option key={c} value={c}>
                  {categoryMeta[c].label}
                </option>
              ))}
            </select>
            <div className="field-note">决定它落在节点库的哪一组里</div>
          </div>

          <div className="field">
            <label>说明</label>
            <input
              type="text"
              value={description}
              placeholder="这个模块做什么、参数怎么用"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="field">
            <label>
              <span>函数代码</span>
            </label>
            <textarea
              className="code-area"
              value={code}
              spellCheck={false}
              rows={12}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>

          <div className="ports-table">
            <div className="ports-row">
              <span className="ports-kind">输入端口</span>
              <span>
                {ports.error ? (
                  <span className="field-note warn">解析失败：{ports.error}</span>
                ) : ports.inputs.length === 0 ? (
                  <span className="field-note">无（这个函数不需要输入）</span>
                ) : (
                  ports.inputs.map((p) => (
                    <span key={p.name} className="port-chip">
                      {p.name}
                      {!p.optional && <em>必接</em>}
                    </span>
                  ))
                )}
              </span>
            </div>
            <div className="ports-row">
              <span className="ports-kind">输出端口</span>
              <span>
                {ports.error ? (
                  <span className="field-note">—</span>
                ) : (
                  ports.outputs.map((o) => (
                    <span key={o} className="port-chip">
                      {o}
                    </span>
                  ))
                )}
              </span>
            </div>
            <div className="field-note">
              端口来自代码签名，不在这里单独填 —— 少一处会和代码对不上的地方。
            </div>
          </div>

          <label className="checkbox-row">
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
            钉到画布左上角的常用工具栏
          </label>

          {!storageOk && (
            <div className="field-note warn">
              浏览器拒绝了本地存储，这个模块这次能用，但刷新后不会保留。
            </div>
          )}

          {error && <div className="dialog-error">{error}</div>}
        </div>

        <div className="modal-foot">
          {editing && (
            <button className="danger" onClick={onDelete} style={{ marginRight: 'auto' }}>
              {confirmDelete ? '再点一次确认删除' : '删除这个模块'}
            </button>
          )}
          <button onClick={closeEditor}>取消</button>
          <button className="primary" onClick={onSave}>
            {editing ? '保存修改' : '保存并加入节点库'}
          </button>
        </div>
      </div>
    </div>
  )
}
