"use client"

// What the engine is actually given, once a project can hold more than one clip.
//
// Every path that pushes keyframes into reze-engine goes through here, because
// there are now two right answers and the wrong one is silent: with a single
// clip laid at frame 0 the engine wants that clip, and with anything else it
// wants the bake. Feeding the raw active clip in the second case plays the
// right motion at the wrong frames — the viewport disagrees with the timeline
// and nothing says why.

import { useCallback } from "react"
import type { AnimationClip } from "reze-engine"
import { bakeProject } from "@/lib/bake"
import { projectOf, useStudioSelector } from "@/context/studio-context"
import type { Project } from "@/lib/project"

/**
 * One placement, at the start, untrimmed — the shape a one-VMD session has.
 *
 * Worth testing for rather than always baking: the bake reproduces this case
 * key for key (see lib/__tests__/bake.test.ts), so skipping it costs nothing
 * and saves a full walk of every track on every drag tick, which is where the
 * cost would actually be felt.
 */
export function isSingleClipAtOrigin(project: Project): boolean {
  const placements = project.tracks.flatMap((t) => t.placements)
  if (placements.length !== 1) return false
  const only = placements[0]
  return only.start === 0 && only.in === 0 && only.out == null && !project.tracks.some((t) => t.mute || t.solo)
}

/**
 * The clip to hand `model.loadClip`, for the arrangement as it stands now.
 *
 * `cameraLastFrame` lengthens it where the shot outruns the motion. The engine
 * samples the camera off the MODEL's animation clock, and that clock is clamped
 * to the loaded clip's frameCount — so a camera VMD, which carries no bone or
 * morph frames at all, freezes partway through unless the clip it rides on is
 * at least as long. Applied HERE and not to the document: the clip's length is
 * a fact about the clip, and stretching the real one made a one-second take
 * report the camera's length and fill its whole lane.
 */
export function engineClipFor(
  project: Project,
  activeClip: AnimationClip,
  cameraLastFrame = 0,
): AnimationClip {
  // The ARRANGEMENT is what plays — including when it is empty. Falling back to
  // the active clip whenever nothing was placed seemed harmless while the only
  // way to reach that state was booting, but it also meant deleting the last
  // block left its motion running: the timeline said nothing was there and the
  // model went on dancing.
  if (isSingleClipAtOrigin(project)) {
    return cameraLastFrame > activeClip.frameCount ? { ...activeClip, frameCount: cameraLastFrame } : activeClip
  }
  return bakeProject(project, cameraLastFrame)
}

/**
 * The same decision, as a hook, for the preview paths.
 *
 * A slider or gizmo drag mutates the active clip in place and re-uploads on
 * every tick. Because the library entry and `clip` are the same object, a bake
 * taken here already sees that mutation — there is nothing to flush first.
 */
export function useEngineClip(): (clip: AnimationClip) => AnimationClip {
  const library = useStudioSelector((s) => s.library)
  const tracks = useStudioSelector((s) => s.tracks)
  const clipDisplayName = useStudioSelector((s) => s.clipDisplayName)
  const cameraTrack = useStudioSelector((s) => s.cameraTrack)
  const cameraLastFrame = cameraTrack.length > 0 ? cameraTrack[cameraTrack.length - 1].frame : 0
  return useCallback(
    (clip: AnimationClip) => engineClipFor(projectOf({ library, tracks, clipDisplayName }), clip, cameraLastFrame),
    [library, tracks, clipDisplayName, cameraLastFrame],
  )
}
