// The document, once it holds more than one clip.
//
// A Project is a LIBRARY of clips and a set of TRACKS that arrange them. The
// engine never sees any of this: the studio bakes the arrangement down to one
// flat AnimationClip and hands that to `model.loadClip`, exactly as it did when
// there was only ever one clip. See lib/bake.ts.
//
// Vocabulary, fixed:
//   Clip       a VMD's worth of keyframes, stored once in the library
//   Track      a lane. The first one wins where two of them key the same bone.
//   Placement  a clip laid on a track: which clip, where it starts, and which
//              local range of it plays
//
// "Layer" is not a word here. Tracks are the layering mechanism, and NLE users
// already have a name for a lane.
//
// Every operation below is `(project, ...) -> project` and never mutates its
// input: the store keeps past projects in the undo stack, and structural
// sharing is what keeps that cheap — an arrangement edit re-uses every clip
// object it did not touch.

import type { AnimationClip } from "reze-engine"
import { clipRetainedForModel, DEFAULT_STUDIO_CLIP_FRAMES } from "@/lib/utils"

export type ClipId = string
export type PlacementId = string
export type TrackId = string

export interface LibraryClip {
  id: ClipId
  /** File stem at import. Renamable, never unique-ified — two takes of the
   *  same dance are allowed to share a name; the id is what identifies them. */
  name: string
  clip: AnimationClip
}

export interface Placement {
  id: PlacementId
  clipId: ClipId
  /** Arrangement frame that the clip's `in` frame lands on. */
  start: number
  /** First local frame that plays, inclusive. */
  in: number
  /** Local end, exclusive. Null means "to the end of the clip", so an untrimmed
   *  placement grows when keys are added past its current end — which is what
   *  the one-clip workflow needs to keep behaving like a plain timeline. */
  out: number | null
}

export interface Track {
  id: TrackId
  name: string
  mute: boolean
  solo: boolean
  /** Sorted by `start`, and never overlapping — see `fitStart`. */
  placements: Placement[]
}

