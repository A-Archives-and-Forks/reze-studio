// Music, as loudness over time — the waveform drawn under the keyframes.
//
// Nothing here edits audio. The track is a reference you cut against: seeing
// where the beats are is most of what syncing a dance to a song needs, and it
// is the one thing a numeric playhead cannot tell you.

/** Columns of RMS the waveform is reduced to.
 *
 *  Fixed rather than per-pixel: the lane is zoomed and scrolled constantly, and
 *  re-walking a four-minute buffer on every zoom step would cost far more than
 *  sampling a precomputed array. High enough that a deep zoom still has detail
 *  to show, small enough to keep in a draft record. */
export const AUDIO_PEAK_COLUMNS = 4096

export type AudioPeaks = {
  /** RMS per column, normalised to 0..1. */
  peaks: number[]
  /** Track length in seconds — what the lane is drawn to scale against. */
  duration: number
}

/**
 * Decode a track and reduce it to one value per column.
 *
 * RMS per column, not peak. Peak is the obvious choice and it is wrong at this
 * size: a four-minute track across a few thousand columns is a fraction of a
 * second each, and the loudest single sample in any such window of mastered
 * music is essentially the track's own maximum — so every column comes out full
 * height and the waveform renders as a solid bar. RMS follows the energy
 * actually in each window, which is what makes a waveform look like the song.
 *
 * The decoded buffer is dropped as soon as the columns are out: a four-minute
 * track is tens of megabytes of Float32, and the draft record only needs the
 * few thousand numbers the lane draws.
 */
export async function decodeAudioPeaks(bytes: ArrayBuffer): Promise<AudioPeaks | null> {
  // AudioContext rather than OfflineAudioContext: this only decodes, and an
  // offline context wants a length up front that we do not know yet.
  const AC: typeof AudioContext | undefined =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  const ac = new AC()
  try {
    const buf = await ac.decodeAudioData(bytes)
    const cols = new Array<number>(AUDIO_PEAK_COLUMNS).fill(0)
    const per = Math.max(1, Math.floor(buf.length / AUDIO_PEAK_COLUMNS))
    // Channel 0 alone. A stereo pass costs a second walk of the whole buffer to
    // move a handful of columns a few percent.
    const data = buf.getChannelData(0)
    let max = 0
    for (let c = 0; c < AUDIO_PEAK_COLUMNS; c++) {
      const from = c * per
      const to = Math.min(data.length, from + per)
      let sum = 0
      for (let i = from; i < to; i++) sum += data[i] * data[i]
      const rms = to > from ? Math.sqrt(sum / (to - from)) : 0
      cols[c] = rms
      if (rms > max) max = rms
    }
    // Normalised so a quietly-mastered track still fills the lane — this is a
    // shape to read, not a level meter.
    if (max > 0) for (let c = 0; c < cols.length; c++) cols[c] /= max
    return { peaks: cols, duration: buf.duration }
  } catch {
    return null
  } finally {
    void ac.close()
  }
}
