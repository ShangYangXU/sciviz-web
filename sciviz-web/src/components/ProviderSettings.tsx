import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ChatConfig } from '../store/useChatStore'

interface Props {
  config: ChatConfig
  currentProvider: string
  hostUrl: string
  disabled: boolean
  onUpdated: (config: ChatConfig, provider: string) => void
}

/** Keys belong only to this short-lived form, never to a store or a model message. */
export function ProviderSettings(props: Props) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={button} type="button" disabled={props.disabled} onClick={() => setOpen(true)}>模型服务设置</button>
    {open && button.current && <ProviderSettingsForm {...props} container={button.current.ownerDocument.body} onClose={() => setOpen(false)} />}
  </>
}

function ProviderSettingsForm({ config, currentProvider, hostUrl, onUpdated, onClose, container }: Props & { onClose: () => void; container: HTMLElement }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const providers = config.providers ?? []
  const [provider, setProvider] = useState(providers.some((entry) => entry.id === currentProvider) ? currentProvider : providers[0]?.id ?? '')
  const info = providers.find((entry) => entry.id === provider)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    setApiKey('')
    setBaseUrl(info?.baseUrl ?? '')
    setModel(info?.model ?? '')
    setError('')
  }, [info])

  const submit = async (action: 'save' | 'remove') => {
    if (busy) return
    const payload = action === 'remove'
      ? { action, provider }
      : { action, provider, apiKey: apiKey.trim(), ...(info?.endpointEditable !== false ? { baseUrl: baseUrl.trim(), model: model.trim() } : {}) }
    // Do not leave the submitted key in the visible component while waiting for IO.
    setApiKey('')
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${hostUrl}/agent/providers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sciviz-Agent-Token': config.token },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`配置未保存（HTTP ${response.status}）。请检查地址、模型及密钥格式后重试。`)
      const result = await response.json() as { ok: boolean; config: ChatConfig }
      if (!result.ok || !result.config) throw new Error('宿主没有确认配置已保存')
      onUpdated(result.config, provider)
      onClose()
    } catch (failure: unknown) {
      // Never display a request body or an upstream echo of the submitted credential.
      setError(failure instanceof Error ? failure.message : '本机配置保存失败')
    } finally {
      setBusy(false)
    }
  }
  const save = (event: FormEvent) => { event.preventDefault(); void submit('save') }

  return createPortal(<dialog ref={dialog} className="provider-settings" aria-labelledby="provider-settings-title" onCancel={(event) => { if (busy) event.preventDefault(); else onClose() }}>
    <form onSubmit={save}>
      <h2 id="provider-settings-title">模型服务设置 · BYOK</h2>
      <p>使用你自己的 API key。密钥只保存到本机，已有密钥不会回显。</p>
      <label>服务商<select value={provider} disabled={busy} onChange={(event) => setProvider(event.target.value)}>{providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
      <p className="provider-settings-status">{info?.apiKeyConfigured ? '已配置密钥' : '尚未配置密钥'}{info?.source === 'env' ? ' · 当前使用环境变量；保存或移除本地配置不会覆盖它' : ''}</p>
      <label>API key<input type="password" name="sciviz-byok-key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={busy} maxLength={8192} placeholder={info?.apiKeyConfigured ? '留空保留当前密钥' : '粘贴你自己的 API key；本机服务可留空'} /></label>
      <label>API 基础地址<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={busy || info?.endpointEditable === false} maxLength={2048} placeholder="https://你的服务/v1" required={info?.endpointEditable !== false} /></label>
      <label>模型 ID<input value={info?.endpointEditable === false ? info.defaultModel ?? '' : model} onChange={(event) => setModel(event.target.value)} disabled={busy || info?.endpointEditable === false} maxLength={120} placeholder="可留空，保存后发现或选择模型" /></label>
      <p>兼容 Chat Completions 的服务均可使用自定义入口。远程服务使用 HTTPS；本机服务可使用 HTTP 回环地址。请选择支持工具调用的模型。</p>
      {error && <p role="alert" className="provider-settings-error">{error}</p>}
      <div className="provider-settings-actions">
        <button type="button" disabled={busy || !info?.hasLocalConfig} onClick={() => void submit('remove')}>移除本地配置</button>
        <button type="button" disabled={busy} onClick={onClose}>关闭</button>
        <button type="submit" disabled={busy || !provider}>{busy ? '保存中…' : '保存配置'}</button>
      </div>
    </form>
  </dialog>, container)
}
