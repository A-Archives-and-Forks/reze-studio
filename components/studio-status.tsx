"use client"

/** Status bar — self-contained external store + footer component.
 *
 *  Extracted from StudioPage so high-frequency chrome updates (FPS ticks, PMX
 *  swap feedback) don't re-render the page shell. The footer subscribes to its
 *  own slices via `useStudioStatusSelector`; producers push via
 *  `useStudioStatusActions()` without causing any parent re-render. */

import {
  createContext,
  createElement,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"
import { useT } from "@/lib/i18n"

export type StudioStatusState = {
  pmxFileName: string
  fps: number | null
  /** Reserved for save feedback / transient hints. */
  message: string
}

export type StudioStatusActions = {
  setPmxFileName: (name: string) => void
  setFps: (fps: number | null) => void
  setMessage: (msg: string) => void
}

const INITIAL_STATE: StudioStatusState = {
  pmxFileName: "—",
  fps: null,
  message: "",
}

type StudioStatusStore = {
  getState: () => StudioStatusState
  subscribe: (l: () => void) => () => void
  actions: StudioStatusActions
}

function createStore(): StudioStatusStore {
  let state = INITIAL_STATE
  const listeners = new Set<() => void>()
  const set = (next: StudioStatusState) => {
    if (next === state) return
    state = next
    listeners.forEach((l) => l())
  }
  const update = <K extends keyof StudioStatusState>(key: K, value: StudioStatusState[K]) => {
    if (state[key] === value) return
    set({ ...state, [key]: value })
  }
  const actions: StudioStatusActions = {
    setPmxFileName: (name) => update("pmxFileName", name),
    setFps: (fps) => update("fps", fps),
    setMessage: (msg) => update("message", msg),
  }
  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    actions,
  }
}

const Ctx = createContext<StudioStatusStore | null>(null)

export function StudioStatusProvider({ children }: { children: ReactNode }) {
  const ref = useRef<StudioStatusStore | null>(null)
  if (ref.current == null) ref.current = createStore()
  return createElement(Ctx.Provider, { value: ref.current }, children)
}

function useStore(): StudioStatusStore {
  const s = useContext(Ctx)
  if (s == null) throw new Error("useStudioStatus* must be used within <StudioStatusProvider>")
  return s
}

export function useStudioStatusSelector<T>(selector: (s: StudioStatusState) => T): T {
  const store = useStore()
  const getSnapshot = () => selector(store.getState())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function useStudioStatusActions(): StudioStatusActions {
  return useStore().actions
}

/**
 * The two things the status bar was actually for, over the viewport instead of
 * under everything.
 *
 * A full-width bar spent a row of the window on four labels that never change
 * and one number that does. What is left is what a bar was the wrong shape for:
 * a message that appears when something happened and leaves on its own, and a
 * corner readout for the health of the frame.
 */
export const StudioStatusOverlay = memo(function StudioStatusOverlay({ ikEnabled }: { ikEnabled: boolean }) {
  const t = useT()
  const fps = useStudioStatusSelector((s) => s.fps)
  const message = useStudioStatusSelector((s) => s.message)
  // Shown, then gone. The store keeps the last message forever — it has no idea
  // when one has been read — so the fade is the overlay's own business.
  const [visible, setVisible] = useState("")
  useEffect(() => {
    if (message === "") return
    setVisible(message)
    const id = setTimeout(() => setVisible(""), 4000)
    return () => clearTimeout(id)
  }, [message])

  return (
    <>
      {visible !== "" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
          <div className="max-w-[80%] truncate rounded-full border border-line-strong bg-surface-raised px-3 py-1 text-[11px] text-muted-foreground shadow-float">
            {visible}
          </div>
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-2 right-3 z-10 flex items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
        {!ikEnabled ? <span className="text-amber-400">{t.footer.ik} {t.footer.off}</span> : null}
        <span title={t.footer.fpsTitle}>{fps != null ? `${fps} FPS` : "— FPS"}</span>
      </div>
    </>
  )
})
