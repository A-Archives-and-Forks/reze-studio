"use client"

// Suppresses the browser's native context menu site-wide — a canvas-heavy editor
// where every div can sit under the cursor makes right-click-anywhere land on the
// OS menu constantly. Text inputs are exempted so copy/paste/spellcheck still work.
// Once we register our own context menu(s), they hook the same `contextmenu` event
// and this just stops the native one from showing underneath.

import { useEffect } from "react"

export function NoNativeContextMenu() {
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return
      e.preventDefault()
    }
    document.addEventListener("contextmenu", onCtx)
    return () => document.removeEventListener("contextmenu", onCtx)
  }, [])
  return null
}
