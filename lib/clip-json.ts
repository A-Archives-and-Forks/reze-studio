import type {
  AnimationClip,
  BoneInterpolation,
  BoneKeyframe,
  ControlPoint,
  MorphKeyframe,
} from "reze-engine"
import { Quat, Vec3 } from "reze-engine"
import { VMD_LINEAR_DEFAULT_IP, cloneBoneInterpolation } from "@/lib/keyframe-insert"

/** JSON-friendly snapshot of a studio clip (Maps → records, Quat/Vec3 → plain numbers). */
export interface AnimationClipJson {
  format: "reze-animation-clip"
  version: 1
  frameCount: number
  boneTracks: Record<string, BoneKeyframeJson[]>
  morphTracks: Record<string, MorphKeyframeJson[]>
}

export interface BoneKeyframeJson {
  boneName: string
  frame: number
  rotation: { x: number; y: number; z: number; w: number }
  translation: { x: number; y: number; z: number }
  interpolation: BoneInterpolationJson
}

export interface BoneInterpolationJson {
  rotation: ControlPoint[]
  translationX: ControlPoint[]
  translationY: ControlPoint[]
  translationZ: ControlPoint[]
}

export interface MorphKeyframeJson {
  morphName: string
  frame: number
  weight: number
}

function isControlPoint(v: unknown): v is ControlPoint {
  return (
    typeof v === "object" &&
    v !== null &&
    "x" in v &&
    "y" in v &&
    typeof (v as ControlPoint).x === "number" &&
    typeof (v as ControlPoint).y === "number"
  )
}

function parseInterpolation(raw: unknown): BoneInterpolation {
  const def = VMD_LINEAR_DEFAULT_IP
  if (typeof raw !== "object" || raw === null) return cloneBoneInterpolation(def)
  const o = raw as Record<string, unknown>
  const axis = (key: keyof BoneInterpolation): ControlPoint[] => {
    const a = o[key as string]
    const fallback = () => [...def[key]]
    if (!Array.isArray(a) || a.length < 2) return fallback()
    const p0 = a[0],
      p1 = a[1]
    if (!isControlPoint(p0) || !isControlPoint(p1)) return fallback()
    return [{ x: p0.x, y: p0.y }, { x: p1.x, y: p1.y }]
  }
  return {
    rotation: axis("rotation"),
    translationX: axis("translationX"),
    translationY: axis("translationY"),
    translationZ: axis("translationZ"),
  }
}

function parseBoneKeyframe(raw: unknown): BoneKeyframe | null {
  if (typeof raw !== "object" || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.boneName !== "string" || typeof o.frame !== "number") return null
  const r = o.rotation
  const t = o.translation
  if (
    typeof r !== "object" ||
    r === null ||
    typeof t !== "object" ||
    t === null ||
    !("x" in r && "y" in r && "z" in r && "w" in r) ||
    !("x" in t && "y" in t && "z" in t)
  )
    return null
  const rq = r as Record<string, number>
  const tv = t as Record<string, number>
  return {
    boneName: o.boneName,
    frame: o.frame,
    rotation: new Quat(rq.x, rq.y, rq.z, rq.w),
    translation: new Vec3(tv.x, tv.y, tv.z),
    interpolation: parseInterpolation(o.interpolation),
  }
}

function parseMorphKeyframe(raw: unknown): MorphKeyframe | null {
  if (typeof raw !== "object" || raw === null) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.morphName !== "string" ||
    typeof o.frame !== "number" ||
    typeof o.weight !== "number"
  )
    return null
  return { morphName: o.morphName, frame: o.frame, weight: o.weight }
}

function inferFrameCount(o: Record<string, unknown>): number {
  let maxF = 0
  const bt = o.boneTracks
  const mt = o.morphTracks
  const scan = (rec: unknown) => {
    if (typeof rec !== "object" || rec === null) return
    for (const kfs of Object.values(rec)) {
      if (!Array.isArray(kfs)) continue
      for (const k of kfs) {
        if (typeof k === "object" && k !== null && "frame" in k && typeof (k as { frame: unknown }).frame === "number") {
          maxF = Math.max(maxF, (k as { frame: number }).frame)
        }
      }
    }
  }
  scan(bt)
  scan(mt)
  return maxF
}

