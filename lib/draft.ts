// The current draft: the edited AnimationClip + its display name, in
// localStorage. The other half of persistence — the uploaded model itself —
// lives in IndexedDB (lib/model-store.ts); this is the small, synchronously
// readable part.
//
// AnimationClip is not JSON-safe as-is: boneTracks/morphTracks/ikTracks are
// Maps, and BoneKeyframe.rotation/.translation are Quat/Vec3 class instances.
// serializeClip/deserializeClip round-trip through plain arrays and objects.
// BoneInterpolation's control points are already plain {x,y} — no special
// handling needed there.

import type { AnimationClip, BoneInterpolation, BoneKeyframe, IkKeyframe, MorphKeyframe } from "reze-engine"
import { Quat, Vec3 } from "reze-engine"
import { storageKey } from "@/lib/storage"

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
type StoredDraft = { clipDisplayName: string; clip: SerializedClip }

const KEY = storageKey("draft")

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

// Coalesced writes: editing is continuous (slider drags, keystrokes), and
// re-serialising the whole clip on every change would cost more than the
// change did. A short trailing delay turns a drag into one write. Single
// slot, not keyed per-id — this store only ever holds one draft.
let pendingWrite: ReturnType<typeof setTimeout> | null = null
let pendingRun: (() => void) | null = null

function write(clipDisplayName: string, clip: AnimationClip) {
  try {
    const payload: StoredDraft = { clipDisplayName, clip: serializeClip(clip) }
    window.localStorage.setItem(KEY, JSON.stringify(payload))
  } catch (e) {
    console.warn("[draft] localStorage write failed — the current draft will not survive a reload", e)
  }
}

export function saveDraftSoon(clipDisplayName: string, clip: AnimationClip, ms = 400): void {
  if (pendingWrite) clearTimeout(pendingWrite)
  pendingRun = () => write(clipDisplayName, clip)
  pendingWrite = setTimeout(() => {
    pendingWrite = null
    const run = pendingRun
    pendingRun = null
    run?.()
  }, ms)
}

/** Write anything still queued, now. Covers closing the tab mid-edit, inside
 *  the debounce window — call from a `pagehide` listener. */
export function flushDraftWrite(): void {
  if (pendingWrite) clearTimeout(pendingWrite)
  pendingWrite = null
  const run = pendingRun
  pendingRun = null
  run?.()
}

export function loadDraft(): { clipDisplayName: string; clip: AnimationClip } | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const rec = JSON.parse(raw) as StoredDraft
    return { clipDisplayName: rec.clipDisplayName, clip: deserializeClip(rec.clip) }
  } catch {
    return null
  }
}

export function clearDraft(): void {
  if (pendingWrite) clearTimeout(pendingWrite)
  pendingWrite = null
  pendingRun = null
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // storage blocked — nothing to clear
  }
}