export interface Project {
  name: string
  library: LibraryClip[]
  /** Index 0 is the top lane, and the top lane wins. */
  tracks: Track[]
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

// ─── Reading ──────────────────────────────────────────────────────────────

/** A placement's local end — its own `out`, or the clip's full length. */
export function outOf(p: Placement, clip: AnimationClip): number {
  return p.out ?? Math.max(1, clip.frameCount)
}

export function placementLength(p: Placement, clip: AnimationClip): number {
  return Math.max(1, outOf(p, clip) - p.in)
}

/** Arrangement frame one past the placement's last. */
export function placementEnd(p: Placement, clip: AnimationClip): number {
  return p.start + placementLength(p, clip)
}

/** Arrangement frame ↔ clip-local frame. A constant integer, which is why
 *  placements carry trims and not a time scale: every mapping is exact both
 *  ways, with no rounding to disagree about. */
export function offsetOf(p: Placement): number {
  return p.start - p.in
}

export function clipById(project: Project, id: ClipId): LibraryClip | null {
  return project.library.find((c) => c.id === id) ?? null
}

export function findPlacement(
  project: Project,
  id: PlacementId,
): { track: Track; placement: Placement; libraryClip: LibraryClip } | null {
  for (const track of project.tracks) {
    for (const placement of track.placements) {
      if (placement.id !== id) continue
      const libraryClip = clipById(project, placement.clipId)
      if (!libraryClip) return null
      return { track, placement, libraryClip }
    }
  }
  return null
}

export function placementsUsing(project: Project, clipId: ClipId): Placement[] {
  return project.tracks.flatMap((t) => t.placements.filter((p) => p.clipId === clipId))
}

/** Every placement, with the track it sits on — for the bake and the UI. */
export function allPlacements(project: Project): { track: Track; placement: Placement }[] {
  return project.tracks.flatMap((track) => track.placements.map((placement) => ({ track, placement })))
}

/** Where the arrangement ends. Never shorter than a default clip, so an empty
 *  project still has a ruler to work against. */
export function projectEnd(project: Project, cameraLastFrame = 0): number {
  let end = 0
  for (const { placement } of allPlacements(project)) {
    const lib = clipById(project, placement.clipId)
    if (lib) end = Math.max(end, placementEnd(placement, lib.clip))
  }
  return Math.max(end, cameraLastFrame, DEFAULT_STUDIO_CLIP_FRAMES)
}

/** Tracks whose contents actually play: the soloed ones if any are soloed,
 *  otherwise every unmuted one. */
export function activeTracks(project: Project): Track[] {
  const soloed = project.tracks.filter((t) => t.solo)
  return soloed.length > 0 ? soloed : project.tracks.filter((t) => !t.mute)
}

// ─── Writing ──────────────────────────────────────────────────────────────

function withTracks(project: Project, tracks: Track[]): Project {
  return { ...project, tracks }
}

function mapTrack(project: Project, trackId: TrackId, fn: (t: Track) => Track): Project {
  return withTracks(
    project,
    project.tracks.map((t) => (t.id === trackId ? fn(t) : t)),
  )
}

function sortedPlacements(placements: Placement[]): Placement[] {
  return [...placements].sort((a, b) => a.start - b.start)
}

export function emptyTrack(name: string): Track {
  return { id: newId(), name, mute: false, solo: false, placements: [] }
}

/** Lanes an empty project offers. One, because a lane nobody has put anything
 *  on is a row of empty space asking to be explained. */
export const MIN_LANES = 1

/**
 * The lane list, kept to exactly the lanes in use.
 *
 * Nobody adds or deletes a lane here. A timeline that makes you manage its
 * tracks before you can use them is asking about filing, and the question this
 * view exists to answer is what plays over what — so lanes appear as they fill
 * and retire as they empty.
 *
 * No standing spare, either: the place to put a NEW lane appears under the
 * pointer while a clip is being dragged (see the phantom lane in
 * arrange-view.tsx) and becomes real when one lands on it. An empty lane
 * sitting there at rest is a row asking to be explained.
 *
 * Applied on every arrangement commit, so the invariant cannot drift.
 */
export function normalizeLanes(tracks: Track[]): Track[] {
  let lastUsed = -1
  tracks.forEach((t, i) => {
    if (t.placements.length > 0) lastUsed = i
  })
  const wanted = Math.max(MIN_LANES, lastUsed + 1)
  // Trailing empties beyond what is wanted go, but a soloed or muted one stays:
  // those are states someone set, and dropping them would undo that silently.
  const kept = tracks.filter((t, i) => i <= lastUsed || i < wanted || t.mute || t.solo)
  const out = [...kept]
  while (out.length < wanted) out.push(emptyTrack(`Track ${out.length + 1}`))
  return out
}

export function emptyProject(name = "project"): Project {
  return { name, library: [], tracks: [emptyTrack("Track 1")] }
}

/** The one-clip document, as a project: one clip, one track, starting at 0.
 *  This is what a plain "Open VMD" produces, and what the old single-clip
 *  draft migrates into. */
export function newProjectWith(name: string, clip: AnimationClip): Project {
  const libraryClip: LibraryClip = { id: newId(), name, clip }
  const placement: Placement = { id: newId(), clipId: libraryClip.id, start: 0, in: 0, out: null }
  return {
    name,
    library: [libraryClip],
    tracks: [{ ...emptyTrack("Track 1"), placements: [placement] }],
  }
}

// ── Library ──

export function addClip(project: Project, name: string, clip: AnimationClip): { project: Project; clipId: ClipId } {
  const libraryClip: LibraryClip = { id: newId(), name, clip }
  return { project: { ...project, library: [...project.library, libraryClip] }, clipId: libraryClip.id }
}

/** Swap one library clip's keyframes, leaving its identity and every placement
 *  of it alone. This is what a keyframe edit commits through. */
export function replaceClipData(project: Project, clipId: ClipId, clip: AnimationClip): Project {
  return {
    ...project,
    library: project.library.map((c) => (c.id === clipId ? { ...c, clip } : c)),
  }
}

export function renameClip(project: Project, clipId: ClipId, name: string): Project {
  return {
    ...project,
    library: project.library.map((c) => (c.id === clipId ? { ...c, name } : c)),
  }
}

/** Drop a clip and every placement of it — a library row is the clip itself,
 *  so removing it cannot leave lanes pointing at nothing. */
export function removeClip(project: Project, clipId: ClipId): Project {
  return {
    ...project,
    library: project.library.filter((c) => c.id !== clipId),
    tracks: project.tracks.map((t) => ({
      ...t,
      placements: t.placements.filter((p) => p.clipId !== clipId),
    })),
  }
}

export function duplicateClip(
  project: Project,
  clipId: ClipId,
  cloneClip: (c: AnimationClip) => AnimationClip,
): { project: Project; clipId: ClipId } {
  const source = clipById(project, clipId)
  if (!source) return { project, clipId }
  return addClip(project, `${source.name} copy`, cloneClip(source.clip))
}

// ── Tracks ──

export function addTrack(project: Project, name?: string): { project: Project; trackId: TrackId } {
  const track = emptyTrack(name ?? `Track ${project.tracks.length + 1}`)
  return { project: withTracks(project, [...project.tracks, track]), trackId: track.id }
}

export function removeTrack(project: Project, trackId: TrackId): Project {
  const tracks = project.tracks.filter((t) => t.id !== trackId)
  // A project always has somewhere to put a clip.
  return withTracks(project, tracks.length > 0 ? tracks : [emptyTrack("Track 1")])
}

export function renameTrack(project: Project, trackId: TrackId, name: string): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, name }))
}

