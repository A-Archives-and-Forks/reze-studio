# Clip mode: non-linear editing of VMD clips

Plan for turning reze-studio from a single-clip curve editor into a project
that holds many clips and arranges them on tracks. Written 2026-09-03 for the
implementation session. Everything here was checked against the working tree
at `b80b415` plus the uncommitted reze-engine 0.55.0 bump, which typechecks.

The old `clip` branch (last commit `9413ae9`, merge-base `ac8029e`, engine
0.21 era) is superseded by this document. Delete it locally and on origin at
the start of the implementation session and branch fresh from `main`:

```sh
git branch -D clip && git push origin --delete clip
git switch -c clips
```

## 1. Goal and scope

A user imports several VMD files, trims them, cuts them into pieces, lays them
end to end, and stacks them on tracks so a face file plays over a body file
and a hand file plays over both. The keyframe editor keeps working, on one
clip at a time, inside that arrangement. Export flattens the arrangement into
one VMD. Everything autosaves, and a project can be saved and reopened as a
file.

In V1:

- Project = library of clips + tracks of placements + the camera track.
- Arrange view in the timeline: move, trim, split, delete, duplicate placements;
  add, rename, reorder, mute, solo, delete tracks.
- Keys view (today's dopesheet + curves) edits the active placement's clip in
  arrangement time, with the composite playing in the viewport.
- Implicit per-bone / per-morph masking between tracks: the topmost track that
  keys a name at a frame owns that name at that frame.
- Exact cuts: a trim or split reproduces the source motion inside the cut, via
  bezier splitting at the boundary.
- Autosave of the whole project; `.rsproj` save/open; migration of the
  existing single-clip draft.

Later phases: camera clips on a camera track, retime (time stretch) as a
library operation, keyframe-density sparklines inside blocks, ghost keys from
other tracks in Keys view. Out of scope entirely: music editing, crossfades
and blend weights between tracks, explicit bone-mask UI (V2, after users ask).

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Clip** | A VMD's worth of keyframes (`AnimationClip`), stored once in the library. |
| **Library** | The project's bin of imported and created clips. Left column, Clips section. |
| **Track** | A horizontal lane in the arrangement. Top track has priority. |
| **Placement** | A clip laid on a track: which clip, where it starts, and which local range of it plays. |
| **Arrange view** | The timeline showing tracks and placements as blocks. |
| **Keys view** | The timeline showing the active placement's dopesheet and curves. Today's timeline. |
| **Active placement** | The one placement whose clip Keys view, the inspector, the bone list and the gizmo edit. |
| **Composite** | What the viewport plays: the arrangement baked into one flat clip. |

Say "track" for lanes. The word "layer" stays out of code, UI and README.

## 3. Decisions

Each of these was weighed; the rationale is one line so the implementer does
not reopen it.

1. **Keys view edits in arrangement time.** The ruler shows arrangement
   frames, the playhead is global, the viewport plays the composite, and the
   active clip's keys are drawn at `local + offset`. Editing a hand clip
   layered over a dance is only useful if you can see the dance while you do
   it. The single-clip workflow has offset 0 and is pixel-identical to today.
2. **Placements carry only integer trims, no time scale.** `offset = start -
   in` is a constant integer, so local and arrangement frames map both ways
   without rounding. Retime is a library operation that creates a new
   resampled clip (phase 3).
3. **Placements reference library clips; editing one edits every placement of
   that clip.** A split produces two placements of one clip with disjoint
   local ranges, so editing either half touches only its own frames. A loop
   made by placing a clip three times follows edits, which is what a loop
   wants. Blocks show a `×N` badge when the clip is placed more than once, and
   "Make unique" copies the clip into the library for the one placement.
4. **No overlaps within a track.** Dragging clamps to the nearest free gap.
   Layering is what other tracks are for; it keeps the bake a per-frame
   lookup with at most one owner per track.
5. **Ownership is per frame, per name.** For each bone, morph and IK name, at
   each frame, the topmost active track that has a placement covering the
   frame whose clip keys that name owns it. A hand clip from 300 to 400 on
   Track 1 overrides the dance's hands only in 300 to 400.
6. **Cuts are exact.** Where ownership changes mid-segment, the bake
   synthesizes a key from the sampled pose and splits the segment's bezier so
   the motion inside the cut is the source motion.
7. **Gaps hold the last pose.** Frames no placement covers for a name emit no
   keys. The engine holds the last key, as VMD does between keys.
8. **Mode toggle lives in the timeline toolbar.** Arrange | Keys as the first
   control on the left. The left column's Clips section is a library panel and does
   not change the timeline's mode.
9. **Blocks are DOM, the axis is canvas.** The ruler, grid, waveform and
   playhead come from the existing canvas code; the track lanes and clip blocks
   are DOM elements positioned by the same `pxPerFrame` / `scrollX`. This is
   the pattern reze-design uses for effect strips
   (`../reze-design/components/scene/effect-strips.tsx`) and it gives labels,
   tooltips, context menus and cursors for free.
10. **History is unified and structurally shared.** One undo stack covers
    keyframe edits, arrangement edits and camera edits. A keyframe commit
    clones only the edited clip; an arrangement commit clones nothing.
11. **Engine stays as it is.** `Model.loadClip` takes the baked clip.
    `setBlendPose` averages toward rest for missing bones, which is the wrong
    semantic for layering, so it is not used. No reze-engine change is
    required for V1.
12. **Open VMD stays as the fast path.** It replaces the arrangement with the
    one file, keeping model, camera and music, exactly today's Load VMD.
    Import VMD adds to the library and auto-places only into an empty
    arrangement.

## 4. Data model

`lib/project.ts`, pure functions, no React.

```ts
export type ClipId = string
export type PlacementId = string
export type TrackId = string

export interface LibraryClip {
  id: ClipId
  name: string                 // file stem at import; renamable
  clip: AnimationClip          // immutable snapshot; see store
}

export interface Placement {
  id: PlacementId
  clipId: ClipId
  start: number                // arrangement frame where local frame `in` lands
  in: number                   // first local frame (inclusive), 0 at import
  out: number | null           // local end (exclusive); null = clip.frameCount, so an
                               // untrimmed placement grows when keys are added at the end
}

export interface Track {
  id: TrackId
  name: string
  mute: boolean
  solo: boolean
  placements: Placement[]      // sorted by start, pairwise disjoint
}

export interface Project {
  name: string
  library: LibraryClip[]       // import order
  tracks: Track[]              // index 0 is the top lane and wins ownership
}
```

Derived helpers, all exported:

```ts
outOf(p, clip)          // p.out ?? clip.frameCount
placementLength(p, clip)
placementEnd(p, clip)   // p.start + placementLength
offsetOf(p)             // p.start - p.in;  arrangement = local + offset
projectEnd(project, cameraTrack)  // max(placement ends, last camera key, DEFAULT_STUDIO_CLIP_FRAMES)
findPlacement(project, id) → { track, placement, clip } | null
placementsUsing(project, clipId)
```

Operations return a new `Project` and never mutate. Every one enforces the
invariants (no overlap, `0 ≤ in < out ≤ clip.frameCount`, `start ≥ 0`):

```ts
addClip(project, name, clip) → { project, clipId }
removeClip(project, clipId)             // cascades to its placements
renameClip, duplicateClip
addTrack(project, name?)                // appended at the bottom
removeTrack, renameTrack, moveTrack(id, dir), setTrackMute, setTrackSolo
addPlacement(project, trackId, clipId, start)      // clamps into the nearest free gap
movePlacement(project, id, start, trackId?)        // same clamp; cross-track allowed
trimPlacement(project, id, { in?, out? })          // bounded by clip range and neighbours
splitPlacement(project, id, atArrangementFrame)    // → two placements, same clip
removePlacements(project, ids)
duplicatePlacement(project, id)                    // lands right after the original
makeUnique(project, placementId)                   // duplicateClip + repoint
retainForModel(project, boneSet, morphSet)         // clipRetainedForModel over every library clip
newProjectWith(name, clip)                         // one track, one placement at 0
```

The clamp rule for move/add: try the requested start; if it overlaps a
neighbour on the target track, slide to the closest edge that fits (before or
after, whichever is nearer); if nothing fits, reject and leave the project
unchanged. Snapping (playhead, block edges, frame 0, 6px reach) is the view's
job; copy `snapped()` from reze-design's effect strips.

## 5. Bake

`bakeProject(project, cameraTrack): AnimationClip` and
`bakeName(project, kind: "bone" | "morph" | "ik", name): Keyframe[]` in
`lib/bake.ts`. The full bake is `bakeName` over the union of names, wrapped in
Maps with names in sorted order so the engine's retirement diff sees a stable
shape.

Active tracks: the solo set when any track is soloed, otherwise every unmuted
track.

For one name `n` of kind `k`:

1. **Ownership intervals.** Walk active tracks top to bottom. For each
   placement whose clip has a non-empty `n` track, its arrangement span
   `[start, end)` claims every frame not yet claimed. The result is a sorted
   list of disjoint `(from, to, placement)` intervals.
2. **Emit per interval**, with `local(f) = f - offsetOf(p)` and the source
   track `T`:
   - The key at `from`: the real key when `T` has one at `local(from)`;
     otherwise a synthesized key with the sampled pose at `local(from)` and
     linear interpolation (the one-frame join from the previous owner has no
     curve worth preserving).
   - Every real key with local frame strictly inside `(local(from), local(to - 1))`.
     The first real key after a synthesized `from` key gets a copy whose
     interpolation is the **right half** of its own bezier split at `from`,
     since it now shapes the shorter segment `from → key`.
   - The key at `to - 1` when `to - 1 > from`: real if present, otherwise
     synthesized from the sampled pose with interpolation equal to the **left
     half** of the enclosing segment's bezier split at `to - 1`, since it
     shapes `previousKey → to - 1`.
   - Frames are `local + offset`. Keyframe objects are always fresh copies
     (frames differ from the source), using `cloneBoneInterpolation` for the
     untouched ones.
3. Bones use `evalBoneTrackAt` for samples; morphs use `sampleMorphTrackAt`
   and carry no bezier; IK uses the step state at `local(from)` plus real
   keys inside.
4. `frameCount = projectEnd(project, cameraTrack)`.

Why the split is exact: slerp is linear in angle along one geodesic, so
`slerp(a, slerp(a, b, c), y / c) = slerp(a, b, y)`; translation lerp is linear
per axis. Splitting the timing bezier and renormalizing each half reproduces
the same eased parameter, so the pose at every frame inside the cut equals the
source. Add `splitInterpolation(ip, t): { left, right }` to `lib/animation.ts`:
per channel, treat the four bytes as a cubic from (0,0) to (127,127), find the
bezier parameter `s` with `x(s) = t · 127` by bisection (x is monotonic), de
Casteljau at `s`, renormalize each half to its own (0,0)–(127,127) box, round
and clamp to 0..127. A degenerate half (zero width or height) falls back to
the linear pair (20, 20, 107, 107).

Cost is linear in total keys. The full bake runs once per commit. Preview hot
paths (slider drag, gizmo drag, dope and curve drags) call `bakeName` for the
one bone or morph being touched and patch that entry into the loaded baked
clip before `model.loadClip`, so a 100k-key project stays fluid during a drag.

## 6. Store and history

`context/studio-context.ts` grows; nothing existing is renamed.

```ts
StudioState {
  project: Project                    // immutable; library clips are snapshots
  activePlacementId: PlacementId | null
  clip: AnimationClip | null          // WORKING copy of the active clip, mutated in place during drags (today's role)
  clipSnapshot: AnimationClip | null  // the library entry's clip for the active placement
  selectedPlacementIds: PlacementId[] // Arrange selection; not in history
  timelineMode: "arrange" | "keys"    // view; persisted, not in history
  activeClipEpoch: number             // bumps whenever the active clip identity changes; Timeline resets view state on it
  ...every existing field
}
HistoryEntry = { project: Project; camera: CameraKeyframe[]; activePlacementId: PlacementId | null }
```

Actions:

- `commit(clipAction)` keeps its signature. Resolve → `clipAfterKeyframeEdit`
  → clone → new `Project` with the active library entry's `clip` swapped for
  the clone → push the previous `{project, camera, activePlacementId}` →
  `clip = next`, `clipSnapshot = clone`.
- `commitProject(next: Project)` for arrangement and library ops. Pushes
  history. If the active placement is gone, picks the first placement of the
  first track (or null). If the active clip's identity changed, re-derives
  `clip` as a clone of the library entry and bumps `activeClipEpoch`.
- `replaceProject(next, activePlacementId?)` without history: open project,
  boot, migration, PMX swap.
- `setActivePlacement(id | null)` without history: `clip = clone(library
  clip)`, clears `selectedKeyframes`, keeps bone/morph selection when the
  clip has that name, bumps `activeClipEpoch`.
- `setSelectedPlacements`, `setTimelineMode`.
- `replaceClip(next)` stays as "replace the active clip's data without
  history" for the callers that need it (Clear motion uses `commit`, PMX swap
  uses `replaceProject`).
