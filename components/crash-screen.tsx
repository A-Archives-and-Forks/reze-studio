"use client"

// The page that replaces the page when a render throws.
//
// Two jobs, in this order: get the user moving again, and make the failure
// reportable. The second one is why this is more than an apology — a crash on
// someone else's machine is only ever as debuggable as what they can hand over,
// and "it went white" is not that. So the report is assembled here, shown in
// full before it is sent anywhere, and copyable in one press.
//
// Deliberately self-contained: no context providers (global-error replaces the
// root layout, so nothing is mounted above it), no engine. Everything it imports
// is a candidate for the thing that just broke.
//
// Ported from reze-design. Studio has no saved scene, so the "clear local state"
// escape hatch that version offers is absent here rather than reproduced empty —
// there is nothing a reload could restore into a bad state.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { buildReport, collectStorage, type StorageSnapshot } from "@/lib/crash-log"

const ISSUES_URL = "https://github.com/AmyangXYZ/reze-studio/issues/new"
/** GitHub truncates a long prefilled URL; the copy button carries the whole thing. */
const PREFILL_LIMIT = 4000

const COPY = {
  en: {
    title: "Something broke",
    blurb: "The editor stopped rendering. Reloading usually brings it back — your model and motion files are on disk, not in the page.",
    retry: "Try again",
    reload: "Reload",
    copy: "Copy report",
    copied: "Copied",
    details: "Show details",
    hide: "Hide details",
    report: "Open an issue",
    reportHint: "Copy the report first — paste it into the issue.",
  },
  zh: {
    title: "出错了",
    blurb: "编辑器渲染中断。刷新通常就能恢复——模型和动作文件都在本地磁盘上，不在页面里。",
    retry: "重试",
    reload: "刷新",
    copy: "复制报告",
    copied: "已复制",
    details: "查看详情",
    hide: "收起详情",
    report: "提交问题",
    reportHint: "请先复制报告，再粘贴到问题里。",
  },
}

/**
 * The locale, read without mounting anything.
 *
 * Through useSyncExternalStore rather than an effect, because the source is
 * outside React and unavailable while rendering on the server: the server
 * snapshot is "en", the client's is whatever the browser says, and React
 * reconciles the two instead of the page flashing through a state update.
 */
const NEVER_CHANGES = () => () => {}
const readLocale = (): "en" | "zh" => (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en")
function useCrashLocale(): "en" | "zh" {
  return useSyncExternalStore(NEVER_CHANGES, readLocale, () => "en")
}

export function CrashScreen({
  error,
  retry,
}: {
  error?: (Error & { digest?: string }) | null
  /** Re-render the boundary's children. Absent where retrying cannot help. */
  retry?: () => void
}) {
  const locale = useCrashLocale()
  const t = COPY[locale]
  const [storage, setStorage] = useState<StorageSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    // Into the console too: a reporter who opens devtools instead of pressing
    // copy should find the same thing, not a blank log behind a polite page.
    if (error) console.error("[reze] render crashed:", error)
    void collectStorage().then(setStorage)
  }, [error])

  const report = buildReport(error ?? null, storage)

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (insecure origin, denied permission): open the details
      // so the text is at least selectable by hand.
      setOpen(true)
    }
  }, [report])

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card p-6">
        <h1 className="text-base font-medium">{t.title}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t.blurb}</p>

        {error && (
          <p className="mt-4 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs break-words">
            {error.message || error.name}
            {error.digest && <span className="text-muted-foreground"> · {error.digest}</span>}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {retry && (
            <Button size="sm" onClick={retry}>
              {t.retry}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            {t.reload}
          </Button>
          <Button size="sm" variant="outline" onClick={copy}>
            {copied ? t.copied : t.copy}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? t.hide : t.details}
          </Button>
        </div>

        {open && (
          <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text">
            {report}
          </pre>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <a
            href={`${ISSUES_URL}?title=${encodeURIComponent(
              `Crash: ${error?.message ?? "page failed to load"}`,
            )}&body=${encodeURIComponent("```\n" + report.slice(0, PREFILL_LIMIT) + "\n```")}`}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 underline-offset-4 hover:underline"
          >
            {t.report}
          </a>
          <span>{t.reportHint}</span>
        </div>
      </div>
    </div>
  )
}
