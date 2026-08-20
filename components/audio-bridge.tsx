"use client"

/** Headless: keeps the imported track in step with the transport.
 *
 *  The engine owns the animation clock, so audio follows it rather than the
 *  other way round — the model is what you are editing, and a song that dragged
 *  the playhead around would fight every scrub. Returns null. */

import { useEffect, useRef } from "react"
import { usePlaybackSelector, usePlaybackFrameRef } from "@/context/playback-context"

const FPS = 30

/**
 * How far out of step audio has to drift before it is worth correcting.
 *
 * Generous on purpose. Assigning `currentTime` makes the element re-seek, which
 * is audible — so a tight tolerance does not keep audio honest, it produces a
 * stream of seeks. The engine's clock comes off rAF and jitters by a frame
 * either way at any moment; a tolerance near that jitter means the difference
 * crosses it constantly and the track stutters in place. That is the jitter,
 * not the drift it was added to fix.
 *
 * A third of a second is well past rAF noise and still far short of anything
 * that reads as out of sync against a dance.
 */
const DRIFT_TOLERANCE_SECONDS = 0.35

/** And even then, no more often than this. Two corrections back to back are
 *  always the clock arguing with itself rather than real drift accumulating. */
const DRIFT_CHECK_MS = 1000

export function AudioBridge({ audioUrl }: { audioUrl: string | null }) {
  const playing = usePlaybackSelector((s) => s.playing)
  const currentFrame = usePlaybackSelector((s) => s.currentFrame)
  const frameRef = usePlaybackFrameRef()
  const elRef = useRef<HTMLAudioElement | null>(null)

  // One element for the lifetime of a track.
  useEffect(() => {
    if (!audioUrl) {
      elRef.current?.pause()
      elRef.current = null
      return
    }
    const el = new Audio(audioUrl)
    el.preload = "auto"
    elRef.current = el
    return () => {
      el.pause()
      if (elRef.current === el) elRef.current = null
    }
  }, [audioUrl])

  // Transport → audio. Play starts from wherever the playhead is; pause stops
  // where it is rather than rewinding, so stepping a frame at a time does not
  // restart the track.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    if (playing) {
      el.currentTime = Math.max(0, frameRef.current) / FPS
      // A browser that has not seen a gesture yet will refuse; that is a
      // legitimate answer, not an error worth interrupting playback for.
      void el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [playing, frameRef])

  // Scrubbing while paused: follow the playhead exactly. React owns the clock
  // here, so every change is a deliberate move.
  useEffect(() => {
    const el = elRef.current
    if (!el || playing) return
    el.currentTime = Math.max(0, currentFrame) / FPS
  }, [currentFrame, playing])

  // While playing, the two clocks run independently and drift. The engine's is
  // authoritative — it is what the keyframes are drawn against — so audio is
  // nudged back to it, rarely and only when the gap is real.
  //
  // An interval, not a rAF loop: this does not need to run at frame rate, and
  // running it there was the problem — checking sixty times a second against a
  // clock that jitters by a frame guarantees the threshold is crossed
  // constantly, and every crossing is another seek. Audio playback wants to be
  // left alone; the browser's own clock is far steadier than ours.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      const el = elRef.current
      if (!el || el.paused || el.seeking) return
      const want = Math.max(0, frameRef.current) / FPS
      if (Math.abs(el.currentTime - want) > DRIFT_TOLERANCE_SECONDS) el.currentTime = want
    }, DRIFT_CHECK_MS)
    return () => clearInterval(id)
  }, [playing, frameRef])

  return null
}
