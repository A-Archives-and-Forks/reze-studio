"use client"

/**
 * The arrangement: clips as blocks on lanes, over one time axis.
 *
 * DOM rather than canvas, unlike the keyframe view beside it. The mapping is
 * the same — `pxPerFrame` and `scrollX` come from <Timeline> and both views
 * read them — so a block cannot drift from the ruler above it, and everything
 * a block needs (a name that truncates, a cursor that changes at its edges, a
 * title, a context menu later) is free here and would be hit-testing
 * arithmetic in a canvas. The dopesheet is canvas because it draws thousands of
 * diamonds; a project holds tens of blocks.
 *
 * Priority runs top to bottom: lane 0 wins wherever two lanes key the same
 * bone at the same frame. That is the bake's rule (lib/bake.ts), and the lane
 * order on screen is the order it walks.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react"
import { Eye, EyeOff, Scissors } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStudioActions, useStudioSelector, projectOf } from "@/context/studio-context"
import { usePlayback } from "@/context/playback-context"
import { useT } from "@/lib/i18n"
import { registerClipDropTarget, useDraggingClipId } from "@/lib/clip-drag"
import {
  addPlacement,
  addTrack,
  clipById,
  fitStart,
  movePlacement,
  offsetOf,
  outOf,
  placementEnd,
  placementLength,
  removePlacements,
  setTrackMute,
  splitPlacement,
  trimPlacement,
  type ClipId,
  type Placement,
  type PlacementId,
  type Project,
  type Track,
} from "@/lib/project"
import { cn } from "@/lib/utils"

/** One lane's height, and the ruler's. Both are fixed: the lanes form a grid
 *  with the ruler, and a grid whose rows vary is not one. */
const LANE_H = 28
const RULER_H = 18
/** How close to an end grabs it instead of the block. Pixels, not a share of
 *  the width — an edge is a target for a pointer, and a short block would
 *  otherwise be two handles with no middle. */
const EDGE = 6
/** Pull, in pixels, so snapping feels the same at every zoom. */
const SNAP_PX = 6

type Drag =
  /** Dragging in empty lane space moves the playhead, the way the ruler does —
   *  the lanes are the same axis, and having to aim at an 18px strip to move
   *  the playhead is a rule nobody would guess. */
  | { kind: "scrub" }
  | {
      kind: "move"
      id: PlacementId
      startX: number
      startY: number
      from: number
      laneIndex: number
    }
  | { kind: "trim-in"; id: PlacementId; startX: number; from: number }
  | { kind: "trim-out"; id: PlacementId; startX: number; from: number }

/** Where a drag currently WOULD land, before it is committed. Held in state so
 *  the block follows the pointer; the project only changes on release, which is
 *  what keeps one gesture to one undo step. */
type Preview = {
  id: PlacementId
  start: number
  in: number
  out: number | null
  laneIndex: number
}

export interface ArrangeViewProps {
  pxPerFrame: number
  scrollX: number
  /** Width of the lane-header column, shared with the ruler above it. */
  labelWidth: number
  frameCount: number
  /** Written by the playback loop so the line moves without React. */
  playheadRef: RefObject<HTMLDivElement | null>
  /** Leave the arrangement and edit this placement's keyframes. */
  onEditPlacement: (id: PlacementId) => void
}

