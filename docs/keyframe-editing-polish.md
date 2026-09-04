# Keyframe editing: polish for the clip-mode release

A review of the Keys view, the Properties inspector and the bone/morph lists
as they stand at `b80b415`, done 2026-09-03 alongside `clip-mode-plan.md`.
Everything here ships in the same release as clip mode. Tier A is fixes and
can land at any point, including before Phase 1. Tiers B and C are workflow
and curve-editor ergonomics and slot in after Phase 2, in the order given.
Sizes: S is under half a day, M is a day, L is more.

Every item names where it lives so the implementer can go straight there.

## Tier A: fixes

1. **Interpolation drags flood the undo stack.** (S)
   `InterpolationSection.applyInterpolation` in `properties-inspector.tsx`
   calls `commit` on every pointer move of the curve editor, so one handle
   drag is dozens of history entries and dozens of engine reuploads. The
   camera side does the same twice: `CameraSection.applyIp`, and the camera
   sliders' `onChange` → `applyChannel` → `commitCamera` per tick. Give
   `InterpolationCurveEditor` an `onCommit` fired on pointer up, mutate the
   keyframe's interpolation in place during the drag with a redraw, and
   commit once. Camera sliders get the same preview/commit split the bone
   sliders already have.

2. **A key dragged onto another leaves two keys on one frame.** (S)
   `onMoveDopeKeyframe`, `onMoveDopeColumns`, `onMoveCurveKeyframe` and
   `onMoveMorphKeyframe` in `timeline.tsx` set `kf.frame` and sort; nothing
   removes the key already at the landing frame. The track then carries a
   duplicate frame into the engine and the export. `pasteAtPlayhead` already
   does the right thing (filter the landing frame, then insert). On
   `onEndKeyframeDrag`, dedupe every touched track with the dragged key
   winning, and show the column that will be replaced while dragging (a
   hollow diamond under the dragged one).

3. **Column operations disagree about which bones they mean.** (S)
   With no bone selected, dragging a dope column moves keys on
   `visibleBones` (the group filter), while `deleteSelectedKeyframes` and
   `copySelectedKeyframes` in `studio.tsx` walk every bone track in the
   clip. A user filtered to Left Arm who deletes a column loses the whole
   body's keys at that frame. Thread `visibleBones` into both so the column
   means "the bones the dopesheet is showing".

4. **Translation input clamps at ±10.** (S)
   `AxisSliderRow` clamps both the slider and the typed value to `min..max`,
   and `TRA_RANGE` is ±10. `lib/animation.ts` documents the range as advisory
   because a センター bone legitimately travels further. Accept any typed
   value, and grow the slider's range to include the current value (rounded
   up to the next multiple of 10) so the thumb stays on the track.

