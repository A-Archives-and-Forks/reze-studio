"use client"

/** A reference video, floating over the studio.
 *
 *  Deliberately NOT a textured plane in the scene: a reference is something you
 *  look at beside the model, not something the camera has to frame, light and
 *  render — and the moment it lives in the scene it starts costing per-frame GPU
 *  work and showing up in exports. A plain <video> in an HTML panel decodes on
 *  the compositor, drags and resizes to wherever the pose you are matching is,
 *  and is free again the moment you close it.
 *
 *  The engine owns the clock; the video follows. Same contract the imported
 *  music has (see AudioBridge) and for the same reason — the clip is what you
 *  are editing, and a reference that dragged the playhead around would fight
 *  every keyframe you place.
 *
 *  Session-only: the file is never persisted. A dance reference is tens or
 *  hundreds of megabytes, which is not what IndexedDB is for, and re-picking it
 *  is one menu item.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Film, Minus, Plus, Volume2, VolumeX, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FloatingPanel, clampRect, type Rect } from "@/components/floating-panel"
import { usePlaybackFrameRef, usePlaybackSelector } from "@/context/playback-context"
import { cn } from "@/lib/utils"

/** The studio's clip frame rate. The video's OWN frame rate never enters into
 *  it — everything below is done in seconds, so 24, 30 and 60fps references all
 *  line up against the same playhead. */
const FPS = 30

/** Wide enough that the status row below never has to crowd. */
const MIN_W = 320
const MIN_H = 180
/** Matching the timeline's toolbar and the studio's status bar exactly. */
const HEADER_H = 26
const FOOTER_H = 24
/** So a rect can be sized to the video's aspect ratio. */
const CHROME_H = HEADER_H + FOOTER_H

/** The studio's bar-button shape — same one the timeline transport wears. */
const BAR_BUTTON = cn(
  "flex size-5 shrink-0 items-center justify-center overflow-hidden p-0 text-muted-foreground",
  "hover:bg-transparent dark:hover:bg-transparent",
  "active:bg-muted/50",
  "focus-visible:outline-none focus-visible:ring-0",
)

/**
 * Correction while playing.
 *
 * Assigning `currentTime` is a re-seek: the decoder flushes, the picture holds
 * still and then jumps. Doing that every time two free-running clocks disagree
 * by a few milliseconds is what "synced" video usually looks like, and it is
 * worse than the drift it was added to fix — you cannot read motion out of a
 * picture that stutters in place.
 *
 * So the servo trims `playbackRate` instead: a video running 4% fast eats 40ms
 * of lag per second without dropping a frame, and the picture stays smooth the
 * whole way. A hard seek is kept only for what rate alone cannot answer — a
 * scrub, the clip looping, a tab that was backgrounded — where the gap is big
 * enough that waiting seconds for the trim to close it would be the worse of
 * the two.
 */
const SEEK_TOLERANCE = 0.2 // s — past this, rate correction would take too long
const DEADBAND = 0.5 / FPS // half a clip frame: below this there is nothing to fix
const GAIN = 0.8 // error seconds → rate trim
const MAX_TRIM = 0.08 // ±8%: closes 0.2s in under three seconds, inaudible on speech
const SERVO_MS = 60

/** How stale a presented-frame timestamp may be before we fall back to
 *  `currentTime` — two video frames at 30fps. */
const SAMPLE_FRESH_MS = 70

