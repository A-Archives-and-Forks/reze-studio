"use client"

/** Headless component that owns every engine-coupled effect: initialization,
 *  clip upload, scrub/seek, play/pause, end-of-clip handling, and the 60Hz
 *  playback rAF loop that imperatively drives the timeline playhead.
 *
 *  StudioPage mounts this once (with refs + chrome setters) and otherwise has
 *  no engine logic in its render body. EngineBridge returns null. */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react"
import { Engine, Model, Vec3, VMDLoader } from "reze-engine"
import type { AnimationClip, GizmoDragEvent } from "reze-engine"
import { useStudioActions, useStudioSelector } from "@/context/studio-context"
import { usePlayback, usePlaybackFrameRef } from "@/context/playback-context"
import { useStudioStatusActions } from "@/components/studio-status"
import { autoClassifyMaterials } from "@/lib/materials"
import { clipRetainedForModel, emptyStudioClip, interpolationTemplateForFrame, readLocalPoseAfterSeek } from "@/lib/utils"
import { loadDraft, type StoredTimelineView } from "@/lib/draft"
import { clearModelUpload, loadModelUpload } from "@/lib/model-store"

// ─── Constants shared with StudioPage file handlers ──────────────────────
export const MODEL_PATH = "/models/塞尔凯特/塞尔凯特.pmx"
export const VMD_PATH = "/animations/Classic.vmd"
/** The shot and the song that ship with the demo motion — one scene, so they
 *  arrive together on a fresh boot rather than leaving the dance unscored. */