- `undo` / `redo` restore project, camera and active placement; `clip`
  becomes a fresh clone of the active library clip.

Selectors: `useActivePlacement()` → `{ placement, track, clip, offset } |
null`; `useActiveClipOffset()` → number, 0 when none; `useProjectEnd()`.

`clipVersion` in `StudioPage` is replaced by `activeClipEpoch` from the store.

## 7. Engine touchpoints

All in `components/engine-bridge.tsx` plus one small module,
`lib/engine-sync.ts`, that owns the only two ways the studio pushes a clip
into the engine:

```ts
syncCommit(model, project, cameraTrack, bakedRef)   // full bake, diff bone set, resetAllBones when a bone vanished, loadClip, seek
syncPreview(model, project, activePlacement, workingClip, bakedRef, { bone? | morph? })  // bakeName for one name, patch, loadClip
```

`bakedRef` holds the baked clip currently loaded so previews can patch it.
The fifteen `model.loadClip(STUDIO_ANIM_NAME, …)` calls in `engine-bridge.tsx`,
`studio.tsx` and `properties-inspector.tsx` become calls to these two. Export
calls `syncCommit` then `model.exportVmd`.

Other bridge changes:

- The "upload on edit" effect keys on `project` instead of `clip`.
- Playback span, end-of-clip stop, playhead clamp and the rAF loop read
  `projectEnd`.
