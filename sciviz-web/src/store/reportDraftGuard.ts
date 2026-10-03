/** The report editor registers a transient guard for replacing the current project. */
let isDirty: (() => boolean) | null = null

export function registerReportDraftGuard(check: (() => boolean) | null): void {
  isDirty = check
}

export function hasDirtyReportDraft(): boolean {
  return isDirty?.() ?? false
}

export function confirmDiscardReportDraft(): boolean {
  if (!hasDirtyReportDraft()) return true
  return window.confirm('项目报告里有未保存的修改。放弃这些修改并切换工程？')
}
