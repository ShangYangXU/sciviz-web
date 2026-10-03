/**
 * 引擎侧抛出的异常。
 *
 * traceback 原样带到界面，这是排查用户自定义函数的主要依据 —— 所以它属于
 * "引擎契约"的一部分，而不是某个后端的内部细节：Pyodide 适配器与本地宿主适配器
 * 抛的是同一个类型，上层的 catch 才不需要知道自己在跟谁说话。
 */
export class EngineError extends Error {
  readonly traceback: string

  constructor(message: string, traceback = '') {
    super(message)
    this.name = 'EngineError'
    this.traceback = traceback
  }
}

/**
 * 这次求值被**取消**了。
 *
 * 它继承 `EngineError`，所以既有的 catch 不会漏掉它；而它是单独一个类，
 * 是因为上层要据此做一件不同的事：把节点放回"可以重试"，而不是记成失败 ——
 * 用户按了取消，不该在运行清单里留下一条"失败"。
 */
export class CancelledError extends EngineError {
  constructor(message = '已取消') {
    super(message)
    this.name = 'CancelledError'
  }
}
