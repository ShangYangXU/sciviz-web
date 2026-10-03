import { useMemo, useState } from 'react'
import { useWorkflowStore } from '../store/useWorkflowStore'
import {
  datasetIdentityOf,
  featuresOf,
  findDatasetByIdentity,
  hasDataset,
  timeColumnOf,
} from '../store/useDataStore'
import { workflowToYaml, yamlToWorkflow } from '../workflow/yaml'
import type { PortContext } from '../workflow/ports'

/**
 * 端口解析用的上下文。
 *
 * 比求值时多三项数据集相关的信息：导出时写出数据集身份、导入时按身份把失效的 id 认回来、
 * 以及识别本地数据集、保留旧工程迁移信息所需的 hasDataset。
 */
const yamlPortContext: PortContext = {
  featuresOf,
  timeColumnOf,
  hasDataset,
  identityOf: datasetIdentityOf,
  findByIdentity: findDatasetByIdentity,
}

interface Props {
  mode: 'export' | 'import'
  onClose: () => void
}

export function YamlDialog({ mode: initialMode, onClose }: Props) {
  const workflow = useWorkflowStore((s) => s.workflow)
  const setWorkflow = useWorkflowStore((s) => s.setWorkflow)

  const [mode, setMode] = useState(initialMode)
  const exported = useMemo(() => workflowToYaml(workflow, yamlPortContext), [workflow])
  const [text, setText] = useState(exported)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [copied, setCopied] = useState(false)

  const switchMode = (next: 'export' | 'import') => {
    setMode(next)
    setError(null)
    setWarnings([])
    if (next === 'export') setText(exported)
  }

  const handleImport = () => {
    setError(null)
    setWarnings([])
    const res = yamlToWorkflow(text, `wf-imported-${Date.now().toString(36)}`, yamlPortContext)
    if (res.error || !res.workflow) {
      setError(res.error ?? '解析失败')
      return
    }
    setWorkflow(res.workflow)
    if (res.warnings.length) {
      // 有告警也照样导入，但要让用户看见
      setWarnings(res.warnings)
      return
    }
    onClose()
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('复制失败，浏览器拒绝了剪贴板权限，请手动选中复制')
    }
  }

  const handleDownload = () => {
    const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflow.name.replace(/[\\/:*?"<>|]/g, '_')}.yaml`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="tab-row">
            <button className={mode === 'export' ? 'tab active' : 'tab'} onClick={() => switchMode('export')}>
              导出 YAML
            </button>
            <button className={mode === 'import' ? 'tab active' : 'tab'} onClick={() => switchMode('import')}>
              导入 YAML
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div className="hint-box">
            {mode === 'export'
              ? '工作流的唯一真相是这份 YAML —— 可以 git diff、可以批量生成变体、可以发给同事。画布只是它的一个视图。'
              : '粘贴 YAML 后导入会覆盖当前画布。老的或手写的 YAML 也能导入：缺失参数会用默认值补齐。'}
          </div>

          <textarea
            className="code-area yaml-area"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={mode === 'export'}
          />

          {error && <div className="dialog-error">{error}</div>}
          {warnings.length > 0 && (
            <div className="dialog-warn">
              <strong>已导入，但有 {warnings.length} 条提示：</strong>
              <ul>
                {warnings.slice(0, 6).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
                {warnings.length > 6 && <li>…还有 {warnings.length - 6} 条</li>}
              </ul>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button onClick={onClose}>关闭</button>
          {mode === 'export' ? (
            <>
              <button onClick={handleCopy}>{copied ? '已复制' : '复制'}</button>
              <button className="primary" onClick={handleDownload}>
                下载 .yaml
              </button>
            </>
          ) : (
            <button className="primary" onClick={handleImport}>
              导入并覆盖画布
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
