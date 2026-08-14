// What the crash screen knows.
//
// Ported from reze-design, trimmed to what Studio actually has. A React error
// boundary sees exactly one thing: the error that broke a render. Almost nothing
// here breaks a render — the engine throws inside a rAF tick, a texture fails to
// decode, a VMD parses into something the curve editor cannot hold. Those leave
// the boundary showing a blank page and the console holding the answer, which is
// fine on the reporter's machine and useless in a bug report.
//
// So: a small ring of the last warnings and errors, whatever their origin,
// captured from the moment the app loads. When something does break a render,
// the fallback has the run-up rather than just the last frame of it.

const CAPACITY = 80
/** Long enough to hold a WebGPU validation message; short enough to paste. */
const MAX_ENTRY = 600

export type LogEntry = { at: number; level: "warn" | "error"; text: string }

const ring: LogEntry[] = []

function push(level: LogEntry["level"], text: string): void {
  if (!text) return
  ring.push({ at: Date.now(), level, text: text.length > MAX_ENTRY ? `${text.slice(0, MAX_ENTRY)}…` : text })
  if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY)
}

/** Console arguments as one line, without ever throwing on a circular object. */
function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(" ")
}

// Module scope, so the same buffer is shared by whoever imports this — including
// global-error.tsx, which replaces the root layout and therefore re-renders from
// a different tree but the same module graph.
let installed = false

/**
 * Start capturing. Idempotent, and safe to call from a component that remounts.
 *
 * console.warn/error are wrapped rather than replaced: everything still reaches
 * devtools untouched, which matters because the wrapper must never become the
 * reason a message goes missing.
 */
export function installCrashLog(): void {
  if (installed || typeof window === "undefined") return
  installed = true

  const nativeWarn = console.warn.bind(console)
  const nativeError = console.error.bind(console)
  console.warn = (...args: unknown[]) => {
    try {
      push("warn", format(args))
    } catch {
      // capture is best-effort; never break the call it is observing
    }
    nativeWarn(...args)
  }
  console.error = (...args: unknown[]) => {
    try {
      push("error", format(args))
    } catch {
      // as above
    }
    nativeError(...args)
  }

  // Capture phase: a listener further in that stops propagation must not be able
  // to hide the error from the report.
  window.addEventListener(
    "error",
    (e) => {
      const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ""
      push("error", `uncaught: ${e.error?.stack ?? e.message}${where}`)
    },
    true,
  )
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason
    push("error", `unhandled rejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`)
  })
}

export function recentLogs(): LogEntry[] {
  return ring.slice()
}

const time = (ms: number) => new Date(ms).toISOString().slice(11, 23)

/**
 * What the environment can say about itself.
 *
 * Design reports the scene it restored from localStorage, because a page that
 * fails immediately on refresh is usually failing on something it restored.
 * Studio persists nothing — every session starts from an uploaded model and a
 * loaded VMD — so the only line worth carrying is the storage estimate, which
 * still catches the eviction-under-pressure class of failure.
 */
export type StorageSnapshot = { quota: string }

export async function collectStorage(): Promise<StorageSnapshot> {
  try {
    const est = await navigator.storage?.estimate?.()
    if (est?.usage != null && est?.quota != null) {
      return { quota: `${(est.usage / 1024).toFixed(1)} KB of ${(est.quota / 1024 / 1024).toFixed(0)} MB used` }
    }
  } catch {
    // not supported — the line just says unknown
  }
  return { quota: "unknown" }
}

/**
 * The whole report as plain text, ready to paste into an issue.
 *
 * Plain text on purpose: it survives a chat window, an email and a GitHub
 * comment box identically, and a reporter can read every line of it before
 * sending — which is the point at which they decide whether to.
 */
export function buildReport(error: (Error & { digest?: string }) | null, storage: StorageSnapshot | null): string {
  const out: string[] = []
  out.push("Reze Studio — crash report")
  out.push(new Date().toISOString())
  if (typeof window !== "undefined") {
    out.push(window.location.href)
    out.push(navigator.userAgent)
    out.push(`webgpu: ${"gpu" in navigator ? "present" : "absent"} · viewport ${innerWidth}×${innerHeight}`)
  }

  out.push("")
  out.push("── Error ──")
  if (error) {
    out.push(`${error.name}: ${error.message}`)
    // The digest is the only handle on a server-side error: production strips the
    // message before it reaches the client, and this hash is what matches it to
    // the server log.
    if (error.digest) out.push(`digest: ${error.digest}`)
    if (error.stack) out.push(error.stack)
  } else {
    out.push("(none — reported from the console log alone)")
  }

  if (storage) {
    out.push("")
    out.push(`storage: ${storage.quota}`)
  }

  const logs = recentLogs()
  out.push("")
  out.push(`── Console, last ${logs.length} ──`)
  if (!logs.length) out.push("(nothing captured — the failure may precede the app's own scripts)")
  for (const l of logs) out.push(`${time(l.at)}  ${l.level.padEnd(5)} ${l.text}`)

  return out.join("\n")
}