export const ArrangeView = memo(function ArrangeView({
  pxPerFrame,
  scrollX,
  labelWidth,
  frameCount,
  playheadRef,
  onEditPlacement,
}: ArrangeViewProps) {
  const t = useT()
  const library = useStudioSelector((s) => s.library)
  const tracks = useStudioSelector((s) => s.tracks)
  const clipDisplayName = useStudioSelector((s) => s.clipDisplayName)
  const activePlacementId = useStudioSelector((s) => s.activePlacementId)
  const selectedPlacementIds = useStudioSelector((s) => s.selectedPlacementIds)
  const { commitProject, setSelectedPlacements } = useStudioActions()
  const { currentFrame, setCurrentFrame, setPlaying } = usePlayback()

  const project = useMemo(() => projectOf({ library, tracks, clipDisplayName }), [library, tracks, clipDisplayName])

  const drag = useRef<Drag | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const lanesRef = useRef<HTMLDivElement | null>(null)
  const draggingClipId = useDraggingClipId()
  /** Where a clip dragged out of the library would land, while it is in the
   *  air. Null when the pointer is not over a lane. */
  const [dropAt, setDropAt] = useState<{ laneIndex: number; start: number } | null>(null)
  /**
   * A lane that is not there yet.
   *
   * Appears only while the pointer is actually over the row below the last real
   * one — not for the whole of every drag. A lane that opens the moment you
   * pick anything up is a lane you did not ask for, and it makes the arrangement
   * look one taller than it is throughout a move that was never going there.
   *
   * The pointer can reach it before it exists because the hit test already
   * reads one lane past the end; `tracks.length` is its index.
   */
  const phantomVisible = dropAt?.laneIndex === tracks.length || preview?.laneIndex === tracks.length

  const toX = useCallback(
    (frame: number) => labelWidth + frame * pxPerFrame - scrollX,
    [labelWidth, pxPerFrame, scrollX],
  )
  const toFrame = useCallback(
    (clientX: number) => {
      const el = lanesRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      return (clientX - rect.left - labelWidth + scrollX) / pxPerFrame
    },
    [labelWidth, pxPerFrame, scrollX],
  )

/**
   * The nearest thing worth landing on: the playhead, the start, and every
   * other block's two ends.
   *
   * Always on, with no switch. The pull is measured in PIXELS, so it shrinks to
   * nothing as you zoom in — six pixels is forty frames at the far end of the
   * range and less than one frame at the near end. A control for turning it off
   * was a control for a problem the pixel measure already solves.
   *
   * `exclude` is the block being dragged. Without it a trim would snap the edge
   * to where that same edge already is, and nothing would move.
   */
  const snapped = useCallback(
    (frame: number, exclude?: PlacementId) => {
      const reach = pxPerFrame > 0 ? SNAP_PX / pxPerFrame : 0
      let best = Math.round(frame)
      let bestDistance = reach
      const consider = (target: number) => {
        const d = Math.abs(target - frame)
        if (d <= bestDistance) {
          bestDistance = d
          best = target
        }
      }
      consider(0)
      consider(Math.round(currentFrame))
      for (const track of tracks) {
        for (const p of track.placements) {
          if (p.id === exclude) continue
          const lib = clipById(project, p.clipId)
          if (!lib) continue
          consider(p.start)
          consider(placementEnd(p, lib.clip))
        }
      }
      return Math.round(best)
    },
    [pxPerFrame, currentFrame, tracks, project],
  )

  // ── Gestures ────────────────────────────────────────────────────────────

  const onBlockPointerDown = useCallback(
    (placement: Placement, laneIndex: number, edge: "in" | "out" | null) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      const lib = clipById(project, placement.clipId)
      if (!lib) return
      setSelectedPlacements(
        e.shiftKey && !selectedPlacementIds.includes(placement.id)
          ? [...selectedPlacementIds, placement.id]
          : [placement.id],
      )
      drag.current =
        edge === "in"
          ? {
              kind: "trim-in",
              id: placement.id,
              startX: e.clientX,
              from: placement.in,
            }
          : edge === "out"
            ? {
                kind: "trim-out",
                id: placement.id,
                startX: e.clientX,
                from: outOf(placement, lib.clip),
              }
            : {
                kind: "move",
                id: placement.id,
                startX: e.clientX,
                startY: e.clientY,
                from: placement.start,
                laneIndex,
              }
      setPreview({
        id: placement.id,
        start: placement.start,
        in: placement.in,
        out: placement.out,
        laneIndex,
      })
    },
    [project, selectedPlacementIds, setSelectedPlacements],
  )

  const scrubTo = useCallback(
    (clientX: number) => {
      setPlaying(false)
      setCurrentFrame(Math.max(0, Math.min(frameCount, Math.round(toFrame(clientX)))))
    },
    [setPlaying, setCurrentFrame, frameCount, toFrame],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      if (d.kind === "scrub") {
        scrubTo(e.clientX)
        return
      }
      const found = tracks.flatMap((tr, i) => tr.placements.map((p) => ({ p, i }))).find((x) => x.p.id === d.id)
      if (!found) return
      const lib = clipById(project, found.p.clipId)
      if (!lib) return
      const dx = (e.clientX - d.startX) / pxPerFrame

      if (d.kind === "move") {
        const start = Math.max(0, snapped(d.from + dx, d.id))
        // Which lane the pointer is over, not how far it has travelled: lanes
        // are a list, and a drag that crosses two of them should land on the
        // one under the cursor rather than two below where it started.
        const el = lanesRef.current
        let laneIndex = d.laneIndex
        if (el) {
          const rect = el.getBoundingClientRect()
          const y = e.clientY - rect.top - RULER_H
          laneIndex = Math.max(0, Math.min(tracks.length, Math.floor(y / LANE_H)))
        }
        setPreview({
          id: d.id,
          start,
          in: found.p.in,
          out: found.p.out,
          laneIndex,
        })
        return
      }

      const full = Math.max(1, lib.clip.frameCount)
      const offset = offsetOf(found.p)
      if (d.kind === "trim-in") {
        const wanted = snapped(d.from + dx + offset, d.id) - offset
        const nextIn = Math.max(0, Math.min(wanted, outOf(found.p, lib.clip) - 1))
        setPreview({
          id: d.id,
          start: Math.max(0, found.p.start + (nextIn - found.p.in)),
          in: nextIn,
          out: found.p.out,
          laneIndex: found.i,
        })
        return
      }
      const wanted = snapped(d.from + dx + offset, d.id) - offset
      const nextOut = Math.max(found.p.in + 1, Math.min(wanted, full))
      setPreview({
        id: d.id,
        start: found.p.start,
        in: found.p.in,
        out: nextOut,
        laneIndex: found.i,
      })
    },
    [tracks, project, pxPerFrame, snapped, scrubTo],
  )

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      const p = preview
      drag.current = null
      setPreview(null)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // Already released.
      }
      if (!d || d.kind === "scrub" || !p) return
      if (d.kind === "move") {
        // Same rule as a drop from the library: a block dragged past the last
        // lane makes the next one.
        const onPhantom = p.laneIndex >= tracks.length
        const base = onPhantom ? addTrack(project) : { project, trackId: tracks[p.laneIndex]?.id }
        if (!base.trackId) return
        commitProject(movePlacement(base.project, d.id, p.start, base.trackId))
        return
      }
      commitProject(trimPlacement(project, d.id, d.kind === "trim-in" ? { in: p.in } : { out: p.out ?? undefined }))
    },
    [preview, tracks, project, commitProject],
  )

  // ── Taking a clip from the library ──────────────────────────────────────

  /** Which lane the pointer is over, and the frame it would land on. */
  const dropSpotAt = useCallback(
    (clientX: number, clientY: number, clipId: string | null) => {
      const el = lanesRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      // The lane header counts as part of its lane: a drop there lands at the
      // start rather than being refused. Outside the panel is still outside —
      // that guard is what stops a drop over the library itself from placing.
      if (clientX < rect.left || clientX > rect.right) return null
      const y = clientY - rect.top - RULER_H
      if (y < 0) return null
      // Everything below the last lane is the phantom, not just the 28 pixels
      // directly under it. The lanes occupy a fraction of a tall panel, so a
      // band-sized target meant most of the empty space silently refused the
      // drop — which reads as the drag doing nothing at all.
      const laneIndex = Math.max(0, Math.min(tracks.length, Math.floor(y / LANE_H)))
      const lib = clipId != null ? clipById(project, clipId) : null
      const wanted = Math.max(0, snapped(toFrame(clientX)))
      const lane = tracks[laneIndex]
      // The phantom is empty by definition, so nothing can be in the way.
      if (!lane || !lib) return { laneIndex, start: wanted }
      const at = fitStart(project, lane, wanted, Math.max(1, lib.clip.frameCount))
      return at == null ? null : { laneIndex, start: at }
    },
    [labelWidth, tracks, project, snapped, toFrame],
  )

  // Read by the drop target, which is registered once and must not be
  // re-registered on every pointer move.
  const draggingClipIdRef = useRef(draggingClipId)
  draggingClipIdRef.current = draggingClipId
  const dropSpotRef = useRef(dropSpotAt)
  dropSpotRef.current = dropSpotAt
  const dropStateRef = useRef({ project, tracks, commitProject })
  dropStateRef.current = { project, tracks, commitProject }

  useEffect(() => {
    registerClipDropTarget({
      onMove: (x, y) => setDropAt(dropSpotRef.current(x, y, draggingClipIdRef.current)),
      onDrop: (x, y) => {
        setDropAt(null)
        const clipId = draggingClipIdRef.current
        const spot = dropSpotRef.current(x, y, clipId)
        if (!spot) return false
        const { project: p, tracks: lanes, commitProject: commit } = dropStateRef.current
        if (clipId == null) return false
        // Landing past the last lane brings one into being, then puts the clip
        // on it — one gesture, one undo step.
        const onPhantom = spot.laneIndex >= lanes.length
        const base = onPhantom ? addTrack(p) : { project: p, trackId: lanes[spot.laneIndex]?.id }
        if (!base.trackId) return false
        const added = addPlacement(base.project, base.trackId, clipId, spot.start)
        if (added.placementId == null) return false
        commit(added.project)
        return true
      },
      onCancel: () => setDropAt(null),
    })
    return () => registerClipDropTarget(null)
  }, [])

  const draggedClip = draggingClipId != null ? clipById(project, draggingClipId) : null

  // ── Ruler ───────────────────────────────────────────────────────────────
  // Only the ticks that are actually on screen. At the smallest zoom a long
  // clip is tens of thousands of frames, and a div per frame would be a div
  // per frame whether or not anyone can see it.
  const ticks = useMemo(() => {
    const step = pxPerFrame >= 12 ? 10 : pxPerFrame >= 6 ? 30 : pxPerFrame >= 2 ? 60 : 300
    const el = lanesRef.current
    const width = el ? el.clientWidth - labelWidth : 800
    const first = Math.max(0, Math.floor(scrollX / pxPerFrame / step) * step)
    const last = Math.min(frameCount, first + Math.ceil(width / pxPerFrame) + step)
    const out: number[] = []
    for (let f = first; f <= last; f += step) out.push(f)
    return out
  }, [pxPerFrame, scrollX, frameCount, labelWidth])

  const laneOf = (trackIndex: number, placement: Placement) =>
    preview && preview.id === placement.id ? preview.laneIndex : trackIndex

  const geometryOf = (placement: Placement, clipFrames: number) => {
    const p = preview && preview.id === placement.id ? preview : placement
    const out = p.out ?? Math.max(1, clipFrames)
    return { start: p.start, length: Math.max(1, out - p.in) }
  }

  return (
    <div
      ref={lanesRef}
      className="relative flex h-full w-full select-none flex-col overflow-hidden"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerDown={(e) => {
        // Only reaches here when nothing inner took it: a block, an edge grip
        // and the ruler all stop propagation, so this is empty lane space.
        setSelectedPlacements([])
        if (e.button !== 0) return
        const el = lanesRef.current
        if (!el || e.clientX < el.getBoundingClientRect().left + labelWidth) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { kind: "scrub" }
        scrubTo(e.clientX)
      }}
    >
      {/* Ruler — the same axis the keyframe view uses, drawn in the same place */}
      <div className="relative flex shrink-0 border-b border-line" style={{ height: RULER_H }}>
        <div className="shrink-0 border-r border-line-strong" style={{ width: labelWidth }} />
        <div
          className="relative flex-1 cursor-col-resize overflow-hidden"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            setPlaying(false)
            setCurrentFrame(Math.max(0, Math.min(frameCount, Math.round(toFrame(e.clientX)))))
          }}
        >
          {ticks.map((f) => (
            <span
              key={f}
              className="pointer-events-none absolute bottom-0 top-0 border-l border-line text-[10px] tabular-nums text-muted-foreground"
              style={{ left: toX(f) - labelWidth }}
            >
              <span className="pl-1">{f}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Lanes */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tracks.map((track, trackIndex) => (
          <Lane
            key={track.id}
            track={track}
            trackIndex={trackIndex}
            labelWidth={labelWidth}
            onMute={() => commitProject(setTrackMute(project, track.id, !track.mute))}
            dropping={dropAt?.laneIndex === trackIndex}
          >
            {dropAt?.laneIndex === trackIndex && draggedClip ? (
              <div
                className="pointer-events-none absolute inset-y-[3px] z-10 flex items-center overflow-hidden rounded-chip border border-dashed border-blue-400 bg-blue-400/20 px-1.5 font-mono text-[11px] text-blue-200"
                style={{
                  left: toX(dropAt.start) - labelWidth,
                  width: Math.max(2, Math.max(1, draggedClip.clip.frameCount) * pxPerFrame),
                }}
                title={t.arrange.dropHere}
              >
                <span className="truncate">{draggedClip.name}</span>
              </div>
            ) : null}
            {tracks.flatMap((source, sourceIndex) =>
              source.placements.map((placement) => {
                if (laneOf(sourceIndex, placement) !== trackIndex) return null
                const lib = clipById(project, placement.clipId)
                if (!lib) return null
                const { start, length } = geometryOf(placement, lib.clip.frameCount)
                const isActive = placement.id === activePlacementId
                const isSelected = selectedPlacementIds.includes(placement.id)
                const trimmed = placement.in > 0 || placement.out != null
                return (
                  <div
                    key={placement.id}
                    onPointerDown={onBlockPointerDown(placement, trackIndex, null)}
                    onDoubleClick={() => onEditPlacement(placement.id)}
                    title={`${lib.name} · ${start}–${start + length}`}
                    className={cn(
                      "absolute inset-y-[3px] flex touch-none items-center gap-1 overflow-hidden rounded-chip border px-1.5 font-mono text-[11px]",
                      "cursor-grab active:cursor-grabbing",
                      isSelected
                        ? "border-blue-400 bg-blue-400/35 text-foreground"
                        : "border-blue-400/50 bg-blue-400/20 text-foreground hover:bg-blue-400/30",
                      isActive && "ring-1 ring-inset ring-blue-300",
                      track.mute && "opacity-40",
                    )}
                    style={{
                      left: toX(start) - labelWidth,
                      width: Math.max(2, length * pxPerFrame),
                    }}
                  >
                    {/* Edge grips. Their own elements so the cursor changes
                        before the click, rather than the block guessing from
                        the pointer's offset once it has already started. */}
                    <span
                      onPointerDown={onBlockPointerDown(placement, trackIndex, "in")}
                      className="absolute inset-y-0 left-0 z-10 cursor-ew-resize"
                      style={{ width: EDGE }}
                    />
                    <span
                      onPointerDown={onBlockPointerDown(placement, trackIndex, "out")}
                      className="absolute inset-y-0 right-0 z-10 cursor-ew-resize"
                      style={{ width: EDGE }}
                    />
                    {trimmed ? <Scissors className="size-2.5 shrink-0 text-blue-200" /> : null}
                    <span className="min-w-0 flex-1 truncate">{lib.name}</span>
                  </div>
                )
              }),
            )}
          </Lane>
        ))}
        {phantomVisible ? (
          <div
            className={cn(
              "flex border-b border-dashed border-line-strong",
              dropAt?.laneIndex === tracks.length || preview?.laneIndex === tracks.length
                ? "bg-blue-400/[0.06]"
                : null,
            )}
            style={{ height: LANE_H }}
          >
            <div
              className="flex shrink-0 items-center border-r border-line-strong px-2 font-mono text-[11px] text-muted-foreground"
              style={{ width: labelWidth }}
            >
              {tracks.length + 1}
            </div>
            <div className="relative min-w-0 flex-1 overflow-hidden">
              {preview && preview.laneIndex === tracks.length
                ? (() => {
                    const found = tracks.flatMap((tr) => tr.placements).find((p) => p.id === preview.id)
                    const lib = found ? clipById(project, found.clipId) : null
                    if (!found || !lib) return null
                    const { start, length } = geometryOf(found, lib.clip.frameCount)
                    return (
                      <div
                        className="pointer-events-none absolute inset-y-[3px] flex items-center gap-1 overflow-hidden rounded-chip border border-blue-400 bg-blue-400/35 px-1.5 font-mono text-[11px] text-foreground"
                        style={{ left: toX(start) - labelWidth, width: Math.max(2, length * pxPerFrame) }}
                      >
                        <span className="min-w-0 flex-1 truncate">{lib.name}</span>
                      </div>
                    )
                  })()
                : null}
              {dropAt?.laneIndex === tracks.length && draggedClip ? (
                <div
                  className="pointer-events-none absolute inset-y-[3px] z-10 flex items-center overflow-hidden rounded-chip border border-dashed border-blue-400 bg-blue-400/20 px-1.5 font-mono text-[11px] text-blue-200"
                  style={{
                    left: toX(dropAt.start) - labelWidth,
                    width: Math.max(2, Math.max(1, draggedClip.clip.frameCount) * pxPerFrame),
                  }}
                >
                  <span className="truncate">{draggedClip.name}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Playhead — one line, moved by the playback loop without React */}
      <div
        ref={playheadRef}
        className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-foreground"
        style={{ left: toX(currentFrame) }}
      >
        <span className="absolute -left-[4.5px] top-0 border-[4.5px] border-transparent border-t-[7px] border-t-foreground" />
      </div>
    </div>
  )
})

/**
 * One lane: which lane it is, whether it plays, and whatever blocks sit on it.
 *
 * No name, no reordering buttons, no delete. Lanes are managed for you
 * (normalizeLanes) — one appears as the last fills and retires as it empties —
 * so the header only has to answer the two questions that are actually about
 * this lane: where it sits in priority, and whether it reaches the model.
 * Everything else was chrome standing between a clip and the place it goes.
 */
function Lane({
  track,
  trackIndex,
  labelWidth,
  onMute,
  dropping,
  children,
}: {
  track: Track
  trackIndex: number
  labelWidth: number
  onMute: () => void
  /** A clip from the library is hovering over this lane. */
  dropping: boolean
  children: React.ReactNode
}) {
  const t = useT()
  return (
    <div
      className={cn("flex border-b border-line", dropping && "bg-blue-400/[0.06]")}
      style={{ height: LANE_H }}
    >
      <div
        className="flex shrink-0 items-center gap-1 border-r border-line-strong px-2 font-mono text-[11px] text-muted-foreground"
        style={{ width: labelWidth }}
      >
        <span
          className="w-3 shrink-0 tabular-nums text-foreground"
          title={trackIndex === 0 ? t.arrange.topLane : undefined}
        >
          {trackIndex + 1}
        </span>
        {/* Whether this lane reaches the model at all. An eye rather than an
            "M": mute is mixing-desk vocabulary, and what this actually asks is
            whether you can see the lane's motion on the character. */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title={track.mute ? t.arrange.unmute : t.arrange.mute}
          aria-label={track.mute ? t.arrange.unmute : t.arrange.mute}
          aria-pressed={!track.mute}
          onClick={onMute}
          className={cn(
            "size-4 shrink-0",
            track.mute ? "text-muted-foreground hover:text-foreground" : "text-blue-400 hover:text-blue-400",
          )}
        >
          {track.mute ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
        </Button>
      </div>
      {/* Clipped: a block scrolled off the left would otherwise paint
          straight over the lane header, which is not scrolling with it. */}
      <div className="relative min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  )
}

/** Exported for <Timeline>'s toolbar: split every selected block, or whatever
 *  sits under the playhead when nothing is selected. */
export function useSplitAtPlayhead(): () => void {
  const library = useStudioSelector((s) => s.library)
  const tracks = useStudioSelector((s) => s.tracks)
  const clipDisplayName = useStudioSelector((s) => s.clipDisplayName)
  const selectedPlacementIds = useStudioSelector((s) => s.selectedPlacementIds)
  const { commitProject } = useStudioActions()
  const { currentFrame } = usePlayback()
  return useCallback(() => {
    const project = projectOf({ library, tracks, clipDisplayName })
    const frame = Math.round(currentFrame)
    const candidates =
      selectedPlacementIds.length > 0
        ? selectedPlacementIds
        : tracks
            .flatMap((track) => track.placements)
            .filter((p) => {
              const lib = clipById(project, p.clipId)
              return lib != null && frame > p.start && frame < placementEnd(p, lib.clip)
            })
            .map((p) => p.id)
    let next = project
    for (const id of candidates) next = splitPlacement(next, id, frame)
    if (next !== project) commitProject(next)
  }, [library, tracks, clipDisplayName, selectedPlacementIds, currentFrame, commitProject])
}

/**
 * Blocks on the clipboard: what was copied, and where each sat RELATIVE to the
 * earliest of them.
 *
 * Module state, beside the keyframe clipboard in studio.tsx and for the same
 * reason: a copy has to outlive the panel that made it, and it is not part of
 * the document, so it has no business in the store or in undo. Trims travel
 * with the copy — a cut block pasted back should be the piece that was cut,
 * not the whole clip it came from.
 */
type CopiedPlacement = { clipId: ClipId; laneIndex: number; rel: number; in: number; out: number | null }
let placementClipboard: CopiedPlacement[] = []

function copyOf(project: Project, tracks: Track[], ids: readonly PlacementId[]): CopiedPlacement[] {
  const found = tracks.flatMap((track, laneIndex) =>
    track.placements.filter((p) => ids.includes(p.id)).map((p) => ({ p, laneIndex })),
  )
  if (found.length === 0) return []
  const base = Math.min(...found.map((f) => f.p.start))
  return found.map(({ p, laneIndex }) => ({
    clipId: p.clipId,
    laneIndex,
    rel: p.start - base,
    in: p.in,
    out: p.out,
  }))
}

export function useCopySelectedPlacements(): () => void {
  const tracks = useStudioSelector((s) => s.tracks)
  const library = useStudioSelector((s) => s.library)
  const clipDisplayName = useStudioSelector((s) => s.clipDisplayName)
  const selectedPlacementIds = useStudioSelector((s) => s.selectedPlacementIds)
  return useCallback(() => {
    const copied = copyOf(projectOf({ library, tracks, clipDisplayName }), tracks, selectedPlacementIds)
    if (copied.length > 0) placementClipboard = copied
  }, [tracks, library, clipDisplayName, selectedPlacementIds])
}

export function useCutSelectedPlacements(): () => void {
  const copy = useCopySelectedPlacements()
  const remove = useRemoveSelectedPlacements()
  return useCallback(() => {
    copy()
    remove()
  }, [copy, remove])
}

/**
 * Lay the clipboard down at the playhead, keeping the shape it was copied in —
 * the same lanes, the same gaps between blocks, the same trims.
 *
 * One commit for the whole paste, so it is one undo step however many blocks
 * it carried. A lane that no longer exists is made, which is what lets a paste
 * survive the lanes retiring underneath it.
 */
export function usePastePlacements(): () => void {
  const tracks = useStudioSelector((s) => s.tracks)
  const library = useStudioSelector((s) => s.library)
  const clipDisplayName = useStudioSelector((s) => s.clipDisplayName)
  const { commitProject, setSelectedPlacements } = useStudioActions()
  const { currentFrame } = usePlayback()
  return useCallback(() => {
    if (placementClipboard.length === 0) return
    const base = Math.round(Math.max(0, currentFrame))
    let project = projectOf({ library, tracks, clipDisplayName })
    const landed: PlacementId[] = []
    for (const entry of placementClipboard) {
      if (!clipById(project, entry.clipId)) continue
      while (project.tracks.length <= entry.laneIndex) project = addTrack(project).project
      const lane = project.tracks[entry.laneIndex]
      const added = addPlacement(project, lane.id, entry.clipId, base + entry.rel)
      if (added.placementId == null) continue
      project = added.project
      landed.push(added.placementId)
      // The copy's own trim, restored on top of the fresh placement.
      if (entry.in !== 0 || entry.out != null) {
        project = trimPlacement(project, added.placementId, {
          in: entry.in,
          ...(entry.out != null ? { out: entry.out } : {}),
        })
      }
    }
    if (landed.length === 0) return
    commitProject(project)
    setSelectedPlacements(landed)
  }, [tracks, library, clipDisplayName, currentFrame, commitProject, setSelectedPlacements])
}

/** Exported for the Delete key. */
export function useRemoveSelectedPlacements(): () => void {
  const library = useStudioSelector((s) => s.library)
  const tracks = useStudioSelector((s) => s.tracks)
  const clipDisplayName = useStudioSelector((s) => s.clipDisplayName)
  const selectedPlacementIds = useStudioSelector((s) => s.selectedPlacementIds)
  const { commitProject, setSelectedPlacements } = useStudioActions()
  return useCallback(() => {
    if (selectedPlacementIds.length === 0) return
    commitProject(removePlacements(projectOf({ library, tracks, clipDisplayName }), selectedPlacementIds))
    setSelectedPlacements([])
  }, [library, tracks, clipDisplayName, selectedPlacementIds, commitProject, setSelectedPlacements])
}

/** The arrangement's own length, for the ruler and the transport. */
export function useArrangementEnd(): number {
  const library = useStudioSelector((s) => s.library)
  const tracks = useStudioSelector((s) => s.tracks)
  return useMemo(() => {
    let end = 0
    for (const track of tracks) {
      for (const p of track.placements) {
        const lib = library.find((c) => c.id === p.clipId)
        if (lib) end = Math.max(end, p.start + placementLength(p, lib.clip))
      }
    }
    return end
  }, [tracks, library])
}

/** The active placement's arrangement↔local offset. Zero when nothing is
 *  placed, which is what makes the one-clip session behave as it always did. */
export function useActiveOffset(): number {
  const tracks = useStudioSelector((s) => s.tracks)
  const activePlacementId = useStudioSelector((s) => s.activePlacementId)
  return useMemo(() => {
    for (const track of tracks) {
      for (const p of track.placements) if (p.id === activePlacementId) return offsetOf(p)
    }
    return 0
  }, [tracks, activePlacementId])
}
