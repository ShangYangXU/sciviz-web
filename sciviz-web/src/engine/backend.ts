import * as local from './localClient'
import * as pyodide from './client'
import { EngineError } from './errors'
import type { ProgressListener, StatusListener } from './dispatch'
import type {
  DatasetPayload,
  EngineStatus,
  EvalRequest,
  EvalResult,
  PreviewTable,
} from './protocol'

export { EngineError }
export type { LocalHealth } from './localClient'

/**
 * 执行后端的选址。**上层只 import 这个文件。**
 *
 * 宿主在（本机 8765 有响应）就用宿主：能用 GPU、能吃大内存、能扛长任务。
 * 宿主不在就回落 Pyodide：零安装、纯 CPU，但功能完整。
 *
 * 两种模式的差别不该让用户去猜，所以：
 * - 自动模式下宿主没起来 = 回落，不是错误；
 * - 用户显式要求 `?engine=local` 而宿主没起来 = **失败并说清原因**，
 *   不偷偷换成 CPU 跑 —— 那样最坏的情况是"以为在用 GPU 训练"。
 */

export type BackendKind = 'local' | 'pyodide'

let active: BackendKind | null = null
let health: local.LocalHealth | null = null
let choosing: Promise<BackendKind> | null = null
let detach: (() => void) | null = null

let status: EngineStatus = 'cold'
let detail = ''
const listeners = new Set<StatusListener>()
const backendListeners = new Set<(kind: BackendKind | null) => void>()

function emitStatus(next: EngineStatus, why: string): void {
  status = next
  detail = why
  for (const listener of listeners) listener(next, why)
}

export function engineStatus(): { status: EngineStatus; detail: string } {
  return { status, detail }
}

export function onEngineStatus(listener: StatusListener): () => void {
  listeners.add(listener)
  listener(status, detail)
  return () => listeners.delete(listener)
}

/** 当前实际在用的后端。还没选址时为 null */
export function activeBackend(): BackendKind | null {
  return active
}

/**
 * 订阅"当前执行面变没变"。界面要靠它提前标出"这个节点只有本地宿主能跑"——
 * 光看引擎状态（ready / failed）不够：两种情况都是 ready，但能跑的东西不一样。
 */
export function onBackendKind(listener: (kind: BackendKind | null) => void): () => void {
  backendListeners.add(listener)
  listener(active)
  return () => {
    backendListeners.delete(listener)
  }
}

/** 宿主的能力清单（设备、算子）。没连宿主时为 null */
export function localHealth(): local.LocalHealth | null {
  return health
}

function forcedBackend(): BackendKind | null {
  const fromUrl = new URLSearchParams(location.search).get('engine')
  const fromStore = localStorage.getItem('sciviz.engine')
  const wanted = fromUrl ?? fromStore
  return wanted === 'local' || wanted === 'pyodide' ? wanted : null
}

function attach(kind: BackendKind): BackendKind {
  active = kind
  detach?.()
  detach = (kind === 'local' ? local : pyodide).onEngineStatus(emitStatus)
  for (const listener of backendListeners) listener(kind)
  return kind
}

/** 选址。只探一次，之后缓存 —— 端口不会变，而每次求值都探一次是纯浪费 */
export function chooseBackend(): Promise<BackendKind> {
  if (choosing) return choosing
  choosing = (async () => {
    const forced = forcedBackend()
    if (forced === 'pyodide') return attach('pyodide')
    health = await local.probeLocalEngine()
    if (forced === 'local') return attach('local')
    return attach(health ? 'local' : 'pyodide')
  })()
  return choosing
}

/**
 * 页面启动时**确立执行面**，必要时顺手把它连起来。
 *
 * 为什么不能等第一次求值再选：选址（"这一页用宿主还是浏览器引擎"）是**页面级事实** ——
 * 顶栏那张状态卡、节点库与画布上「需宿主 / 本地模式」的标签、能力门
 * `canRunHostOperators` 读的都是它。此前它只在"图里真有东西要算"时才发生，于是空画布上
 * 它永远不成立：宿主明明在跑（桌面入口打开窗口前刚自检过 `/health`），顶栏却写
 * "引擎未启动"，节点标签永远停在"检查中"，`?engine=local` 这个"宿主必须在线"的前提
 * 也从没在页面这一级被验证过。
 *
 * 只有本地宿主会被**提前连上**：握手是毫秒级的，而且 `?engine=local` 的前提本来就是它在线。
 * Pyodide 那侧要下载一整个运行时，保持按需加载 —— 空画布上下载 10MB 才是真没道理。
 */
export async function primeBackend(): Promise<BackendKind> {
  const kind = await chooseBackend()
  if (kind === 'local') await local.ensureEngine()
  return kind
}

async function kind(): Promise<BackendKind> {
  return active ?? (await chooseBackend())
}

export async function ensureEngine(): Promise<void> {
  const target = await kind()
  return target === 'local' ? local.ensureEngine() : pyodide.ensureEngine()
}

export async function setDataset(payload: DatasetPayload): Promise<void> {
  const target = await kind()
  return target === 'local' ? local.setDataset(payload) : pyodide.setDataset(payload)
}

export async function loadFn(nodeId: string, code: string, fnName: string): Promise<void> {
  const target = await kind()
  return target === 'local' ? local.loadFn(nodeId, code, fnName) : pyodide.loadFn(nodeId, code, fnName)
}

/**
 * 订阅节点进度。
 *
 * 只有宿主会报进度：Pyodide 那侧一次求值是一个**同步**的 Python 调用，中间插不进话。
 * 所以这里只转发本地适配器的一条线 —— 界面据此决定要不要画进度条，
 * 而不是拿一个假的比例糊弄人。
 */
export function onNodeProgress(listener: ProgressListener): () => void {
  return local.onNodeProgress(listener)
}

/**
 * 请当前执行面停下某个节点。
 *
 * 只有本地宿主做得到：它是另一个进程、有自己的线程，取消是一面旗子。
 * Pyodide 里中断插不进去，所以那里返回 false —— 界面据此**不显示**取消按钮，
 * 而不是给一个按下去没有反应的按钮。
 */
export function cancelNode(nodeId: string): boolean {
  return active === 'local' ? local.cancelNode(nodeId) : false
}

/** 当前执行面能不能取消长任务。界面用它决定取消按钮出不出现 */
export function supportsCancel(): boolean {
  return active === 'local'
}

export async function evalNode(args: EvalRequest): Promise<EvalResult> {
  const target = await kind()
  return target === 'local' ? local.evalNode(args) : pyodide.evalNode(args)
}

export async function head(nodeId: string, portId: string, n: number, offset = 0): Promise<PreviewTable> {
  const target = await kind()
  return target === 'local' ? local.head(nodeId, portId, n, offset) : pyodide.head(nodeId, portId, n, offset)
}

export function dropNode(nodeId: string): void {
  if (active === 'local') local.dropNode(nodeId)
  else if (active === 'pyodide') pyodide.dropNode(nodeId)
}
