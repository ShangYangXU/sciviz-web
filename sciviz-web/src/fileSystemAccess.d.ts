/**
 * File System Access API 的**最小**类型声明。
 *
 * TypeScript 当前 lib.dom 里还没有这几个成员（Chromium 早就实现了）。
 * 只声明我们真正用到的部分，而不是从别处引一套完整类型：
 * 这些接口的完整形状不由我们掌握，声明得越少，与浏览器实际行为的偏差越小。
 *
 * 浏览器不支持时（Firefox / Safari）这几个成员是 undefined —— 所以调用方必须
 * 逐个 feature-detect，声明成可选正是为了让"忘了判"在类型层面就暴露出来。
 */

interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface FilePickerOptions {
  types?: FilePickerAcceptType[]
  multiple?: boolean
  excludeAcceptAllOption?: boolean
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: FilePickerAcceptType[]
}

interface FileSystemFileHandle {
  /** Chromium 有，Safari/Firefox 没有 */
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

interface Window {
  showOpenFilePicker?(options?: FilePickerOptions): Promise<FileSystemFileHandle[]>
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
}
