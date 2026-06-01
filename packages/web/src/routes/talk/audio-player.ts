/**
 * Jinn Talk — streamed audio player (Phase 2 real loop).
 *
 * Plays base64-encoded audio chunks (a complete WAV per sentence from the local
 * Kokoro TTS backend) IN ARRIVAL ORDER with low latency, and exposes an
 * AnalyserNode so the AURA orb can react to the REAL output audio (RMS level)
 * while it speaks.
 *
 * Design:
 *  - One shared AudioContext (created lazily, resumed on the first user gesture).
 *  - Each `talk:audio` frame is a SELF-CONTAINED WAV. The backend speaks one
 *    sentence per call, so the per-frame `seq` resets to 0 each sentence — it is
 *    NOT a turn-global counter and must not be used to gate playback. Frames
 *    arrive in order over a single WS connection, so we simply play them in
 *    arrival order.
 *  - Decode + schedule is serialized on a promise chain so the moving "playhead"
 *    clock stays correct and chunks are scheduled back-to-back with no gaps,
 *    clicks, or overlaps — regardless of how fast each chunk decodes.
 *  - Every source routes through a single AnalyserNode → destination, giving the
 *    page a continuous signal to read regardless of which chunk is playing.
 *  - `onIdle` fires once the queue fully drains (used to settle the avatar).
 *
 * Decode errors are swallowed per-chunk (we skip the bad chunk) so playback
 * never stalls on one corrupt frame.
 */

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export class TalkAudioPlayer {
  private ctx: AudioContext | null = null
  private analyserNode: AnalyserNode | null = null
  private gain: GainNode | null = null

  /** Serializes decode+schedule so arrival order and the playhead stay correct. */
  private chain: Promise<void> = Promise.resolve()
  /** Have we started a fresh playback run (to anchor the playhead)? */
  private started = false

  /** Absolute AudioContext time at which the next buffer should start. */
  private playhead = 0
  /** Count of buffers currently scheduled / playing. */
  private activeSources = 0
  /** Chunks accepted but not yet decoded/scheduled (sitting in the chain). */
  private inFlight = 0
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

  /**
   * Enqueue a base64-encoded audio chunk. Each chunk is a standalone WAV and is
   * played in ARRIVAL ORDER (the `seq` arg is intentionally ignored — see the
   * file header). Decode+schedule is serialized so timing stays correct.
   */
  enqueue(_seq: number, _mime: string, dataBase64: string): void {
    const ctx = this.ensureContext()
    if (ctx.state === "suspended") void ctx.resume()

    let data: ArrayBuffer
    try {
      data = base64ToArrayBuffer(dataBase64)
    } catch {
      return // bad base64 — skip
    }

    if (!this.started) {
      this.started = true
      this.playhead = ctx.currentTime
      this._playing = true
    }

    this.inFlight++
    this.chain = this.chain.then(() => this.decodeAndSchedule(data))
  }

  private async decodeAndSchedule(data: ArrayBuffer): Promise<void> {
    const ctx = this.ctx
    const analyser = this.analyserNode
    if (!ctx || !analyser) {
      this.inFlight = Math.max(0, this.inFlight - 1)
      return
    }

    let buffer: AudioBuffer
    try {
      // decodeAudioData consumes the ArrayBuffer; slice keeps callers safe.
      buffer = await ctx.decodeAudioData(data.slice(0))
    } catch {
      // Corrupt/unsupported chunk — skip it; the queue keeps flowing.
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.checkIdle()
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
    this.inFlight = Math.max(0, this.inFlight - 1)
    source.onended = () => {
      this.activeSources--
      this.checkIdle()
    }
    source.start(startAt)
  }

  private checkIdle(): void {
    // Idle only when nothing is playing AND nothing is still queued to decode.
    if (this.activeSources <= 0 && this.inFlight <= 0) {
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
    // Abandon the in-flight decode chain; future enqueues start a fresh chain.
    this.chain = Promise.resolve()
    this.started = false
    this.inFlight = 0
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