type FrameMeta = { mediaTime: number }
type RvfcVideo = {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** m:ss.mmm — milliseconds shown because a frame is 33 of them, and lining a
 *  reference up against a pose is exactly the job where the digit below a
 *  second is the one you are reading. */
function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0
  const total = Math.floor(t * 1000)
  const ms = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000)
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`
}

function initialRect(): Rect {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth
  const vh = typeof window === "undefined" ? 800 : window.innerHeight
  const w = Math.round(Math.min(480, Math.max(MIN_W, vw * 0.28)))
  const h = Math.round((w * 9) / 16) + CHROME_H
  // Bottom-right by default: the left rail is the file menu and the bottom
  // strip is the timeline, so this is the corner whose content you are least
  // likely to be reading while matching a pose. Drag it anywhere from there.
  return clampRect({ x: vw - w - 24, y: vh - h - 96, w, h }, MIN_W, MIN_H)
}

export function ReferenceVideo({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const playing = usePlaybackSelector((s) => s.playing)
  const currentFrame = usePlaybackSelector((s) => s.currentFrame)
  const frameRef = usePlaybackFrameRef()

  const videoRef = useRef<HTMLVideoElement>(null)
  const [rect, setRect] = useState<Rect>(initialRect)
  const onRectChange = useCallback((r: Rect) => setRect(r), [])
  /** Muted by default — the music track is imported separately, and two audio
   *  sources over one timeline is a phasing mess. The toggle is here because a
   *  reference video is often the only copy of the song you have. */
  const [muted, setMuted] = useState(true)

  /** Which clip frame the video's own t=0 sits on. Raise it to delay the
   *  reference, lower it to trim the reference's head. */
  const [offset, setOffset] = useState(0)
  const offsetRef = useRef(offset)
  useEffect(() => {
    offsetRef.current = offset
  }, [offset])
  /** Typed-but-uncommitted offset, same as the timeline's frame fields: a
   *  half-typed "-" or "" must not be read as a jump to zero. */
  const [offsetDraft, setOffsetDraft] = useState<string | null>(null)

  /** Status row, written straight to the DOM: the servo runs sixteen times a
   *  second and not one of those ticks is worth a React render. */
  const timeRef = useRef<HTMLSpanElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const durationRef = useRef(0)

  /** Where the video WANTS to be, in its own time base. */
  const wantedTime = useCallback((frame: number) => (frame - offsetRef.current) / FPS, [])

  /** Paint the status row from a position in the video's own time base. */
  const paint = useCallback((t: number) => {
    const dur = durationRef.current
    const at = clamp(t, 0, dur > 0 ? dur : t)
    if (timeRef.current) timeRef.current.textContent = `${fmt(at)} / ${fmt(dur)}`
    if (fillRef.current) fillRef.current.style.width = dur > 0 ? `${(at / dur) * 100}%` : "0%"
  }, [])

  // ── Fit the panel to the video once its real dimensions are known ───────
  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    durationRef.current = Number.isFinite(v.duration) ? v.duration : 0
    paint(v.currentTime)
    if (!v.videoWidth || !v.videoHeight) return
    setRect((r) => clampRect({ ...r, h: Math.round((r.w * v.videoHeight) / v.videoWidth) + CHROME_H }, MIN_W, MIN_H))
  }, [paint])

  // ── Paused: the playhead is the only clock ──────────────────────────────
  // Every change here is a deliberate move — a scrub, a frame step, a click on
  // the ruler — so the video is seeked to match EXACTLY rather than trimmed
  // towards it. This is the case frame-accurate reference work actually lives
  // in: you step one frame and read the pose.
  useEffect(() => {
    const v = videoRef.current
    if (!v || playing) return
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity
    const want = clamp(wantedTime(currentFrame), 0, dur)
    v.currentTime = want
    paint(want)
  }, [currentFrame, playing, offset, wantedTime, paint])

  // ── Play / pause edges ──────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (!playing) {
      v.pause()
      v.playbackRate = 1
      return
    }
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity
    // Start from the playhead, not from wherever the element was left.
    v.currentTime = clamp(wantedTime(frameRef.current), 0, dur)
    v.playbackRate = 1
    // A browser that has not seen a gesture yet refuses to play; that is a
    // legitimate answer, not something to interrupt playback over.
    void v.play().catch(() => {})
  }, [playing, frameRef, wantedTime])

  // ── Playing: measure the presented frame, trim the rate ─────────────────
  useEffect(() => {
    if (!playing) return
    const v = videoRef.current
    if (!v) return

    // `requestVideoFrameCallback` reports the media timestamp of the frame the
    // compositor actually PUT ON SCREEN. `currentTime` is the decoder's
    // playback position: it leads the picture by an unspecified amount and is
    // coarsely quantised in some browsers, so servoing against it means locking
    // onto a number that is not what the user is looking at.
    const rvfc = (v as unknown as RvfcVideo).requestVideoFrameCallback?.bind(v)
    const cancelRvfc = (v as unknown as RvfcVideo).cancelVideoFrameCallback?.bind(v)
    let sample: { t: number; at: number } | null = null
    let handle = 0
    let stopped = false
    if (rvfc) {
      const onFrame = (_now: number, meta: FrameMeta) => {
        sample = { t: meta.mediaTime, at: performance.now() }
        if (!stopped) handle = rvfc(onFrame)
      }
      handle = rvfc(onFrame)
    }

    // An interval, not rAF and not the frame callback itself: the control loop
    // has to keep running while the element sits paused past the end of a short
    // reference, which is exactly when the frame callback stops firing. 60ms is
    // far below the servo's own bandwidth and costs nothing.
    const id = setInterval(() => {
      const el = videoRef.current
      if (!el || el.seeking) return
      const dur = Number.isFinite(el.duration) ? el.duration : Infinity
      const want = wantedTime(frameRef.current)

      // Outside the reference's own span: park on the nearest end and hold.
      // Letting it simply run out would leave the element paused at the last
      // frame with nothing to bring it back when the playhead returns.
      if (want < 0 || want > dur) {
        if (!el.paused) el.pause()
        el.currentTime = clamp(want, 0, dur)
        paint(want)
        return
      }
      if (el.paused) {
        el.currentTime = want
        el.playbackRate = 1
        void el.play().catch(() => {})
        return
      }

      const now = performance.now()
      const at =
        sample && now - sample.at < SAMPLE_FRESH_MS
          ? // Extrapolate off the last presented frame: the sample is at most
            // one video frame old, and at rates near 1 that is a straight line.
            sample.t + ((now - sample.at) / 1000) * el.playbackRate
          : el.currentTime
      const err = want - at

      if (Math.abs(err) > SEEK_TOLERANCE) {
        el.playbackRate = 1
        el.currentTime = clamp(want, 0, dur)
      } else if (Math.abs(err) < DEADBAND) {
        if (el.playbackRate !== 1) el.playbackRate = 1
      } else {
        const rate = 1 + clamp(err * GAIN, -MAX_TRIM, MAX_TRIM)
        // Only write when it moves meaningfully: every assignment is a message
        // to the decoder, and the audio pitch chases it.
        if (Math.abs(el.playbackRate - rate) > 0.002) el.playbackRate = rate
      }

      // The presented time, not the wanted one: this row reports where the
      // reference IS, which is the only reading that can tell you it is off.
      paint(at)
    }, SERVO_MS)

    return () => {
      stopped = true
      clearInterval(id)
      if (handle && cancelRvfc) cancelRvfc(handle)
    }
  }, [playing, frameRef, wantedTime, paint])

  const commitOffsetDraft = useCallback(() => {
    const raw = offsetDraft ?? ""
    setOffsetDraft(null)
    const v = parseInt(raw.replace(/\s/g, ""), 10)
    if (Number.isFinite(v)) setOffset(v)
  }, [offsetDraft])

  return (
    <FloatingPanel
      rect={rect}
      onRectChange={onRectChange}
      minW={MIN_W}
      minH={MIN_H}
      className="flex select-none flex-col overflow-hidden rounded-surface border border-line-strong bg-surface shadow-float"
    >
      <header
        data-drag-handle
        className="flex shrink-0 cursor-grab items-center gap-1 overflow-hidden border-b border-line px-1.5 active:cursor-grabbing"
        style={{ height: HEADER_H }}
      >
        <Film className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="min-w-0 truncate font-mono text-[9px] text-muted-foreground" title={name}>
          {name}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={muted ? "Unmute reference" : "Mute reference"}
            onClick={() => setMuted((m) => !m)}
            className={BAR_BUTTON}
          >
            {muted ? (
              <VolumeX className="size-3.5" strokeWidth={1.75} />
            ) : (
              <Volume2 className="size-3.5" strokeWidth={1.75} />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="Close reference video"
            onClick={onClose}
            className={BAR_BUTTON}
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </Button>
        </div>
      </header>

      {/* No `controls`: the transport is the timeline. A second set of play
          buttons on the reference is two clocks to reconcile, and one of them
          is always the wrong one. */}
      <video
        ref={videoRef}
        src={src}
        muted={muted}
        playsInline
        preload="auto"
        onLoadedMetadata={onLoadedMetadata}
        className="min-h-0 w-full flex-1 bg-black object-contain"
      />

      <footer
        className="flex shrink-0 items-center gap-1.5 border-t border-line px-2 font-mono text-[9px] tabular-nums text-muted-foreground"
        style={{ height: FOOTER_H }}
      >
        <span ref={timeRef} className="shrink-0">
          0:00.000 / 0:00.000
        </span>
        <div className="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line">
          <div ref={fillRef} className="h-full w-0 bg-muted-foreground" />
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5 rounded-chip border border-line bg-surface-raised px-1 py-px"
          title="Which clip frame the reference's first frame sits on"
        >
          <span className="opacity-60">Offset</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="One frame earlier"
            onClick={() => setOffset((o) => o - 1)}
            className={cn(BAR_BUTTON, "size-4")}
          >
            <Minus className="size-3" strokeWidth={1.75} />
          </Button>
          <input
            type="text"
            inputMode="numeric"
            aria-label="Reference offset in frames"
            data-no-drag
            value={offsetDraft ?? String(offset)}
            onFocus={() => setOffsetDraft(String(offset))}
            onChange={(e) => setOffsetDraft(e.target.value)}
            onBlur={commitOffsetDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur()
            }}
            className={cn(
              "h-4 w-8 min-w-0 rounded border border-transparent bg-transparent px-0.5 text-right text-[9px] tabular-nums outline-none",
              "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/30",
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="One frame later"
            onClick={() => setOffset((o) => o + 1)}
            className={cn(BAR_BUTTON, "size-4")}
          >
            <Plus className="size-3" strokeWidth={1.75} />
          </Button>
        </div>
      </footer>
    </FloatingPanel>
  )
}