/** Build an engine clip from exported JSON or a minimal `{ frameCount, boneTracks, morphTracks }` object. */
export function animationClipFromJson(text: string): AnimationClip {
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof data !== "object" || data === null) throw new Error("Clip JSON must be an object")

  const root = data as Record<string, unknown>
  const fmt = root.format
  const boneRaw =
    typeof root.boneTracks === "object" && root.boneTracks !== null
      ? (root.boneTracks as Record<string, unknown>)
      : null
  if (!boneRaw) throw new Error('Missing "boneTracks"')

  if (fmt !== undefined && fmt !== "reze-animation-clip") {
    throw new Error(`Unknown clip format: ${String(fmt)}`)
  }

  let frameCount =
    typeof root.frameCount === "number" && root.frameCount >= 0 ? root.frameCount : inferFrameCount(root)

  const boneTracks = new Map<string, BoneKeyframe[]>()
  for (const [boneName, arr] of Object.entries(boneRaw)) {
    if (!Array.isArray(arr)) continue
    const kfs: BoneKeyframe[] = []
    for (const item of arr) {
      const kf = parseBoneKeyframe(item)
      if (kf) {
        kf.boneName = boneName
        kfs.push(kf)
      }
    }
    kfs.sort((a, b) => a.frame - b.frame)
    if (kfs.length) boneTracks.set(boneName, kfs)
  }

  const morphTracks = new Map<string, MorphKeyframe[]>()
  const morphRaw =
    typeof root.morphTracks === "object" && root.morphTracks !== null
      ? (root.morphTracks as Record<string, unknown>)
      : {}
  for (const [morphName, arr] of Object.entries(morphRaw)) {
    if (!Array.isArray(arr)) continue
    const kfs: MorphKeyframe[] = []
    for (const item of arr) {
      const kf = parseMorphKeyframe(item)
      if (kf) {
        kf.morphName = morphName
        kfs.push(kf)
      }
    }
    kfs.sort((a, b) => a.frame - b.frame)
    if (kfs.length) morphTracks.set(morphName, kfs)
  }

  frameCount = Math.max(frameCount, inferFrameCount({ boneTracks: boneRaw, morphTracks: morphRaw }))

  return { boneTracks, morphTracks, frameCount }
}

function boneKeyframeToJson(kf: BoneKeyframe): BoneKeyframeJson {
  return {
    boneName: kf.boneName,
    frame: kf.frame,
    rotation: { x: kf.rotation.x, y: kf.rotation.y, z: kf.rotation.z, w: kf.rotation.w },
    translation: { x: kf.translation.x, y: kf.translation.y, z: kf.translation.z },
    interpolation: {
      rotation: kf.interpolation.rotation.map((p) => ({ x: p.x, y: p.y })),
      translationX: kf.interpolation.translationX.map((p) => ({ x: p.x, y: p.y })),
      translationY: kf.interpolation.translationY.map((p) => ({ x: p.x, y: p.y })),
      translationZ: kf.interpolation.translationZ.map((p) => ({ x: p.x, y: p.y })),
    },
  }
}

function morphKeyframeToJson(kf: MorphKeyframe): MorphKeyframeJson {
  return { morphName: kf.morphName, frame: kf.frame, weight: kf.weight }
}

/** Serialise the current clip for File → Export JSON (readable, round-trips with `animationClipFromJson`). */
export function animationClipToJsonString(clip: AnimationClip, pretty = true): string {
  const boneTracks: Record<string, BoneKeyframeJson[]> = {}
  for (const [name, kfs] of clip.boneTracks) {
    boneTracks[name] = kfs.map(boneKeyframeToJson)
  }
  const morphTracks: Record<string, MorphKeyframeJson[]> = {}
  for (const [name, kfs] of clip.morphTracks) {
    morphTracks[name] = kfs.map(morphKeyframeToJson)
  }
  const payload: AnimationClipJson = {
    format: "reze-animation-clip",
    version: 1,
    frameCount: clip.frameCount,
    boneTracks,
    morphTracks,
  }
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)
}
