"use client"

/**
 * A column of stacked, collapsible, resizable sections — the left column's
 * permanent structure.
 *
 * Not `<ResizablePanelGroup>`: that library keeps every panel's size as a share
 * of one hundred percent, so a panel collapsed to a header height is still
 * holding a slice of the group, and collapsing the last expanded section leaves
 * the arithmetic with nowhere to put the remainder. A section stack wants the
 * opposite arrangement — headers are fixed furniture, and only the OPEN bodies
 * divide what is left. That is a dozen lines of flexbox, so it lives here
 * rather than being coaxed out of a general-purpose splitter.
 *
 * Open bodies share the leftover height by WEIGHT rather than by stored pixel
 * heights, which is what makes the split survive a window resize: `flex: w`
 * keeps the same ratio at any container height, where a pixel height either
 * squeezes its neighbours out or strands empty space.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import { storageKey } from "@/lib/storage"
import { cn } from "@/lib/utils"

/** Header height, in px. A collapsed section is exactly this tall. */
const HEADER_H = 24
/** Shortest a section may be squeezed to by dragging — its header plus about
 *  three rows, so a section never becomes a header with a sliver under it. */
const MIN_SECTION = HEADER_H + 66

export type PanelStackSection = {
  id: string
  /** Shown uppercase in the header. */
  label: string
  /** Right-aligned in the header — how many rows the body holds. */
  count?: number
  /** Between the label and the count: what this section is scoped to (the
   *  active clip, once clips exist). Muted, and truncates before the count. */
  scope?: string
  /** Share of the open height relative to its open siblings. */
  defaultWeight?: number
  title?: string
  body: ReactNode
}

type StackPrefs = { collapsed: string[]; weights: Record<string, number> }

function readPrefs(key: string): StackPrefs {
  const empty: StackPrefs = { collapsed: [], weights: {} }
  if (typeof window === "undefined") return empty
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return empty
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return empty
    const p = parsed as Partial<StackPrefs>
    const weights: Record<string, number> = {}
    if (p.weights && typeof p.weights === "object") {
      for (const [k, v] of Object.entries(p.weights)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) weights[k] = v
      }
    }
    return {
      collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((x): x is string => typeof x === "string") : [],
      weights,
    }
  } catch {
    return empty
  }
}

/** One section's header. Also the collapse control — the whole bar is the
 *  target, since a 12px chevron is not one. */
function SectionHeader({
  label,
  count,
  scope,
  open,
  onToggle,
  title,
}: {
  label: string
  count?: number
  scope?: string
  open: boolean
  onToggle: () => void
  title?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-expanded={open}
      title={title}
      onClick={onToggle}
      className={cn(
        "h-6 w-full shrink-0 justify-start gap-1 rounded-none border-b border-line px-2 text-muted-foreground",
        "hover:bg-white/[0.03] hover:text-foreground dark:hover:bg-white/[0.03]",
      )}
    >
      <ChevronRight
        className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        strokeWidth={2.5}
      />
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.1em]">{label}</span>
      {scope ? (
        <span className="min-w-0 truncate font-mono text-[10px] normal-case tracking-normal">
          · {scope}
        </span>
      ) : null}
      {count != null ? (
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums tracking-normal">{count}</span>
      ) : null}
    </Button>
  )
}

export function PanelStack({
  id,
  sections,
  className,
}: {
  /** Namespace for the persisted collapse + weight state. */
  id: string
  sections: PanelStackSection[]
  className?: string
}) {
  const t = useT()
  const prefsKey = storageKey(`panelStack.${id}`)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(readPrefs(prefsKey).collapsed),
  )
  const [weights, setWeights] = useState<Record<string, number>>(() => readPrefs(prefsKey).weights)

  useEffect(() => {
    try {
      window.localStorage.setItem(prefsKey, JSON.stringify({ collapsed: [...collapsed], weights }))
    } catch {
      // Private mode, or a full quota. Panel geometry is not worth a warning.
    }
  }, [prefsKey, collapsed, weights])

  // The whole SECTION is measured, not just its body: the weights below drive
  // `flex-grow` on the section, header included, so measuring the body would
  // convert pixels the pointer moved into a ratio that describes something
  // else — the split would trail the cursor by one header per boundary.
  const sectionRefs = useRef(new Map<string, HTMLDivElement | null>())
  const drag = useRef<{
    aId: string
    bId: string
    startY: number
    heightA: number
    total: number
    weightTotal: number
  } | null>(null)

  const weightOf = useCallback(
    (s: PanelStackSection) => weights[s.id] ?? s.defaultWeight ?? 1,
    [weights],
  )

  const toggle = useCallback((sectionId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }, [])

  const onHandleDown = useCallback(
    (a: PanelStackSection, b: PanelStackSection) => (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const elA = sectionRefs.current.get(a.id)
      const elB = sectionRefs.current.get(b.id)
      if (!elA || !elB) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      const heightA = elA.getBoundingClientRect().height
      const heightB = elB.getBoundingClientRect().height
      drag.current = {
        aId: a.id,
        bId: b.id,
        startY: e.clientY,
        heightA,
        total: heightA + heightB,
        weightTotal: weightOf(a) + weightOf(b),
      }
    },
    [weightOf],
  )

  const onHandleMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.total <= 0) return
    // Both ends keep MIN_SECTION, unless the pair is too short to give it to
    // them — then the split holds still rather than jumping to a bound.
    const lo = Math.min(MIN_SECTION, d.total / 2)
    const hi = Math.max(lo, d.total - lo)
    const nextA = Math.max(lo, Math.min(hi, d.heightA + (e.clientY - d.startY)))
    const weightA = (d.weightTotal * nextA) / d.total
    setWeights((prev) => ({ ...prev, [d.aId]: weightA, [d.bId]: d.weightTotal - weightA }))
  }, [])

  const onHandleUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // The capture is already gone — nothing to release.
    }
  }, [])

  const openSections = sections.filter((s) => !collapsed.has(s.id))
  const lastOpenId = openSections.length > 0 ? openSections[openSections.length - 1].id : null

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {sections.map((section) => {
        const open = !collapsed.has(section.id)
        const next = open && section.id !== lastOpenId ? openSections[openSections.indexOf(section) + 1] : null
        return (
          <div
            key={section.id}
            ref={(el) => {
              sectionRefs.current.set(section.id, el)
            }}
            className={cn("flex min-h-0 flex-col", open ? "flex-auto" : "shrink-0")}
            style={open ? { flexGrow: weightOf(section), flexBasis: 0 } : undefined}
          >
            <SectionHeader
              label={section.label}
              count={section.count}
              scope={section.scope}
              title={section.title}
              open={open}
              onToggle={() => toggle(section.id)}
            />
            {open ? <div className="min-h-0 flex-1 overflow-hidden">{section.body}</div> : null}
            {next ? (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={t.panel.resize(section.label)}
                onPointerDown={onHandleDown(section, next)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                className="group relative z-10 h-1 shrink-0 cursor-row-resize touch-none"
              >
                <div className="absolute inset-x-0 -top-1 bottom-0" />
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-transparent transition-colors group-hover:bg-line-strong" />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
