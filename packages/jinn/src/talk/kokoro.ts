/**
 * Jinn Talk — Kokoro-82M TTS engine (Phase 2 voice loop).
 *
 * Implements the `Tts` interface from ./context.js. Mirrors the STT sidecar
 * pattern (src/stt/stt.ts): weights live under JINN_HOME/models/kokoro, a Python
 * venv hosts a long-running HTTP sidecar (kokoro_sidecar.py) that wraps
 * `kokoro-onnx`, and this module owns the sidecar's lifecycle (spawn / health /
 * restart / shutdown).
 *
 * speak() sentence-chunks the text and streams ordered talk:audio events so the
 * frontend can play chunks as they arrive. Everything is defensive: if Python,
 * the venv, or the weights are missing, status().available is false and speak()
 * rejects gracefully so the loop degrades to the frontend's Web Speech fallback.
 */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { JINN_HOME } from "../shared/paths.js"
import { logger } from "../shared/logger.js"
import { TALK_EVENTS, type Emit } from "./protocol.js"
import type { Tts } from "./context.js"

/** Model / venv layout under JINN_HOME. */
const KOKORO_DIR = path.join(JINN_HOME, "models", "kokoro")
const VENV_PYTHON = path.join(KOKORO_DIR, "venv", "bin", "python")
const ONNX_FILE = path.join(KOKORO_DIR, "kokoro-v1.0.onnx")
const VOICES_FILE = path.join(KOKORO_DIR, "voices-v1.0.bin")

/** kokoro-onnx official release assets. */
const RELEASE_BASE =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
const DOWNLOADS: Array<{ url: string; dest: string; size: number }> = [
  { url: `${RELEASE_BASE}/kokoro-v1.0.onnx`, dest: ONNX_FILE, size: 325_000_000 },
  { url: `${RELEASE_BASE}/voices-v1.0.bin`, dest: VOICES_FILE, size: 28_000_000 },
]

const DEFAULT_VOICE = "af_heart"
const DEFAULT_PORT = 8765
const HEALTH_TIMEOUT_MS = 60_000 // model load is lazy + heavy on first synth
const SYNTH_TIMEOUT_MS = 120_000

interface HealthResponse {
  ok: boolean
  ready: boolean
}