export const CAMERA_VMD_PATH = "/animations/Classic_camera.vmd"
export const AUDIO_PATH = "/audio/Classic.mp3"
export const STUDIO_ANIM_NAME = "studio"
export const BUNDLED_PMX_FILENAME = MODEL_PATH.replace(/^.*\//, "") || "model.pmx"

// Whether this build ships the demo model and motion (absent = on). Set
// NEXT_PUBLIC_USE_DEFAULT_ASSETS=false to boot empty; parsed leniently, same
// convention as reze-design. Read at build time (NEXT_PUBLIC_ inlines it).
const NO = ["false", "0", "off", "no"]
const USE_DEFAULT_ASSETS = !NO.includes((process.env.NEXT_PUBLIC_USE_DEFAULT_ASSETS ?? "").trim().toLowerCase())

// ─── Filename helpers — used by EngineBridge (initial VMD load) and by
//     StudioPage (file menu / export). Kept here so both can import without
//     a circular dependency. ──────────────────────────────────────────────
export function fileStem(pathOrName: string): string {
  const base = pathOrName.replace(/^.*[/\\]/, "")
  const i = base.lastIndexOf(".")
  return (i > 0 ? base.slice(0, i) : base).trim() || "clip"
}

export function sanitizeClipFilenameBase(name: string): string {
  const s = name.trim() || "clip"
  const cleaned = s.replace(/[/\\<>:"|?*\x00-\x1f]/g, "-").replace(/-+/g, "-")
  return cleaned.slice(0, 120).replace(/^-|-$/g, "") || "clip"
}

interface EngineBridgeProps {
  canvasRef: RefObject<HTMLCanvasElement | null>
  engineRef: RefObject<Engine | null>
  modelRef: RefObject<Model | null>
  /** Current engine model key — "reze" at boot, replaced on PMX folder upload.
   *  EngineBridge needs this to push selectedBone / selectedMaterial to the
   *  right model (the engine keys selection state per model name). */
  loadedModelNameRef: RefObject<string>
  /** Parent's imperative "scroll the bone list to this bone" hook. Called on
   *  raycast hit so a bone picked in the viewport auto-centers in the list. */
  revealBoneInListRef: RefObject<((bone: string) => void) | null>
  currentFrameRef: RefObject<number>
  playheadDrawRef: RefObject<((frame: number) => void) | null>
  /** A restored draft's timeline view (zoom + scroll) — set once, on boot
   *  restore, so StudioPage can hand it to <Timeline> as its `initialView` prop. */
  setTimelineView: Dispatch<SetStateAction<StoredTimelineView | undefined>>
  /** The rest of a restored draft's UI state — all StudioPage-local, so it
   *  can't be reached via useStudioActions() the way selectedMorph/Material
   *  can (see below). */
  setSelectedGroup: Dispatch<SetStateAction<string>>
  setRightPanelTab: Dispatch<SetStateAction<"properties" | "materials">>
  setTimelineTab: Dispatch<SetStateAction<string>>
  setPmxBoneNames: Dispatch<SetStateAction<ReadonlySet<string>>>
  setModelBoneOrder: Dispatch<SetStateAction<string[]>>
  setMorphNames: Dispatch<SetStateAction<string[]>>
  setMaterialNames: Dispatch<SetStateAction<string[]>>
  setEngineError: Dispatch<SetStateAction<string | null>>
  setStudioReady: Dispatch<SetStateAction<boolean>>
  /** Fired once, only when booting with no saved draft — the moment the
   *  bundled demo assets are the right thing to show. StudioPage uses it to
   *  bring in the default track; a returning user's cleared music must not
   *  come back on every reload. */
  onFreshBoot?: () => void
}

export function EngineBridge({
  canvasRef,
  engineRef,
  modelRef,
  loadedModelNameRef,
  revealBoneInListRef,
  currentFrameRef,
  playheadDrawRef,
  setTimelineView,
  setSelectedGroup,
  setRightPanelTab,
  setTimelineTab,
  setPmxBoneNames,
  setModelBoneOrder,
  setMorphNames,
  setMaterialNames,
  setEngineError,
  setStudioReady,
  onFreshBoot,
}: EngineBridgeProps) {
  const clip = useStudioSelector((s) => s.clip)
  const selectedBone = useStudioSelector((s) => s.selectedBone)
  const selectedMaterial = useStudioSelector((s) => s.selectedMaterial)
  const gizmoVisible = useStudioSelector((s) => s.gizmoVisible)
  const cameraTrack = useStudioSelector((s) => s.cameraTrack)
  const cameraVmdEnabled = useStudioSelector((s) => s.cameraVmdEnabled)
  const {
    commit,
    replaceClip,
    setClipDisplayName,
    setSelectedBone,
    setSelectedMorph,
    setSelectedMaterial,
    setGizmoVisible,
    setSelectedKeyframes,
    setIkEnabled,
    replaceCameraTrack,
    setCameraSelected,
  } = useStudioActions()
  const { currentFrame, setCurrentFrame, playing, setPlaying } = usePlayback()
  const playbackFrameRef = usePlaybackFrameRef()
  const { setPmxFileName: setStatusPmxFileName, setFps: setStatusFps } = useStudioStatusActions()
  // Playback spans the whole document, not just the model's clip. A camera VMD
  // carries no bone or morph frames, so with a camera-only load `clip` stays at
  // its short default while the shot runs for thousands of frames — and every
  // consumer below (the end-of-clip stop, the playhead clamp, the rAF loop)
  // reads this. Without the camera's length in here the playhead stops dead
  // partway through the shot, which also means it never leaves the visible
  // window and the timeline never page-turns.
  const lastCameraFrame = cameraTrack.length > 0 ? cameraTrack[cameraTrack.length - 1].frame : 0
  const frameCount = Math.max(clip?.frameCount ?? 0, lastCameraFrame)

  // ─── Refs for the engine-supplied callbacks ──────────────────────────
  //     The Engine constructor takes `onRaycast` / `onGizmoDrag` once at
  //     startup and there's no setter — so we hand it stable thunks that
  //     read the latest handler from a ref. The handlers themselves close
  //     over refs (clipRef, playbackFrameRef, modelRef) so they always see
  //     current values without needing re-registration.
  const clipRef = useRef<AnimationClip | null>(clip)
  useEffect(() => {
    clipRef.current = clip
  }, [clip])
  const dragDirtyRef = useRef(false)

  const playRef = useRef(false)
  const lastFpsRef = useRef<number | null>(null)

  // ─── Physics reset after animation-time jumps ───────────────────────
  //     `model.seek` retargets the animation; rigid bodies only catch up
  //     on the engine's next tick, so resetting in the same call zeroes
  //     velocities against the *old* pose and things explode. One rAF
  //     of delay lets the engine propagate the new pose to physics, then
  //     `resetPhysics` stabilizes velocities at the new rest state.
  //
  //     Small frame-to-frame deltas (smooth scrub drag) don't need a
  //     reset — physics can integrate continuously between neighboring
  //     poses without blowing up. Only jumps beyond `RESET_PHYSICS_FRAME_THRESHOLD`
  //     trigger the next-frame reset. Bursts of qualifying seeks collapse
  //     into one reset via rAF cancellation.
  const RESET_PHYSICS_FRAME_THRESHOLD = 2
  const physicsResetRafRef = useRef<number | null>(null)
  const lastSeekFrameRef = useRef<number | null>(null)

  const maybeResetPhysicsAfterSeek = useCallback(
    (frame: number) => {
      const prev = lastSeekFrameRef.current
      lastSeekFrameRef.current = frame
      if (prev !== null && Math.abs(frame - prev) <= RESET_PHYSICS_FRAME_THRESHOLD) return
      if (physicsResetRafRef.current !== null) cancelAnimationFrame(physicsResetRafRef.current)
      physicsResetRafRef.current = requestAnimationFrame(() => {
        physicsResetRafRef.current = null
        engineRef.current?.resetPhysics()
      })
    },
    [engineRef],
  )

  useEffect(() => {
    return () => {
      if (physicsResetRafRef.current !== null) cancelAnimationFrame(physicsResetRafRef.current)
      physicsResetRafRef.current = null
    }
  }, [])

  // ─── Viewport raycast (dblclick on model) ───────────────────────────
  //     Engine resolves bone + material for the hit triangle; studio only
  //     consumes the bone (material lives in the panel, per UX rule:
  //     "material picks happen in the material list, not the viewport").
  //     Null modelName means the click missed the mesh — deselect.
  const handleRaycast = useCallback(
    (modelName: string, _material: string | null, bone: string | null, _screenX: number, _screenY: number) => {
      if (!modelName) {
        // Miss (dblclick on empty space) → hide the gizmo in the viewport
        // without touching studio selection. Bone-list highlight, Properties
        // inspector, and timeline state all stay intact — the flag is the
        // only thing that changes, and re-selecting the bone brings it back.
        setGizmoVisible(false)
        return
      }
      // Hit → select the bone. Mirrors `handleSelectBone` in studio.tsx so the
      // mutual-exclusion contract holds whether picks come from viewport or
      // from the bone list.
      setSelectedBone(bone)
      setSelectedMorph(null)
      setSelectedMaterial(null)
      setSelectedKeyframes([])
      // Scroll the bone list so the pick lands in view. Only for raycasts —
      // bone-list clicks don't need this (the row is already where the user
      // pointed).
      if (bone) revealBoneInListRef.current?.(bone)
    },
    [setSelectedBone, setSelectedMorph, setSelectedMaterial, setGizmoVisible, setSelectedKeyframes, revealBoneInListRef],
  )

  // ─── Gizmo drag → keyframe edit (undoable) ──────────────────────────
  //     Mirrors the preview/commit pattern in properties-inspector.tsx:
  //     mutate the keyframe in place during drag moves (no React churn),
  //     commit a new clip ref on drag end so history records one entry
  //     per gesture. `dragDirtyRef` suppresses the commit for no-op drags
  //     (gizmo click without movement).
  const handleGizmoDrag = useCallback(
    (e: GizmoDragEvent) => {
      const model = modelRef.current
      const clip = clipRef.current
      if (!model || !clip) return

      if (e.phase === "start") {
        dragDirtyRef.current = false
        // Sidebar + Properties should track whatever the user is dragging.
        // Same mutual-exclusion contract as a raycast pick.
        setSelectedBone(e.boneName)
        setSelectedMorph(null)
        setSelectedMaterial(null)
        setSelectedKeyframes([])
        return
      }

      const frame = Math.round(Math.max(0, Math.min(clip.frameCount, playbackFrameRef.current)))
      const bone = e.boneName
      const track = clip.boneTracks.get(bone) ?? []
      const atKey = track.find((k) => k.frame === frame)

      if (atKey) {
        if (e.kind === "rotate") atKey.rotation = e.localRotation
        else atKey.translation = e.localTranslation
      } else {
        // No key at this frame yet — pull the untouched channel from the
        // interpolated pose so the new key preserves whatever's currently
        // displayed on the channel the user isn't dragging.
        model.loadClip(STUDIO_ANIM_NAME, clip)
        model.seek(frame / 30)
        const pose = readLocalPoseAfterSeek(model, bone)
        if (!pose) return
        const rotation = e.kind === "rotate" ? e.localRotation : pose.rotation
        const translation = e.kind === "translate" ? e.localTranslation : pose.translation
        if (!clip.boneTracks.has(bone)) clip.boneTracks.set(bone, track)
        track.push({
          boneName: bone,
          frame,
          rotation,
          translation,
          interpolation: interpolationTemplateForFrame(track, frame),
        })
        track.sort((a, b) => a.frame - b.frame)
      }

      model.loadClip(STUDIO_ANIM_NAME, clip)
      model.seek(frame / 30)

      if (e.phase === "end") {
        if (dragDirtyRef.current) {
          commit({ ...clip, boneTracks: new Map(clip.boneTracks) })
        }
        dragDirtyRef.current = false
      } else {
        dragDirtyRef.current = true
      }
    },
    [commit, modelRef, playbackFrameRef, setSelectedBone, setSelectedMorph, setSelectedMaterial, setSelectedKeyframes],
  )

  // Stable thunks that read the latest handlers via ref — re-registration
  // would require recreating the Engine.
  const handleRaycastRef = useRef(handleRaycast)
  const handleGizmoDragRef = useRef(handleGizmoDrag)
  useEffect(() => {
    handleRaycastRef.current = handleRaycast
  }, [handleRaycast])
  useEffect(() => {
    handleGizmoDragRef.current = handleGizmoDrag
  }, [handleGizmoDrag])

  // ─── Mirror React selection → engine gizmo/outline ──────────────────
  //     The engine keys selection per model name, so every write uses the
  //     live `loadedModelNameRef.current` (swaps on PMX folder upload).
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setSelectedBone(loadedModelNameRef.current, gizmoVisible ? selectedBone : null)
  }, [selectedBone, gizmoVisible, engineRef, loadedModelNameRef])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setSelectedMaterial(loadedModelNameRef.current, selectedMaterial)
  }, [selectedMaterial, engineRef, loadedModelNameRef])

  // ─── Mirror the camera track → engine ────────────────────────────────
  //     Every edit lands here: the array identity changes on commit, and a
  //     drag bumps it too (Timeline commits on mouse-up), so the viewport
  //     shows the shot being edited. An empty track hands the camera back to
  //     orbit control, which is what loadCameraClip([]) does.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.loadCameraClip([...cameraTrack])
    // loadCameraClip switches the camera on whenever a non-empty track lands;
    // re-assert the user's choice so a re-commit mid-edit does not yank the
    // viewport back off orbit.
    engine.setCameraVmdEnabled(cameraVmdEnabled)
  }, [cameraTrack, cameraVmdEnabled, engineRef])

  // ─── Engine init + initial model/VMD load ───────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const el = canvas
    let disposed = false

    async function initEngine() {
      try {
        const engine = new Engine(el, {
          camera: {
            distance: 31.5,
            target: new Vec3(0, 11.5, 0),
          },
          bloom: { color: new Vec3(1, 0.1, 0.88) },
          onRaycast: (modelName, material, bone, screenX, screenY) =>
            handleRaycastRef.current(modelName, material, bone, screenX, screenY),
          onGizmoDrag: (event) => handleGizmoDragRef.current(event),
        })
        await engine.init()
        if (disposed) return

        // Stage first: ground up and the render loop painting before any model
        // bytes arrive — the model streams in and reveals styled below.
        engine.addGround({ diffuseColor: new Vec3(0.05, 0.04, 0.06) })
        lastFpsRef.current = null
        engine.runRenderLoop(() => {
          const fps = engine.getStats().fps
          if (fps === lastFpsRef.current) return
          lastFpsRef.current = fps
          setStatusFps(fps > 0 ? fps : null)
        })

        // Push bone/morph/material names + status filename, then compile style
        // groups before the render loop starts so the first frame uses the
        // correct NPR graphs instead of the neutral default. autoStyleGroups
        // applies the engine's maintained JP/CN/EN name hints, with our local
        // keyword pass as overrides (explicit wins). StudioPage's materials
        // effect reads the installed groups back into React state (idempotent).
        // Shared between the bundled default and a restored upload below —
        // only the source of the model and its status filename differ.
        async function installModelIntoUi(instanceKey: string, model: Model, statusFileName: string) {
          const sk = model.getSkeleton().bones.map((b) => b.name)
          setPmxBoneNames(new Set(sk))
          setModelBoneOrder(sk)
          setMorphNames(model.getMorphing().morphs.map((m) => m.name))
          const materialNames = model.getMaterials().map((m) => m.name)
          setMaterialNames(materialNames)
          setStatusPmxFileName(statusFileName)
          await engine.autoStyleGroups(instanceKey, autoClassifyMaterials(materialNames))
        }

        // A model saved to IndexedDB by a previous session takes priority over
        // the bundled default — restoring it is the whole point of persisting
        // an upload. `restoredStem` doubles as the "did this succeed" flag
        // below: only set once the restore actually lands a model.
        let restoredStem: string | null = null
        const storedModel = await loadModelUpload()
        if (disposed) return

        if (storedModel) {
          const instanceKey = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
          try {
            const model = await engine.loadModel(instanceKey, { files: storedModel.files, pmxFile: storedModel.pmxFile })
            if (disposed) return
            // Hidden until the NPR graphs are compiled: the first VISIBLE frame
            // wears the studio look, never the neutral default.
            engine.setModelTransform(instanceKey, { visible: false })
            model.setName(storedModel.stem)
            modelRef.current = model
            loadedModelNameRef.current = instanceKey
            // `pmxFile.name` is the full stored path (see model-store.ts), not
            // the bare filename a live folder pick's `File.name` would be —
            // trim it back to match what the status bar shows for a fresh upload.
            const statusFileName = storedModel.pmxFile.name.split("/").pop() || storedModel.pmxFile.name
            await installModelIntoUi(instanceKey, model, statusFileName)
            if (disposed) return
            engine.setModelTransform(instanceKey, { visible: true })
            restoredStem = storedModel.stem
          } catch (e) {
            console.warn("[boot] stored model failed to load — falling back to the bundled default", e)
            void clearModelUpload()
          }
        }

        if (!modelRef.current && USE_DEFAULT_ASSETS) try {
          const model = await engine.loadModel("reze", MODEL_PATH)
          if (disposed) return
          engine.setModelTransform("reze", { visible: false })
          modelRef.current = model
          await installModelIntoUi("reze", model, BUNDLED_PMX_FILENAME)
          if (disposed) return
          engine.setModelTransform("reze", { visible: true })
        } catch {
          setEngineError(`Add model at public${MODEL_PATH}`)
        }

        // ─── Clip: a persisted draft takes priority over the bundled demo
        //     motion, on whichever model just booted (custom or bundled). ───
        const draft = await loadDraft()
        if (disposed) return
        const model = modelRef.current
        if (draft && model) {
          try {
            const boneSet = new Set(model.getSkeleton().bones.map((b) => b.name))
            const morphSet = new Set(model.getMorphing().morphs.map((m) => m.name))
            const materialSet = new Set(model.getMaterials().map((m) => m.name))
            const clip = clipRetainedForModel(draft.clip, boneSet, morphSet)
            model.loadClip(STUDIO_ANIM_NAME, clip)
            replaceClip(clip)
            setClipDisplayName(draft.clipDisplayName)
            model.show(STUDIO_ANIM_NAME)
            const restoredFrame = Math.min(Math.max(0, draft.currentFrame ?? 0), Math.max(0, clip.frameCount))
            model.seek(restoredFrame / 30)
            setCurrentFrame(restoredFrame)
            lastSeekFrameRef.current = restoredFrame
            setSelectedBone(draft.selectedBone && boneSet.has(draft.selectedBone) ? draft.selectedBone : null)
            setSelectedMorph(draft.selectedMorph && morphSet.has(draft.selectedMorph) ? draft.selectedMorph : null)
            setSelectedMaterial(
              draft.selectedMaterial && materialSet.has(draft.selectedMaterial) ? draft.selectedMaterial : null,
            )
            setSelectedGroup(draft.selectedGroup ?? "All Bones")
            setRightPanelTab(draft.rightPanelTab ?? "properties")
            setTimelineTab(draft.timelineTab ?? "allRot")
            // ikEnabled's display state only — clip.ikTracks (what actually
            // drives IK, live and on export) is already restored above as
            // part of the clip itself.
            setIkEnabled(draft.ikEnabled ?? true)
            // Same filter the PMX-swap path uses: drop curve selections whose
            // bone no longer exists, keep dope selections and morph refs as-is.
            setSelectedKeyframes(
              (draft.selectedKeyframes ?? []).filter((s) => s.type !== "curve" || !s.bone || boneSet.has(s.bone)),
            )
            if (draft.camera) {
              engine.setCameraAlpha(draft.camera.alpha)
              engine.setCameraBeta(draft.camera.beta)
              engine.setCameraDistance(draft.camera.distance)
            }
            setCameraSelected(draft.cameraSelected === true && (draft.cameraTrack?.length ?? 0) > 0)
            if (draft.cameraTrack?.length) {
              // Rebuild Vec3s: structured clone through IndexedDB drops the
              // prototype, and the sampler does vector maths on these.
              replaceCameraTrack(
                draft.cameraTrack.map((kf) => ({
                  ...kf,
                  target: new Vec3(kf.target.x, kf.target.y, kf.target.z),
                  rotation: new Vec3(kf.rotation.x, kf.rotation.y, kf.rotation.z),
                  interpolation: kf.interpolation ? new Uint8Array(kf.interpolation) : undefined,
                })),
              )
            }
            if (draft.timelineView) setTimelineView(draft.timelineView)
            requestAnimationFrame(() => engine.resetPhysics())
          } catch (e) {
            console.warn("[boot] stored draft failed to restore", e)
          }
        } else if (restoredStem === null) {
          // No draft, and we're on the bundled model (no restored upload) —
          // the pre-persistence behavior: load the demo motion so the studio
          // never boots on a bare model.
          try {
            await model?.loadVmd(STUDIO_ANIM_NAME, VMD_PATH)
            if (disposed) return
            const c = model?.getClip(STUDIO_ANIM_NAME)
            if (c) {
              replaceClip(c)
              setClipDisplayName(sanitizeClipFilenameBase(fileStem(VMD_PATH)))
              model?.show(STUDIO_ANIM_NAME)
              model?.seek(0)
              lastSeekFrameRef.current = 0
              requestAnimationFrame(() => engine.resetPhysics())
            }
          } catch (e) {
            console.warn(`VMD load failed — add file at public${VMD_PATH}`, e)
          }
          // The bundled shot. Its own try: a missing camera file should cost
          // the camera, not the motion that already loaded.
          try {
            const camFrames = await VMDLoader.loadCamera(CAMERA_VMD_PATH)
            if (disposed) return
            if (camFrames.length > 0) replaceCameraTrack(camFrames)
          } catch (e) {
            console.warn(`Camera VMD load failed — add file at public${CAMERA_VMD_PATH}`, e)
          }
          // And the song, which StudioPage owns (decode + object URL).
          onFreshBoot?.()
        } else if (model) {
          // A restored custom model with no prior draft: start clean, same as
          // a fresh folder upload with no previous timeline (see studio.tsx's
          // applyLoadedPmxModel).
          const fresh = emptyStudioClip()
          model.loadClip(STUDIO_ANIM_NAME, fresh)
          replaceClip(fresh)
          setClipDisplayName(sanitizeClipFilenameBase(restoredStem))
          model.show(STUDIO_ANIM_NAME)
          model.seek(0)
          lastSeekFrameRef.current = 0
        }

        setStudioReady(true)
        engineRef.current = engine
      } catch (e) {
        console.error(e)
        setEngineError(e instanceof Error ? e.message : String(e))
      }
    }

    void initEngine()

    return () => {
      disposed = true
      setStudioReady(false)
      setModelBoneOrder([])
      setPmxBoneNames(new Set())
      setMorphNames([])
      setMaterialNames([])
      setSelectedBone(null)
      setSelectedMorph(null)
      setSelectedMaterial(null)
      setStatusPmxFileName("—")
      setStatusFps(null)
      lastFpsRef.current = null
      modelRef.current = null
      engineRef.current?.stopRenderLoop()
      engineRef.current?.dispose()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Upload clip to engine ONLY on edits (not on playhead movement).
  //     After upload, re-seek to the current React frame so a commit during
  //     pause doesn't snap the viewport back to frame 0. ────────────────
  useEffect(() => {
    const model = modelRef.current
    if (!model || !clip) return
    model.loadClip(STUDIO_ANIM_NAME, clip)
    const f = Math.max(0, currentFrameRef.current)
    model.seek(f / 30)
    maybeResetPhysicsAfterSeek(f)
  }, [clip, currentFrameRef, modelRef, maybeResetPhysicsAfterSeek])

  // ─── Scrub: when paused, React owns the playhead and pushes seeks into
  //     the engine. When playing, the engine owns the playhead; the rAF
  //     loop below reads from it — do NOT seek here. ────────────────────
  useLayoutEffect(() => {
    const model = modelRef.current
    if (!model || !clip) return
    if (!playing) {
      const f = Math.max(0, currentFrame)
      model.seek(f / 30)
      maybeResetPhysicsAfterSeek(f)
    }
  }, [currentFrame, clip, playing, modelRef, maybeResetPhysicsAfterSeek])

  // ─── Play / pause ───────────────────────────────────────────────────
  useEffect(() => {
    const model = modelRef.current
    if (!model || !clip) return
    if (playing) {
      // If the user pressed play at the end, rewind to 0 first and mirror.
      let startFrame = currentFrameRef.current
      if (startFrame >= frameCount) {
        startFrame = 0
        setCurrentFrame(0)
      }
      const f = Math.max(0, startFrame)
      model.seek(f / 30)
      maybeResetPhysicsAfterSeek(f)
      model.play()
    } else {
      model.pause()
    }
  }, [playing, clip, frameCount, setCurrentFrame, currentFrameRef, modelRef, maybeResetPhysicsAfterSeek])

  // Clamp currentFrame to [0, frameCount] whenever the clip shrinks.
  useEffect(() => {
    setCurrentFrame((c) => Math.min(c, frameCount))
  }, [frameCount, setCurrentFrame])

  // ─── Playback rAF loop ──────────────────────────────────────────────
  //     Engine owns the clock during playback; React's job is to mirror it
  //     imperatively into the timeline playhead via `playheadDrawRef`. No
  //     `setCurrentFrame` per-tick — zero reconciliation cost at 60Hz.
  useEffect(() => {
    playRef.current = playing
    if (!playing) return
    if (frameCount <= 0) return
    const model = modelRef.current
    if (!model) return
    let raf: number
    const tick = () => {
      if (!playRef.current) return
      const m = modelRef.current
      if (!m) return
      const progress = m.getAnimationProgress()
      const frame = progress.current * 30
      if (frame >= frameCount) {
        // Natural end isn't a jump — physics integrated continuously through
        // the last frame. Sync seek tracking BEFORE setState so the scrub
        // useLayoutEffect (which runs on the resulting commit, ahead of this
        // effect's cleanup) sees delta=0 and skips the physics reset.
        currentFrameRef.current = frameCount
        lastSeekFrameRef.current = frameCount
        setCurrentFrame(frameCount)
        setPlaying(false)
        return
      }
      currentFrameRef.current = frame
      playheadDrawRef.current?.(frame)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      // Flush the final frame into React state so the paused view matches
      // what the playhead was last showing. Sync `lastSeekFrameRef` first so
      // the scrub effect this flush triggers sees delta=0 and skips the
      // physics reset — pausing from playback isn't a jump, physics is
      // already in a valid state.
      lastSeekFrameRef.current = currentFrameRef.current
      setCurrentFrame(currentFrameRef.current)
    }
  }, [playing, frameCount, setCurrentFrame, setPlaying, currentFrameRef, modelRef, playheadDrawRef])

  return null
}
