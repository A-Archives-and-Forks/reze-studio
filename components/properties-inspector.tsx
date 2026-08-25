"use client"

import type { RefObject } from "react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AnimationClip, BoneInterpolation, BoneKeyframe, CameraKeyframe, Model } from "reze-engine"
import { CameraAnimation, Quat, Vec3 } from "reze-engine"
import { Button } from "@/components/ui/button"
import {
  boneTitleSubtitle,
  eulerToQuat,
  quatToEuler,
  ROT_CHANNELS,
  TRA_CHANNELS,
  CAMERA_CHANNELS,
  CAMERA_IP_TABS,
  cameraChannelsForTab,
  cameraIpChannelForTab,
  cameraIpPair,
} from "@/lib/animation"
import { AxisSliderRow } from "@/components/axis-slider-row"
import { InterpolationCurveEditor, PRESETS, type CurvePoint } from "@/components/interpolation-curve-editor"
import {
  cloneBoneInterpolation,
  cn,
  interpolationTemplateForFrame,
  readLocalPoseAfterSeek,
  VMD_LINEAR_DEFAULT_IP,
} from "@/lib/utils"
import { useStudioActions, useStudioSelector } from "@/context/studio-context"
import { usePlaybackFrameRef, usePlaybackSelector } from "@/context/playback-context"

/** Must match `loadClip` name in app/page (engine clip vs React state). */
const STUDIO_ANIM_NAME = "studio"

/** Curve tabs that show rotation channels — keys must match `components/timeline.tsx` TABS. */
const ROT_TAB_KEYS = new Set<string>(["allRot", "rx", "ry", "rz"])
const TRA_TAB_KEYS = new Set<string>(["allTra", "tx", "ty", "tz"])
const ROT_AXIS_KEYS = ["rx", "ry", "rz"] as const
const TRA_AXIS_KEYS = ["tx", "ty", "tz"] as const

/** Off rotation group → All Rot; on RY/RZ but dragging X → RX (same for translation / All Trans). */
function syncTimelineTabForRotationDrag(
  currentTab: string,
  axisIdx: 0 | 1 | 2,
  setTimelineTab: (t: string) => void,
) {
  if (!ROT_TAB_KEYS.has(currentTab)) {
    setTimelineTab("allRot")
    return
  }
  if (currentTab === "allRot") return
  const want = ROT_AXIS_KEYS[axisIdx]
  if (currentTab !== want) setTimelineTab(want)
}

function syncTimelineTabForTranslationDrag(
  currentTab: string,
  axisIdx: 0 | 1 | 2,
  setTimelineTab: (t: string) => void,
) {
  if (!TRA_TAB_KEYS.has(currentTab)) {
    setTimelineTab("allTra")
    return
  }
  if (currentTab === "allTra") return
  const want = TRA_AXIS_KEYS[axisIdx]
  if (currentTab !== want) setTimelineTab(want)
}

function syncTimelineTabForMorphDrag(currentTab: string, setTimelineTab: (t: string) => void) {
  if (currentTab !== "morph") setTimelineTab("morph")
}

function sampleBoneKeyframe(clip: AnimationClip | null, boneName: string, frame: number) {
  if (!clip) return null
  const track = clip.boneTracks.get(boneName)
  if (!track?.length) return null
  const f = Math.round(frame)
  let kf = track[0]
  for (const k of track) {
    if (k.frame <= f) kf = k
    else break
  }
  return kf
}

function findKeyframeAt(clip: AnimationClip, bone: string, frame: number): BoneKeyframe | null {
  return clip.boneTracks.get(bone)?.find((k) => k.frame === frame) ?? null
}

type IpTab = "rot" | "tx" | "ty" | "tz"

const BONE_IP_TABS = [
  { key: "rot", label: "Rotation" },
  { key: "tx", label: "Trans X" },
  { key: "ty", label: "Trans Y" },
  { key: "tz", label: "Trans Z" },
] as const

function interpolationPairFromTab(kf: BoneKeyframe, tab: IpTab): [CurvePoint, CurvePoint] | null {
  let row: { x: number; y: number }[] | undefined
  if (tab === "rot") row = kf.interpolation.rotation
  else if (tab === "tx") row = kf.interpolation.translationX
  else if (tab === "ty") row = kf.interpolation.translationY
  else row = kf.interpolation.translationZ
  if (!row || row.length < 2) return null
  return [{ x: row[0].x, y: row[0].y }, { x: row[1].x, y: row[1].y }]
}

function mergeInterpolation(kf: BoneKeyframe, tab: IpTab, p1: CurvePoint, p2: CurvePoint): BoneInterpolation {
  const ip = cloneBoneInterpolation(kf.interpolation)
  const pair = [
    { x: p1.x, y: p1.y },
    { x: p2.x, y: p2.y },
  ]
  if (tab === "rot") ip.rotation = pair
  else if (tab === "tx") ip.translationX = pair
  else if (tab === "ty") ip.translationY = pair
  else ip.translationZ = pair
  return ip
}

/** Mutate the keyframe in the shared track (engine clip shares this array) then shallow-copy clip for React. */
function patchKeyframeAt(
  clip: AnimationClip,
  bone: string,
  keyFrame: number,
  patch: (kf: BoneKeyframe) => void,
): AnimationClip {
  const track = clip.boneTracks.get(bone)
  if (!track) return clip
  const i = track.findIndex((k) => k.frame === keyFrame)
  if (i < 0) return clip
  patch(track[i])
  return { ...clip, boneTracks: new Map(clip.boneTracks) }
}

function interpolationTemplateForChannel(tab: IpTab): [CurvePoint, CurvePoint] {
  const ip = VMD_LINEAR_DEFAULT_IP
  if (tab === "rot") return [{ x: ip.rotation[0].x, y: ip.rotation[0].y }, { x: ip.rotation[1].x, y: ip.rotation[1].y }]
  if (tab === "tx")
    return [{ x: ip.translationX[0].x, y: ip.translationX[0].y }, { x: ip.translationX[1].x, y: ip.translationX[1].y }]
  if (tab === "ty")
    return [{ x: ip.translationY[0].x, y: ip.translationY[0].y }, { x: ip.translationY[1].x, y: ip.translationY[1].y }]
  return [{ x: ip.translationZ[0].x, y: ip.translationZ[0].y }, { x: ip.translationZ[1].x, y: ip.translationZ[1].y }]
}

