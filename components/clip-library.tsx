"use client"

/**
 * The project's clips, as a list you pick from.
 *
 * A row is a CLIP — the keyframes an imported VMD brought in — and clicking one
 * makes it the clip every other panel is editing. That is the whole interaction
 * for now: where each clip sits in time becomes a question once the Arrange
 * view exists, and until then a project is a shelf of takes with one of them
 * open.
 *
 * The active row wears the same blue every other highlight in the editor wears
 * — the clip you are editing is the clip you have picked, and inventing a
 * second highlight colour for it would make the reader ask what the difference
 * is when there is none.
 */

import { memo, useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { Plus, X } from "lucide-react"
import type { AnimationClip } from "reze-engine"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { ClipId, LibraryClip } from "@/lib/project"
import { useT } from "@/lib/i18n"
import { beginClipDrag, cancelClipDrag, endClipDrag, moveClipDrag, useDraggingClipId } from "@/lib/clip-drag"
import { cn } from "@/lib/utils"

/** Clip length as minutes and seconds at MMD's 30fps. */
function clipDuration(clip: AnimationClip): string {
  const seconds = Math.max(0, clip.frameCount) / 30
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

/**
 * What a clip actually carries. A VMD is often only half a performance — the
 * dance without the face, or the face on its own — and which half it is decides
 * what you can do with it.
 *
 * A fixed set in a fixed order, each in a box the same size whether it is one
 * letter or two. The point is the COLUMN: run an eye down the middle slot and
 * it says which clips carry expressions. Chips sized to their own text put that
 * answer in a different place on every row.
 */
const CAPABILITIES = ["B", "M", "IK"] as const

function capabilities(clip: AnimationClip): ReadonlySet<string> {
  const caps = new Set<string>()
  if (clip.boneTracks.size > 0) caps.add("B")
  if (clip.morphTracks.size > 0) caps.add("M")
  if (clip.ikTracks && clip.ikTracks.size > 0) caps.add("IK")
  return caps
}

interface ClipLibraryProps {
  library: LibraryClip[]
  activeClipId: ClipId | null
  onActivate: (id: ClipId) => void
  onRemove: (id: ClipId) => void
  onImport: () => void
  /** A drag has begun. The caller brings the arrangement into view, since a
   *  clip cannot be dropped on a lane nobody is looking at. */
  onDragStart: () => void
}

export const ClipLibrary = memo(function ClipLibrary({
  library,
  activeClipId,
  onActivate,
  onRemove,
  onImport,
  onDragStart,
}: ClipLibraryProps) {
  const t = useT()
  // Removing a clip cannot be undone — the history stack holds keyframes, not
  // library membership — so it asks first.
  const [pendingRemove, setPendingRemove] = useState<LibraryClip | null>(null)
  const draggingClipId = useDraggingClipId()
  const ghostRef = useRef<HTMLDivElement | null>(null)

  /**
   * Press, then either a click or a drag — decided by whether the pointer
   * moves.
   *
   * A row has to be both: clicking it opens the clip for editing, dragging it
   * lays a copy on a lane. Committing to one on pointerdown would cost the
   * other, so the gesture stays undecided until the pointer travels far enough
   * that nobody would call it a click.
   */
  const onRowPointerDown = useCallback(
    (entry: LibraryClip) => (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const startX = e.clientX
      const startY = e.clientY
      let dragging = false

      const move = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= 4) return
          dragging = true
          onDragStart()
          beginClipDrag(entry.id)
        }
        const ghost = ghostRef.current
        if (ghost) ghost.style.transform = `translate(${ev.clientX + 10}px, ${ev.clientY + 10}px)`
        moveClipDrag(ev.clientX, ev.clientY)
      }
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        window.removeEventListener("pointercancel", cancel)
        if (dragging) endClipDrag(ev.clientX, ev.clientY)
        else onActivate(entry.id)
      }
      const cancel = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        window.removeEventListener("pointercancel", cancel)
        cancelClipDrag()
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
      window.addEventListener("pointercancel", cancel)
    },
    [onActivate, onDragStart],
  )

  const dragged = library.find((c) => c.id === draggingClipId) ?? null

  return (
    <div className="flex flex-col">
      <div className="flex flex-col pb-4 pt-1">
        {/* Above the rows, not below them: this is where a clip ARRIVES, and
              the dashed edge is the standard way to say a place is waiting to
              be filled rather than holding something. */}
        <Button
          type="button"
          variant="ghost"
          onClick={onImport}
          title={t.clips.import}
          aria-label={t.clips.import}
          className="mx-auto mb-1 h-6 w-auto shrink-0 gap-1 rounded-chip border border-dashed border-line-strong px-2 text-[11px] font-normal text-muted-foreground hover:border-blue-400/50 hover:bg-transparent hover:text-blue-400"
        >
          <Plus className="size-3" />
          {t.clips.import}
        </Button>
        {library.length === 0 ? (
          <div className="px-3 py-1.5 text-[12px] text-muted-foreground">{t.clips.empty}</div>
        ) : (
          library.map((entry) => {
            const isActive = entry.id === activeClipId
            const caps = capabilities(entry.clip)
            return (
              <div
                key={entry.id}
                className={cn(
                  "group relative flex w-full items-center gap-1 pl-3 pr-1 text-left font-mono text-[12px] leading-snug",
                  isActive
                    ? "bg-blue-400/[0.1] text-blue-400 shadow-[inset_2px_0_0_var(--color-blue-400)]"
                    : "text-muted-foreground hover:bg-white/[0.03]",
                )}
              >
                <button
                  type="button"
                  onPointerDown={onRowPointerDown(entry)}
                  title={t.clips.dragHint(entry.name, entry.clip.frameCount)}
                  className={cn(
                    "flex min-w-0 flex-1 cursor-grab items-center gap-1 py-0.5 text-left active:cursor-grabbing",
                    draggingClipId === entry.id && "opacity-50",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="flex shrink-0 gap-0.5">
                    {CAPABILITIES.map((c) => (
                      <span
                        key={c}
                        className={cn(
                          "inline-flex h-[15px] w-[19px] items-center justify-center rounded-chip border text-[9px] leading-none",
                          isActive ? "border-blue-400/40" : "border-line-strong",
                          // Holds its column when the clip does not carry it,
                          // so every row's chips start and end in one place.
                          !caps.has(c) && "invisible",
                        )}
                      >
                        {c}
                      </span>
                    ))}
                  </span>
                  <span className="shrink-0 tabular-nums text-[11px]">{clipDuration(entry.clip)}</span>
                </button>
                {/* Offered for every clip, the last one included. An empty
                    project is a state the editor can hold — the import button
                    above is right there, and refusing the delete to spare
                    someone an empty list is deciding for them. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={t.clips.removeHint(entry.name)}
                  onClick={() => setPendingRemove(entry)}
                  className="size-4 shrink-0 text-muted-foreground opacity-0 hover:bg-red-400/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="size-3" />
                </Button>
              </div>
            )
          })
        )}
      </div>
      {/* Follows the pointer without React: a ghost repositioned by state
          would reconcile the whole library on every pointermove. */}
      {dragged ? (
        <div
          ref={ghostRef}
          className="pointer-events-none fixed left-0 top-0 z-50 rounded-chip border border-blue-400 bg-blue-400/30 px-2 py-0.5 font-mono text-[11px] text-foreground shadow-float"
        >
          {dragged.name}
        </div>
      ) : null}

      <Dialog open={pendingRemove !== null} onOpenChange={(o) => !o && setPendingRemove(null)}>
        <DialogContent className="gap-3">
          <DialogHeader>
            <DialogTitle>{t.clips.removeTitle(pendingRemove?.name ?? "")}</DialogTitle>
            <DialogDescription>{t.clips.removeBlurb}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPendingRemove(null)}>
              {t.clips.cancel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="border border-red-400/40 text-red-400 hover:bg-red-400/10 hover:text-red-400"
              onClick={() => {
                if (pendingRemove) onRemove(pendingRemove.id)
                setPendingRemove(null)
              }}
            >
              {t.clips.remove}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
})
