import { create } from 'zustand'
import type { NodeTypeDef } from '../workflow/types'
import { registerCustomModuleProvider } from '../workflow/nodeRegistry'
import {
  buildUserModule,
  checkUserModuleDraft,
  sanitizeStoredModules,
  type UserModuleDraft,
} from '../workflow/userModules'

/**
 * 自建模块与常用栏。
 *
 * 这是工作台配置，保存自建模块和收藏；工程本身由 projectFile 的 .sciviz 保存链负责。
 *
 * 读写全部包在 try/catch 里：隐私模式、配额用尽、存储被策略禁用都会让
 * `localStorage` 直接抛异常，那种情况下功能应该降级成"本次会话有效"，
 * 而不是让整个界面白屏。
 */

const STORAGE_KEY = 'sciviz.workbench.v1'

interface Persisted {
  modules: NodeTypeDef[]
  favorites: string[]
}

function loadPersisted(): Persisted & { ok: boolean } {
  if (typeof localStorage === 'undefined') return { modules: [], favorites: [], ok: false }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { modules: [], favorites: [], ok: true }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    const modules = sanitizeStoredModules(parsed?.modules)
    const favorites = Array.isArray(parsed?.favorites)
      ? parsed.favorites.filter((x): x is string => typeof x === 'string')
      : []
    return { modules, favorites, ok: true }
  } catch {
    return { modules: [], favorites: [], ok: false }
  }
}

function persist(state: Persisted): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modules: state.modules, favorites: state.favorites }))
    return true
  } catch {
    return false
  }
}

export interface SaveModuleResult {
  ok: boolean
  /** 成功时给出新模块的 type，失败时给出给人看的原因 */
  type?: string
  error?: string
}

interface ModuleState extends Persisted {
  /** 本地存储是否可用。false 时界面要说明"这次改动不会保留" */
  storageOk: boolean
  /** 定义模块弹窗的开关与编辑对象（不持久化） */
  editorOpen: boolean
  editingType: string | null

  openEditor: (type?: string | null) => void
  closeEditor: () => void
  /** type 由调用方给（新建时先算好，保证创建后不再变），这里只负责落库与持久化 */
  saveModule: (type: string, draft: UserModuleDraft, pin: boolean) => SaveModuleResult
  removeModule: (type: string) => void
  toggleFavorite: (type: string) => void
  setFavorite: (type: string, on: boolean) => void
}

const initial = loadPersisted()

export const useModuleStore = create<ModuleState>((set, get) => {
  const commit = (next: Partial<Persisted>) => {
    const merged: Persisted = {
      modules: next.modules ?? get().modules,
      favorites: next.favorites ?? get().favorites,
    }
    const ok = persist(merged)
    set({ ...merged, storageOk: ok })
  }

  return {
    modules: initial.modules,
    favorites: initial.favorites,
    storageOk: initial.ok,
    editorOpen: false,
    editingType: null,

    openEditor: (type = null) => set({ editorOpen: true, editingType: type ?? null }),
    closeEditor: () => set({ editorOpen: false, editingType: null }),

    saveModule: (type, draft, pin) => {
      const check = checkUserModuleDraft(draft)
      if (check.error) return { ok: false, error: check.error }

      const def = buildUserModule(draft, type)
      const exists = get().modules.some((m) => m.type === type)
      const modules = exists
        ? get().modules.map((m) => (m.type === type ? def : m))
        : [...get().modules, def]

      const favorites = pin
        ? get().favorites.includes(type)
          ? get().favorites
          : [...get().favorites, type]
        : get().favorites.filter((t) => t !== type)

      commit({ modules, favorites })
      return { ok: true, type }
    },

    removeModule: (type) =>
      commit({
        modules: get().modules.filter((m) => m.type !== type),
        // 连带把常用栏里那一项也摘掉，否则会留下一个点不动的空按钮
        favorites: get().favorites.filter((t) => t !== type),
      }),

    setFavorite: (type, on) => {
      const has = get().favorites.includes(type)
      if (has === on) return
      commit({ favorites: on ? [...get().favorites, type] : get().favorites.filter((t) => t !== type) })
    },

    toggleFavorite: (type) => get().setFavorite(type, !get().favorites.includes(type)),
  }
})

// Provide an accessor, not a copied registry: edits remain visible immediately.
registerCustomModuleProvider(() => useModuleStore.getState().modules)

/** 自建模块的只读快照。 */
export function customModuleDefs(): NodeTypeDef[] {
  return useModuleStore.getState().modules
}

/** 按 type 取一个自建模块 */
export function customModuleDef(type: string): NodeTypeDef | undefined {
  return useModuleStore.getState().modules.find((m) => m.type === type)
}