type LivePose = {
  euler: { x: number; y: number; z: number }
  translation: Vec3
}

function poseNearEqual(a: LivePose, b: LivePose, eps = 1e-5) {
  return (
    Math.abs(a.euler.x - b.euler.x) < eps &&
    Math.abs(a.euler.y - b.euler.y) < eps &&
    Math.abs(a.euler.z - b.euler.z) < eps &&
    Math.abs(a.translation.x - b.translation.x) < eps &&
    Math.abs(a.translation.y - b.translation.y) < eps &&
    Math.abs(a.translation.z - b.translation.z) < eps
  )
}

/** Samples the selected bone's pose and keeps it live:
 *  - Paused: re-samples whenever currentFrame / clip / bone changes.
 *  - Playing: rAF loop that reads straight from the engine (which owns the
 *    clock). Scoped to the subcomponent that uses it so the rest of the
 *    inspector does not reconcile at 60Hz. */
function useLivePose(
  modelRef: RefObject<Model | null>,
  selectedBone: string | null,
  clip: AnimationClip | null,
): LivePose | null {
  const playing = usePlaybackSelector((s) => s.playing)
  const currentFrame = usePlaybackSelector((s) => s.currentFrame)
  const playbackFrameRef = usePlaybackFrameRef()
  const [livePose, setLivePose] = useState<LivePose | null>(null)

  const sample = useCallback((): LivePose | null => {
    const model = modelRef.current
    if (!model || !selectedBone || !clip) return null
    const cf = playbackFrameRef.current
    // Paused: React owns the clock, so seek the engine first. Playing: engine
    // owns the clock and the rAF loop in <EngineBridge/> has already written
    // the live frame into playbackFrameRef — do NOT seek (would fight play).
    if (!playing) model.seek(Math.max(0, cf) / 30)
    const p = readLocalPoseAfterSeek(model, selectedBone)
    if (!p) return null
    // When paused at an integer frame, prefer the stored keyframe value: the
    // runtime skeleton returns the post-IK pose, so bones under an IK chain
    // would otherwise display a different value than what's in the keyframe.
    // During playback we skip the snap — fractional frames rarely land on a
    // keyframe, and the engine pose is already the interpolated truth.
    if (!playing) {
      const frameInt = Math.round(Math.max(0, cf))
      const kfAt = clip.boneTracks.get(selectedBone)?.find((k) => k.frame === frameInt)
      if (kfAt) return { euler: quatToEuler(kfAt.rotation), translation: kfAt.translation }
    }
    return { euler: quatToEuler(p.rotation), translation: p.translation }
  }, [modelRef, selectedBone, clip, playing, playbackFrameRef])

  const apply = useCallback((next: LivePose | null) => {
    setLivePose((prev) => {
      if (prev === next) return prev
      if (prev && next && poseNearEqual(prev, next)) return prev
      return next
    })
  }, [])

  // Paused path: resample on scrub / selection / clip edit.
  useEffect(() => {
    apply(sample())
  }, [sample, currentFrame, apply])

  // Playing path: rAF loop.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      apply(sample())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, sample, apply])

  return livePose
}

/** Returns the keyframe currently under the playhead (last key with frame ≤ f)
 *  for the selected bone, live during playback. Mirrors useLivePose's split:
 *  - Paused: resamples on `currentFrame` change.
 *  - Playing: rAF loop reads straight from `playbackFrameRef`.
 *
 *  State updates are gated on keyframe *identity change* — within a single
 *  segment the sampled keyframe is reference-stable, so we skip the setState
 *  and avoid reconciling the section every rAF tick. The identity only flips
 *  when the playhead crosses a keyframe boundary, which is what the
 *  interpolation editor actually needs to redraw on. */
function useLiveActiveKeyframe(
  clip: AnimationClip | null,
  selectedBone: string | null,
): BoneKeyframe | null {
  const playing = usePlaybackSelector((s) => s.playing)
  const currentFrame = usePlaybackSelector((s) => s.currentFrame)
  const playbackFrameRef = usePlaybackFrameRef()
  const [kf, setKf] = useState<BoneKeyframe | null>(null)

  const sample = useCallback((): BoneKeyframe | null => {
    if (!clip || !selectedBone) return null
    return sampleBoneKeyframe(clip, selectedBone, playbackFrameRef.current)
  }, [clip, selectedBone, playbackFrameRef])

  const apply = useCallback((next: BoneKeyframe | null) => {
    setKf((prev) => (prev === next ? prev : next))
  }, [])

  // Paused path: resample on scrub / selection / clip edit.
  useEffect(() => {
    apply(sample())
  }, [sample, currentFrame, apply])

  // Playing path: rAF loop; no-op when the active key hasn't changed.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      apply(sample())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, sample, apply])

  return kf
}

/** Reads the selected morph's current weight live. Same playing/paused split
 *  as useLivePose so the morph slider tracks the playhead during playback. */
