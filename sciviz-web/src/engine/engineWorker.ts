/// <reference lib="webworker" />
import operatorsPy from './python/operators.py?raw'
import runtimePy from './python/runtime.py?raw'
import type { DatasetPayload, WorkerIn, WorkerOut } from './protocol'
// 与 scripts/sync-pyodide.mjs 共用同一份清单：一个决定"下载哪些包"，
// 一个决定"加载哪些包"。分成两份的下场是本地能跑、浏览器 ModuleNotFoundError
import pyodidePackages from '../../pyodide-packages.json'

/**
 * 执行引擎 Worker。
 *
 * 两件事必须在这里做，不能在主线程：
 * 1. Pyodide 与 numpy / pandas 的加载和运算很重，启动期也长；
 * 2. 用户自定义函数是任意 Python，可能死循环 —— 隔离在 Worker 里，最坏情况只废掉这个 Worker。
 *
 * Pyodide 刻意**不经打包器**，而是从 public/pyodide/ 直接动态 import：
 * 它的 asm 胶水依赖 import.meta.url 定位同目录的 .wasm，被打包器改写路径后容易炸。
 * 这样运行时资源也与代码分离，换版本只需重跑 scripts/sync-pyodide.mjs。
 */

interface PyodideLike {
  loadPackage(names: string[]): Promise<void>
  runPython(code: string): unknown
  globals: { set(name: string, value: unknown): void }
  FS: { mkdirTree(path: string): void; writeFile(path: string, data: string): void }
}

interface PyError {
  message?: string
}

const PY_DIR = '/home/pyodide/sciviz'

const post = (msg: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? [])

let initPromise: Promise<PyodideLike> | null = null

function runtimeDir(): URL {
  return new URL('/pyodide/', self.location.href)
}

async function loadPyodideRuntime(): Promise<PyodideLike> {
  const url = new URL('pyodide.mjs', runtimeDir()).href
  const mod = (await import(/* @vite-ignore */ url)) as {
    loadPyodide: (opts: { indexURL: string }) => Promise<PyodideLike>
  }
  return mod.loadPyodide({ indexURL: runtimeDir().href })
}

