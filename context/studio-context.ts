"use client"

/** Editable document + selection — the undo/redo target.
 *  External store so consumers can subscribe to slices via `useStudioSelector`
 *  without re-rendering on unrelated changes. Transport (playhead, play/pause)
 *  lives in <Playback>; playback ticks never touch this store. */
import {
  createContext,
  createElement,
  useContext,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import type { AnimationClip, CameraKeyframe } from "reze-engine"
import { clipAfterKeyframeEdit, cloneAnimationClip } from "@/lib/utils"
import { newId, type ClipId, type LibraryClip } from "@/lib/project"

const HISTORY_LIMIT = 100

/** Dopesheet diamond vs curve-editor handle — shared by timeline hit-testing. */
export interface SelectedKeyframe {
  bone?: string
  morph?: string
  frame: number
  channel?: string
  /** Set when the entry names the camera track. A camera dope column is
   *  otherwise indistinguishable from a bone column — both are a bare frame —
   *  and delete/copy have to know which track a frame belongs to. */
  camera?: boolean
  type: "dope" | "curve"
}

export type StudioState = {
  /**
   * Every clip the project holds, in import order.
   *
   * The first half of `Project` from lib/project.ts — the arrangement's other
   * half, tracks and placements, becomes visible with the Arrange view. Until
   * then exactly one library entry is being edited at a time and `clip` below
   * is that entry's own clip object, not a copy of it: the drag paths mutate
   * keyframes in place, and two objects that have to be kept in step are two
   * objects that will eventually not be.
   */
  library: LibraryClip[]
  /** Which library entry `clip` belongs to. Null only before the first load. */
  activeClipId: ClipId | null
  clip: AnimationClip | null
  clipDisplayName: string
  selectedBone: string | null
  selectedMorph: string | null
  /** Engine shows an orange outline on this material. Mutually exclusive with
   *  bone/morph — selecting either clears this, and selecting a material
   *  clears bone/morph. Does not belong to the clip — not in undo history. */
  selectedMaterial: string | null
  /** Whether the viewport gizmo is currently shown.
   *
   *  OFF by default, and never turned on as a side effect of selecting a bone:
   *  the gizmo sits in front of the model it is posing, and most of the time
   *  what you want from the viewport is to SEE the character — picking a bone
   *  in the list to read its curves should not put a set of arrows over the
   *  face. It appears only when asked for, by the two gestures that mean "I
   *  want to grab this": the Gizmo button in Properties, and a dblclick on the
   *  bone in the viewport.
   *
   *  Decoupled from `selectedBone` so hiding it (dblclick empty viewport) costs
   *  no inspector or bone-list context, and so it follows the selection once
   *  shown rather than needing to be re-summoned per bone. */
  gizmoVisible: boolean
  /** The camera shot, as its own track.
   *
   *  NOT part of `clip`: reze-engine's AnimationClip is per-model (bones,
   *  morphs, IK) and a camera belongs to the scene, not to a character — the
   *  VMD format keeps them in separate files for the same reason. So it lives
   *  beside the clip and rides the same undo history.
   *
   *  Empty means no shot loaded; the viewport stays on orbit control. */
  cameraTrack: CameraKeyframe[]
  /** Camera is the selected editing target. Mutually exclusive with
   *  bone/morph/material, the same way those are with each other. */
  cameraSelected: boolean
  /** Whether the loaded shot is driving the viewport, or the user is free to
   *  orbit. Not part of the document — it is how you are LOOKING at the scene,
   *  not what the scene is, so it never lands in undo. */
  cameraVmdEnabled: boolean
  /** Whether IK solves for this clip — a document setting, not an engine-wide
   *  switch: toggling it rewrites the clip's own `ikTracks` (see
   *  studio.tsx's toggleIkEnabled), the same data a VMD's IK/display block
   *  round-trips through, so it's undoable and travels with the clip rather
   *  than the session. Resets to true whenever a genuinely new clip loads. */
  ikEnabled: boolean
  selectedKeyframes: SelectedKeyframe[]
  /** Immutable clone of `clip` taken at the last commit / undo / redo. Lets
   *  us push a *clean* snapshot onto history even though slider preview
   *  mutates `clip`'s keyframes in place between commits. */
  clipSnapshot: AnimationClip | null
  /** The camera half of that same snapshot — see HistoryEntry. */
  cameraSnapshot: CameraKeyframe[]
  past: HistoryEntry[]
  future: HistoryEntry[]
}

/** One undo step. The clip and the camera move together: an edit to either is
 *  a change to the same document, and undoing a camera key should not silently
 *  roll a bone edit back with it (or vice versa). */
type HistoryEntry = { clip: AnimationClip | null; camera: CameraKeyframe[] }

export type StudioClipCommit = Dispatch<SetStateAction<AnimationClip | null>>
export type StudioKeyframesSetter = Dispatch<SetStateAction<SelectedKeyframe[]>>

export type StudioActions = {
  commit: StudioClipCommit
  /** Add a clip to the library WITHOUT making it the one being edited — what
   *  Import VMD does. Returns the id so the caller can reveal the new row. */
  importClip: (name: string, clip: AnimationClip) => ClipId
  /** Edit a different library clip. Selections that name something the new clip
   *  does not have are dropped by the caller, not here. */
  activateClip: (id: ClipId) => void
  /** Replace the whole library with this one clip — what Open VMD and New do.
   *  Keeps the model, the camera and the music, like the old single-clip Load. */
  openClip: (name: string, clip: AnimationClip) => void
  /** Put a whole library back, from a saved draft. No history — a restore is
   *  where the document starts, not something to undo past. */
  restoreLibrary: (library: LibraryClip[], activeClipId: ClipId | null) => void
  removeLibraryClip: (id: ClipId) => void
  renameLibraryClip: (id: ClipId, name: string) => void
  /** Load a clip without recording history — for VMD imports, PMX swaps,
   *  document reset. Clears past/future. Editing actions go through `commit`. */
  replaceClip: (next: AnimationClip | null) => void
  setClipDisplayName: (name: string) => void
  setSelectedBone: Dispatch<SetStateAction<string | null>>
  setSelectedMorph: Dispatch<SetStateAction<string | null>>
  setSelectedMaterial: Dispatch<SetStateAction<string | null>>
  setGizmoVisible: Dispatch<SetStateAction<boolean>>
  setIkEnabled: Dispatch<SetStateAction<boolean>>
  /** Commit a camera-track edit — undoable, like `commit` is for the clip. */
  commitCamera: Dispatch<SetStateAction<CameraKeyframe[]>>
  /** Load a camera track without recording history (file import, restore). */
  replaceCameraTrack: (next: CameraKeyframe[]) => void
  setCameraSelected: Dispatch<SetStateAction<boolean>>
  setCameraVmdEnabled: Dispatch<SetStateAction<boolean>>
  setSelectedKeyframes: StudioKeyframesSetter
  undo: () => void
  redo: () => void
}

const INITIAL_STATE: StudioState = {
  library: [],
  activeClipId: null,
  clip: null,
  clipDisplayName: "clip",
  selectedBone: null,
  selectedMorph: null,
  selectedMaterial: null,
  gizmoVisible: false,
  cameraTrack: [],
  cameraSelected: false,
  cameraVmdEnabled: true,
  ikEnabled: true,
  selectedKeyframes: [],
  clipSnapshot: null,
  cameraSnapshot: [],
  past: [],
  future: [],
}

/** Deep-enough copy of a camera track: the keyframe objects are replaced (a
 *  drag mutates them in place) while target/rotation Vec3s are swapped whole by
 *  the channel setters rather than mutated, so sharing them is safe. */
function cloneCameraTrack(track: CameraKeyframe[]): CameraKeyframe[] {
  return track.map((kf) => ({ ...kf }))
}

/**
 * The library, with the active entry's clip pointed at `clip`.
 *
 * Called from every path that changes `clip` — commit, replace, undo, redo — so
 * the two can never describe different keyframes. Doing it here rather than at
 * the call sites is the point: an edit path that forgets would leave the
 * library holding a clip the editor has already moved past, and nothing on
 * screen would say so until the next export.
 */
function libraryWithActiveClip(state: StudioState, clip: AnimationClip | null): LibraryClip[] {
  if (clip == null || state.activeClipId == null) return state.library
  let touched = false
  const next = state.library.map((entry) => {
    if (entry.id !== state.activeClipId || entry.clip === clip) return entry
    touched = true
    return { ...entry, clip }
  })
  return touched ? next : state.library
}

/** Resolve a `SetStateAction<T>` against the current value. */
function resolve<T>(action: SetStateAction<T>, prev: T): T {
  return typeof action === "function" ? (action as (p: T) => T)(prev) : action
}

type StudioStore = {
  getState: () => StudioState
  subscribe: (listener: () => void) => () => void
  actions: StudioActions
}

function createStudioStore(): StudioStore {
  let state = INITIAL_STATE
  const listeners = new Set<() => void>()

  /** Replace state and notify — no-op if nothing changed. */
  const set = (next: StudioState) => {
    if (next === state) return
    state = next
    listeners.forEach((l) => l())
  }

  /** Update a single field, bailing if the resolved value is identical. */
  const update = <K extends keyof StudioState>(key: K, action: SetStateAction<StudioState[K]>) => {
    const next = resolve(action, state[key])
    if (next === state[key]) return
    set({ ...state, [key]: next })
  }

  /** Append a snapshot to `past`, capping at HISTORY_LIMIT (drop oldest).
   *  A null clip with no camera keys is nothing to go back to, so it is not
   *  recorded — but a null clip WITH a camera track still is: the camera is
   *  half the document and can be edited on its own. */
  const pushPast = (past: HistoryEntry[], snap: HistoryEntry): HistoryEntry[] => {
    if (snap.clip == null && snap.camera.length === 0) return past
    const next = past.length >= HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT + 1) : past.slice()
    next.push(snap)
    return next
  }
  /** The state's current snapshot, as one history entry. */
  const snapshotOf = (st: StudioState): HistoryEntry => ({ clip: st.clipSnapshot, camera: st.cameraSnapshot })

  const actions: StudioActions = {
    commit: (payload) => {
      const next = resolve(payload, state.clip)
      if (next == null) {
        set({
          ...state,
          clip: null,
          clipSnapshot: null,
          past: pushPast(state.past, snapshotOf(state)),
          future: [],
          selectedBone: null,
          selectedMorph: null,
          selectedKeyframes: [],
        })
        return
      }
      const finalNext = clipAfterKeyframeEdit(next)
      set({
        ...state,
        clip: finalNext,
        library: libraryWithActiveClip(state, finalNext),
        clipSnapshot: cloneAnimationClip(finalNext),
        past: pushPast(state.past, snapshotOf(state)),
        future: [],
      })
    },
    replaceClip: (next) => {
      if (next == null) {
        set({
          ...state,
          clip: null,
          clipSnapshot: null,
          past: [],
          future: [],
          selectedBone: null,
          selectedMorph: null,
          selectedKeyframes: [],
        })
        return
      }
      const finalNext = clipAfterKeyframeEdit(next)
      set({
        ...state,
        clip: finalNext,
        library: libraryWithActiveClip(state, finalNext),
        clipSnapshot: cloneAnimationClip(finalNext),
        past: [],
        future: [],
      })
    },

    importClip: (name, clip) => {
      const entry: LibraryClip = { id: newId(), name, clip: clipAfterKeyframeEdit(clip) }
      set({ ...state, library: [...state.library, entry] })
      return entry.id
    },

    activateClip: (id) => {
      const entry = state.library.find((c) => c.id === id)
      if (!entry || id === state.activeClipId) return
      // The working clip becomes the entry's own object, so the drag paths keep
      // mutating in place exactly as they did with one clip.
      set({
        ...state,
        activeClipId: id,
        clip: entry.clip,
        clipDisplayName: entry.name,
        clipSnapshot: cloneAnimationClip(entry.clip),
        // The other clip's keys are not this clip's keys, and a stale
        // selection would delete or drag something the user cannot see.
        selectedKeyframes: [],
        past: [],
        future: [],
      })
    },

    openClip: (name, clip) => {
      const finalNext = clipAfterKeyframeEdit(clip)
      const entry: LibraryClip = { id: newId(), name, clip: finalNext }
      set({
        ...state,
        library: [entry],
        activeClipId: entry.id,
        clip: finalNext,
        clipDisplayName: name,
        clipSnapshot: cloneAnimationClip(finalNext),
        selectedKeyframes: [],
        past: [],
        future: [],
      })
    },

    restoreLibrary: (library, activeClipId) => {
      const active = library.find((c) => c.id === activeClipId) ?? library[0] ?? null
      set({
        ...state,
        library,
        activeClipId: active?.id ?? null,
        clip: active?.clip ?? null,
        clipDisplayName: active?.name ?? "clip",
        clipSnapshot: active ? cloneAnimationClip(active.clip) : null,
        selectedKeyframes: [],
        past: [],
        future: [],
      })
    },

    removeLibraryClip: (id) => {
      const library = state.library.filter((c) => c.id !== id)
      if (library.length === state.library.length) return
      if (id !== state.activeClipId) {
        set({ ...state, library })
        return
      }
      // Removing what is being edited moves the edit to whatever is left, and
      // to an empty document when nothing is.
      const next = library[0] ?? null
      set({
        ...state,
        library,
        activeClipId: next?.id ?? null,
        clip: next?.clip ?? null,
        clipDisplayName: next?.name ?? "clip",
        clipSnapshot: next ? cloneAnimationClip(next.clip) : null,
        selectedBone: null,
        selectedMorph: null,
        selectedKeyframes: [],
        past: [],
        future: [],
      })
    },

    renameLibraryClip: (id, name) => {
      set({
        ...state,
        library: state.library.map((c) => (c.id === id ? { ...c, name } : c)),
        clipDisplayName: id === state.activeClipId ? name : state.clipDisplayName,
      })
    },

    setClipDisplayName: (name) => update("clipDisplayName", name),
    // Selecting a bone does NOT summon the gizmo — see `gizmoVisible`. The
    // viewport dblclick path asks for it explicitly, because there the pick and
    // the intent to grab are the same gesture.
    setSelectedBone: (payload) => update("selectedBone", payload),
    setSelectedMorph: (payload) => update("selectedMorph", payload),
    setSelectedMaterial: (payload) => update("selectedMaterial", payload),
    setGizmoVisible: (payload) => update("gizmoVisible", payload),
    setIkEnabled: (payload) => update("ikEnabled", payload),
    setSelectedKeyframes: (payload) => update("selectedKeyframes", payload),
    // Editing the shot puts you behind it. Both camera writers do this rather
    // than the call sites, so no edit path can forget: dragging a keyframe in
    // the timeline, nudging a slider in the inspector and importing a VMD all
    // land here. Otherwise you tune a camera you are not looking through and
    // the viewport never reacts — the edit appears to do nothing.
    //
    // Only when there is something to follow: an emptied track (Clear camera)
    // must hand the viewport back to orbit, not point it at nothing.
    commitCamera: (payload) => {
      const next = resolve(payload, state.cameraTrack)
      const sorted = [...next].sort((a, b) => a.frame - b.frame)
      set({
        ...state,
        cameraTrack: sorted,
        cameraSnapshot: cloneCameraTrack(sorted),
        cameraVmdEnabled: sorted.length > 0 ? true : state.cameraVmdEnabled,
        past: pushPast(state.past, snapshotOf(state)),
        future: [],
      })
    },
    replaceCameraTrack: (next) => {
      const sorted = [...next].sort((a, b) => a.frame - b.frame)
      set({
        ...state,
        cameraTrack: sorted,
        cameraSnapshot: cloneCameraTrack(sorted),
        cameraVmdEnabled: sorted.length > 0 ? true : state.cameraVmdEnabled,
        past: [],
        future: [],
      })
    },
    setCameraSelected: (payload) => update("cameraSelected", payload),
    setCameraVmdEnabled: (payload) => update("cameraVmdEnabled", payload),
    undo: () => {
      if (state.past.length === 0) return
      const popped = state.past[state.past.length - 1]
      const past = state.past.slice(0, -1)
      const future = [snapshotOf(state), ...state.future]
      // popped is immutable; clone it so preview-time mutation can't poison history.
      const restored = popped.clip ? cloneAnimationClip(popped.clip) : null
      set({
        ...state,
        clip: restored,
        library: libraryWithActiveClip(state, restored),
        clipSnapshot: popped.clip,
        cameraTrack: cloneCameraTrack(popped.camera),
        cameraSnapshot: popped.camera,
        past,
        future,
      })
    },
    redo: () => {
      if (state.future.length === 0) return
      const popped = state.future[0]
      const future = state.future.slice(1)
      const past = pushPast(state.past, snapshotOf(state))
      const restored = popped.clip ? cloneAnimationClip(popped.clip) : null
      set({
        ...state,
        clip: restored,
        library: libraryWithActiveClip(state, restored),
        clipSnapshot: popped.clip,
        cameraTrack: cloneCameraTrack(popped.camera),
        cameraSnapshot: popped.camera,
        past,
        future,
      })
    },
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    actions,
  }
}

const StudioStoreContext = createContext<StudioStore | null>(null)

export function Studio({ children }: { children: ReactNode }) {
  const storeRef = useRef<StudioStore | null>(null)
  if (storeRef.current == null) storeRef.current = createStudioStore()
  return createElement(StudioStoreContext.Provider, { value: storeRef.current }, children)
}

function useStudioStore(): StudioStore {
  const store = useContext(StudioStoreContext)
  if (store == null) throw new Error("useStudio* must be used within <Studio>")
  return store
}

/** Subscribe to a slice of studio state. Component re-renders only when the
 *  selected value changes (Object.is compare). Selectors should return a
 *  reference-stable value from state — prefer top-level fields. */
export function useStudioSelector<T>(selector: (state: StudioState) => T): T {
  const store = useStudioStore()
  const getSnapshot = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** Stable actions bag — never causes a re-render. Use this in components that
 *  only dispatch without reading state. */
export function useStudioActions(): StudioActions {
  return useStudioStore().actions
}