function useLiveMorphWeight(
  modelRef: RefObject<Model | null>,
  selectedMorph: string | null,
  clip: AnimationClip | null,
): number | null {
  const playing = usePlaybackSelector((s) => s.playing)
  const currentFrame = usePlaybackSelector((s) => s.currentFrame)
  const [weight, setWeight] = useState<number | null>(null)

  // `clip` is in the deps for a reason that is easy to miss: without it a
  // commit never re-samples, so this kept handing back the PRE-EDIT weight.
  // AxisSliderRow follows its `value` prop again the moment the drag ends, so
  // the thumb snapped back to the old number while the timeline showed the new
  // one. useLivePose (bones) has always taken `clip`; this was the odd one out.
  const sample = useCallback((): number | null => {
    const model = modelRef.current
    if (!model || !selectedMorph) return null
    // Paused on a keyed frame, the stored weight is the truth — the engine's
    // live value is whatever the last seek left, which can lag a commit by a
    // frame. Same reasoning as useLivePose's keyframe snap.
    if (!playing) {
      const f = Math.round(Math.max(0, currentFrame))
      const kfAt = clip?.morphTracks.get(selectedMorph)?.find((k) => k.frame === f)
      if (kfAt) return kfAt.weight
    }
    const morphing = model.getMorphing()
    const idx = morphing.morphs.findIndex((m) => m.name === selectedMorph)
    if (idx < 0) return null
    return model.getMorphWeights()[idx] ?? null
  }, [modelRef, selectedMorph, clip, playing, currentFrame])

  const apply = useCallback((next: number | null) => {
    setWeight((prev) => (prev === next ? prev : next))
  }, [])

  useEffect(() => {
    apply(sample())
  }, [sample, currentFrame, apply])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      apply(sample())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, sample, apply])

  return weight
}

interface PropertiesInspectorProps {
  modelRef: RefObject<Model | null>
  onInsertKeyframeAtPlayhead: () => void
  onDeleteSelectedKeyframes: () => void
  onSimplifySelectedBoneTrack: () => void
  onClearSelectedTrack: () => void
  onClearCameraTrack: () => void
  timelineTab: string
  setTimelineTab: (tab: string) => void
  clipVersion: number
}