/** 把 Python 源码写进虚拟文件系统再 import，而不是 exec 一堆拼接的字符串 */
function installPythonModules(py: PyodideLike): void {
  py.FS.mkdirTree(PY_DIR)
  py.FS.writeFile(`${PY_DIR}/runtime.py`, runtimePy)
  py.FS.writeFile(`${PY_DIR}/operators.py`, operatorsPy)
  py.runPython(
    [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(PY_DIR)})`,
      // 这些包也在这里 import：下面报 ready 时要用版本号，而只 import runtime 的话
      // 它们只在 runtime 模块的命名空间里，顶层拿不到。
      // 包名 → 模块名不是一一对应（scikit-learn 的模块叫 sklearn），所以写死这一行，
      // 它同时也是"这两个包真的能 import"的验证 —— 装上了但 import 失败（ABI 不匹配）
      // 要在这里就暴露，而不是等用户拖一个节点下来才炸。
      'import numpy, pandas, scipy, sklearn, matplotlib, runtime',
      // 声明这套 Python 在哪一侧：缺库时的文案据此分流（见 runtime.set_execution_face）
      "runtime.set_execution_face('pyodide')",
    ].join('\n'),
  )
}

async function initOnce(): Promise<PyodideLike> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    post({ type: 'initProgress', phase: '加载 Python 运行时' })
    const py = await loadPyodideRuntime()

    post({ type: 'initProgress', phase: `加载 ${pyodidePackages.join(' / ')}` })
    await py.loadPackage(pyodidePackages)

    post({ type: 'initProgress', phase: '装载算子' })
    installPythonModules(py)

    // 真跑一句再报 ready：loadPackage 成功但 import 失败（ABI 不匹配）也得在这里暴露
    const versions = String(
      py.runPython(
        "import scipy as _s, sklearn as _k\n"
          + "f\"python {__import__('sys').version.split()[0]} · numpy {numpy.__version__}\""
          + " + f\" · pandas {pandas.__version__} · scipy {_s.__version__} · sklearn {_k.__version__} · matplotlib {matplotlib.__version__}\"",
      ),
    )
    post({ type: 'ready', engineInfo: versions })
    return py
  })()
  return initPromise
}

/** Pyodide 抛的是 PythonError，message 里已带 Python 的 traceback 文本 */
function describeError(err: unknown): string {
  const e = err as PyError
  const text = e?.message ?? String(err)
  // 最后一行常常是空的（traceback 以换行结尾），要取最后一行**非空**的
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
  return lines[lines.length - 1] ?? text
}

function handleSetDataset(py: PyodideLike, payload: DatasetPayload): void {
  const meta = JSON.stringify({
    datasetId: payload.datasetId,
    rowCount: payload.rowCount,
    timeColumn: payload.timeColumn,
    columns: Object.keys(payload.data),
  })
  py.globals.set('__meta', meta)
  py.runPython('runtime.begin_dataset(__meta)')

  if (payload.time) {
    py.globals.set('__time', payload.time)
    py.runPython('runtime.set_time(__time)')
  }

  for (const [name, column] of Object.entries(payload.data)) {
    py.globals.set('__col_name', name)
    py.globals.set('__col', column)
    py.runPython('runtime.add_column(__col_name, __col)')
  }
  py.runPython('runtime.end_dataset()')
  post({ type: 'datasetReady', datasetId: payload.datasetId })
}

function handleEval(py: PyodideLike, msg: Extract<WorkerIn, { type: 'evalNode' }>): void {
  // **整条请求原样转给 Python，只去掉 `type`。**
  //
  // 手工列字段在这个项目里已经埋过三次同样的坑：`fingerprint`（T8）、`meta`（T11）、
  // `sampleRate`（T5）—— 每加一个字段都要记得改这里，而忘了改的表现是"字段悄悄变空"，
  // 不报错。让它透传之后，`EvalRequest` 上新增字段不必再改这一处。
  const { type: _type, ...request } = msg
  py.globals.set(
    '__payload',
    JSON.stringify(request),
  )
  const raw = String(py.runPython('runtime.eval_payload(__payload)'))
  const res = JSON.parse(raw) as {
    ok: boolean
    refs?: Record<string, unknown>
    artifacts?: unknown[]
    meta?: Record<string, unknown>
    restored?: boolean
    message?: string
    traceback?: string
  }

  if (res.ok) {
    post({
      type: 'nodeResult',
      nodeId: msg.nodeId,
      refs: (res.refs ?? {}) as Record<string, never>,
      // 产物与元信息也原样带回来（宿主那侧由 server.py 转发，说明书在那里的注释里）
      artifacts: (res.artifacts ?? []) as never,
      meta: (res.meta ?? {}) as never,
      ...(res.restored ? { restored: true } : {}),
    })
    return
  }
  post({
    type: 'nodeError',
    nodeId: msg.nodeId,
    message: res.message ?? '未知错误',
    traceback: res.traceback ?? '',
  })
}

function handle(py: PyodideLike, msg: WorkerIn): void {
  switch (msg.type) {
    case 'setDataset':
      try {
        handleSetDataset(py, msg.payload)
      } catch (err) {
        post({ type: 'datasetError', datasetId: msg.payload.datasetId, message: describeError(err) })
      }
      return

    case 'loadFn':
      try {
        py.globals.set('__fn_code', msg.code)
        py.globals.set('__fn_name', msg.fnName)
        py.globals.set('__fn_node', msg.nodeId)
        py.runPython('runtime.load_fn(__fn_node, __fn_name, __fn_code)')
        post({ type: 'fnLoaded', nodeId: msg.nodeId })
      } catch (err) {
        post({ type: 'fnError', nodeId: msg.nodeId, message: describeError(err) })
      }
      return

    case 'evalNode':
      try {
        handleEval(py, msg)
      } catch (err) {
        post({
          type: 'nodeError',
          nodeId: msg.nodeId,
          message: describeError(err),
          traceback: '',
        })
      }
      return

    case 'head':
      try {
        py.globals.set('__head_node', msg.nodeId)
        py.globals.set('__head_port', msg.portId)
        py.globals.set('__head_n', msg.n)
        py.globals.set('__head_offset', msg.offset ?? 0)
        const raw = String(py.runPython('runtime.head_payload(__head_node, __head_port, __head_n, __head_offset)'))
        post({ type: 'head', requestId: msg.requestId, table: JSON.parse(raw) })
      } catch (err) {
        post({ type: 'headError', requestId: msg.requestId, message: describeError(err) })
      }
      return

    case 'dropNode':
      py.globals.set('__drop_node', msg.nodeId)
      py.runPython('runtime.drop_node(__drop_node)')
      return

    case 'init':
      return
  }
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return

  initOnce()
    .then((py) => handle(py, msg))
    .catch((err: unknown) => {
      post({ type: 'initError', message: describeError(err) })
    })
}
