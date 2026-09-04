"use client"

import { memo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useT } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import type { AnimationClip } from "reze-engine"

interface MorphListProps {
  morphNames: string[]
  clip: AnimationClip | null
  selectedMorph: string | null
  onSelectMorph: (name: string) => void
}

export const MorphList = memo(function MorphList({ morphNames, clip, selectedMorph, onSelectMorph }: MorphListProps) {
  const t = useT()
  return (
    <ScrollArea className="h-full">
      <div className="py-1">
        {morphNames.length === 0 ? (
          <div className="px-3 py-1.5 text-[11px] text-muted-foreground">{t.panel.noMorphs}</div>
        ) : (
          morphNames.map((name) => {
            const kfCount = clip?.morphTracks.get(name)?.length ?? 0
            const isActive = selectedMorph === name
            return (
              <button
                key={name}
                type="button"
                onClick={() => onSelectMorph(name)}
                className={cn(
                  "flex w-full items-center py-0.5 pl-3 pr-3 text-left text-[11px] font-mono leading-snug transition-colors",
                  isActive
                    ? "bg-blue-400/[0.08] text-blue-400 hover:bg-blue-400/12"
                    : "text-muted-foreground hover:bg-white/[0.03]",
                )}
              >
                <span className="inline-flex w-1.5 shrink-0 text-[7px] leading-none" aria-hidden>
                  {isActive ? "●" : ""}
                </span>
                <span className="ml-1 min-w-0 flex-1 truncate">{name}</span>
                {kfCount > 0 && (
                  <span className={cn("shrink-0 pr-1 tabular-nums text-[10px]", isActive ? "text-blue-400" : "text-muted-foreground")}>
                    [{kfCount}]
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
    </ScrollArea>
  )
})