export const PropertiesInspector = memo(function PropertiesInspector({
  modelRef,
  onInsertKeyframeAtPlayhead,
  onDeleteSelectedKeyframes,
  onSimplifySelectedBoneTrack,
  onClearSelectedTrack,
  onClearCameraTrack,
  timelineTab,
  setTimelineTab,
  clipVersion,
}: PropertiesInspectorProps) {
  const clip = useStudioSelector((s) => s.clip)
  const selectedBone = useStudioSelector((s) => s.selectedBone)
  const selectedMorph = useStudioSelector((s) => s.selectedMorph)
  const selectedKeyframes = useStudioSelector((s) => s.selectedKeyframes)
  const cameraTrack = useStudioSelector((s) => s.cameraTrack)
  const cameraSelected = useStudioSelector((s) => s.cameraSelected)
  const gizmoVisible = useStudioSelector((s) => s.gizmoVisible)
  const { commit, commitCamera, setGizmoVisible } = useStudioActions()
  /** Read-only ref to the playhead. Subscribing here would re-render Properties
   *  every rAF tick during playback; instead we read .current inside callbacks
   *  and let the small <PlayheadFrameLabel/> + <InterpolationSection/> children
   *  subscribe for the handful of visible bits that actually need to update. */
  const playbackFrameRef = usePlaybackFrameRef()
  const singleSel = selectedKeyframes.length === 1 ? selectedKeyframes[0] : null
  const multiSel = selectedKeyframes.length > 1

  const canDelete = clip && singleSel !== null
  const canInsert = !!(clip && (selectedBone || selectedMorph))
  const boneTrackLen = selectedBone && clip ? (clip.boneTracks.get(selectedBone)?.length ?? 0) : 0
  const morphTrackLen = selectedMorph && clip ? (clip.morphTracks.get(selectedMorph)?.length ?? 0) : 0
  const canSimplify = !!(clip && selectedBone && boneTrackLen > 2)
  const canClear = !!(clip && ((selectedBone && boneTrackLen > 0) || (selectedMorph && morphTrackLen > 0)))

  const showBoneStats = !!(selectedBone && clip && !selectedMorph && !multiSel)

  const ROT_RANGE = { min: -180, max: 180 }
  const TRA_RANGE = { min: -10, max: 10 }

  // ─── Slider preview / commit split ──────────────────────────────────
  //     `*Preview` fires every drag tick: mutates the clip's keyframe in
  //     place (the engine shares the same track arrays), reloads + seeks so
  //     the 3D viewport reflects the new pose, and skips `commit()` so we
  //     don't re-render Timeline / Properties / invalidate caches per frame.
  //     `*Commit` fires once on pointer-up: commits a new clip reference,
  //     which cascades through the studio store, landing the change in
  //     undo/redo and causing EngineBridge to reupload the clip once.
  //     A ref tracks whether the current drag has actually touched the clip
  //     so the commit is a no-op when a user just clicks the thumb.
  const dragDirtyRef = useRef(false)

  const applyRotationAxis = useCallback(
    (axisIdx: 0 | 1 | 2, v: number, mode: "preview" | "commit") => {
      const model = modelRef.current
      if (!selectedBone || !clip || !model) return
      const cf = playbackFrameRef.current
      const frame = Math.round(Math.max(0, Math.min(clip.frameCount, cf)))
      const atKey = findKeyframeAt(clip, selectedBone, frame)
      let q: Quat
      if (atKey) {
        const e = quatToEuler(atKey.rotation)
        const next = axisIdx === 0 ? { ...e, x: v } : axisIdx === 1 ? { ...e, y: v } : { ...e, z: v }
        q = eulerToQuat(next.x, next.y, next.z)
        // Mutate in place — engine's clip shares the same keyframe objects.
        atKey.rotation = q
      } else {
        // Need pose to create the new keyframe — seek first.
        model.loadClip(STUDIO_ANIM_NAME, clip)
        model.seek(Math.max(0, cf) / 30)
        const pose = readLocalPoseAfterSeek(model, selectedBone)
        if (!pose) return
        const e = quatToEuler(pose.rotation)
        const next = axisIdx === 0 ? { ...e, x: v } : axisIdx === 1 ? { ...e, y: v } : { ...e, z: v }
        q = eulerToQuat(next.x, next.y, next.z)
        // Insert by mutating the track array in place.
        const track = clip.boneTracks.get(selectedBone) ?? []
        if (!clip.boneTracks.has(selectedBone)) clip.boneTracks.set(selectedBone, track)
        track.push({
          boneName: selectedBone,
          frame,
          rotation: q,
          translation: pose.translation,
          interpolation: interpolationTemplateForFrame(track, frame),
        })
        track.sort((a, b) => a.frame - b.frame)
      }
      // Push to engine for viewport update.
      model.loadClip(STUDIO_ANIM_NAME, clip)
      model.seek(Math.max(0, cf) / 30)
      if (mode === "preview") {
        dragDirtyRef.current = true
      } else {
        // Clone for React notification + undo/redo snapshot.
        commit({ ...clip, boneTracks: new Map(clip.boneTracks) })
        dragDirtyRef.current = false
      }
    },
    [selectedBone, clip, commit, playbackFrameRef, modelRef],
  )

  const applyTranslationAxis = useCallback(
    (axisIdx: 0 | 1 | 2, v: number, mode: "preview" | "commit") => {
      const model = modelRef.current
      if (!selectedBone || !clip || !model) return
      const cf = playbackFrameRef.current
      const frame = Math.round(Math.max(0, Math.min(clip.frameCount, cf)))
      const atKey = findKeyframeAt(clip, selectedBone, frame)
      if (atKey) {
        const t = atKey.translation
        atKey.translation =
          axisIdx === 0 ? new Vec3(v, t.y, t.z) : axisIdx === 1 ? new Vec3(t.x, v, t.z) : new Vec3(t.x, t.y, v)
      } else {
        model.loadClip(STUDIO_ANIM_NAME, clip)
        model.seek(Math.max(0, cf) / 30)
        const pose = readLocalPoseAfterSeek(model, selectedBone)
        if (!pose) return
        const t = pose.translation
        const nextT =
          axisIdx === 0 ? new Vec3(v, t.y, t.z) : axisIdx === 1 ? new Vec3(t.x, v, t.z) : new Vec3(t.x, t.y, v)
        const track = clip.boneTracks.get(selectedBone) ?? []
        if (!clip.boneTracks.has(selectedBone)) clip.boneTracks.set(selectedBone, track)
        track.push({
          boneName: selectedBone,
          frame,
          rotation: pose.rotation,
          translation: nextT,
          interpolation: interpolationTemplateForFrame(track, frame),
        })
        track.sort((a, b) => a.frame - b.frame)
      }
      model.loadClip(STUDIO_ANIM_NAME, clip)
      model.seek(Math.max(0, cf) / 30)
      if (mode === "preview") {
        dragDirtyRef.current = true
      } else {
        commit({ ...clip, boneTracks: new Map(clip.boneTracks) })
        dragDirtyRef.current = false
      }
    },
    [selectedBone, clip, commit, playbackFrameRef, modelRef],
  )

  const applyMorphWeight = useCallback(
    (w: number, mode: "preview" | "commit") => {
      if (!selectedMorph || !clip) return
      const frame = Math.round(Math.max(0, Math.min(clip.frameCount, playbackFrameRef.current)))
      // Installing a MISSING track has to go through commit, not through the
      // live clip's Map. Adding it here mutated the object the store is holding
      // while `mode === "preview"` deliberately does not commit, so `clip` and
      // `clipSnapshot` drifted apart — and the next commit then pushed a
      // snapshot that predated edits already applied, which is undo silently
      // losing a morph. Adding one expression and then editing another is
      // exactly the sequence that reaches it.
      //
      // Weight edits to an EXISTING keyframe stay in place: that is what makes
      // slider preview cheap, and the track already belongs to the clip.
      let track = clip.morphTracks.get(selectedMorph)
      if (!track) {
        track = [{ morphName: selectedMorph, frame, weight: w }]
        const morphTracks = new Map(clip.morphTracks)
        morphTracks.set(selectedMorph, track)
        commit({ ...clip, morphTracks })
      } else {
        const existing = track.find((k) => k.frame === frame)
        if (existing) {
          existing.weight = w
        } else {
          track.push({ morphName: selectedMorph, frame, weight: w })
          track.sort((a, b) => a.frame - b.frame)
        }
      }
      const model = modelRef.current
      if (model) {
        model.loadClip(STUDIO_ANIM_NAME, clip)
        model.seek(Math.max(0, playbackFrameRef.current) / 30)
      }
      syncTimelineTabForMorphDrag(timelineTab, setTimelineTab)
      if (mode === "preview") {
        dragDirtyRef.current = true
      } else {
        commit({ ...clip, morphTracks: new Map(clip.morphTracks) })
        dragDirtyRef.current = false
      }
    },
    [selectedMorph, clip, commit, timelineTab, setTimelineTab, playbackFrameRef, modelRef],
  )

  // The camera owns the whole pane when selected — it is not a bone with extra
  // fields, and showing bone operations beside it would offer edits that do not
  // apply to it.
  if (cameraSelected) {
    return (
      <div className="space-y-0 text-[11px] leading-relaxed text-inherit">
        <CameraSection
          cameraTrack={cameraTrack}
          commitCamera={commitCamera}
          timelineTab={timelineTab}
          setTimelineTab={setTimelineTab}
          onClearCameraTrack={onClearCameraTrack}
        />
      </div>
    )
  }

  return (
    <div className="space-y-0 text-[11px] leading-relaxed text-inherit">

      {/* ─── Bone: sliders always; clip write updates key at playhead or inserts one ─── */}
      {showBoneStats && selectedBone ? (
        <section className="border-b border-border pb-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              {(() => {
                const { title, subtitle } = boneTitleSubtitle(selectedBone)
                return (
                  <>
                    <div className="text-xs font-semibold text-inherit">{title}</div>
                    {subtitle ? <div className="text-[10px] text-muted-foreground">{subtitle}</div> : null}
                  </>
                )
              })()}
            </div>
            <PlayheadFrameLabel frameCount={clip?.frameCount ?? null} />
          </div>

          <LiveBoneSliders
            modelRef={modelRef}
            selectedBone={selectedBone}
            clip={clip}
            timelineTab={timelineTab}
            setTimelineTab={setTimelineTab}
            applyRotationAxis={applyRotationAxis}
            applyTranslationAxis={applyTranslationAxis}
            rotRange={ROT_RANGE}
            traRange={TRA_RANGE}
          />

          <InterpolationSection
            clip={clip}
            selectedBone={selectedBone}
            commit={commit}
            clipVersion={clipVersion}
          />
        </section>
      ) : null}

      {selectedMorph && clip && !multiSel ? (
        <section className="border-b border-border pb-3">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-inherit">{selectedMorph}</div>
            </div>
            <PlayheadFrameLabel frameCount={clip?.frameCount ?? null} />
          </div>
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Weight</div>
          <LiveMorphSlider
            modelRef={modelRef}
            selectedMorph={selectedMorph}
            clip={clip}
            disabled={!clip}
            applyMorphWeight={applyMorphWeight}
          />
        </section>
      ) : null}

      <section className="space-y-2 pt-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Operations</div>
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">Key</span>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled={!canInsert}
              onClick={onInsertKeyframeAtPlayhead}
            >
              Insert
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled={!canDelete}
              onClick={onDeleteSelectedKeyframes}
            >
              Delete
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">Track</span>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled={!canSimplify}
              onClick={onSimplifySelectedBoneTrack}
              title="Reduce redundant keyframes on the selected bone track"
            >
              Simplify
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled={!canClear}
              onClick={onClearSelectedTrack}
              title="Remove all keyframes on the selected bone or morph track"
            >
              Clear
            </Button>
          </div>
          {/* The gizmo is off until asked for — it stands between the camera and
              the model, and reading a bone's curves is not a reason to put
              arrows over the character's face.

              Pressed-state colouring, the same on/off language the camera-track
              button over the viewport speaks, and the label names the STATE
              rather than the action: a "Hide" that becomes "Show" reads as a
              command and leaves you guessing which word describes right now. */}
          <div className="flex items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">Gizmo</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={gizmoVisible}
              disabled={!selectedBone}
              onClick={() => setGizmoVisible((v) => !v)}
              title={
                gizmoVisible
                  ? "Hide the transform gizmo (or dblclick empty space in the viewport)"
                  : "Show the transform gizmo on the selected bone (or dblclick the bone in the viewport)"
              }
              className={cn(
                "h-6 flex-1 border px-0.5 text-[11px]",
                gizmoVisible
                  ? "border-blue-400/30 bg-blue-400/[0.12] text-blue-400 hover:bg-blue-400/20 hover:text-blue-400"
                  : "border-line-strong bg-surface-raised text-muted-foreground hover:text-foreground",
              )}
            >
              {gizmoVisible ? "Visible" : "Hidden"}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
})