- Gizmo drag and every "insert at playhead" path convert the playhead to a
  local frame with `useActiveClipOffset()` before touching `clip`. The read
  sites: 23 in `properties-inspector.tsx` (they cluster in the three sampler
  hooks and the keyframe-at-playhead lookup), 13 in `studio.tsx`, 2 in the
  gizmo handler. `readLocalPoseAfterSeek` keeps seeking at the arrangement
  frame, so a new key starts from the composite pose the user sees.
- Boot seeds the demo as one library clip (Classic motion with the bundled
  expressions merged in, as today) on one track. The single-clip first-run
  experience is unchanged.

## 8. UI

### 8.1 Left column

Top: the File menu as today. Below it, three stacked sections in one
`ResizablePanelGroup`, each with a collapsible header, the way a DCC's
project column reads: what you have, then what you are editing.

```
┌ CLIPS ▾ ───────────────────────── 3 ┐
│ Classic          1:32  B M IK  ×1   │
│ hand_wave        0:04  B       ×1   │  ← highlighted: the active clip
│ smile_face       0:41    M     ×2   │
│ [ Import VMD… ]                     │
├ BONES · hand_wave ▾ ───────────────┤
│ ▸ All Bones (142)                   │
│ ▾ Left Arm (9)                      │
│     左肩                      [12]  │
│     左腕                      [12]  │
├ MORPHS · hand_wave ▸ ──────────────┤
└─────────────────────────────────────┘
```

