// The imported music file, in IndexedDB — the same medium the uploaded model
// and the clip draft use, and for the same reason: audio is an asset, often
// several megabytes, and localStorage tops out around five for the whole origin.
//
// ONE record, deliberately: the studio scores one project at a time. Importing
// another track replaces it.
//
// Every failure path resolves null/false rather than throwing: persistence is a
// convenience, never a precondition. Browsers evict IndexedDB under storage
// pressure, so a caller must treat "gone" as normal — the timeline simply loses
// its waveform and the user re-imports.

const DB_NAME = "reze-studio-audio"
const DB_VERSION = 1
const STORE = "audio"
const KEY = "current"

/**
 * Either an imported file, or a marker saying the BUNDLED track is in use.
 *
 * The built-in song is already served from /audio behind an immutable cache
 * header, so copying its several megabytes into IndexedDB as well would be
 * storing the same bytes twice. What actually needs remembering is the choice —
 * that music is on, and which track — so a marker carries that and the bytes
 * are re-fetched. An absent record still means "no music", which is what makes
 * Clear music survive a reload.
 */
type StoredAudio = { name: string; file: File | null; builtin?: boolean }

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

/** Remember that the bundled track is in use, without duplicating its bytes. */
export function saveBuiltinAudioMarker(name: string): Promise<boolean> {
  return putAudio({ name, file: null, builtin: true })
}

export function saveAudioUpload(name: string, file: File): Promise<boolean> {
  return putAudio({ name, file })
}

async function putAudio(record: StoredAudio): Promise<boolean> {
  const db = await open()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(record, KEY)
      tx.oncomplete = () => resolve(true)
      // Quota is the expected failure — a long track in a tight browser.
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    } finally {
      db.close()
    }
  })
}

export async function loadAudioUpload(): Promise<StoredAudio | null> {
  const db = await open()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY)
      req.onsuccess = () => {
        const rec = req.result as StoredAudio | undefined
        // A record with neither bytes nor the builtin flag is nothing to load.
        if (!rec || (!rec.file && !rec.builtin)) return resolve(null)
        resolve(rec)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      db.close()
    }
  })
}

export async function clearAudioUpload(): Promise<void> {
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
