// Tracks and placements → the one flat AnimationClip the engine plays.
//
// The engine has no idea any of this exists, and that is deliberate: reze-engine
// plays a clip, and every layering decision here is a decision about a DOCUMENT.
// `Model.setBlendPose` exists and is the wrong tool — it averages a missing bone
// toward the rest pose, so a face-only clip laid over a dance would drag the
// body halfway back to a T-pose. Layering wants replacement, not averaging.
//
// TWO RULES, and everything below is their consequence.
//
// 1. OWNERSHIP IS PER FRAME, PER NAME. At each frame, for each bone / morph /
//    IK chain, the topmost active track with a placement covering that frame
//    whose clip keys that name owns it there. Nothing else contributes.
//
//    Per NAME is what lets a face-only VMD and a body-only VMD compose with no
//    mask UI, which is the composition MMD users already expect because the
//    scene ships motions in exactly those two halves. Per FRAME is what lets a
//    120-frame hand clip override the dance's wrists for those 120 frames and
//    hand them back afterwards — owning a name for the whole timeline would
//    blank the dance's hands either side of it.
//
// 2. CUTS ARE EXACT. Where ownership changes in the middle of a keyframe
//    interval, the boundary key carries the pose sampled there and the
//    segment's easing is SPLIT rather than copied, so the motion inside the cut
//    is the motion the source clip had. See splitInterpolation in lib/utils.
//
// A CLIP'S INFLUENCE IS ITS SPAN — at the ENDS of the arrangement. VMD holds
// the last key forever and extrapolates the first one backwards, so a ten-frame
// clip laid on a lane would otherwise pose its bones for the whole timeline in
// both directions: the pose arriving before the clip does and staying long
// after it ends. Before anything has played and after everything has, the bake
// writes the REST pose, which is where a bone with no keyframe sits.
//
// A gap BETWEEN two placements is a different question and gets a different
// answer: it HOLDS the pose the previous one ended on. Snapping to rest there
// would be two lurches — out of the pose and back into the next one — across a
// stretch where the arrangement is not asking for anything to happen.
//
// IK IS A STATE, NOT A POSE, so silence about it is itself an answer. A VMD
// that says nothing about 左足ＩＫ plays with that chain SOLVING, because that
// is where MMD leaves it — so a dance laid after a motion that switched the
// feet off has to say "on" somewhere, or it inherits the off and walks the
// whole take on stiff legs. What it must not do is say "on" for chains it is
// not driving, or a face-only clip on the top track would switch the feet back
// on underneath it. So a clip owns a chain exactly where it DRIVES that chain:
// it keys the flag, or it keys the IK bone itself.

import type { AnimationClip, BoneInterpolation, BoneKeyframe, IkKeyframe, MorphKeyframe } from "reze-engine"
import { Vec3 } from "reze-engine"
import { Quat } from "reze-engine"
import {
  activeTracks,
  clipById,
  offsetOf,
  outOf,
  placementEnd,
  projectEnd,
  type Placement,
  type Project,
} from "@/lib/project"
import {
  cloneBoneInterpolation,
  evalBoneTrackAt,
  splitInterpolation,
  VMD_LINEAR_DEFAULT_IP,
} from "@/lib/utils"
import { sampleMorphTrackAt } from "@/lib/animation"

/** One stretch of arrangement frames that a single placement owns for one name. */
type Interval = { from: number; to: number; placement: Placement; clip: AnimationClip }

type TrackKind = "bone" | "morph" | "ik"

function tracksOfKind(clip: AnimationClip, kind: TrackKind): Map<string, unknown[]> | undefined {
  if (kind === "bone") return clip.boneTracks as unknown as Map<string, unknown[]>
  if (kind === "morph") return clip.morphTracks as unknown as Map<string, unknown[]>
  return clip.ikTracks as unknown as Map<string, unknown[]> | undefined
}

/**
 * Whether `clip` has anything to say about `name`.
 *
 * For bones and morphs that is exactly "does it key that track" — a clip with
 * no 左手首 keys leaves the wrist to whatever is under it. IK asks the wider
 * question, because a clip driving a chain has an opinion on its solve state
 * whether or not it wrote one down, and that unwritten opinion is `true`.
 */
