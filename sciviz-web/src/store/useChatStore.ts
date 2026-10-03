import { create, type StateCreator } from 'zustand'
import type { ChatChoicePrompt, SessionSummary } from '../agent/sessionLog'
import type { ChatAttachmentSummary } from '../agent/chatAttachments'
import type { ModelContent } from '../agent/modelContext'

/** `/agent/config` 里那一条 provider 自述。密钥永远不在这里。 */
export interface ChatProviderInfo {
  id: string
  label: string
  available: boolean
  source: 'env' | 'file' | 'preset' | 'none' | string
  apiKeyConfigured: boolean
  local: boolean
  model: string | null
  defaultModel?: string | null
  default?: boolean
  baseUrl?: string
  hasLocalConfig?: boolean
  endpointEditable?: boolean
}

export interface ChatConfig {
  configured: boolean
  provider: string | null
  providerLabel?: string
  model: string | null
  local: boolean
  token: string
  credentialSource?: string
  providers?: ChatProviderInfo[]
  providerManagement?: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  at: number
  streaming?: boolean
  error?: boolean
  attachments?: ChatAttachmentSummary[]
  questions?: ChatChoicePrompt[]
  /** 当前页面内存中的多模态内容；不会序列化进会话 JSONL。 */
  modelContent?: ModelContent
}

/** 宿主 `/agent/models` 说"这个模型上次回的就是不可用"时的一项自述。 */
export interface UnavailableModel {
  model: string
  reason: string
}

interface ChatState {
  config: ChatConfig | null
  configError: string | null
  messages: ChatMessage[]
  /** 当前工程下的全部子对话（含已归档）。列表来自宿主索引，不是本地猜测 */
  sessions: SessionSummary[]
  busy: boolean
  hostUrl: string
  sessionId: string | null
  sessionSeq: number
  setConfig: (config: ChatConfig) => void
  setConfigError: (message: string) => void
  addMessage: (message: ChatMessage) => void
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void
  setMessages: (messages: ChatMessage[]) => void
  setBusy: (busy: boolean) => void
  setSessions: (sessions: SessionSummary[]) => void
  setSession: (sessionId: string | null, sessionSeq: number) => void
  /** 从未用过、或宿主没报告过的模型不在这里 —— 空列表的意思是"没有已知的坏模型" */
  unavailableModels: UnavailableModel[]
  setUnavailableModels: (models: UnavailableModel[]) => void
  /**
   * 读块内代码的授权，**按工程记住**（落在 localStorage 的 `sciviz.chat.readCodeGrant`，
   * 见 `agent/readGrant.ts`）。默认关：代码正文属于要用户点头才外发的东西。
   * 关着的时候模型仍可以显式请求 —— 那一次弹确认，用户点头后这次授权就落地为本工程常设授权。
   */
  allowNodeCode: boolean
  setAllowNodeCode: (allow: boolean) => void
  clear: () => void
}

const messageId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const newChatMessage = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: messageId(),
  role,
  text,
  at: Date.now(),
  ...extra,
})

const createChatState: StateCreator<ChatState> = (set) => ({
  config: null,
  configError: null,
  messages: [],
  sessions: [],
  busy: false,
  hostUrl: 'http://127.0.0.1:8765',
  sessionId: null,
  sessionSeq: 0,
  unavailableModels: [],
  allowNodeCode: true,
  setConfig: (config) => set({ config, configError: null }),
  setConfigError: (configError) => set({ configError }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  updateMessage: (id, patch) => set((state) => ({ messages: state.messages.map((message) => message.id === id ? { ...message, ...patch } : message) })),
  setMessages: (messages) => set({ messages }),
  setBusy: (busy) => set({ busy }),
  setSessions: (sessions) => set({ sessions }),
  setSession: (sessionId, sessionSeq) => set({ sessionId, sessionSeq }),
  setUnavailableModels: (unavailableModels) => set({ unavailableModels }),
  setAllowNodeCode: (allowNodeCode) => set({ allowNodeCode }),
  clear: () => set({ messages: [] }),
})

/** 完整 Agent 与只读侧边问答共用结构，但各自保存当前消息和会话选择。 */
export const useChatStore = create<ChatState>()(createChatState)
export const useSidebarChatStore = create<ChatState>()(createChatState)
