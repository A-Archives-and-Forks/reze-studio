"use client"

import { GripVerticalIcon } from "lucide-react"
import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  gutter,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
  /** Separate two docked SURFACES rather than divide one.
   *
   *  The band becomes the gap between panels — the ground showing through —
   *  and the grip only appears under the pointer, so a resting layout is clean
   *  space between two rounded edges rather than a line drawn across it. */
  gutter?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex items-center justify-center transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden [&[aria-orientation=horizontal]>div]:rotate-90",
        gutter
          ? [
              "w-2 bg-transparent aria-[orientation=horizontal]:h-2 aria-[orientation=horizontal]:w-full",
              "before:absolute before:rounded-full before:bg-transparent before:transition-colors",
              "before:inset-y-3 before:left-1/2 before:w-[3px] before:-translate-x-1/2",
              "aria-[orientation=horizontal]:before:inset-x-3 aria-[orientation=horizontal]:before:inset-y-auto aria-[orientation=horizontal]:before:top-1/2 aria-[orientation=horizontal]:before:h-[3px] aria-[orientation=horizontal]:before:w-auto aria-[orientation=horizontal]:before:translate-x-0 aria-[orientation=horizontal]:before:-translate-y-1/2",
              "hover:before:bg-line-strong data-[state=drag]:before:bg-blue-400",
            ]
          : "w-px bg-line after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 hover:bg-blue-400/50 aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 data-[state=drag]:bg-blue-400",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-chip border border-line-strong bg-surface-raised">
          <GripVerticalIcon className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