function drives(clip: AnimationClip, kind: TrackKind, name: string): boolean {
  if ((tracksOfKind(clip, kind)?.get(name)?.length ?? 0) > 0) return true
  return kind === "ik" && (clip.boneTracks.get(name)?.length ?? 0) > 0
}

/**
 * Which placement owns `name` over which arrangement frames.
 *
 * Walks tracks top to bottom, and each track claims only the frames still
 * unclaimed — so a lower track keeps the stretches the ones above it do not
 * cover. Result is sorted and disjoint.
 */
function ownershipIntervals(project: Project, kind: TrackKind, name: string): Interval[] {
  const claimed: Interval[] = []
  const overlapsClaimed = (from: number, to: number) => claimed.some((c) => from < c.to && to > c.from)

  for (const track of activeTracks(project)) {
    for (const placement of track.placements) {
      const lib = clipById(project, placement.clipId)
      if (!lib) continue
      if (!drives(lib.clip, kind, name)) continue
      const from = placement.start
      const to = placementEnd(placement, lib.clip)
      if (to <= from) continue
      if (!overlapsClaimed(from, to)) {
        claimed.push({ from, to, placement, clip: lib.clip })
        continue
      }
      // Partly covered already: keep only the gaps this placement can still
      // fill. A lower track showing through either side of a short clip above
      // it is the whole point of per-frame ownership.
      const blockers = claimed
        .filter((c) => from < c.to && to > c.from)
        .sort((a, b) => a.from - b.from)
      let cursor = from
      for (const b of blockers) {
        if (b.from > cursor) claimed.push({ from: cursor, to: b.from, placement, clip: lib.clip })
        cursor = Math.max(cursor, b.to)
      }
      if (cursor < to) claimed.push({ from: cursor, to, placement, clip: lib.clip })
    }
  }
  return claimed.sort((a, b) => a.from - b.from)
}

/**
 * The bone keys `interval` contributes, in arrangement frames.
 *
 * `isFirst` and `hasFollower` are about the FLAT track this is being written
 * into, not about the interval itself, and they decide the two boundary keys:
 *
 * - The first interval's opening key keeps the curve it was authored with,
 *   because nothing precedes it and that curve is still the file's own. A later
 *   interval's opening key is linear-in: what precedes it there is the previous
 *   owner's closing key, one frame earlier, and inheriting an easing authored
 *   for a hundred-frame segment to cover a single frame is meaningless.
 *
 * - The closing key is written when the boundary would otherwise be crossed by
 *   an interpolation that ignores it, which happens two ways: another interval
 *   follows and the flat track would run from this owner's last real key into
 *   the next owner's first one, or this owner's own source keeps moving past
 *   the cut and the flat track would freeze at its last key inside. When
 *   neither is true the engine's hold is already the right answer, and pinning
 *   it would put a key into every exported VMD that the source never had.
 */
