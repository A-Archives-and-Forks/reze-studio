// The current draft: the edited AnimationClip plus the small editor state that
// goes with it (display name, playhead, selected bone, camera orbit) — in
// IndexedDB, the same medium lib/model-store.ts uses for the uploaded model.
//
// This used to be localStorage, on the assumption that a clip is "the small
// part" next to the model's bytes. That assumption breaks for a dense
// animation: many bones × many frames, each keyframe carrying a full bezier
// interpolation curve, easily lands in the multiple-MB range — past
// localStorage's ~5MB-per-origin budget, which surfaced as a real
// QuotaExceededError on the bundled demo clip. IndexedDB's budget is a share
// of disk, not a fixed few MB, so the clip belongs there like any other asset.
//
// AnimationClip is not structured-clone-safe as-is: boneTracks/morphTracks/
// ikTracks are Maps (fine for structured clone, actually), but
// BoneKeyframe.rotation/.translation are Quat/Vec3 class instances —
// structured clone drops their prototype and hands back a plain object with
// no methods. serializeClip/deserializeClip round-trip through plain arrays
// and objects so the stored shape doesn't depend on that.

import type { AnimationClip, BoneInterpolation, BoneKeyframe, IkKeyframe, MorphKeyframe } from "reze-engine"
import { Quat, Vec3 } from "reze-engine"

const DB_NAME = "reze-studio-draft"
const DB_VERSION = 1
const STORE = "draft"
const KEY = "current"

type SerializedQuat = { x: number; y: number; z: number; w: number }
type SerializedVec3 = { x: number; y: number; z: number }
type SerializedBoneKeyframe = {
  boneName: string
  frame: number
  rotation: SerializedQuat
  translation: SerializedVec3
  interpolation: BoneInterpolation
}
type SerializedClip = {
  boneTracks: [string, SerializedBoneKeyframe[]][]
  morphTracks: [string, MorphKeyframe[]][]
  ikTracks?: [string, IkKeyframe[]][]
  frameCount: number
}

/** Orbit camera only — alpha/beta/distance round-trip through the engine's
 *  own getters/setters. The orbit target (pan center) has a setter but no
 *  getter on `Engine`, so it can't be read back to persist; a restored draft
 *  reopens framed the same way it was zoomed and rotated, just not panned. */
export type StoredCamera = { alpha: number; beta: number; distance: number }

/** The timeline's own view, independent of the camera's — time-axis zoom (px
 *  per frame), value-axis zoom (curve-graph), and horizontal scroll. Without
 *  scrollX a restore only guarantees the playhead is SOMEWHERE visible (the
 *  auto-scroll-into-view margin), not framed exactly where it was. */
export type StoredTimelineView = { pxPerFrame: number; yZoom: number; scrollX: number }

export type DraftExtras = {
  currentFrame?: number
  selectedBone?: string | null
  camera?: StoredCamera
  timelineView?: StoredTimelineView
}

type StoredDraft = {
  clipDisplayName: string
  clip: SerializedClip
  currentFrame?: number
  selectedBone?: string | null
  camera?: StoredCamera
  timelineView?: StoredTimelineView
}

export function serializeClip(clip: AnimationClip): SerializedClip {
  const boneTracks: [string, SerializedBoneKeyframe[]][] = Array.from(clip.boneTracks, ([name, track]) => [
    name,
    track.map((k) => ({
      boneName: k.boneName,
      frame: k.frame,
      rotation: { x: k.rotation.x, y: k.rotation.y, z: k.rotation.z, w: k.rotation.w },
      translation: { x: k.translation.x, y: k.translation.y, z: k.translation.z },
      interpolation: k.interpolation,
    })),
  ])
  const morphTracks: [string, MorphKeyframe[]][] = Array.from(clip.morphTracks, ([name, track]) => [name, track])
  const ikTracks: [string, IkKeyframe[]][] | undefined = clip.ikTracks
    ? Array.from(clip.ikTracks, ([name, track]) => [name, track])
    : undefined
  return { boneTracks, morphTracks, ikTracks, frameCount: clip.frameCount }
}

