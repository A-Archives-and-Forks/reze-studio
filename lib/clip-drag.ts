"use client"

// Dragging a clip out of the library and onto a lane.
//
// The two ends of this gesture live far apart in the tree — the library is in
// the left column, the lanes are inside the timeline — and the pointer belongs
// to neither while it is in flight. So the drag itself lives here: the library
// starts one and draws the thing under the cursor, the arrangement registers
// itself as the place a drop can land, and neither has to know the other
// exists.
//
// Not HTML5 drag-and-drop. That API brings its own drag image, its own cursor
// rules and a drop model built around transferring DATA between documents;
// what this needs is a position, a highlight that follows it, and a commit —
// all of which are three pointer events.

import { useSyncExternalStore } from "react"
import type { ClipId } from "@/lib/project"

/** What the arrangement registers so a drag has somewhere to go. */
export type ClipDropTarget = {
  /** The pointer moved while a clip is in flight. */
  onMove: (clientX: number, clientY: number) => void
  /** Released here. Returns true if the drop was taken. */
  onDrop: (clientX: number, clientY: number) => boolean
  /** The drag ended without a drop, or left the target. */
  onCancel: () => void
}

let draggingClipId: ClipId | null = null
let target: ClipDropTarget | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

/** The arrangement calls this while it is mounted; null on unmount. Only one
 *  target exists at a time — there is one arrangement. */
export function registerClipDropTarget(next: ClipDropTarget | null) {
  target = next
}

export function beginClipDrag(clipId: ClipId) {
  if (draggingClipId === clipId) return
  draggingClipId = clipId
  emit()
}

export function moveClipDrag(clientX: number, clientY: number) {
  if (draggingClipId == null) return
  target?.onMove(clientX, clientY)
}

/** Release. The target takes it if the pointer is over somewhere it can go. */
export function endClipDrag(clientX: number, clientY: number): boolean {
  if (draggingClipId == null) return false
  const taken = target?.onDrop(clientX, clientY) ?? false
  draggingClipId = null
  emit()
  return taken
}

export function cancelClipDrag() {
  if (draggingClipId == null) return
  target?.onCancel()
  draggingClipId = null
  emit()
}

export function useDraggingClipId(): ClipId | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => draggingClipId,
    () => null,
  )
}