function bakeBoneInterval(
  interval: Interval,
  name: string,
  isFirst: boolean,
  hasFollower: boolean,
): BoneKeyframe[] {
  const { from, to, placement, clip } = interval
  const source = clip.boneTracks.get(name)
  if (!source || source.length === 0) return []
  const offset = offsetOf(placement)
  const localFrom = from - offset
  const localLast = to - 1 - offset
  const out: BoneKeyframe[] = []

  const keyAt = (local: number) => source.find((k) => k.frame === local) ?? null
  const copyOf = (k: BoneKeyframe, frame: number, ip?: BoneInterpolation): BoneKeyframe => ({
    boneName: name,
    frame,
    rotation: k.rotation.clone(),
    translation: new Vec3(k.translation.x, k.translation.y, k.translation.z),
    interpolation: ip ?? cloneBoneInterpolation(k.interpolation),
  })
  /** A key the source does not have, holding the pose the source is in there. */
  const sampled = (local: number, frame: number, ip = cloneBoneInterpolation(VMD_LINEAR_DEFAULT_IP)): BoneKeyframe => {
    const pose = evalBoneTrackAt(source, local)
    return { boneName: name, frame, rotation: pose.rotation, translation: pose.translation, interpolation: ip }
  }

  // The segment the interval's start falls inside, if it falls inside one —
  // that is the curve that has to be divided.
  const beforeStart = [...source].reverse().find((k) => k.frame < localFrom) ?? null
  const afterStart = source.find((k) => k.frame > localFrom) ?? null
  const startKey = keyAt(localFrom)

  if (startKey) {
    out.push(copyOf(startKey, from, isFirst ? undefined : cloneBoneInterpolation(VMD_LINEAR_DEFAULT_IP)))
  } else {
    out.push(sampled(localFrom, from))
  }

  // Every real key inside, the last frame included.
  for (const k of source) {
    if (k.frame <= localFrom || k.frame > localLast) continue
    // The first real key after a synthesized opening now closes a SHORTER
    // segment than the one its curve was authored for, so it takes the right
    // half of that curve.
    if (!startKey && afterStart && k.frame === afterStart.frame && beforeStart) {
      const span = k.frame - beforeStart.frame
      const t = span > 0 ? (localFrom - beforeStart.frame) / span : 0
      out.push(copyOf(k, k.frame + offset, splitInterpolation(k.interpolation, t).right))
    } else {
      out.push(copyOf(k, k.frame + offset))
    }
  }

  const after = source.find((k) => k.frame > localLast) ?? null
  if ((hasFollower || after !== null) && localLast > localFrom && !keyAt(localLast)) {
    const before = [...source].reverse().find((k) => k.frame < localLast) ?? null
    let ip = cloneBoneInterpolation(VMD_LINEAR_DEFAULT_IP)
    if (before && after) {
      const span = after.frame - before.frame
      const t = span > 0 ? (localLast - before.frame) / span : 0
      // This key now CLOSES the segment that ran from `before`, so it wears the
      // left half of that segment's curve.
      ip = splitInterpolation(after.interpolation, t).left
    }
    out.push(sampled(localLast, to - 1, ip))
  }
  return out
}

function bakeMorphInterval(interval: Interval, name: string, hasFollower: boolean): MorphKeyframe[] {
  const { from, to, placement, clip } = interval
  const source = clip.morphTracks.get(name)
  if (!source || source.length === 0) return []
  const offset = offsetOf(placement)
  const localFrom = from - offset
  const localLast = to - 1 - offset
  const out: MorphKeyframe[] = []
  // Morph tracks carry no curve — VMD lerps them — so a boundary is just the
  // sampled weight, and there is nothing to split.
  out.push({ morphName: name, frame: from, weight: sampleMorphTrackAt(source, localFrom) })
  for (const k of source) {
    if (k.frame <= localFrom || k.frame > localLast) continue
    out.push({ morphName: name, frame: k.frame + offset, weight: k.weight })
  }
  const continues = source.some((k) => k.frame > localLast)
  const closed = source.some((k) => k.frame === localLast)
  if ((hasFollower || continues) && localLast > localFrom && !closed) {
    out.push({ morphName: name, frame: to - 1, weight: sampleMorphTrackAt(source, localLast) })
  }
  return out
}

/**
 * The IK flags `interval` contributes, in arrangement frames.
 *
 * The opening key is written even when the source carries no flags at all —
 * that is the point. An interval reaching this function drives the chain, so it
 * has a state to declare at its own start, and a clip that never mentions the
 * chain declares the one it would play with on its own: solving.
 */
function bakeIkInterval(interval: Interval, name: string): IkKeyframe[] {
  const { from, to, placement, clip } = interval
  const source = clip.ikTracks?.get(name) ?? []
  const offset = offsetOf(placement)
  const localFrom = from - offset
  const localLast = to - 1 - offset
  // IK keys are steps: the state holds until the next one changes it, so the
  // boundary carries whatever was in force there and the rest copy across.
  // Ahead of the first key the chain solves — a trim starting before one takes
  // that, not the key's own state.
  let state = true
  for (const k of source) {
    if (k.frame <= localFrom) state = k.enabled
    else break
  }
  const out: IkKeyframe[] = [{ frame: from, enabled: state }]
  for (const k of source) {
    if (k.frame <= localFrom || k.frame > localLast) continue
    out.push({ frame: k.frame + offset, enabled: k.enabled })
  }
  return out
}