export function deserializeClip(s: SerializedClip): AnimationClip {
  const boneTracks = new Map<string, BoneKeyframe[]>(
    s.boneTracks.map(([name, track]) => [
      name,
      track.map((k) => ({
        boneName: k.boneName,
        frame: k.frame,
        rotation: new Quat(k.rotation.x, k.rotation.y, k.rotation.z, k.rotation.w),
        translation: new Vec3(k.translation.x, k.translation.y, k.translation.z),
        interpolation: k.interpolation,
      })),
    ]),
  )
  const morphTracks = new Map<string, MorphKeyframe[]>(s.morphTracks)
  const ikTracks = s.ikTracks ? new Map<string, IkKeyframe[]>(s.ikTracks) : undefined
  return { boneTracks, morphTracks, ikTracks, frameCount: s.frameCount }
}

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

// Coalesced writes: editing is continuous (slider drags, keystrokes), and
// re-serialising the whole clip on every change would cost more than the
// change did. A short trailing delay turns a drag into one write. Single
// slot, not keyed per-id — this store only ever holds one draft.
let pendingWrite: ReturnType<typeof setTimeout> | null = null
let pendingRun: (() => void) | null = null

async function write(clipDisplayName: string, clip: AnimationClip, extras: DraftExtras) {
  const db = await open()
  if (!db) return
  try {
    const payload: StoredDraft = {
      clipDisplayName,
      clip: serializeClip(clip),
      currentFrame: extras.currentFrame,
      selectedBone: extras.selectedBone,
      camera: extras.camera,
      timelineView: extras.timelineView,
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).put(payload, KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    console.info(
      `[draft] saved "${clipDisplayName}" — ${payload.clip.boneTracks.length} bone tracks, ${payload.clip.morphTracks.length} morph tracks`,
    )
  } catch (e) {
    console.warn("[draft] IndexedDB write failed — the current draft will not survive a reload", e)
  } finally {
    db.close()
  }
}

export function saveDraftSoon(clipDisplayName: string, clip: AnimationClip, extras: DraftExtras = {}, ms = 150): void {
  if (pendingWrite) clearTimeout(pendingWrite)
  pendingRun = () => {
    void write(clipDisplayName, clip, extras)
  }
  pendingWrite = setTimeout(() => {
    pendingWrite = null
    const run = pendingRun
    pendingRun = null
    run?.()
  }, ms)
}

/** Write anything still queued, now. Covers closing the tab mid-edit, inside
 *  the debounce window — call from a `pagehide` listener.
 *
 *  Best-effort: the write itself is now an async IndexedDB transaction, which
 *  a real tab close can cut off mid-flight (unlike the old synchronous
 *  localStorage write). In practice the 150ms debounce has almost always
 *  already fired by the time someone actually navigates away, so this only
 *  matters for a reload landing within that window. */
export function flushDraftWrite(): void {
  if (pendingWrite) clearTimeout(pendingWrite)
  pendingWrite = null
  const run = pendingRun
  pendingRun = null
  run?.()
}

export async function loadDraft(): Promise<({ clipDisplayName: string; clip: AnimationClip } & DraftExtras) | null> {
  const db = await open()
  if (!db) return null
  try {
    const rec = await new Promise<StoredDraft | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve(req.result as StoredDraft | undefined)
      req.onerror = () => reject(req.error)
    })
    if (!rec) {
      console.info("[draft] no stored draft found")
      return null
    }
    console.info(
      `[draft] restoring "${rec.clipDisplayName}" — ${rec.clip.boneTracks.length} bone tracks, ${rec.clip.morphTracks.length} morph tracks`,
    )
    return {
      clipDisplayName: rec.clipDisplayName,
      clip: deserializeClip(rec.clip),
      currentFrame: rec.currentFrame,
      selectedBone: rec.selectedBone,
      camera: rec.camera,
      timelineView: rec.timelineView,
    }
  } catch (e) {
    console.warn("[draft] stored draft failed to load — starting fresh", e)
    return null
  } finally {
    db.close()
  }
}

export async function clearDraft(): Promise<void> {
  if (pendingWrite) clearTimeout(pendingWrite)
  pendingWrite = null
  pendingRun = null
  const db = await open()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } finally {
    db.close()
  }
}