export function setTrackMute(project: Project, trackId: TrackId, mute: boolean): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, mute }))
}

export function setTrackSolo(project: Project, trackId: TrackId, solo: boolean): Project {
  return mapTrack(project, trackId, (t) => ({ ...t, solo }))
}

/** Move a track up or down the priority order. Index 0 wins, so "up" is
 *  toward the front of the array. */
export function moveTrack(project: Project, trackId: TrackId, direction: -1 | 1): Project {
  const i = project.tracks.findIndex((t) => t.id === trackId)
  const j = i + direction
  if (i < 0 || j < 0 || j >= project.tracks.length) return project
  const tracks = [...project.tracks]
  ;[tracks[i], tracks[j]] = [tracks[j], tracks[i]]
  return withTracks(project, tracks)
}

// ── Placements ──

/**
 * The nearest start `length` frames can occupy on `track` without overlapping.
 *
 * Two clips on one lane at one frame have no defined answer — which of them
 * owns a bone is a question the arrangement cannot answer, and layering is
 * what the other tracks are for. So a drag lands beside the neighbour it ran
 * into, on whichever side is closer to where it was aimed, rather than being
 * refused: a placement that snaps to the gap reads as the lane being full,
 * where one that springs back reads as the drag having failed.
 *
 * Returns null when nothing on the lane fits.
 */
export function fitStart(
  project: Project,
  track: Track,
  wanted: number,
  length: number,
  ignoreId?: PlacementId,
): number | null {
  const others = sortedPlacements(track.placements.filter((p) => p.id !== ignoreId))
    .map((p) => {
      const lib = clipById(project, p.clipId)
      return lib ? { start: p.start, end: placementEnd(p, lib.clip) } : null
    })
    .filter((x): x is { start: number; end: number } => x !== null)

  const want = Math.max(0, Math.round(wanted))
  const clashes = (start: number) => others.some((o) => start < o.end && start + length > o.start)
  if (!clashes(want)) return want

  // Every gap between neighbours, plus the ones at either end.
  const candidates: number[] = [0]
  for (const o of others) {
    candidates.push(o.end)
    candidates.push(o.start - length)
  }
  const fits = candidates
    .map((c) => Math.max(0, Math.round(c)))
    .filter((c) => !clashes(c))
    .sort((a, b) => Math.abs(a - want) - Math.abs(b - want))
  return fits.length > 0 ? fits[0] : null
}

export function addPlacement(
  project: Project,
  trackId: TrackId,
  clipId: ClipId,
  start: number,
): { project: Project; placementId: PlacementId | null } {
  const track = project.tracks.find((t) => t.id === trackId)
  const lib = clipById(project, clipId)
  if (!track || !lib) return { project, placementId: null }
  const length = Math.max(1, lib.clip.frameCount)
  const at = fitStart(project, track, start, length)
  if (at == null) return { project, placementId: null }
  const placement: Placement = { id: newId(), clipId, start: at, in: 0, out: null }
  return {
    project: mapTrack(project, trackId, (t) => ({ ...t, placements: sortedPlacements([...t.placements, placement]) })),
    placementId: placement.id,
  }
}

/** Move a placement in time, and optionally to another track. The clamp is
 *  always measured against the TARGET lane's neighbours, never the one it
 *  came from. */
export function movePlacement(
  project: Project,
  placementId: PlacementId,
  start: number,
  toTrackId?: TrackId,
): Project {
  const found = findPlacement(project, placementId)
  if (!found) return project
  const targetId = toTrackId ?? found.track.id
  const target = project.tracks.find((t) => t.id === targetId)
  if (!target) return project
  const length = placementLength(found.placement, found.libraryClip.clip)
  const at = fitStart(project, target, start, length, placementId)
  if (at == null) return project
  const moved: Placement = { ...found.placement, start: at }
  return withTracks(
    project,
    project.tracks.map((t) => {
      if (t.id === found.track.id && t.id === targetId) {
        return { ...t, placements: sortedPlacements(t.placements.map((p) => (p.id === placementId ? moved : p))) }
      }
      if (t.id === found.track.id) return { ...t, placements: t.placements.filter((p) => p.id !== placementId) }
      if (t.id === targetId) return { ...t, placements: sortedPlacements([...t.placements, moved]) }
      return t
    }),
  )
}

