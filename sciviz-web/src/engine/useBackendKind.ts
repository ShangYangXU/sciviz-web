/**
 * 订阅"当前用的是哪个执行面"。
 *
 * 单独一个文件，是为了让 `backend.ts` 保持不依赖 React —— 执行面的选址逻辑
 * 要在无头环境里也能被思考清楚，而"什么时候重渲染"是界面的事。
 */

import { useSyncExternalStore } from 'react'
import { activeBackend, onBackendKind, type BackendKind } from './backend'

export function useBackendKind(): BackendKind | null {
  return useSyncExternalStore(
    (onChange) => onBackendKind(() => onChange()),
    activeBackend,
    () => null,
  )
}
