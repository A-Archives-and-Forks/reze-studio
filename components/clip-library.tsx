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

import { memo, useState } from "react"
import { Plus, X } from "lucide-react"
import type { AnimationClip } from "reze-engine"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { ClipId, LibraryClip } from "@/lib/project"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/** Clip length as minutes and seconds at MMD's 30fps. */
function clipDuration(clip: AnimationClip): string {
  const seconds = Math.max(0, clip.frameCount) / 30
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}

/** What a clip actually carries. A VMD is often only half a performance — the
 *  dance without the face, or the face on its own — and which half it is
 *  decides what you can do with it. */
function capabilities(clip: AnimationClip): string[] {
  const caps: string[] = []
  if (clip.boneTracks.size > 0) caps.push("B")
  if (clip.morphTracks.size > 0) caps.push("M")
  if (clip.ikTracks && clip.ikTracks.size > 0) caps.push("IK")
  return caps
}

interface ClipLibraryProps {
  library: LibraryClip[]
  activeClipId: ClipId | null
  onActivate: (id: ClipId) => void
  onRemove: (id: ClipId) => void
  onImport: () => void
}

export const ClipLibrary = memo(function ClipLibrary({
  library,
  activeClipId,
  onActivate,
  onRemove,
  onImport,
}: ClipLibraryProps) {
  const t = useT()
  // Removing a clip cannot be undone — the history stack holds keyframes, not
  // library membership — so it asks first.
  const [pendingRemove, setPendingRemove] = useState<LibraryClip | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col py-1">
          {/* Above the rows, not below them: this is where a clip ARRIVES, and
              the dashed edge is the standard way to say a place is waiting to
              be filled rather than holding something. */}
          <Button
            type="button"
            variant="ghost"
            onClick={onImport}
            title={t.clips.import}
            aria-label={t.clips.import}
            className="mx-2 mb-1 h-7 shrink-0 rounded-interior border border-dashed border-line-strong text-muted-foreground hover:border-blue-400/50 hover:bg-transparent hover:text-blue-400"
          >
            <Plus className="size-3.5" />
          </Button>
          {library.length === 0 ? (
            <div className="px-3 py-1.5 text-[11px] text-muted-foreground">{t.clips.empty}</div>
          ) : (
            library.map((entry) => {
              const isActive = entry.id === activeClipId
              const caps = capabilities(entry.clip)
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "group relative flex w-full items-center gap-1 pl-3 pr-1 text-left font-mono text-[11px] leading-snug",
                    isActive
                      ? "bg-blue-400/[0.1] text-blue-400 shadow-[inset_2px_0_0_var(--color-blue-400)]"
                      : "text-muted-foreground hover:bg-white/[0.03]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onActivate(entry.id)}
                    title={t.clips.rowTitle(entry.name, entry.clip.frameCount)}
                    className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <span className="shrink-0 tabular-nums text-[10px]">{clipDuration(entry.clip)}</span>
                    <span className="flex shrink-0 gap-0.5">
                      {caps.map((c) => (
                        <span
                          key={c}
                          className={cn(
                            "rounded-chip border px-1 text-[8px] leading-[13px]",
                            isActive ? "border-blue-400/40" : "border-line-strong",
                          )}
                        >
                          {c}
                        </span>
                      ))}
                    </span>
                  </button>
                  {/* Never offered for the last clip: a project with no clip at
                      all has nothing for the timeline or the inspector to edit,
                      and File › New is the way to say that deliberately. */}
                  {library.length > 1 ? (
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
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>
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