5. **Inserting a key changes the motion.** (S, after Phase 1)
   `insertKeyframeAtPlayhead` in `studio.tsx`, and the slider preview paths
   in `properties-inspector.tsx` and the gizmo handler in
   `engine-bridge.tsx` when they key an unkeyed frame, take the sampled pose
   and `interpolationTemplateForFrame` (a copy of the previous key's curve).
   The segment after the new key then eases differently from before. Use
   `splitInterpolation` from Phase 1: the new key gets the left half, the
   next key gets the right half, and the curve on screen does not move.

6. **Curve hit-testing picks the first dot in reach, not the nearest.** (S)
   `hitTest` in `timeline.tsx` returns on the first channel whose dot is
   within `DOT_R + 5`. Where All Rot draws three dots close together, the
   pick follows channel order. Keep the minimum distance across channels.

7. **Delete, copy, cut and paste need the canvas focused.** (S)
   They live on the canvas's `onKeyDown`; the arrow keys already use a window
   listener with an input guard. After a slider drag the canvas has lost
   focus and Delete does nothing. Move the four onto the same window listener.

## Tier B: the workflow MMD animators expect

8. **Loop range.** (M)
   The single most-used tool while polishing a beat: play 40 frames on
   repeat. In and out marks on the ruler (`[` and `]` set them at the
   playhead, `L` toggles looping, drag the marks to adjust, Alt-drag on the
   ruler to draw a range). `EngineBridge`'s rAF loop seeks back to `in` when
   the frame passes `out`, through `maybeResetPhysicsAfterSeek` so the wrap
   does not explode physics. The range is view state (persisted, not in
   history) and draws as a lit band on the ruler in both timeline views.

9. **Interpolation applies to the selection.** (M)
   MMD's own curve panel writes to the selected frames. Ours edits only the
   key under the playhead (`canEditIp` in `InterpolationSection`). When a
   selection exists, presets and handle drags apply to every selected key of
   the shown bone, and to every column when no bone is selected. Add an
   **All** tab beside Rotation / Trans X / Y / Z that writes all four
   channels, which is how MMD users set a whole key's easing in one click.
   The camera panel gets All across its six channels.

10. **Key the whole pose.** (S)
    `insertKeyframeAtPlayhead` keys the selected bone. Blocking a dance is
    pose-to-pose: every bone at once. Shift+I and a **Key pose** button beside
    Insert key every visible bone that has a track (and the selected bone
    even without one) at the playhead, from the sampled pose, in one commit.

11. **Mirrored paste.** (M)
    On the README's roadmap already. Paste with the left/right swap
    (左↔右, and the ＩＫ/IK, 親指 and twist bones follow the same rename),
    rotation `(x, y, z, w) → (x, −y, −z, w)` and translation `x → −x`,
    interpolation copied as is. Center bones mirror in place. Cmd+Shift+V,
    and a **Mirror paste** button in Operations. Copying 左腕 and mirror-pasting
    while 右腕 is selected lands on 右腕.

12. **Search in the bone and morph lists, morphs grouped by panel.** (S + engine S)
    A filter input at the top of each list (`bone-list.tsx`, `morph-list.tsx`),
    matching Japanese and the English label from `BONE_NAME_EN`. Morphs are
    grouped the way MMD groups them, by PMX panel (眉 / 目 / 口 / その他).
    The engine parses `panel` in `pmx-document.d.ts` but `Morph` does not
    carry it; expose `Morph.panel` in reze-engine (one field through the
    loader) and group on it. Until then, group by name heuristics behind the
    same UI.

13. **Keyboard.** (S)
    `I` insert key · `Shift+I` key pose · `,` / `.` previous / next key
    (the arrows keep their current meaning) · `F` fit (Tier C) · `Esc` clear
    selection · Cmd+A select every key on the shown track · Alt+← / → nudge
    the selection one frame, with Shift ten · `L`, `[`, `]` for the loop
    range. A `?` shortcuts sheet as a Dialog, generated from one table the
    README section also renders from.

14. **Axis lock and fine drag in the curve editor.** (S)
    Shift while dragging a handle locks to the dominant axis (time or value)
    so a value tweak stops nudging the frame. Alt scales the value delta by
    0.1 for fine work.

## Tier C: curve-editor ergonomics

15. **Value axis that follows the data.** (M)
    `getAxisConfig` fixes the plotted range (±200° for rotation, ±10 for
    translation) and `yZoom` scales around the axis centre, so a curve
    living at 150° zooms out of view and there is no vertical pan. Add
    `yPan`, fit-to-data on `F` and on bone / tab change (padding 10%),
    Shift+wheel zooms around the cursor's value, and Alt-drag or middle-drag
    pans vertically. Ticks stay at the same steps.

16. **Zoom at the cursor.** (S)
    `zoomTo` anchors on the playhead. Ctrl/Cmd+wheel should anchor on the
    cursor's frame; the toolbar slider keeps the playhead anchor.

17. **Hover readout.** (S)
    Frame and value beside the hovered key or curve point, in the channel's
    colour, drawn in the per-tick overlay. With no bone selected, hovering a
    dope column lists the bones keyed there (up to eight, then "+N").

18. **Two-row dopesheet.** (M)
    Selecting a bone replaces the overview row with that bone's keys
    (`getDopeFrames`). Keep both: an **All** row for the shown bones and a
    row for the selected bone, 22px each in the current 34px budget plus
    10px. The column gestures act on whichever row was grabbed.

19. **Seconds on the ruler.** (S)
    Major ticks carry `m:ss.f` under the frame number when there is room
    (below about 6 px per frame), and the transport's frame chip shows the
    time beside the frame. The music lane is already drawn in real time.

20. **Overview strip.** (S)
    A 4px navigator under the ruler showing the visible window inside the
    clip, draggable. At the 0.5 px/frame minimum a long clip has no other
    indication of where you are.

21. **Time-stretch a selection.** (M, after Phase 1)
    Alt-drag either edge of the sticky selection box to scale the selected
    keys' frames around the opposite edge, rounding to integers with
    collisions resolved as in item 2, and interpolation preserved. This is
    the README's "time stretch" and it stays inside one clip; retiming a
    whole clip is the library's Retime… in the clip plan.

## Not this release

- Bezier handles drawn and dragged on the timeline curve itself. The whole
  interpolation editor in place. L, and worth its own design pass once the
  value axis (item 15) is in.
- Per-bone dopesheet lanes. Clip mode takes the vertical budget this release.
- Playback rate (0.5×, 0.25×). reze-engine has no rate API today; needs one.

## Order

Tier A first, as one small branch or folded into Phase 1. Then 8, 9, 10, 12,
13 with Phase 2 since they touch the same toolbar and inspector. Then 11, 14
and Tier C. Each item ends with Amy's browser test, no commits before.