/** Rotation + translation sliders for the selected bone. Isolated from the
 *  parent inspector so its internal useLivePose hook (which rAFs during
 *  playback and subscribes to currentFrame while paused) only reconciles
 *  this subtree — the sliders themselves — not the rest of the inspector. */
function LiveBoneSliders({
  modelRef,
  selectedBone,
  clip,
  timelineTab,
  setTimelineTab,
  applyRotationAxis,
  applyTranslationAxis,
  rotRange,
  traRange,
}: {
  modelRef: RefObject<Model | null>
  selectedBone: string | null
  clip: AnimationClip | null
  timelineTab: string
  setTimelineTab: (t: string) => void
  applyRotationAxis: (axisIdx: 0 | 1 | 2, v: number, mode: "preview" | "commit") => void
  applyTranslationAxis: (axisIdx: 0 | 1 | 2, v: number, mode: "preview" | "commit") => void
  rotRange: { min: number; max: number }
  traRange: { min: number; max: number }
}) {
  const livePose = useLivePose(modelRef, selectedBone, clip)
  return (
    <>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Rotation (°)</div>
      {livePose ? (
        ROT_CHANNELS.map((ch, i) => (
          <AxisSliderRow
            key={ch.key}
            axis={["X", "Y", "Z"][i] as string}
            color={ch.color}
            value={[livePose.euler.x, livePose.euler.y, livePose.euler.z][i]}
            min={rotRange.min}
            max={rotRange.max}
            decimals={2}
            disabled={!clip}
            onChange={(v) => {
              syncTimelineTabForRotationDrag(timelineTab, i as 0 | 1 | 2, setTimelineTab)
              applyRotationAxis(i as 0 | 1 | 2, v, "preview")
            }}
            onCommit={(v) => applyRotationAxis(i as 0 | 1 | 2, v, "commit")}
          />
        ))
      ) : (
        <div className="text-[11px] text-muted-foreground">—</div>
      )}

      <div className="mb-2 mt-3 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        Translation
      </div>
      {livePose ? (
        TRA_CHANNELS.map((ch, i) => (
          <AxisSliderRow
            key={ch.key}
            axis={["X", "Y", "Z"][i] as string}
            color={ch.color}
            value={[livePose.translation.x, livePose.translation.y, livePose.translation.z][i]}
            min={traRange.min}
            max={traRange.max}
            decimals={3}
            disabled={!clip}
            onChange={(v) => {
              syncTimelineTabForTranslationDrag(timelineTab, i as 0 | 1 | 2, setTimelineTab)
              applyTranslationAxis(i as 0 | 1 | 2, v, "preview")
            }}
            onCommit={(v) => applyTranslationAxis(i as 0 | 1 | 2, v, "commit")}
          />
        ))
      ) : (
        <div className="text-[11px] text-muted-foreground">—</div>
      )}
    </>
  )
}

/** Morph weight slider scoped to its own rAF subscription — mirrors
 *  <LiveBoneSliders>. */