/**
 * The flat track, reduced to the moments the state actually changes.
 *
 * A player reading this reaches every frame the same way the bake did: solving
 * until told otherwise, then holding each flag until the next. So a key
 * restating the state already in force is one the file does not need, and a
 * chain that solves the whole way through leaves no keys at all, so an
 * arrangement of ordinary motions exports as an ordinary motion.
 */
function ikTransitions(keys: IkKeyframe[]): IkKeyframe[] {
  const out: IkKeyframe[] = []
  let state = true
  for (const k of keys) {
    if (k.enabled === state) continue
    out.push(k)
    state = k.enabled
  }
  return out
}

/** A bone at rest: no rotation, no translation — what an unkeyed bone is. */
function restBoneKey(name: string, frame: number): BoneKeyframe {
  return {
    boneName: name,
    frame,
    rotation: new Quat(0, 0, 0, 1),
    translation: new Vec3(0, 0, 0),
    interpolation: cloneBoneInterpolation(VMD_LINEAR_DEFAULT_IP),
  }
}

/**
 * A frame where nothing is driving the name, and what should be written there.
 *
 * `hold` names the interval whose final pose carries across; null means rest.
 */
type Boundary = { frame: number; hold: Interval | null }

/**
 * The edges of the stretches nobody owns.
 *
 * Before the first placement, two rest keys rather than one: rest has to be
 * HELD up to the moment the clip starts, and a single key at frame 0 would just
 * be the far end of an interpolation into the first pose.
 *
 * Between placements, ONE key at the last frame of the gap, carrying the
 * previous placement's final pose. That value already sits on the previous
 * interval's own closing key, so the two together make a flat hold — and the
 * transition into the next placement happens over the single frame between
 * them, where the arrangement says it does.
 *
 * Nothing is written past the arrangement's own end: there is no gap there,
 * only the timeline running out, and a rest key on the final frame would snap
 * the model to a T-pose as it finishes.
 */
function boundaries(intervals: Interval[], arrangementEnd: number): Boundary[] {
  const out: Boundary[] = []
  if (intervals.length === 0) return out
  const first = intervals[0]
  if (first.from > 0) {
    out.push({ frame: 0, hold: null })
    if (first.from - 1 > 0) out.push({ frame: first.from - 1, hold: null })
  }
  for (let i = 1; i < intervals.length; i++) {
    const prev = intervals[i - 1]
    const next = intervals[i]
    if (next.from - 1 >= prev.to) out.push({ frame: next.from - 1, hold: prev })
  }
  const last = intervals[intervals.length - 1]
  if (last.to < arrangementEnd) out.push({ frame: last.to, hold: null })
  return out
}

/** The pose an interval leaves behind — its source, at its own last frame. */
function heldBoneKey(interval: Interval, name: string, frame: number): BoneKeyframe {
  const source = interval.clip.boneTracks.get(name)
  if (!source || source.length === 0) return restBoneKey(name, frame)
  const pose = evalBoneTrackAt(source, interval.to - 1 - offsetOf(interval.placement))
  return {
    boneName: name,
    frame,
    rotation: pose.rotation,
    translation: pose.translation,
    interpolation: cloneBoneInterpolation(VMD_LINEAR_DEFAULT_IP),
  }
}

function heldMorphWeight(interval: Interval, name: string): number {
  const source = interval.clip.morphTracks.get(name)
  if (!source || source.length === 0) return 0
  return sampleMorphTrackAt(source, interval.to - 1 - offsetOf(interval.placement))
}

/** Sort by frame; where two land on one frame the later one wins, which is the
 *  order intervals were emitted in. */
