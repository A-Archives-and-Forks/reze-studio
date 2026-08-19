// The uploaded PMX model's files, in IndexedDB — the other half of
// persistence: lib/draft.ts stores the small clip JSON in localStorage, this
// stores the actual bytes, which can run tens of megabytes and don't fit
// localStorage's ~5MB budget.
//
// ONE record, deliberately: the studio edits one local model at a time.
// Loading a different PMX folder overwrites it outright.
//
// Every failure path resolves null/false rather than throwing: persistence is
// a convenience, never a precondition. Browsers evict IndexedDB under storage
// pressure, so a caller must treat "gone" as normal — the studio boots the
// bundled default and the user re-uploads.

import { storageKey } from "@/lib/storage"

const DB_NAME = "reze-studio"
const DB_VERSION = 1
const STORE = "uploaded-model"
const KEY = storageKey("uploaded-model")

type StoredEntry = { path: string; file: File }
type StoredModel = { pmxPath: string; stem: string; files: StoredEntry[] }

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null) // private mode in some browsers
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

/**
 * True only once the bytes are actually down — the caller must not assume an
 * upload persisted when it didn't (quota is the expected failure mode for a
 * large model in a tight browser).
 *
 * `path` is captured per file as `webkitRelativePath || name` HERE, while the
 * File objects are still live from the picker — that property does not
 * reliably survive an IndexedDB structured-clone round trip, so it must be
 * read now and stored explicitly rather than re-read after restore.
 */
export async function saveModelUpload(files: File[], pmxFile: File, stem: string): Promise<boolean> {
  const db = await open()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite")
      const entries: StoredEntry[] = files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f }))
      const record: StoredModel = {
        pmxPath: pmxFile.webkitRelativePath || pmxFile.name,
        stem,
        files: entries,
      }
      tx.objectStore(STORE).put(record, KEY)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    } finally {
      db.close()
    }
  })
}

/**
 * The stored model as `{ files, pmxFile }` — the exact shape
 * `engine.loadModel(name, { files, pmxFile })` takes. Null when absent or
 * evicted.
 *
 * Re-wrapped so `.name` IS the stored path: a restored File's own
 * `webkitRelativePath` is always `""` (browsers only set it for a live
 * folder/drag pick), and the engine's file-map resolver falls back to
 * `.name` for exactly this case (see reze-engine's asset-reader.js). The pmx
 * file is found by matching `.name` against the stored path directly —
 * `pmxFileAtRelativePath` from reze-engine only checks `webkitRelativePath`
 * and would not find it.
 */
export async function loadModelUpload(): Promise<{ files: File[]; pmxFile: File; stem: string } | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY)
      req.onsuccess = () => {
        const rec = req.result as StoredModel | undefined
        if (!rec) return resolve(null)
        const files = rec.files.map((e) => new File([e.file], e.path, { type: e.file.type }))
        const pmxFile = files.find((f) => f.name === rec.pmxPath)
        if (!pmxFile) return resolve(null)
        resolve({ files, pmxFile, stem: rec.stem })
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      db.close()
    }
  })
}

export async function clearModelUpload(): Promise<void> {
  const db = await open()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    } finally {
      db.close()
    }
  })
}