function LiveMorphSlider({
  modelRef,
  selectedMorph,
  clip,
  disabled,
  applyMorphWeight,
}: {
  modelRef: RefObject<Model | null>
  selectedMorph: string | null
  clip: AnimationClip | null
  disabled: boolean
  applyMorphWeight: (w: number, mode: "preview" | "commit") => void
}) {
  const weight = useLiveMorphWeight(modelRef, selectedMorph, clip)
  return (
    <AxisSliderRow
      axis="W"
      color="#c084fc"
      value={weight ?? 0}
      min={0}
      max={1}
      decimals={2}
      disabled={disabled}
      onChange={(v) => applyMorphWeight(v, "preview")}
      onCommit={(v) => applyMorphWeight(v, "commit")}
    />
  )
}

/** Subscribes to the playhead so the parent <PropertiesInspector/> doesn't have to. */
function PlayheadFrameLabel({ frameCount }: { frameCount: number | null }) {
  const currentFrame = usePlaybackSelector((s) => s.currentFrame)
  return (
    <div className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
      F {Math.round(currentFrame)}
      {frameCount != null ? ` / ${frameCount}` : ""}
    </div>
  )
}

/** Owns the interpolation tab + curve preview. Subscribes to currentFrame
 *  internally so the parent inspector (and its sliders) don't re-render every
 *  rAF tick during playback. */
function InterpolationSection({
  clip,
  selectedBone,
  commit,
  clipVersion,
}: {
  clip: AnimationClip | null
  selectedBone: string | null
  commit: ReturnType<typeof useStudioActions>["commit"]
  clipVersion: number
}) {
  const [ipTab, setIpTab] = useState<IpTab>("rot")

  // Reset interpolation tab when a new clip is loaded.
  const clipVersionRef = useRef(clipVersion)
  useEffect(() => {
    if (clipVersionRef.current === clipVersion) return
    clipVersionRef.current = clipVersion
    setIpTab("rot")
  }, [clipVersion])

  // Live during playback: tracks the keyframe currently under the playhead
  // (last key with frame ≤ f). Reconciles only when the active key flips, not
  // every rAF tick — see `useLiveActiveKeyframe`.
  const kfSample = useLiveActiveKeyframe(clip, selectedBone)
  // A curve belongs to a keyframe, so editing one only means something when the
  // playhead is ON a key. `kfSample` is the last key at OR BEFORE the playhead
  // — right for reading a live value, wrong for editing: parked between two
  // keys it let you edit the earlier one's curve while the timeline highlighted
  // nothing, so the change landed somewhere you were not looking.
  const currentFrame = usePlaybackSelector((st) => st.currentFrame)
  const kfAtPlayhead =
    kfSample && kfSample.frame === Math.round(Math.max(0, currentFrame)) ? kfSample : null
  const canEditIp = !!(clip && selectedBone && kfAtPlayhead)

  // No useMemo: `patchKeyframeAt` mutates the keyframe in place and returns a
  // shallow-cloned clip, so `kfSample` keeps its identity across edits. Memo
  // keyed on `kfSample` would then short-circuit and feed stale numbers back
  // to the curve editor (dragging one control point would "reset" the other,
  // and presets wouldn't redraw). Building a fresh pair every render is cheap
  // and guarantees the editor sees the live interpolation values.
  const ipPair =
    (kfAtPlayhead && interpolationPairFromTab(kfAtPlayhead, ipTab)) ?? interpolationTemplateForChannel(ipTab)

  const applyInterpolation = useCallback(
    (p1: CurvePoint, p2: CurvePoint) => {
      if (!clip || !selectedBone || !kfAtPlayhead) return
      const keyFrame = kfAtPlayhead.frame
      commit(
        patchKeyframeAt(clip, selectedBone, keyFrame, (kf) => {
          kf.interpolation = mergeInterpolation(kf, ipTab, p1, p2)
        }),
      )
    },
    [clip, selectedBone, ipTab, kfAtPlayhead, commit],
  )

  return (
    <InterpolationPanel
      tabs={BONE_IP_TABS}
      activeTab={ipTab}
      onTabChange={(k) => setIpTab(k as IpTab)}
      p1={ipPair[0]}
      p2={ipPair[1]}
      disabled={!canEditIp}
      onChange={applyInterpolation}
    />
  )
}

/**
 * The interpolation editor, shared by bones and the camera.
 *
 * Extracted so "the same panel" is true by construction rather than by two
 * copies staying in sync — they had already drifted in their heading spacing
 * and wrapper. What differs between callers is only WHICH curves exist (a bone
 * has four, a camera six) and what a curve means; the controls are identical.
 */