function dedupe<T extends { frame: number }>(keys: T[]): T[] {
  keys.sort((a, b) => a.frame - b.frame)
  const out: T[] = []
  for (const k of keys) {
    if (out.length > 0 && out[out.length - 1].frame === k.frame) out[out.length - 1] = k
    else out.push(k)
  }
  return out
}

/** Every name of one kind that any active placement keys. */
function namesOfKind(project: Project, kind: TrackKind): string[] {
  const names = new Set<string>()
  for (const track of activeTracks(project)) {
    for (const placement of track.placements) {
      const lib = clipById(project, placement.clipId)
      if (!lib) continue
      const map = tracksOfKind(lib.clip, kind)
      if (!map) continue
      for (const [name, keys] of map) if (keys.length > 0) names.add(name)
    }
  }
  return [...names].sort()
}

/** One name's baked keys, in arrangement frames. Exported so a drag can re-bake
 *  the single bone it is moving instead of the whole project. */
export function bakeName(project: Project, kind: "bone", name: string): BoneKeyframe[]
export function bakeName(project: Project, kind: "morph", name: string): MorphKeyframe[]
export function bakeName(project: Project, kind: "ik", name: string): IkKeyframe[]
export function bakeName(
  project: Project,
  kind: TrackKind,
  name: string,
): BoneKeyframe[] | MorphKeyframe[] | IkKeyframe[] {
  const intervals = ownershipIntervals(project, kind, name)
  const last = intervals.length - 1
  // A gap counts as a follower: the rest keys written into it are what the
  // interval before has to stop interpolating into.
  const end = coveredEnd(project)
  const edges = boundaries(intervals, end)
  // A boundary counts as a follower: it is what the interval before has to stop
  // interpolating into.
  const followed = (i: number) => i < last || edges.some((b) => b.frame >= (intervals[i]?.to ?? 0))
  if (kind === "bone") {
    const keys = intervals.flatMap((iv, i) => bakeBoneInterval(iv, name, i === 0, followed(i)))
    const edgeKeys = edges.map((b) => (b.hold ? heldBoneKey(b.hold, name, b.frame) : restBoneKey(name, b.frame)))
    return dedupe([...keys, ...edgeKeys])
  }
  if (kind === "morph") {
    const keys = intervals.flatMap((iv, i) => bakeMorphInterval(iv, name, followed(i)))
    const edgeKeys = edges.map((b) => ({
      morphName: name,
      frame: b.frame,
      weight: b.hold ? heldMorphWeight(b.hold, name) : 0,
    }))
    return dedupe([...keys, ...edgeKeys])
  }
  return ikTransitions(dedupe(intervals.flatMap((i) => bakeIkInterval(i, name))))
}

/** The last frame any placement reaches. Not `projectEnd`, which floors at a
 *  default clip length — a floor would put a rest key past the real content. */
function coveredEnd(project: Project): number {
  let end = 0
  for (const track of project.tracks) {
    for (const p of track.placements) {
      const lib = clipById(project, p.clipId)
      if (lib) end = Math.max(end, placementEnd(p, lib.clip))
    }
  }
  return end
}

/** The whole arrangement as one clip. */
export function bakeProject(project: Project, cameraLastFrame = 0): AnimationClip {
  const boneTracks = new Map<string, BoneKeyframe[]>()
  for (const name of namesOfKind(project, "bone")) {
    const keys = bakeName(project, "bone", name)
    if (keys.length > 0) boneTracks.set(name, keys)
  }
  const morphTracks = new Map<string, MorphKeyframe[]>()
  for (const name of namesOfKind(project, "morph")) {
    const keys = bakeName(project, "morph", name)
    if (keys.length > 0) morphTracks.set(name, keys)
  }
  let ikTracks: Map<string, IkKeyframe[]> | undefined
  for (const name of namesOfKind(project, "ik")) {
    const keys = bakeName(project, "ik", name)
    if (keys.length === 0) continue
    if (!ikTracks) ikTracks = new Map()
    ikTracks.set(name, keys)
  }
  return { boneTracks, morphTracks, ikTracks, frameCount: projectEnd(project, cameraLastFrame) }
}
