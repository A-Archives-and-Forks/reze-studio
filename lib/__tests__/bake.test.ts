import test from "node:test"
import assert from "node:assert/strict"
import type { AnimationClip, BoneKeyframe } from "reze-engine"
import { Quat, Vec3 } from "reze-engine"
import { bakeProject } from "../bake"
import {
  addClip,
  addPlacement,
  addTrack,
  newProjectWith,
  setTrackMute,
  setTrackSolo,
  splitPlacement,
  trimPlacement,
  type Project,
} from "../project"
import { evalBoneTrackAt, VMD_LINEAR_DEFAULT_IP, cloneBoneInterpolation } from "../utils"

/** A bone track keyed at the given frames, each rotated a different amount
 *  about Y so a sampled pose identifies which key it came from. */
function boneClip(name: string, frames: number[], degPerFrame = 0.5, frameCount?: number): AnimationClip {
  const keys: BoneKeyframe[] = frames.map((f) => ({
    boneName: name,
    frame: f,
    rotation: Quat.fromEuler(0, ((f * degPerFrame) * Math.PI) / 180, 0),
    translation: new Vec3(f * 0.01, 0, 0),
    interpolation: cloneBoneInterpolation(VMD_LINEAR_DEFAULT_IP),
  }))
  return {
    boneTracks: new Map([[name, keys]]),
    morphTracks: new Map(),
    frameCount: frameCount ?? Math.max(...frames),
  }
}

function morphClip(name: string, frames: number[]): AnimationClip {
  return {
    boneTracks: new Map(),
    morphTracks: new Map([
      [name, frames.map((f, i) => ({ morphName: name, frame: f, weight: i % 2 === 0 ? 0 : 1 }))],
    ]),
    frameCount: Math.max(...frames),
  }
}

/** Angle between two poses, in degrees. */
function poseGap(a: AnimationClip, aFrame: number, b: AnimationClip, bFrame: number, bone: string): number {
  const ta = a.boneTracks.get(bone)
  const tb = b.boneTracks.get(bone)
  assert.ok(ta && ta.length, `no ${bone} in the first clip`)
  assert.ok(tb && tb.length, `no ${bone} in the second clip`)
  const pa = evalBoneTrackAt(ta, aFrame)
  const pb = evalBoneTrackAt(tb, bFrame)
  return (Quat.angleTo(pa.rotation, pb.rotation) * 180) / Math.PI
}

test("one clip on one track bakes back to itself", () => {
  const source = boneClip("左手首", [0, 30, 60, 90], 0.7, 120)
  const project = newProjectWith("dance", source)
  const baked = bakeProject(project)

  assert.deepEqual([...baked.boneTracks.keys()], ["左手首"])
  const keys = baked.boneTracks.get("左手首")!
  // Key for key, not pose for pose: the promise for the one-clip document is
  // that exporting it produces the file it produced before clips existed, so
  // an extra boundary key or a rewritten curve is a regression even when it
  // happens to play the same.
  const original = source.boneTracks.get("左手首")!
  assert.equal(keys.length, original.length)
  keys.forEach((k, i) => {
    const o = original[i]
    assert.equal(k.frame, o.frame)
    assert.deepEqual(k.interpolation, o.interpolation, `frame ${k.frame} was re-eased`)
    assert.ok(Quat.angleTo(k.rotation, o.rotation) < 1e-6, `frame ${k.frame} rotated`)
    assert.deepEqual(
      [k.translation.x, k.translation.y, k.translation.z],
      [o.translation.x, o.translation.y, o.translation.z],
    )
  })
  assert.equal(baked.frameCount, 120)
})

test("a bone the top track does not key falls through to the one below", () => {
  const dance = boneClip("センター", [0, 60, 120], 0.4, 120)
  dance.boneTracks.set("左手首", boneClip("左手首", [0, 60, 120], 0.9, 120).boneTracks.get("左手首")!)
  const face = morphClip("まばたき", [0, 20, 40])

  let project = newProjectWith("dance", dance)
  const added = addClip(project, "face", face)
  project = added.project
  const withTrack = addTrack(project, "Face")
  project = withTrack.project
  // Face on its own track; the bake reads tracks top-down, and the dance's
  // track is index 0, so the face contributes only what the dance does not key.
  project = addPlacement(project, withTrack.trackId, added.clipId, 0).project

  const baked = bakeProject(project)
  assert.ok(baked.morphTracks.has("まばたき"), "the face's morph is missing")
  assert.ok(baked.boneTracks.has("センター"))
  assert.ok(baked.boneTracks.has("左手首"))
})

