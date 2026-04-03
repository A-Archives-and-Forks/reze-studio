"use client"

import { memo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface MorphListProps {
  morphNames: string[]
  activeMorph: string | null
  onSelectMorph: (name: string) => void
}

export const MorphList = memo(function MorphList({ morphNames, activeMorph, onSelectMorph }: MorphListProps) {
  return (
    <ScrollArea className="h-full">
      <div className="py-1">
        {morphNames.length === 0 ? (
          <div className="px-3 py-1.5 text-[11px] text-muted-foreground">No morphs</div>
        ) : (
          morphNames.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onSelectMorph(name)}
              className={cn(
                "flex w-full items-center py-0.5 pl-3 pr-3 text-left text-[11px] font-mono leading-snug text-muted-foreground transition-colors",
                activeMorph === name ? "bg-blue-400/[0.08] text-blue-400" : "hover:bg-white/[0.03]",
              )}
            >
              <span className="mr-1 w-2 text-[9px]">{activeMorph === name ? "●" : ""}</span>
              {name}
            </button>
          ))
        )}
      </div>
    </ScrollArea>
  )
})