- **Clips** is the library: name, duration as `m:ss` with frames in the
  tooltip, capability chips (B bones, M morphs, IK), placement count. The
  active placement's clip carries the current accent. Hover actions (icon
  buttons wrapped in Tooltip): **Place at playhead** onto the selected track
  (Track 1 when none) and a `⋯` menu: Rename, Duplicate, Export VMD…, Remove
  (confirm when placed; cascades). Rows drag onto a lane in Arrange view.
  Double-click a row activates its first placement and switches to Keys.
  Sized to its rows up to about six, then scrolls; collapsible to its header.
- **Bones** is today's bone list, scoped to the active clip, and its header
  names that clip so the scope is never a guess.
- **Morphs** is today's morph list, same scope.
- Every section collapses to its header and the open ones share the
  remaining height through resizable handles; collapse state and sizes
  persist with the rest of the UI state.

Empty library: "Import a VMD to start a library." with the button.

### 8.1a Chrome

Decided 2026-09-03 from the design page's mockups:

- **Type.** Instrument Sans for UI text, JetBrains Mono for timeline chrome,
  numerals and file names. Swapped in `app/layout.tsx` through `next/font`
  and the two `--font-*` tokens; nothing else changes. reze-design and
  reze-build are on Geist today, so this is a family choice: apply it to
  all three, or accept studio diverging.
