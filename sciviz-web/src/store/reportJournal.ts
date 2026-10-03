/**
 * Unsaved report changes live in IndexedDB until the matching .sciviz file is written.
 * This is a recovery journal, not a second project format or a computation input.
 */

const DB_NAME = 'sciviz-report-journal'
const STORE_NAME = 'entries'
const memory = new Map<string, unknown>()

interface Entry<T> {
  key: string
  value: T
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器没有 IndexedDB，无法可靠保存报告草稿'))
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('报告草稿数据库无法打开'))
  })
}

function nodeTestRuntime(): boolean {
  return typeof window === 'undefined'
}

async function operation<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    let result: T
    const tx = db.transaction(STORE_NAME, mode)
    tx.oncomplete = () => { db.close(); resolve(result) }
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('报告草稿写入失败')) }
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('报告草稿写入中止')) }
    run(tx.objectStore(STORE_NAME), (value) => { result = value })
  })
}

export async function journalRead<T>(key: string): Promise<T | undefined> {
  if (nodeTestRuntime()) return memory.get(key) as T | undefined
  return operation<T | undefined>('readonly', (store, done) => {
    const request = store.get(key)
    request.onsuccess = () => done((request.result as Entry<T> | undefined)?.value)
  })
}

export async function journalWrite<T>(key: string, value: T): Promise<void> {
  if (nodeTestRuntime()) { memory.set(key, value); return }
  await operation<void>('readwrite', (store, done) => {
    store.put({ key, value } satisfies Entry<T>)
    done(undefined)
  })
}

export async function journalDelete(key: string): Promise<void> {
  if (nodeTestRuntime()) { memory.delete(key); return }
  await operation<void>('readwrite', (store, done) => {
    store.delete(key)
    done(undefined)
  })
}