function InterpolationPanel({
  tabs,
  activeTab,
  onTabChange,
  p1,
  p2,
  disabled,
  onChange,
}: {
  tabs: readonly { key: string; label: string }[]
  activeTab: string
  onTabChange: (key: string) => void
  p1: CurvePoint
  p2: CurvePoint
  disabled: boolean
  onChange: (p1: CurvePoint, p2: CurvePoint) => void
}) {
  return (
    <>
      <div className="mb-2 mt-3 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        Interpolation
      </div>
      <div className="mb-1.5 flex flex-wrap gap-0.5">
        {tabs.map((t) => (
          <Button
            key={t.key}
            type="button"
            variant={activeTab === t.key ? "secondary" : "ghost"}
            size="xs"
            disabled={disabled}
            onClick={() => onTabChange(t.key)}
            className="h-6 px-2 text-[9px] font-medium"
          >
            {t.label}
          </Button>
        ))}
      </div>
      <div className="flex items-stretch gap-1.5" style={{ height: 164 }}>
        <InterpolationCurveEditor p1={p1} p2={p2} disabled={disabled} onChange={onChange} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {PRESETS.map((pr) => {
            const active = pr.p1.x === p1.x && pr.p1.y === p1.y && pr.p2.x === p2.x && pr.p2.y === p2.y
            return (
              <Button
                key={pr.label}
                type="button"
                variant={active ? "secondary" : "outline"}
                size="xs"
                disabled={disabled}
                onClick={() => onChange(pr.p1, pr.p2)}
                className={cn(
                  "h-auto min-h-0 flex-1 truncate px-1 py-0.5 text-center text-[9.5px] font-medium leading-tight",
                  active
                    ? "border-primary/30 text-primary"
                    : "text-muted-foreground hover:border-primary/25 hover:text-accent-foreground",
                )}
              >
                {pr.label}
              </Button>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ─── Camera ─────────────────────────────────────────────────────────────

/** Slider range per camera channel — each is in its own unit, so none of them
 *  can share a range the way a bone's three rotation axes do. */
const CAMERA_RANGES: Record<string, { min: number; max: number; decimals: number }> = {
  cgx: { min: -30, max: 30, decimals: 2 },
  cgy: { min: -30, max: 30, decimals: 2 },
  cgz: { min: -30, max: 30, decimals: 2 },
  crx: { min: -180, max: 180, decimals: 1 },
  cry: { min: -180, max: 180, decimals: 1 },
  crz: { min: -180, max: 180, decimals: 1 },
  cds: { min: -100, max: 0, decimals: 2 },
  cfv: { min: 1, max: 150, decimals: 0 },
}

/** A camera's pose at `frame`, as a keyframe ready to insert.
 *
 *  Uses the engine's own CameraAnimation so an inserted key sits exactly on the
 *  curve the viewport is already showing — a second implementation of the same
 *  beziers here would drift from it in the small, and the drift would only show
 *  up as a camera that twitches when you key it. An empty track has no curve to
 *  sample, so it falls back to a plain MMD-ish default shot. */
function sampleCameraAt(track: readonly CameraKeyframe[], frame: number): CameraKeyframe {
  const pose = track.length > 0 ? new CameraAnimation([...track]).sample(frame / 30) : null
  if (!pose) {
    return {
      frame,
      distance: -35,
      target: new Vec3(0, 10, 0),
      rotation: new Vec3(0, 0, 0),
      fov: 30,
    }
  }
  return {
    frame,
    distance: pose.distance,
    target: new Vec3(pose.target.x, pose.target.y, pose.target.z),
    rotation: new Vec3(pose.rotation.x, pose.rotation.y, pose.rotation.z),
    // CameraAnimation hands fov back in radians; the file stores whole degrees.
    fov: Math.round((pose.fov * 180) / Math.PI),
  }
}

/** Slider groups, mirroring the bone inspector's Rotation / Translation split
 *  — eight ungrouped rows showed "X Y Z" twice with nothing saying which was
 *  which. */
const CAMERA_GROUPS = [
  { group: "rot" as const, label: "Rotation", stripPrefix: true },
  { group: "tgt" as const, label: "Target", stripPrefix: true },
  // Distance and FOV get no heading of their own: a one-row section whose title
  // repeats the row's own label is a header saying nothing. They are separated
  // from Target by space instead — enough to read as a break, without pretending
  // to be two more groups.
  { group: "dist" as const, label: null, stripPrefix: false },
  { group: "fov" as const, label: null, stripPrefix: false },
]

/** The axis tab that shows exactly one channel — where a slider drag points
 *  the timeline when the current view does not already include that channel. */
const CAMERA_AXIS_TAB: Record<string, string> = {
  crx: "camRx", cry: "camRy", crz: "camRz",
  cgx: "camTx", cgy: "camTy", cgz: "camTz",
  cds: "camDist", cfv: "camFov",
}

function withCameraIp(ip: Uint8Array | undefined, channel: number, p1: CurvePoint, p2: CurvePoint): Uint8Array {
  const next = new Uint8Array(24)
  if (ip && ip.length >= 24) next.set(ip.subarray(0, 24))
  else for (let c = 0; c < 6; c++) next.set([20, 107, 20, 107], c * 4)
  const b = channel * 4
  next[b] = p1.x
  next[b + 1] = p2.x
  next[b + 2] = p1.y
  next[b + 3] = p2.y
  return next
}

/**
 * The camera's pose at the playhead, and the curve leading into it.
 *
 * Edits the keyframe the playhead is ON (or the last one before it) — the same
 * rule the bone inspector uses. A camera keyframe carries the whole pose, so
 * unlike a bone there is no "this channel has no key here" case: if there is a
 * keyframe at all, every channel is editable.
 */
const CameraSection = memo(function CameraSection({
  cameraTrack,
  commitCamera,
  timelineTab,
  setTimelineTab,
  onClearCameraTrack,
}: {
  cameraTrack: readonly CameraKeyframe[]
  commitCamera: ReturnType<typeof useStudioActions>["commitCamera"]
  timelineTab: string
  setTimelineTab: (t: string) => void
  onClearCameraTrack: () => void
}) {
  const playhead = usePlaybackSelector((st) => st.currentFrame)
  const frame = Math.round(Math.max(0, playhead))

  // The keyframe AT the playhead, or null. Deliberately exact rather than
  // "last one at or before": editing the previous key while the playhead sits
  // between two of them is what made the sliders appear to move the wrong
  // keyframe and the interpolation appear not to apply — the thing highlighted
  // in the timeline and the thing being edited were different objects.
  const keyAtPlayhead = useMemo(
    () => cameraTrack.find((kf) => kf.frame === frame) ?? null,
    [cameraTrack, frame],
  )

  // What the sliders READ: the real key when there is one, otherwise the shot's
  // interpolated pose there — so the numbers always describe the frame you are
  // looking at, whether or not it has been keyed yet. Sampled with the engine's
  // own CameraAnimation rather than a second implementation of the same curves.
  const displayed = useMemo(() => {
    if (keyAtPlayhead) return keyAtPlayhead
    return sampleCameraAt(cameraTrack, frame)
  }, [keyAtPlayhead, cameraTrack, frame])

  // Which of the six interpolation channels the curve editor is showing.
  //
  // Its OWN state, seeded from the timeline's tab but not chained to it.
  // Deriving it meant picking a curve to ease here also yanked the timeline off
  // whatever you were looking at — you clicked "Distance" to change its easing
  // and lost your "All Rot" view. The two are related, not the same: one is
  // which curve you are reading, the other is which curve you are easing.
  const [ipChannel, setIpChannel] = useState(() => cameraIpChannelForTab(timelineTab))
  // Following the timeline is still the right default when you deliberately
  // switch tabs there — just not the other way round.
  const lastTabRef = useRef(timelineTab)
  useEffect(() => {
    if (lastTabRef.current === timelineTab) return
    lastTabRef.current = timelineTab
    setIpChannel(cameraIpChannelForTab(timelineTab))
  }, [timelineTab])

  /** Edit the key at the playhead, creating it first if it does not exist —
   *  the same "drag a slider and it keys" contract the bone sliders have. A new
   *  key starts from the pose already showing there, so inserting one changes
   *  nothing on its own; only the channel you dragged moves. */
  const applyChannel = useCallback(
    (channelKey: string, v: number) => {
      const ch = CAMERA_CHANNELS.find((c) => c.key === channelKey)
      if (!ch) return
      commitCamera((track) => {
        const existing = track.find((kf) => kf.frame === frame)
        if (existing) {
          return track.map((kf) => {
            if (kf.frame !== frame) return kf
            const next = { ...kf }
            ch.set(next, v)
            return next
          })
        }
        const seeded = { ...sampleCameraAt(track, frame) }
        ch.set(seeded, v)
        return [...track, seeded]
      })
    },
    [frame, commitCamera],
  )

  /** Point the timeline at the curve being dragged — on the FIRST tick, the
   *  way a bone slider does it, so the view is already right while you drag
   *  rather than snapping over once you let go. An "All" view already shows
   *  this channel, so it is left alone. */
  const syncTab = useCallback(
    (channelKey: string) => {
      const showing = cameraChannelsForTab(timelineTab).some((c) => c.key === channelKey)
      if (showing) return
      const want = CAMERA_AXIS_TAB[channelKey]
      if (want) setTimelineTab(want)
    },
    [timelineTab, setTimelineTab],
  )

  /** Key the pose already showing at the playhead. Inserting changes nothing
   *  on its own — that is the point: it pins the current shot so a later edit
   *  elsewhere cannot drag this moment with it. */
  const insertKey = useCallback(() => {
    if (keyAtPlayhead) return
    commitCamera((track) => [...track, sampleCameraAt(track, frame)])
  }, [keyAtPlayhead, frame, commitCamera])

  const deleteKey = useCallback(() => {
    if (!keyAtPlayhead) return
    commitCamera((track) => track.filter((kf) => kf.frame !== frame))
  }, [keyAtPlayhead, frame, commitCamera])

  const applyIp = useCallback(
    (p1: CurvePoint, p2: CurvePoint) => {
      if (!keyAtPlayhead) return
      commitCamera((track) =>
        track.map((kf) =>
          kf.frame === frame
            ? { ...kf, interpolation: withCameraIp(kf.interpolation, ipChannel, p1, p2) }
            : kf,
        ),
      )
    },
    [keyAtPlayhead, frame, ipChannel, commitCamera],
  )

  const ipPair = cameraIpPair(keyAtPlayhead?.interpolation, ipChannel)

  return (
    <div className="space-y-0">
      <section className="border-b border-line pb-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-inherit">Camera</div>
            <div className="text-[10px] text-muted-foreground">
              {cameraTrack.length === 0
                ? "No keys — move a slider to key one"
                : keyAtPlayhead
                  ? `${cameraTrack.length} keys · editing key @ ${frame}`
                  : `${cameraTrack.length} keys · none @ ${frame}`}
            </div>
          </div>
        </div>

        {CAMERA_GROUPS.map((group) => (
          <div
            key={group.group}
            className={cn(
              "mb-2 last:mb-0",
              // The one gap that separates the headed groups above from the
              // bare scalar rows below.
              group.group === "dist" && "mt-4",
            )}
          >
            {group.label ? (
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                {group.label}
              </div>
            ) : null}
            {CAMERA_CHANNELS.filter((c) => c.group === group.group).map((ch) => {
              const r = CAMERA_RANGES[ch.key]
              return (
                <AxisSliderRow
                  key={ch.key}
                  axis={group.stripPrefix ? ch.label.replace(/^(Tgt|Rot)\./, "") : ch.label}
                  color={ch.color}
                  value={ch.get(displayed)}
                  min={r.min}
                  max={r.max}
                  decimals={r.decimals}
                  onChange={(v) => {
                    applyChannel(ch.key, v)
                    syncTab(ch.key)
                  }}
                  onCommit={(v) => applyChannel(ch.key, v)}
                />
              )
            })}
          </div>
        ))}
      </section>

      <InterpolationPanel
        tabs={CAMERA_IP_TABS.map((t) => ({ key: String(t.ip), label: t.label }))}
        activeTab={String(ipChannel)}
        onTabChange={(k) => setIpChannel(Number(k))}
        p1={ipPair[0]}
        p2={ipPair[1]}
        disabled={!keyAtPlayhead}
        onChange={applyIp}
      />

      <section className="space-y-2 pt-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Operations</div>
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">Key</span>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled={!!keyAtPlayhead}
              onClick={insertKey}
              title="Key the camera's current pose at the playhead"
            >
              Insert
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled={!keyAtPlayhead}
              onClick={deleteKey}
              title="Remove the camera keyframe at the playhead"
            >
              Delete
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-10 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">Track</span>
            {/* Permanently disabled, and kept anyway: Simplify fits a curve
                through dense keys, and a camera VMD is sparse by nature — its
                keys ARE the cuts, so there is nothing to reduce. Dropping the
                button would make this row one control wide and the whole
                Operations block a different shape from the bone one. */}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled
              title="Simplify applies to dense bone tracks — a camera's keys are its cuts"
            >
              Simplify
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="h-6 flex-1 px-0.5 text-[11px]"
              disabled={cameraTrack.length === 0}
              onClick={onClearCameraTrack}
              title="Remove every camera keyframe"
            >
              Clear
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
})