- **Accents.** blue-400 stays *selected*: the bone or morph row you picked,
  selected keys, a selected block. amber-400 becomes *current*: the active
  clip and placement, the key under the playhead, and engaged toggles
  (Solo, Snap, Loop, Gizmo). red-400 stays destructive. Design and build use
  amber for warnings; studio's warnings are text with an icon, so the hue is
  free here.
- **Surfaces.** The columns and the timeline render as the family's Surface
  skin (`bg-surface`, `border-line-strong`, `rounded-surface`) with the
  family's gutter, docked and resizable rather than floating, and both
  columns at 16rem. No backdrop blur over the live canvas.
- **Focus toggle.** One control collapses both columns, persisted like
  reze-design's dock-open flag, for an immersive viewport on demand.

### 8.2 Timeline shell

`Timeline` stays the shell and keeps owning `pxPerFrame`, `scrollX`, `yZoom`,
the toolbar and the `playheadDrawRef` handoff. It gains `mode`. The toolbar
row, left to right:

```
[Arrange|Keys] ⏮ ◀ ▶ ▶ ⏭ ═══slider═══ F 0000 / 0000 │ {mode area} … Time ▭▭▭ Value ▭▭▭
```

- Mode toggle: two chips in the channel-tab style, tooltips "Arrange clips on
  tracks" / "Edit the active clip's keyframes".
- Keys mode area: a **clip chip** naming the active placement
  (`Classic · T1 · 0–2760`; with one placement just the name), click reveals it
  in Arrange, then the channel tabs as today, then Time and Value zoom.
- Arrange mode area: `+ Track`, `✂ Split at playhead`, `Snap` toggle, then
  Time zoom only.
- The end field edits the active clip's `frameCount` in Keys mode (today's
  behaviour) and shows `projectEnd` read-only in Arrange mode.

Both modes share `pxPerFrame` and `scrollX`, so switching keeps the same time
window in view.

### 8.3 Arrange view

```
 label 96px │ ruler (canvas, arrangement frames)
────────────┼──────────────────────────────────────────────────────────────
 T1  M S  ⋯ │ ▓▓ Classic ▓▓▓▓▓▓▓▓▓▓▓▓▓▓│          │▓ hand_wave ▓│
 T2  M S  ⋯ │            │▓▓ smile_face ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
 + Add track│
 Music      │ ~~~~~~~~~~~~~~ waveform (canvas, existing) ~~~~~~~~~~~~~~~~~
```

Layers, bottom to top:

1. **Axis canvas.** `drawRuler` and `drawAudio` extracted from
   `TimelineCanvas`'s draw into `lib/timeline-draw.ts`, parametrized by label
   width (96 here, `LABEL_W` = 42 in Keys). Ruler drag scrubs, as today.
2. **Lanes.** One DOM row per track, 28px, with the header in the label
   column: name (double-click to rename with the shadcn `Input`), M and S
   toggles as Tooltip-wrapped icon buttons, `⋯` menu (Rename, Move up, Move
   down, Delete track). Muted tracks render their blocks at 40% opacity. A
   final "+ Add track" row.