/**
 * Trim a placement's visible range.
 *
 * `in` and `out` are LOCAL frames, so trimming the head moves `start` with it —
 * otherwise the frames that stay would slide backwards under the playhead, and
 * a trim would be a retime.
 */
export function trimPlacement(
  project: Project,
  placementId: PlacementId,
  edges: { in?: number; out?: number },
): Project {
  const found = findPlacement(project, placementId)
  if (!found) return project
  const { placement, libraryClip } = found
  const full = Math.max(1, libraryClip.clip.frameCount)
  const currentOut = outOf(placement, libraryClip.clip)
  const nextIn = Math.max(0, Math.min(Math.round(edges.in ?? placement.in), currentOut - 1))
  const wantedOut = edges.out != null ? Math.round(edges.out) : currentOut
  const nextOut = Math.max(nextIn + 1, Math.min(wantedOut, full))
  const start = placement.start + (nextIn - placement.in)
  const trimmed: Placement = {
    ...placement,
    in: nextIn,
    // Only a head trim keeps "to the end of the clip" meaningful — once the
    // tail has been cut, the length is a decision rather than a consequence.
    out: edges.out != null || placement.out != null ? nextOut : null,
    start: Math.max(0, start),
  }
  return mapTrack(project, found.track.id, (t) => ({
    ...t,
    placements: sortedPlacements(t.placements.map((p) => (p.id === placementId ? trimmed : p))),
  }))
}

/**
 * Cut a placement in two at an arrangement frame.
 *
 * Both halves keep pointing at the SAME library clip, with disjoint local
 * ranges — so editing a key in one half cannot reach the other, and the clip
 * is still one clip. Splitting is a statement about the arrangement, not about
 * the material.
 */
export function splitPlacement(project: Project, placementId: PlacementId, atFrame: number): Project {
  const found = findPlacement(project, placementId)
  if (!found) return project
  const { placement, libraryClip } = found
  const at = Math.round(atFrame)
  const end = placementEnd(placement, libraryClip.clip)
  if (at <= placement.start || at >= end) return project
  const localCut = at - offsetOf(placement)
  const outAbs = outOf(placement, libraryClip.clip)
  const head: Placement = { ...placement, out: localCut }
  const tail: Placement = { id: newId(), clipId: placement.clipId, start: at, in: localCut, out: outAbs }
  return mapTrack(project, found.track.id, (t) => ({
    ...t,
    placements: sortedPlacements([...t.placements.filter((p) => p.id !== placementId), head, tail]),
  }))
}

export function removePlacements(project: Project, ids: readonly PlacementId[]): Project {
  const drop = new Set(ids)
  return withTracks(
    project,
    project.tracks.map((t) => ({ ...t, placements: t.placements.filter((p) => !drop.has(p.id)) })),
  )
}

export function duplicatePlacement(
  project: Project,
  placementId: PlacementId,
): { project: Project; placementId: PlacementId | null } {
  const found = findPlacement(project, placementId)
  if (!found) return { project, placementId: null }
  const length = placementLength(found.placement, found.libraryClip.clip)
  const at = fitStart(project, found.track, placementEnd(found.placement, found.libraryClip.clip), length)
  if (at == null) return { project, placementId: null }
  const copy: Placement = { ...found.placement, id: newId(), start: at }
  return {
    project: mapTrack(project, found.track.id, (t) => ({ ...t, placements: sortedPlacements([...t.placements, copy]) })),
    placementId: copy.id,
  }
}

/** Give one placement its own copy of the clip, so editing it stops changing
 *  every other placement of the same material. */
export function makeUnique(
  project: Project,
  placementId: PlacementId,
  cloneClip: (c: AnimationClip) => AnimationClip,
): Project {
  const found = findPlacement(project, placementId)
  if (!found) return project
  if (placementsUsing(project, found.placement.clipId).length <= 1) return project
  const { project: withCopy, clipId } = addClip(
    project,
    `${found.libraryClip.name} copy`,
    cloneClip(found.libraryClip.clip),
  )
  return mapTrack(withCopy, found.track.id, (t) => ({
    ...t,
    placements: t.placements.map((p) => (p.id === placementId ? { ...p, clipId } : p)),
  }))
}

/** Drop tracks the loaded model does not have, across the whole library — the
 *  same filter a single clip goes through on a PMX swap. */
export function retainForModel(
  project: Project,
  boneNames: ReadonlySet<string>,
  morphNames: ReadonlySet<string>,
): Project {
  return {
    ...project,
    library: project.library.map((c) => ({ ...c, clip: clipRetainedForModel(c.clip, boneNames, morphNames) })),
  }
}
