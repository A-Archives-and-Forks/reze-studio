/** Minimal IndexedDB key-value wrapper (async get/set/del). */

const DB_NAME = "reze-studio"
const STORE_NAME = "kv"
const DB_VERSION = 1

/** Single shared connection — avoids open/close per op (was main-thread churn during clip saves). */
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE_NAME)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
    })
  }
  return dbPromise
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDb().then((db) => {
    const t = db.transaction(STORE_NAME, mode)
    return t.objectStore(STORE_NAME)
  })
}

export async function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  const store = await tx("readonly")
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const store = await tx("readwrite")
  return new Promise((resolve, reject) => {
    const req = store.put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function idbDel(key: string): Promise<void> {
  const store = await tx("readwrite")
  return new Promise((resolve, reject) => {
    const req = store.delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}