test("a short clip above owns only the frames it covers", () => {
  const dance = boneClip("左手首", [0, 100, 200], 0.3, 200)
  const wave = boneClip("左手首", [0, 20, 40], 3, 40)

  let project: Project = { name: "p", library: [], tracks: [] }
  const top = addTrack(project, "Hands")
  project = top.project
  const bottom = addTrack(project, "Dance")
  project = bottom.project
  const waveClip = addClip(project, "wave", wave)
  project = waveClip.project
  const danceClip = addClip(project, "dance", dance)
  project = danceClip.project
  project = addPlacement(project, top.trackId, waveClip.clipId, 100).project
  project = addPlacement(project, bottom.trackId, danceClip.clipId, 0).project

  const baked = bakeProject(project)

  // Before the wave, and after it, the dance is in charge.
  assert.ok(poseGap(baked, 50, dance, 50, "左手首") < 0.5, "the dance lost its own frames before the wave")
  assert.ok(poseGap(baked, 180, dance, 180, "左手首") < 0.5, "the dance did not come back after the wave")
  // Inside it, the wave is — and at its own local frames.
  assert.ok(poseGap(baked, 120, wave, 20, "左手首") < 0.5, "the wave is not driving its own span")
  assert.ok(poseGap(baked, 110, wave, 10, "左手首") < 0.5, "the wave is not driving its own span")
})

test("a trimmed placement plays the frames it was trimmed to", () => {
  const source = boneClip("左手首", [0, 25, 50, 75, 100], 1.2, 100)
  let project = newProjectWith("take", source)
  const placementId = project.tracks[0].placements[0].id
  project = trimPlacement(project, placementId, { in: 20, out: 80 })

  const p = project.tracks[0].placements[0]
  assert.equal(p.in, 20)
  assert.equal(p.out, 80)
  assert.equal(p.start, 20, "trimming the head must carry the start with it")

  const baked = bakeProject(project)
  // Arrangement frame f maps to local frame f, since start moved with in.
  for (let f = 21; f < 79; f++) {
    assert.ok(poseGap(baked, f, source, f, "左手首") < 0.6, `frame ${f} does not match the source`)
  }
})

test("splitting a placement leaves the motion alone", () => {
  const source = boneClip("左手首", [0, 40, 80, 120], 0.8, 120)
  const project = newProjectWith("take", source)
  const before = bakeProject(project)
  const after = bakeProject(splitPlacement(project, project.tracks[0].placements[0].id, 55))

  assert.equal(splitPlacement(project, project.tracks[0].placements[0].id, 55).tracks[0].placements.length, 2)
  for (let f = 0; f <= 120; f++) {
    const gap = poseGap(after, f, before, f, "左手首")
    assert.ok(gap < 0.6, `frame ${f} moved by ${gap}° when the placement was split`)
  }
})

test("mute drops a track, and solo drops every track but one", () => {
  const dance = boneClip("センター", [0, 60], 0.4, 60)
  const wave = boneClip("左手首", [0, 30], 2, 30)

  let project = newProjectWith("dance", dance)
  const waveClip = addClip(project, "wave", wave)
  project = waveClip.project
  const t2 = addTrack(project, "Hands")
  project = t2.project
  project = addPlacement(project, t2.trackId, waveClip.clipId, 0).project

  assert.deepEqual([...bakeProject(project).boneTracks.keys()].sort(), ["センター", "左手首"])

  const muted = setTrackMute(project, t2.trackId, true)
  assert.deepEqual([...bakeProject(muted).boneTracks.keys()], ["センター"])

  const soloed = setTrackSolo(project, t2.trackId, true)
  assert.deepEqual([...bakeProject(soloed).boneTracks.keys()], ["左手首"])
})

test("two placements of one clip cannot overlap on a lane", () => {
  const source = boneClip("左手首", [0, 50], 1, 50)
  let project = newProjectWith("take", source)
  const clipId = project.library[0].id
  // Aimed straight at the existing placement; it has to land beside it.
  project = addPlacement(project, project.tracks[0].id, clipId, 10).project

  const [a, b] = [...project.tracks[0].placements].sort((x, y) => x.start - y.start)
  assert.ok(b.start >= a.start + 50, `placements overlap: ${a.start} and ${b.start}`)
})