/** Resolve the sidecar .py path: next to this module, then a src/ fallback. */
function resolveSidecarPath(): string {
  const here = fileURLToPath(import.meta.url)
  const sameDir = path.join(path.dirname(here), "kokoro_sidecar.py")
  if (fs.existsSync(sameDir)) return sameDir
  // Running from dist before the lead's build copies the .py — fall back to src.
  const srcPath = here.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`)
  if (srcPath !== here) {
    const candidate = srcPath.replace(/kokoro\.(js|ts)$/, "kokoro_sidecar.py")
    if (fs.existsSync(candidate)) return candidate
  }
  return sameDir // best effort; spawn will surface ENOENT
}

/** Pick a free localhost TCP port (used when no explicit port is configured). */
function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once("error", () => resolve(preferred)) // fall back to preferred on bind error
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : preferred
      srv.close(() => resolve(port))
    })
  })
}

export function createKokoroTts(opts?: {
  voice?: string
  modelDir?: string
  sidecarPort?: number
}): Tts {
  const voice = opts?.voice || DEFAULT_VOICE
  const modelDir = opts?.modelDir || KOKORO_DIR
  const onnxFile = modelDir === KOKORO_DIR ? ONNX_FILE : path.join(modelDir, "kokoro-v1.0.onnx")
  const voicesFile = modelDir === KOKORO_DIR ? VOICES_FILE : path.join(modelDir, "voices-v1.0.bin")
  const pythonBin =
    modelDir === KOKORO_DIR ? VENV_PYTHON : path.join(modelDir, "venv", "bin", "python")

  let child: ChildProcess | null = null
  let port = 0
  let starting: Promise<void> | null = null
  let ready = false // last-known sidecar /health "ready" (model loaded)
  let downloading = false
  let downloadProgress = 0

  /** Are the on-disk weights present? */
  function weightsPresent(): boolean {
    return fs.existsSync(onnxFile) && fs.existsSync(voicesFile)
  }

  /** Is the venv python runnable? */
  function pythonPresent(): boolean {
    return fs.existsSync(pythonBin)
  }

  async function httpGetHealth(p: number): Promise<HealthResponse | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!res.ok) return null
      return (await res.json()) as HealthResponse
    } catch {
      return null
    }
  }

  /** Spawn the sidecar and wait until /health answers. Idempotent per failure. */
  async function ensureSidecar(): Promise<void> {
    // Already alive?
    if (child && child.exitCode === null && port) {
      const h = await httpGetHealth(port)
      if (h?.ok) {
        ready = h.ready
        return
      }
    }
    if (starting) return starting

    starting = (async () => {
      if (!pythonPresent()) {
        throw new Error(`Kokoro venv python missing at ${pythonBin} — run download() first`)
      }
      if (!weightsPresent()) {
        throw new Error(`Kokoro weights missing in ${modelDir} — run download() first`)
      }

      const chosen = opts?.sidecarPort || (await findFreePort(DEFAULT_PORT))
      const sidecar = resolveSidecarPath()

      const proc = spawn(
        pythonBin,
        [sidecar, "--port", String(chosen), "--model-dir", modelDir, "--voice", voice],
        { stdio: ["ignore", "pipe", "pipe"] },
      )

      let listening = false
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!listening) reject(new Error("Kokoro sidecar did not start in time"))
        }, 20_000)

        proc.stdout?.on("data", (buf: Buffer) => {
          const line = buf.toString()
          if (line.includes("KOKORO_SIDECAR_LISTENING")) {
            listening = true
            clearTimeout(timer)
            resolve()
          }
        })
        proc.stderr?.on("data", (buf: Buffer) => {
          logger.debug(`[kokoro] ${buf.toString().trim()}`)
        })
        proc.on("error", (err) => {
          clearTimeout(timer)
          reject(err)
        })
        proc.on("exit", (code) => {
          if (!listening) {
            clearTimeout(timer)
            reject(new Error(`Kokoro sidecar exited early (code ${code})`))
          }
        })
      })

      // Reset liveness flags whenever the process dies so the next call respawns.
      proc.on("exit", (code, signal) => {
        logger.warn(`[kokoro] sidecar exited (code=${code} signal=${signal})`)
        if (child === proc) {
          child = null
          port = 0
          ready = false
        }
      })

      child = proc
      port = chosen
      const h = await httpGetHealth(chosen)
      ready = h?.ready ?? false
      logger.info(`[kokoro] sidecar listening on 127.0.0.1:${chosen} (voice=${voice})`)
    })()

    try {
      await starting
    } finally {
      starting = null
    }
  }

  /** POST one sentence to /synth and return the raw WAV bytes. */
  async function synth(text: string): Promise<Buffer> {
    await ensureSidecar()
    if (!port) throw new Error("Kokoro sidecar not available")
    const res = await fetch(`http://127.0.0.1:${port}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    })
    if (!res.ok) {
      let detail = ""
      try {
        detail = ((await res.json()) as { error?: string }).error || ""
      } catch {
        /* non-json error body */
      }
      throw new Error(`Kokoro synth failed (${res.status})${detail ? `: ${detail}` : ""}`)
    }
    ready = true // a successful synth means the model is loaded
    return Buffer.from(await res.arrayBuffer())
  }

  /**
   * Split text into sentence-sized chunks for low-latency, ordered playback.
   * Keeps the terminal punctuation; collapses whitespace; drops empties.
   */
  function splitSentences(text: string): string[] {
    const parts = text
      .replace(/\s+/g, " ")
      .trim()
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return parts.length > 0 ? parts : []
  }

  return {
    async speak(sessionId: string, text: string, emit: Emit): Promise<void> {
      const sentences = splitSentences(text)
      if (sentences.length === 0) return

      // Fail fast & gracefully if the engine can't run at all.
      if (!pythonPresent() || !weightsPresent()) {
        throw new Error(
          "Kokoro TTS unavailable (missing venv or weights) — falling back to Web Speech",
        )
      }

      let seq = 0
      for (let i = 0; i < sentences.length; i++) {
        const wav = await synth(sentences[i]!)
        const last = i === sentences.length - 1
        emit(TALK_EVENTS.audio, {
          sessionId,
          seq: seq++,
          mime: "audio/wav",
          dataBase64: wav.toString("base64"),
          last,
        })
      }
    },

    async warm(): Promise<void> {
      // Nothing to warm if the engine can't run; speak() will surface the error.
      if (!pythonPresent() || !weightsPresent()) return
      try {
        // One throwaway synth spawns the sidecar AND forces the heavy model load
        // so the user's first real sentence doesn't pay it. Audio is discarded.
        await synth(".")
      } catch (err) {
        logger.debug(`[kokoro] warm failed: ${err instanceof Error ? err.message : err}`)
      }
    },

    status() {
      return {
        available: pythonPresent() && weightsPresent(),
        downloading,
        progress: downloadProgress,
        voice,
        ready: ready && child !== null && child.exitCode === null,
      }
    },

    async download(emit: Emit): Promise<void> {
      if (downloading) return
      downloading = true
      downloadProgress = 0
      try {
        fs.mkdirSync(modelDir, { recursive: true })

        // 1. Ensure the venv + python deps exist (kokoro-onnx + onnxruntime + soundfile + numpy).
        if (!pythonPresent()) {
          await ensureVenv(modelDir)
        }

        // 2. Fetch the onnx weights + voices if absent, reporting growth as progress.
        const totalBytes = DOWNLOADS.reduce((n, d) => n + d.size, 0)
        let basePrior = 0
        for (const d of DOWNLOADS) {
          if (fs.existsSync(d.dest)) {
            basePrior += d.size
            downloadProgress = Math.min(99, Math.round((basePrior / totalBytes) * 100))
            emit(TALK_EVENTS.ttsDownloadProgress, { progress: downloadProgress })
            continue
          }
          await curlDownload(d.url, d.dest, (bytes) => {
            downloadProgress = Math.min(
              99,
              Math.round(((basePrior + Math.min(bytes, d.size)) / totalBytes) * 100),
            )
            emit(TALK_EVENTS.ttsDownloadProgress, { progress: downloadProgress })
          })
          basePrior += d.size
        }

        downloadProgress = 100
        emit(TALK_EVENTS.ttsDownloadProgress, { progress: 100 })
        emit(TALK_EVENTS.ttsDownloadComplete, {})
        logger.info(`[kokoro] weights ready in ${modelDir}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit(TALK_EVENTS.ttsDownloadError, { error: message })
        logger.error(`[kokoro] download failed: ${message}`)
        throw err
      } finally {
        downloading = false
      }
    },

    shutdown(): void {
      if (child && child.exitCode === null) {
        try {
          child.kill("SIGTERM")
        } catch {
          /* already gone */
        }
      }
      child = null
      port = 0
      ready = false
    },
  }
}

/** Create the venv and install the Python deps for the sidecar. */
function ensureVenv(modelDir: string): Promise<void> {
  const venvDir = path.join(modelDir, "venv")
  const py = path.join(venvDir, "bin", "python")
  return new Promise<void>((resolve, reject) => {
    const make = spawn("python3", ["-m", "venv", venvDir], { stdio: "ignore" })
    make.on("error", reject)
    make.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`venv creation failed (code ${code})`))
      const pip = spawn(
        py,
        ["-m", "pip", "install", "--quiet", "kokoro-onnx", "onnxruntime", "soundfile", "numpy"],
        { stdio: "ignore" },
      )
      pip.on("error", reject)
      pip.on("exit", (pcode) =>
        pcode === 0 ? resolve() : reject(new Error(`pip install failed (code ${pcode})`)),
      )
    })
  })
}

/** Download a URL to dest via curl, polling file size for progress. */
function curlDownload(
  url: string,
  dest: string,
  onBytes: (bytes: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tmp = `${dest}.downloading`
    const curl = spawn("curl", ["-L", "--fail", "-o", tmp, url])

    const poll = setInterval(() => {
      try {
        const st = fs.statSync(tmp, {
          throwIfNoEntry: false,
        } as fs.StatSyncOptions & { throwIfNoEntry: false })
        if (st && st.size > 0) onBytes(st.size as number)
      } catch {
        /* not created yet */
      }
    }, 1_000)

    curl.on("error", (err) => {
      clearInterval(poll)
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      reject(err)
    })
    curl.on("exit", (code) => {
      clearInterval(poll)
      if (code === 0) {
        try {
          fs.renameSync(tmp, dest)
          resolve()
        } catch (err) {
          reject(err as Error)
        }
      } else {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        reject(new Error(`curl exited with code ${code} for ${url}`))
      }
    })
  })
}