3. **Blocks.** Absolutely positioned inside the lane at
   `left = labelW + (start · pxPerFrame) - scrollX`, `width = length ·
   pxPerFrame`. Style follows reze-design's strips: `rounded-chip border
   border-blue-400/50 bg-blue-400/20 hover:bg-blue-400/30`, selected
   `border-blue-400 bg-blue-400/35`, active placement gets an inner ring.
   Content: name truncated, `×N` badge when the clip is placed more than once,
   a scissors glyph at a trimmed edge. 6px edge zones show `ew-resize`, the
   middle `grab`.
4. **Playhead.** One DOM line, `pointer-events: none`, translated
   imperatively through the same `playheadDrawRef` contract the canvas uses.
   The compositor moves it at 60Hz without React.

Interactions:

| Gesture | Effect |
| --- | --- |
| Click block / Shift-click | Select / add to selection |
| Click empty lane | Clear selection |
| Drag block | Move in time, snap to playhead, block edges, frame 0; drag across lanes moves it to that track |
| Drag block edge | Trim `in` or `out`, bounded by the clip and neighbours |
| Alt-drag | Duplicate then move (phase 3) |
| Double-click block | Set active placement, switch to Keys |
| Delete / Backspace | Remove selected placements |
| S or ✂ | Split selected blocks at the playhead; with nothing selected, every block under the playhead |
| Cmd/Ctrl+A | Select all placements |
| Cmd/Ctrl+Z / Shift+Z | Shared history |
| ← / → | Playhead ±1; Shift jumps to the previous / next block edge |
| Right-click block | Context menu: Split at playhead, Duplicate, Make unique, Trim start to playhead, Trim end to playhead, Reveal in library, Remove |
| Drop from library | New placement at the drop frame, clamped into a gap |

During a drag only the block's DOM position updates; the project commits on
release, one history entry per gesture. This is the same hot-path discipline
the rest of the editor follows.

Empty arrangement: a centred "Drag a clip here, or File → Import VMD…".

### 8.4 Keys view changes

- Ruler in arrangement frames. Keys draw at `frame + offset`; hit-testing
  subtracts it. This is the one place `TimelineCanvas` learns about the
  offset: `toX(f) = ox + (f + offset) · pxPerFrame`, and the inverse.
- The active placement's `[start, end)` is the lit region; frames outside the
  cut but inside the clip get a hatched overlay on the dope strip and curve
  area, labelled "outside the cut" once, at the left edge. Keys there remain
  visible and editable; they are real data the trim excludes.
- No placement active (empty project): today's "Load VMD for timeline…"
  becomes "Place a clip on a track to edit its keys".

### 8.5 Right sidebar

Properties tab, mode-aware top section:

- Arrange mode with a selection: a **Placement** section: clip name, track,
  Start / In / Out / Length frame inputs in the transport's number-input
  style, buttons Split at playhead, Make unique, Remove. Several selected:
  count and Remove only.
- Keys mode: today's inspector for the active clip.

Materials tab is untouched.

### 8.6 File menu

```
New project
Reset project…
─
Load PMX folder…
Open VMD…              replaces the arrangement with this file (model, camera, music kept)
Import VMD…            adds to the library; multi-select; a camera-only file replaces the camera track
Import music…
Import reference video…
─
Open project…          .rsproj
Save project…          .rsproj
─
Export VMD…            the baked arrangement
Export motion only…    baked
Export morphs only…    baked
Export camera…
─
Clear motion           active clip
Clear morphs           active clip
Clear camera
Clear music
```

"Load morph VMD…" goes away: an expression file is a clip to place on a track
above the body. Import detects a file's contents: bone or morph keys make a
motion clip; camera keys and nothing else replace the camera track; both make
one of each.

### 8.7 Footer

The footer's clip name shows the active placement's clip. The message channel
announces imports ("Imported hand_wave — in the library, drag it onto a
track") and autosaves as today.

## 9. Persistence

- `lib/clip-codec.ts`: move `serializeClip` / `deserializeClip` out of
  `draft.ts` and add `serializeProject` / `deserializeProject`.
- `lib/project-store.ts`: IndexedDB `reze-studio-project`, store `project`,
  key `current`. Record: `{ project, activePlacementId, timelineMode,
  leftPanelTab, selectedPlacementIds, camera, ...today's DraftExtras }`. Same
  debounce, flush and clear API as `draft.ts`.
- Boot order: project record → else legacy draft (wrap as
  `newProjectWith(draft.clipDisplayName, draft.clip)`, save as project, clear
  the legacy draft) → else demo. `draft.ts` shrinks to its reader.
- `.rsproj`: `{ app: "reze-studio", type: "project", version: 1, project,
  camera, modelRef: { name }, musicRef?: { name } }`. The PMX is by name;
  music bytes stay in the audio store. Open validates the header and refuses
  unknown versions. Clips whose bones the current model lacks are retained in
  the library and filtered at bake time by `retainForModel` at open.

## 10. Build phases

Each phase ends with a typecheck, a build and a hand-off for Amy to test in
her browser. Commit only after she has.

### Phase 1: foundation, invisible

Files: `lib/project.ts`, `lib/bake.ts`, `lib/animation.ts`
(`splitInterpolation`), `lib/clip-codec.ts`, `lib/project-store.ts`,
`lib/engine-sync.ts`, `context/studio-context.ts`, `components/engine-bridge.tsx`,
`components/studio.tsx` (file handlers and menu), `components/properties-inspector.tsx`
(offset in samplers and the `loadClip` sites).

1. Types, ops and bake with unit tests in `lib/__tests__/` (node test runner,
   as reze-engine does): ownership intervals, boundary sampling, exactness of
   `splitInterpolation` (sample the source and the split at every frame, error
   below 1e-3 after 127-quantization), overlap clamping, split/trim round
   trips.
2. Store: project, active placement, unified history, epoch.
3. Engine sync module; replace every `loadClip` call.
4. Persistence and migration; `.rsproj` open/save; File menu items (Open VMD,
   Import VMD, Open/Save project, baked exports).
5. Offset plumbing in the inspector, gizmo, insert/paste at playhead, arrow
   jumps.

Test: the app behaves exactly as today with the demo; reload restores; an
existing draft migrates; Import VMD into a fresh project auto-places; Export
VMD of a one-clip project is byte-identical to the current export for the
same edits.

### Phase 2: the two views

Files: `components/timeline.tsx` (shell: mode, toolbar areas, offset in
`TimelineCanvas`, outside-the-cut overlay), `lib/timeline-draw.ts`,
`components/arrange-view.tsx` (lanes, blocks, playhead line, drag/trim/split),
`components/clip-library.tsx` (Clips section), `components/placement-inspector.tsx`,
`components/studio.tsx` (stacked left column, keyboard routing by mode, fonts and accent tokens),
`components/ui/tooltip.tsx`, `components/ui/context-menu.tsx`,
`components/ui/dropdown-menu.tsx` via `npx shadcn add`.

Test: import two files, place on two tracks, mute/solo, trim, split, move
across tracks, double-click into Keys, edit a key with the composite playing,
undo across both views, autosave round trip, export the composite and load it
in MMD or the studio.

### Phase 3: polish

Alt-drag duplicate, placement clipboard, keyframe-density sparkline in blocks
(reference `../reze-design/hooks/use-lane-graphs.ts` `useClipDensity`),
Retime… on the library row (resample via `evalBoneTrackAt`, new clip), camera
clips as a track kind (`Track.kind: "motion" | "camera"`, bake concatenates
`CameraKeyframe[]` with boundary samples from `CameraAnimation.sample`),
README section, screenshot.

## 11. Risks and gotchas

- **Offset misses.** A playhead read that forgets `- offset` inserts keys at
  the wrong frame only when a placement sits away from 0. Test with a
  placement at 300 in every editing gesture.
- **Working copy vs bake identity.** The baked clip is a copy; in-place
  mutation of `clip` during a drag reaches the engine only through
  `syncPreview`. Any new preview path must call it.
- **Vanishing bones.** When a bake drops a bone the engine holds its last
  pose. `syncCommit` diffs the bone set and calls `resetAllBones` before
  loading. Morph retirement is handled by the engine.
- **Solo and the active clip.** Soloing a track that does not contain the
  active placement makes Keys edits invisible in the viewport. The clip chip
  shows a muted glyph in that case.
- **`out: null` and trims.** A trimmed-then-extended clip keeps its trim;
  only null follows growth. Split pins both halves.
- **Overlap clamp during cross-track drags.** Clamp against the target
  track, not the source.
- **Timeline view reset.** `activeClipEpoch` replaces `clipVersion`; bump it
  on active-placement change, open project, new project and PMX swap.
- **Per-name morph masking vs MMD's wholesale expression override.** A body
  file's stray morphs that the face file does not name leak through. Named in
  the README; explicit masks are the V2 answer.

## 12. Conventions for the implementation session

- shadcn or existing repo components over raw elements; icon-only buttons
  wrapped in Tooltip; number inputs in the transport's style.
- Hot paths mutate refs, redraw imperatively, touch React once on release.
- No commits until Amy has browser-tested; no browser automation.
- Prose and comments state what things are. After a correction, delete the
  wrong thing and stop.
- Names: Track, Placement, Clip, Library, Arrange, Keys. "Layer" does not
  appear.
