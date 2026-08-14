"use client" // Error boundaries must be Client Components

// The boundary around every route below the root layout — which in Studio is the
// editor itself. Without this, a throw anywhere in the render escapes to Next's
// default handler and the tab goes white with nothing to report.

import { CrashScreen } from "@/components/crash-screen"

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  // Retry re-renders the children. Worth offering: a good share of what reaches
  // here is a transient decode or device failure, and recovering in place keeps
  // the loaded model and motion rather than reloading the tab out from under it.
  return <CrashScreen error={error} retry={unstable_retry} />
}
