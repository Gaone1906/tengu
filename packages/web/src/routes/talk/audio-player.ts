/**
 * Jinn Talk — streamed audio player (Phase 2 real loop).
 *
 * Plays base64-encoded audio chunks (WAV/PCM from the local TTS backend) IN
 * ORDER with low latency, and exposes an AnalyserNode so the AURA orb can react
 * to the REAL output audio (RMS level) while it speaks.
 *
 * Design:
 *  - One shared AudioContext (created lazily, resumed on the first user gesture).
 *  - Each `talk:audio` frame carries a monotonic `seq`. Frames can arrive out of
 *    order; we buffer them in a min-ordered map and only play the next expected
 *    seq, so playback is always sequential even if the network reorders.
 *  - Decoded buffers are scheduled back-to-back on a moving "playhead" clock so
 *    there are no gaps/clicks between chunks.
 *  - Every source routes through a single AnalyserNode → destination, giving the
 *    page a continuous signal to read regardless of which chunk is playing.
 *  - `onIdle` fires once the queue fully drains (used to settle the avatar).
 *
 * Decode errors are swallowed per-chunk (we skip the bad chunk and advance the
 * expected seq so playback never stalls on one corrupt frame).
 */

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

interface PendingChunk {
  seq: number
  data: ArrayBuffer
}

export class TalkAudioPlayer {
  private ctx: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null
  private gain: GainNode | null = null

  /** Frames received but not yet decoded/scheduled, keyed by seq. */
  private pending = new Map<number, PendingChunk>()
  /** The next seq we expect to schedule. */
  private nextSeq = 0
  /** Have we seen the very first chunk yet (to anchor nextSeq)? */
  private started = false

  /** Absolute AudioContext time at which the next buffer should start. */
  private playhead = 0
  /** Count of buffers currently scheduled / playing. */
  private activeSources = 0
  /** True between the first enqueue and the queue fully draining. */
  private _playing = false

  private idleCb: (() => void) | null = null
  /** Reused RMS scratch buffer for the level getter. */
  private rmsBuf: Uint8Array<ArrayBuffer> | null = null

  /** Lazily create the AudioContext + analyser graph. */
  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = new Ctor()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.7
    const gain = ctx.createGain()
    gain.gain.value = 1
    // graph: source -> analyser -> gain -> destination
    analyser.connect(gain)
    gain.connect(ctx.destination)
    this.ctx = ctx
    this.analyserNode = analyser
    this.gain = gain
    this.rmsBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    return ctx
  }

  /**
   * Resume the AudioContext. Must be called from a user gesture (e.g. mic click)
   * so browsers permit playback. Safe to call repeatedly.
   */
  resume(): void {
    const ctx = this.ensureContext()
    if (ctx.state === "suspended") void ctx.resume()
  }

  /** Enqueue a base64-encoded audio chunk. Plays in `seq` order. */
  enqueue(seq: number, _mime: string, dataBase64: string): void {
    const ctx = this.ensureContext()
    if (ctx.state === "suspended") void ctx.resume()

    let data: ArrayBuffer
    try {
      data = base64ToArrayBuffer(dataBase64)
    } catch {
      return // bad base64 — skip
    }

    // Anchor the expected seq to whatever the first chunk announces.
    if (!this.started) {
      this.started = true
      this.nextSeq = seq
      this.playhead = ctx.currentTime
      this._playing = true
    }

    this.pending.set(seq, { seq, data })
    this.drainPending()
  }

  /** Decode + schedule any pending chunks that are now contiguous from nextSeq. */
  private drainPending(): void {
    while (this.pending.has(this.nextSeq)) {
      const chunk = this.pending.get(this.nextSeq)!
      this.pending.delete(this.nextSeq)
      const seq = this.nextSeq
      this.nextSeq++
      void this.decodeAndSchedule(chunk.data, seq)
    }
  }

  private async decodeAndSchedule(data: ArrayBuffer, _seq: number): Promise<void> {
    const ctx = this.ctx
    const analyser = this.analyserNode
    if (!ctx || !analyser) return

    let buffer: AudioBuffer
    try {
      // decodeAudioData consumes the ArrayBuffer; slice keeps callers safe.
      buffer = await ctx.decodeAudioData(data.slice(0))
    } catch {
      // Corrupt/unsupported chunk — skip it; nextSeq already advanced so the
      // queue keeps flowing.
      return
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(analyser)

    // Schedule back-to-back. If we've fallen behind (playhead in the past),
    // catch up to "now" to avoid scheduling in the past.
    const now = ctx.currentTime
    const startAt = Math.max(this.playhead, now)
    this.playhead = startAt + buffer.duration

    this.activeSources++
    source.onended = () => {
      this.activeSources--
      this.checkIdle()
    }
    source.start(startAt)
  }

  private checkIdle(): void {
    if (this.activeSources <= 0 && this.pending.size === 0) {
      this._playing = false
      this.started = false
      const cb = this.idleCb
      if (cb) cb()
    }
  }

  /** The AnalyserNode the page reads for the speaking-state orb level. */
  get analyser(): AnalyserNode | null {
    return this.analyserNode
  }

  /** True while audio is queued or playing. */
  get playing(): boolean {
    return this._playing
  }

  /** Current output amplitude 0..1 (RMS from the analyser), or 0 when silent. */
  get level(): number {
    const analyser = this.analyserNode
    const buf = this.rmsBuf
    if (!analyser || !buf || !this._playing) return 0
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / buf.length)
    return Math.min(1, rms * 3.2)
  }

  /** Register a callback fired each time the queue fully drains. */
  onIdle(cb: () => void): void {
    this.idleCb = cb
  }

  /** Drop all queued audio and reset ordering state (e.g. on barge-in / unmount). */
  reset(): void {
    this.pending.clear()
    this.started = false
    this.nextSeq = 0
    this._playing = false
    this.activeSources = 0
    if (this.ctx) this.playhead = this.ctx.currentTime
  }

  /** Fully tear down the AudioContext. Call on unmount. */
  dispose(): void {
    this.reset()
    this.idleCb = null
    const ctx = this.ctx
    this.ctx = null
    this.analyserNode = null
    this.gain = null
    this.rmsBuf = null
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {})
  }
}
