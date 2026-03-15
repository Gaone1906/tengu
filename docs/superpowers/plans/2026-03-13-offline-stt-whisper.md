# Offline Speech-to-Text with whisper.cpp Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser Web Speech API mic button with offline STT powered by whisper.cpp running on the gateway server, including a first-time model download UX and a live waveform animation during recording.

**Architecture:** The gateway gets a new `stt` module that wraps `nodejs-whisper` for model management and transcription. Three new API endpoints expose STT status, model download (with WebSocket progress events), and transcription. The web UI replaces the Web Speech API code in `chat-input.tsx` with a `useStt` hook that manages recording via MediaRecorder, renders a live waveform via Web Audio API AnalyserNode, and sends audio blobs to the gateway. A download modal appears on first mic click if no model is installed.

**Tech Stack:** nodejs-whisper (whisper.cpp wrapper), MediaRecorder API, Web Audio API (AnalyserNode), Radix UI Dialog, WebSocket events

---

## File Structure

### Gateway (`packages/jimmy/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/stt/stt.ts` | Create | Core STT module — model status, download with progress callback, transcribe audio files |
| `src/shared/paths.ts` | Modify | Add `MODELS_DIR` and `STT_MODELS_DIR` constants |
| `src/shared/types.ts` | Modify | Add `stt` field to `JinnConfig` interface |
| `src/gateway/api.ts` | Modify | Add 3 endpoints: `GET /api/stt/status`, `POST /api/stt/download`, `POST /api/stt/transcribe`; add `readBodyRaw()` for binary uploads |
| `package.json` | Modify | Add `nodejs-whisper` dependency |

### Web UI (`packages/web/`)

| File | Action | Responsibility |
|------|--------|----------------|
| `src/hooks/use-stt.ts` | Create | Hook: manages STT status polling, download trigger, recording state, audio capture, transcription request |
| `src/components/chat/stt-download-modal.tsx` | Create | First-time download dialog with progress bar |
| `src/components/chat/stt-waveform.tsx` | Create | Live waveform visualizer (animated frequency bars from AnalyserNode) |
| `src/components/chat/chat-input.tsx` | Modify | Replace Web Speech API code with `useStt` hook integration; new mic button states |
| `src/lib/api.ts` | Modify | Add `sttStatus()`, `sttDownload()`, `sttTranscribe(blob)` methods |
| `src/types/speech-recognition.d.ts` | Delete | No longer needed (was for Web Speech API) |

---

## Chunk 1: Gateway STT Module

### Task 1: Add paths and config type

**Files:**
- Modify: `packages/jimmy/src/shared/paths.ts`
- Modify: `packages/jimmy/src/shared/types.ts`

- [ ] **Step 1: Add model directory paths to paths.ts**

Add after the existing `TMP_DIR` line:

```typescript
export const MODELS_DIR = path.join(JINN_HOME, "models");
export const STT_MODELS_DIR = path.join(JINN_HOME, "models", "whisper");
```

- [ ] **Step 2: Add STT config to JinnConfig interface in types.ts**

Add inside the `JinnConfig` interface, after the `portal?` field:

```typescript
stt?: {
  enabled?: boolean;
  model?: string;
  language?: string;
};
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (new fields are optional, no consumers yet)

- [ ] **Step 4: Commit**

```bash
git add packages/jimmy/src/shared/paths.ts packages/jimmy/src/shared/types.ts
git commit -m "feat(stt): add model directory paths and config type"
```

---

### Task 2: Install nodejs-whisper

**Files:**
- Modify: `packages/jimmy/package.json`

- [ ] **Step 1: Add nodejs-whisper dependency**

```bash
cd packages/jimmy && pnpm add nodejs-whisper
```

- [ ] **Step 2: Verify it installed and check the whisper.cpp models path**

```bash
ls node_modules/nodejs-whisper/cpp/whisper.cpp/models/ 2>/dev/null || echo "models dir will be created on first download"
```

- [ ] **Step 3: Commit**

```bash
git add packages/jimmy/package.json pnpm-lock.yaml
git commit -m "feat(stt): add nodejs-whisper dependency"
```

---

### Task 3: Create the STT module

**Files:**
- Create: `packages/jimmy/src/stt/stt.ts`

This module manages the symlink between `~/.jinn/models/whisper/` and nodejs-whisper's internal models directory, checks model availability, triggers downloads, and runs transcription.

- [ ] **Step 1: Create the stt module**

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { STT_MODELS_DIR, TMP_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

// nodejs-whisper stores models inside node_modules — we symlink our persistent dir there
// so models survive npm installs
const WHISPER_INTERNAL_MODELS = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "..", "node_modules", "nodejs-whisper", "cpp", "whisper.cpp", "models",
);

const MODEL_FILES: Record<string, string> = {
  tiny: "ggml-tiny.bin",
  "tiny.en": "ggml-tiny.en.bin",
  base: "ggml-base.bin",
  "base.en": "ggml-base.en.bin",
  small: "ggml-small.bin",
  "small.en": "ggml-small.en.bin",
  medium: "ggml-medium.bin",
  "medium.en": "ggml-medium.en.bin",
  "large-v3-turbo": "ggml-large-v3-turbo.bin",
};

let downloading = false;
let downloadProgress = 0;

/**
 * Ensure ~/.jinn/models/whisper/ exists and is symlinked into nodejs-whisper's
 * internal models directory so the package can find downloaded models.
 */
export function initStt(): void {
  // Create persistent models dir
  fs.mkdirSync(STT_MODELS_DIR, { recursive: true });

  // Ensure the parent dir for the symlink target exists
  const parentDir = path.dirname(WHISPER_INTERNAL_MODELS);
  if (fs.existsSync(parentDir)) {
    // Remove existing models dir/symlink and replace with our symlink
    const stat = fs.lstatSync(WHISPER_INTERNAL_MODELS, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(WHISPER_INTERNAL_MODELS);
        if (target === STT_MODELS_DIR) return; // already correct
        fs.unlinkSync(WHISPER_INTERNAL_MODELS);
      } else if (stat.isDirectory()) {
        // Move any existing models to our persistent dir
        for (const file of fs.readdirSync(WHISPER_INTERNAL_MODELS)) {
          const src = path.join(WHISPER_INTERNAL_MODELS, file);
          const dest = path.join(STT_MODELS_DIR, file);
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest);
          }
        }
        fs.rmSync(WHISPER_INTERNAL_MODELS, { recursive: true });
      }
    }
    fs.symlinkSync(STT_MODELS_DIR, WHISPER_INTERNAL_MODELS, "dir");
    logger.info(`STT models symlinked: ${WHISPER_INTERNAL_MODELS} → ${STT_MODELS_DIR}`);
  }
}

export function getModelPath(model: string): string | null {
  const filename = MODEL_FILES[model];
  if (!filename) return null;
  const filePath = path.join(STT_MODELS_DIR, filename);
  return fs.existsSync(filePath) ? filePath : null;
}

export interface SttStatus {
  available: boolean;
  model: string | null;
  downloading: boolean;
  progress: number;
}

export function getSttStatus(configModel?: string): SttStatus {
  const model = configModel || "small";
  const modelPath = getModelPath(model);
  return {
    available: modelPath !== null,
    model: modelPath ? model : null,
    downloading,
    progress: downloadProgress,
  };
}

export async function downloadModel(
  model: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  if (downloading) throw new Error("Download already in progress");

  const filename = MODEL_FILES[model];
  if (!filename) throw new Error(`Unknown model: ${model}`);

  // Check if already downloaded
  if (getModelPath(model)) {
    onProgress(100);
    return;
  }

  downloading = true;
  downloadProgress = 0;

  try {
    // Use nodejs-whisper's auto-download by calling it with a dummy file
    // This triggers the model download + whisper.cpp build
    const { nodewhisper } = await import("nodejs-whisper");

    // Create a minimal silent WAV to trigger download
    const silentWav = path.join(TMP_DIR, "stt-download-trigger.wav");
    fs.mkdirSync(TMP_DIR, { recursive: true });
    createSilentWav(silentWav);

    // Progress polling — check file size growth
    const expectedSizes: Record<string, number> = {
      tiny: 75_000_000,
      "tiny.en": 75_000_000,
      base: 142_000_000,
      "base.en": 142_000_000,
      small: 466_000_000,
      "small.en": 466_000_000,
      medium: 1_500_000_000,
      "medium.en": 1_500_000_000,
      "large-v3-turbo": 1_500_000_000,
    };
    const expectedSize = expectedSizes[model] || 466_000_000;
    const modelFilePath = path.join(STT_MODELS_DIR, filename);

    const progressInterval = setInterval(() => {
      try {
        const stat = fs.statSync(modelFilePath, { throwIfNoEntry: false } as any);
        if (stat && stat.size > 0) {
          downloadProgress = Math.min(95, Math.round((stat.size / expectedSize) * 100));
          onProgress(downloadProgress);
        }
      } catch {
        // File doesn't exist yet
      }
    }, 500);

    try {
      await nodewhisper(silentWav, {
        modelName: model,
        autoDownloadModelName: model,
        whisperOptions: { outputInText: true },
      });
    } finally {
      clearInterval(progressInterval);
      // Clean up temp file
      try { fs.unlinkSync(silentWav); } catch {}
    }

    downloadProgress = 100;
    onProgress(100);
    logger.info(`STT model '${model}' downloaded successfully`);
  } finally {
    downloading = false;
  }
}

export async function transcribe(
  audioPath: string,
  model: string,
  language?: string,
): Promise<string> {
  const modelPath = getModelPath(model);
  if (!modelPath) throw new Error(`Model '${model}' not found. Download it first.`);

  const { nodewhisper } = await import("nodejs-whisper");

  const result = await nodewhisper(audioPath, {
    modelName: model,
    whisperOptions: {
      outputInText: true,
      language: language || "en",
    },
  });

  // nodejs-whisper returns text with timestamps — strip them
  // Format: "[00:00:00.000 --> 00:00:02.000]  Hello world"
  const cleaned = result
    .replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, "")
    .trim();

  return cleaned;
}

/** Create a minimal 16kHz mono WAV file (0.1s of silence) for triggering model download. */
function createSilentWav(filePath: string): void {
  const sampleRate = 16000;
  const numSamples = sampleRate / 10; // 0.1 seconds
  const dataSize = numSamples * 2; // 16-bit samples
  const buffer = Buffer.alloc(44 + dataSize);

  // WAV header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  // Data is already zero-filled (silence)

  fs.writeFileSync(filePath, buffer);
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/jimmy/src/stt/stt.ts
git commit -m "feat(stt): create core STT module with model management and transcription"
```

---

## Chunk 2: Gateway API Endpoints

### Task 4: Add binary body reader and STT API routes

**Files:**
- Modify: `packages/jimmy/src/gateway/api.ts`
- Modify: `packages/jimmy/src/gateway/server.ts`

- [ ] **Step 1: Add readBodyRaw to api.ts**

Add after the existing `readBody` function (around line 90):

```typescript
function readBodyRaw(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
```

- [ ] **Step 2: Add STT imports at top of api.ts**

```typescript
import { initStt, getSttStatus, downloadModel, transcribe as sttTranscribe } from "../stt/stt.js";
import { TMP_DIR } from "../shared/paths.js";
```

(Note: `TMP_DIR` may already be imported — check and merge if so. `JINN_HOME` is already imported.)

- [ ] **Step 3: Add STT routes to handleApiRequest**

Add these routes inside the `handleApiRequest` function, before the final `notFound(res)` call. Find the appropriate location (near the end of the function, before `notFound`):

```typescript
// ── STT (Speech-to-Text) ────────────────────────────────────────
if (method === "GET" && pathname === "/api/stt/status") {
  const config = context.getConfig();
  const status = getSttStatus(config.stt?.model);
  return json(res, status);
}

if (method === "POST" && pathname === "/api/stt/download") {
  const config = context.getConfig();
  const model = config.stt?.model || "small";

  try {
    // Start download — progress is pushed via WebSocket
    downloadModel(model, (progress) => {
      context.emit("stt:download:progress", { progress });
    }).then(() => {
      // Update config to mark STT as enabled
      try {
        const yaml = await import("js-yaml");
        const configPath = (await import("../shared/paths.js")).CONFIG_PATH;
        const raw = fs.readFileSync(configPath, "utf-8");
        const cfg = yaml.load(raw) as Record<string, any>;
        if (!cfg.stt) cfg.stt = {};
        cfg.stt.enabled = true;
        cfg.stt.model = model;
        fs.writeFileSync(configPath, yaml.dump(cfg, { lineWidth: -1 }));
      } catch (err) {
        logger.error(`Failed to update config after STT download: ${err}`);
      }
      context.emit("stt:download:complete", { model });
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`STT download failed: ${msg}`);
      context.emit("stt:download:error", { error: msg });
    });

    return json(res, { status: "downloading", model });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return serverError(res, msg);
  }
}

if (method === "POST" && pathname === "/api/stt/transcribe") {
  const config = context.getConfig();
  const model = config.stt?.model || "small";
  const language = config.stt?.language || "en";

  // Read raw audio body
  const audioBuffer = await readBodyRaw(req);
  if (audioBuffer.length === 0) return badRequest(res, "No audio data");
  if (audioBuffer.length > 10 * 1024 * 1024) return badRequest(res, "Audio too large (10MB max)");

  // Determine file extension from content-type
  const contentType = req.headers["content-type"] || "audio/webm";
  const ext = contentType.includes("wav") ? ".wav"
    : contentType.includes("mp4") || contentType.includes("m4a") ? ".m4a"
    : contentType.includes("ogg") ? ".ogg"
    : ".webm";

  // Write to temp file
  const tmpFile = path.join(TMP_DIR, `stt-${crypto.randomUUID()}${ext}`);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(tmpFile, audioBuffer);

  try {
    const text = await sttTranscribe(tmpFile, model, language);
    return json(res, { text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`STT transcription failed: ${msg}`);
    return serverError(res, `Transcription failed: ${msg}`);
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
```

**IMPORTANT:** The download route uses `await` inside the `.then()` callback for config update. Since the download handler fires async and returns immediately, the actual download route body should NOT be async for the config update part. Instead, restructure: the `downloadModel().then()` callback should use synchronous fs reads/writes (which it does — `fs.readFileSync`, `fs.writeFileSync`). The `import()` calls need to be resolved. Better approach: import `yaml` and `CONFIG_PATH` at the top of the file (they're likely already imported) and use them directly in the `.then()` callback. Here's the corrected version of the download route's `.then()`:

```typescript
downloadModel(model, (progress) => {
  context.emit("stt:download:progress", { progress });
}).then(() => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = yaml.load(raw) as Record<string, any>;
    if (!cfg.stt) cfg.stt = {};
    cfg.stt.enabled = true;
    cfg.stt.model = model;
    fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
  } catch (err) {
    logger.error(`Failed to update config after STT download: ${err}`);
  }
  context.emit("stt:download:complete", { model });
}).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error(`STT download failed: ${msg}`);
  context.emit("stt:download:error", { error: msg });
});
```

(`yaml` and `CONFIG_PATH` are already imported at the top of api.ts.)

- [ ] **Step 4: Initialize STT on gateway startup in server.ts**

In `server.ts`, add the import and init call. After the existing imports:

```typescript
import { initStt } from "../stt/stt.js";
```

Then inside the `startGateway()` function, after the `syncSkillSymlinks()` call (around line 269):

```typescript
// Initialize STT model symlinks
try {
  initStt();
} catch (err) {
  logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
}
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/jimmy/src/gateway/api.ts packages/jimmy/src/gateway/server.ts
git commit -m "feat(stt): add STT API endpoints and gateway init"
```

---

## Chunk 3: Web UI — API Client & STT Hook

### Task 5: Add STT methods to the API client

**Files:**
- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Add STT API methods**

Add to the `api` object at the end, before the closing `}`:

```typescript
sttStatus: () => get<{ available: boolean; model: string | null; downloading: boolean; progress: number }>("/api/stt/status"),
sttDownload: () => post<{ status: string; model: string }>("/api/stt/download", {}),
sttTranscribe: async (audioBlob: Blob): Promise<{ text: string }> => {
  const res = await fetch(`${BASE}/api/stt/transcribe`, {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
},
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "feat(stt): add STT API methods to web client"
```

---

### Task 6: Create the useStt hook

**Files:**
- Create: `packages/web/src/hooks/use-stt.ts`

This hook encapsulates all STT state: model availability, download progress, recording state, audio capture (MediaRecorder + AnalyserNode for waveform), and transcription.

- [ ] **Step 1: Create the hook**

```typescript
"use client"
import { useState, useRef, useCallback, useEffect } from "react"
import { api } from "@/lib/api"

export type SttState =
  | "idle"           // mic not active
  | "no-model"       // model not downloaded, need to show download modal
  | "recording"      // actively recording
  | "transcribing"   // audio sent, waiting for result

export interface UseSttReturn {
  state: SttState
  /** Whether the STT model is available on the gateway */
  available: boolean | null
  /** Download progress 0-100, null if not downloading */
  downloadProgress: number | null
  /** AnalyserNode for waveform rendering — only set during recording */
  analyser: AnalyserNode | null
  /** Check model status, then start or prompt download */
  handleMicClick: () => void
  /** Start recording (after model is confirmed available) */
  startRecording: () => Promise<void>
  /** Stop recording, transcribe, return text */
  stopRecording: () => Promise<string | null>
  /** Cancel recording without transcribing */
  cancelRecording: () => void
  /** Trigger model download */
  startDownload: () => void
  /** Dismiss the download prompt */
  dismissDownload: () => void
}

const MAX_RECORDING_MS = 60_000 // 60 seconds

export function useStt(
  onWsEvent?: (event: string, payload: unknown) => void,
): UseSttReturn {
  const [state, setState] = useState<SttState>("idle")
  const [available, setAvailable] = useState<boolean | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelRecording()
    }
  }, [])

  const checkStatus = useCallback(async () => {
    try {
      const status = await api.sttStatus()
      setAvailable(status.available)
      if (status.downloading) {
        setDownloadProgress(status.progress)
      }
      return status.available
    } catch {
      setAvailable(false)
      return false
    }
  }, [])

  const handleMicClick = useCallback(async () => {
    if (state === "recording") {
      // Will be handled by the caller via stopRecording
      return
    }

    // Check status first
    const isAvailable = await checkStatus()
    if (isAvailable) {
      await startRecordingInner()
    } else {
      setState("no-model")
    }
  }, [state, checkStatus])

  const startRecordingInner = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Set up audio analysis for waveform
      const audioCtx = new AudioContext()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyserNode = audioCtx.createAnalyser()
      analyserNode.fftSize = 128
      source.connect(analyserNode)
      setAnalyser(analyserNode)

      // Set up MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : ""
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.start(100) // 100ms timeslice
      setState("recording")

      // Auto-stop after 60 seconds
      timeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop()
        }
      }, MAX_RECORDING_MS)
    } catch {
      // Mic permission denied or error
      cleanup()
      setState("idle")
    }
  }

  const startRecording = useCallback(async () => {
    await startRecordingInner()
  }, [])

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      setState("idle")
      return null
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current!

      recorder.onstop = async () => {
        cleanup()
        setState("transcribing")

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        })
        chunksRef.current = []

        if (blob.size === 0) {
          setState("idle")
          resolve(null)
          return
        }

        try {
          const result = await api.sttTranscribe(blob)
          setState("idle")
          resolve(result.text || null)
        } catch {
          setState("idle")
          resolve(null)
        }
      }

      if (recorder.state === "recording") {
        recorder.stop()
      } else {
        cleanup()
        setState("idle")
        resolve(null)
      }
    })
  }, [])

  const cancelRecording = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop()
    }
    cleanup()
    chunksRef.current = []
    setState("idle")
  }, [])

  const cleanup = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    setAnalyser(null)
    mediaRecorderRef.current = null
  }

  const startDownload = useCallback(() => {
    setDownloadProgress(0)
    api.sttDownload().catch(() => {
      setDownloadProgress(null)
    })
  }, [])

  const dismissDownload = useCallback(() => {
    setState("idle")
    setDownloadProgress(null)
  }, [])

  // Listen for WebSocket events for download progress
  useEffect(() => {
    if (downloadProgress === null) return
    // This is handled by passing events from the parent
  }, [downloadProgress])

  // Process WS events from parent
  const processWsEvent = useCallback((event: string, payload: unknown) => {
    const p = payload as Record<string, unknown>
    if (event === "stt:download:progress") {
      setDownloadProgress(Number(p.progress) || 0)
    }
    if (event === "stt:download:complete") {
      setDownloadProgress(null)
      setAvailable(true)
      setState("idle")
    }
    if (event === "stt:download:error") {
      setDownloadProgress(null)
      setState("idle")
    }
  }, [])

  return {
    state,
    available,
    downloadProgress,
    analyser,
    handleMicClick,
    startRecording,
    stopRecording,
    cancelRecording,
    startDownload,
    dismissDownload,
    // Expose event processor so parent can pipe WS events
    _processWsEvent: processWsEvent,
  } as UseSttReturn & { _processWsEvent: (event: string, payload: unknown) => void }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/use-stt.ts
git commit -m "feat(stt): create useStt hook for recording and transcription"
```

---

## Chunk 4: Web UI — Download Modal & Waveform

### Task 7: Create the STT download modal

**Files:**
- Create: `packages/web/src/components/chat/stt-download-modal.tsx`

Uses inline styles matching the codebase pattern (not Radix Dialog — keep it consistent with the confirm-delete dialog pattern in `chat/page.tsx`).

- [ ] **Step 1: Create the download modal component**

```typescript
"use client"
import React from "react"

interface SttDownloadModalProps {
  open: boolean
  progress: number | null  // null = not downloading, 0-100 = downloading
  onDownload: () => void
  onCancel: () => void
}

export function SttDownloadModal({ open, progress, onDownload, onCancel }: SttDownloadModalProps) {
  if (!open) return null

  const isDownloading = progress !== null

  return (
    <div
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={isDownloading ? undefined : onCancel}
    >
      <div
        style={{
          background: "var(--bg)",
          borderRadius: "var(--radius-lg)",
          padding: "var(--space-6)",
          maxWidth: 400,
          width: "90%",
          boxShadow: "var(--shadow-overlay)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Icon */}
        <div style={{
          width: 48,
          height: 48,
          borderRadius: "var(--radius-md)",
          background: "var(--fill-secondary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "var(--space-4)",
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </div>

        <h3 style={{
          fontSize: "var(--text-headline)",
          fontWeight: "var(--weight-bold)",
          color: "var(--text-primary)",
          marginBottom: "var(--space-2)",
        }}>
          Enable voice input?
        </h3>

        <p style={{
          fontSize: "var(--text-body)",
          color: "var(--text-secondary)",
          marginBottom: "var(--space-5)",
          lineHeight: "var(--leading-relaxed)",
        }}>
          This will download a speech recognition model (~500MB). Transcription runs locally on your server — no data leaves your network.
        </p>

        {/* Progress bar */}
        {isDownloading && (
          <div style={{ marginBottom: "var(--space-5)" }}>
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              marginBottom: "var(--space-2)",
              fontSize: "var(--text-footnote)",
              color: "var(--text-tertiary)",
            }}>
              <span>Downloading model…</span>
              <span>{progress}%</span>
            </div>
            <div style={{
              height: 6,
              borderRadius: 3,
              background: "var(--fill-tertiary)",
              overflow: "hidden",
            }}>
              <div style={{
                height: "100%",
                width: `${progress}%`,
                borderRadius: 3,
                background: "var(--accent)",
                transition: "width 300ms ease",
              }} />
            </div>
          </div>
        )}

        {/* Buttons */}
        <div style={{
          display: "flex",
          gap: "var(--space-3)",
          justifyContent: "flex-end",
        }}>
          {!isDownloading && (
            <button
              onClick={onCancel}
              style={{
                padding: "var(--space-2) var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "var(--fill-tertiary)",
                color: "var(--text-primary)",
                border: "none",
                cursor: "pointer",
                fontSize: "var(--text-body)",
              }}
            >
              Cancel
            </button>
          )}
          <button
            onClick={onDownload}
            disabled={isDownloading}
            style={{
              padding: "var(--space-2) var(--space-4)",
              borderRadius: "var(--radius-md)",
              background: isDownloading ? "var(--fill-tertiary)" : "var(--accent)",
              color: isDownloading ? "var(--text-tertiary)" : "#000",
              border: "none",
              cursor: isDownloading ? "default" : "pointer",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            {isDownloading ? "Downloading…" : "Download"}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/chat/stt-download-modal.tsx
git commit -m "feat(stt): create download modal component"
```

---

### Task 8: Create the waveform visualizer

**Files:**
- Create: `packages/web/src/components/chat/stt-waveform.tsx`

Renders animated frequency bars using an AnalyserNode's frequency data via `requestAnimationFrame`.

- [ ] **Step 1: Create the waveform component**

```typescript
"use client"
import React, { useRef, useEffect } from "react"

interface SttWaveformProps {
  analyser: AnalyserNode
  /** Width in px */
  width?: number
  /** Height in px */
  height?: number
  /** Bar color */
  color?: string
}

export function SttWaveform({
  analyser,
  width = 64,
  height = 32,
  color = "var(--system-red)",
}: SttWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !analyser) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    // Use ~12 bars spread across the frequency range
    const barCount = 12
    const barGap = 2
    const barWidth = (width - barGap * (barCount - 1)) / barCount

    function draw() {
      rafRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      ctx!.clearRect(0, 0, width, height)

      for (let i = 0; i < barCount; i++) {
        // Sample from the lower frequency range (more interesting for voice)
        const dataIndex = Math.floor((i / barCount) * (bufferLength * 0.6))
        const value = dataArray[dataIndex] / 255
        // Min height of 3px so bars are always visible
        const barHeight = Math.max(3, value * height)
        const x = i * (barWidth + barGap)
        const y = (height - barHeight) / 2 // center vertically

        ctx!.fillStyle = color
        ctx!.beginPath()
        ctx!.roundRect(x, y, barWidth, barHeight, 1.5)
        ctx!.fill()
      }
    }

    draw()

    return () => {
      cancelAnimationFrame(rafRef.current)
    }
  }, [analyser, width, height, color])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ width, height, display: "block" }}
    />
  )
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/chat/stt-waveform.tsx
git commit -m "feat(stt): create live waveform visualizer component"
```

---

## Chunk 5: Web UI — Chat Input Integration

### Task 9: Integrate STT into chat-input.tsx

**Files:**
- Modify: `packages/web/src/components/chat/chat-input.tsx`
- Delete: `packages/web/src/types/speech-recognition.d.ts`

This is the main integration task. Replace all Web Speech API code with the `useStt` hook. The mic button now:
1. On first click (no model) → opens download modal
2. On click (model available) → starts recording with waveform
3. On click while recording → stops, transcribes, fills textarea
4. Shows transcribing state while waiting

- [ ] **Step 1: Delete the speech-recognition types file**

```bash
rm packages/web/src/types/speech-recognition.d.ts
```

(If the `types/` directory is now empty, remove it too.)

- [ ] **Step 2: Update chat-input.tsx imports**

Replace the existing imports section. Add the new STT imports:

```typescript
import { useStt } from '@/hooks/use-stt'
import { SttDownloadModal } from './stt-download-modal'
import { SttWaveform } from './stt-waveform'
```

- [ ] **Step 3: Add events prop to ChatInputProps**

The component needs WebSocket events to forward to the STT hook for download progress tracking. Add to the interface:

```typescript
interface ChatInputProps {
  disabled: boolean
  loading: boolean
  onSend: (message: string, media?: MediaAttachment[], interrupt?: boolean) => void
  onInterrupt?: () => void
  onNewSession: () => void
  onStatusRequest: () => void
  skillsVersion?: number
  /** WebSocket events from useGateway — needed for STT download progress */
  events?: Array<{ event: string; payload: unknown }>
}
```

Update the destructuring to include `events`:

```typescript
export function ChatInput({
  disabled,
  loading,
  onSend,
  onInterrupt,
  onNewSession,
  onStatusRequest,
  skillsVersion,
  events,
}: ChatInputProps) {
```

- [ ] **Step 4: Remove all Web Speech API state and logic**

Remove these:
- `const [isListening, setIsListening] = useState(false)`
- `const recognitionRef = useRef<SpeechRecognition | null>(null)`
- `const transcriptRef = useRef<string>('')`
- The entire `/* ── Speech-to-text (Web Speech API) ── */` section including `hasSpeechSupport`, `fillTranscript`, and `toggleSpeechRecognition`

- [ ] **Step 5: Add useStt hook usage**

After the existing state declarations:

```typescript
const stt = useStt() as ReturnType<typeof useStt> & { _processWsEvent: (event: string, payload: unknown) => void }
```

- [ ] **Step 6: Forward WebSocket events to the STT hook**

Add a useEffect to pipe events:

```typescript
// Forward WebSocket events to STT hook for download progress
useEffect(() => {
  if (!events || events.length === 0) return
  const latest = events[events.length - 1]
  if (latest.event.startsWith("stt:")) {
    stt._processWsEvent(latest.event, latest.payload)
  }
}, [events])
```

- [ ] **Step 7: Add textarea fill helper with proper auto-resize**

```typescript
const fillTextarea = useCallback((text: string) => {
  if (!text) return
  setValue((prev) => {
    const next = prev ? prev + ' ' + text : text
    // Schedule resize after React re-renders with the new value
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
      }
    })
    return next
  })
}, [])
```

- [ ] **Step 8: Add mic click handler**

```typescript
async function handleMicClick() {
  if (stt.state === "recording") {
    const text = await stt.stopRecording()
    fillTextarea(text ?? "")
    textareaRef.current?.focus()
  } else if (stt.state === "transcribing") {
    // Do nothing while transcribing
  } else {
    stt.handleMicClick()
  }
}
```

- [ ] **Step 9: Replace the mic button JSX**

Replace the entire `{/* Voice input button (Web Speech API) */}` block with:

```tsx
{/* Voice input / STT button */}
<button
  aria-label={
    stt.state === "recording" ? "Stop recording"
    : stt.state === "transcribing" ? "Transcribing…"
    : "Voice input"
  }
  onClick={handleMicClick}
  disabled={stt.state === "transcribing"}
  style={{
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: stt.state === "recording" ? "var(--radius-full, 999px)" : "var(--radius-sm)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: stt.state === "recording" ? "var(--system-red)" : "transparent",
    border: "none",
    cursor: stt.state === "transcribing" ? "wait" : "pointer",
    color: stt.state === "recording" ? "#fff" : "var(--text-secondary)",
    transition: "all 150ms ease",
    position: "relative",
  }}
  title={
    stt.state === "recording" ? "Stop recording"
    : stt.state === "transcribing" ? "Transcribing…"
    : "Voice input"
  }
>
  {stt.state === "transcribing" ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}>
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )}
</button>

{/* Live waveform during recording */}
{stt.state === "recording" && stt.analyser && (
  <SttWaveform analyser={stt.analyser} width={64} height={28} />
)}
```

- [ ] **Step 10: Add the download modal before the closing `</div>` of the main container**

Add right after the hint div (the `hidden sm:flex` section), before the final closing `</div>`:

```tsx
{/* STT model download modal */}
<SttDownloadModal
  open={stt.state === "no-model"}
  progress={stt.downloadProgress}
  onDownload={stt.startDownload}
  onCancel={stt.dismissDownload}
/>
```

- [ ] **Step 11: Add the spin keyframe animation**

Add to the component's return, inside the style tag or as an inline style element. The simplest approach is to add it alongside the existing JSX. Since there's no `<style>` tag in chat-input, add one right before the final `</div>`:

```tsx
<style>{`
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
`}</style>
```

- [ ] **Step 12: Pass events prop from chat page**

In `packages/web/src/app/chat/page.tsx`, find the `<ChatInput>` usage and add the `events` prop:

```tsx
<ChatInput
  disabled={false}
  loading={loading}
  onSend={handleSend}
  onNewSession={handleNewChat}
  onStatusRequest={handleStatusRequest}
  skillsVersion={skillsVersion}
  events={events}
/>
```

- [ ] **Step 13: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — fix any type errors before proceeding

- [ ] **Step 14: Run build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(stt): integrate whisper.cpp STT into chat input with download modal and waveform"
```

---

## Chunk 6: Polish & Final Verification

### Task 10: Fix textarea auto-expand for programmatic value changes

**Files:**
- Modify: `packages/web/src/components/chat/chat-input.tsx`

The `fillTextarea` function in Task 9 Step 7 uses `requestAnimationFrame` to resize after React renders. Verify this works. If the textarea doesn't expand, the alternative fix is to use a `useEffect` that watches `value` and resizes:

- [ ] **Step 1: Add value-watching resize effect (if needed)**

If the `requestAnimationFrame` approach in `fillTextarea` doesn't reliably trigger, add this effect as a fallback:

```typescript
// Auto-resize textarea when value changes programmatically (e.g., from STT)
useEffect(() => {
  if (textareaRef.current) {
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
  }
}, [value])
```

This fires on every keystroke too but is cheap (just reading scrollHeight and setting a style). More reliable than `requestAnimationFrame` inside `setValue`.

- [ ] **Step 2: Run full build**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 3: Final commit**

```bash
git add packages/web/src/components/chat/chat-input.tsx
git commit -m "fix(stt): ensure textarea auto-expands on programmatic value changes"
```

---

### Task 11: Squash into a single feature commit

- [ ] **Step 1: Interactive rebase to squash all STT commits**

Check `git log --oneline` to count the STT commits, then squash them into one clean commit:

```bash
git rebase -i HEAD~N  # where N is the number of STT commits
```

Squash all into the first, with final message:

```
feat: add offline speech-to-text with whisper.cpp

- Gateway STT module wraps nodejs-whisper for local transcription
- Three API endpoints: GET /api/stt/status, POST /api/stt/download, POST /api/stt/transcribe
- First-time UX: mic click triggers download modal (~500MB model)
- Download progress streamed via WebSocket events
- Recording with live waveform animation (Web Audio AnalyserNode)
- Audio recorded as WebM/opus, transcribed server-side by whisper.cpp
- Replaces browser Web Speech API with fully offline solution
- Config: stt.enabled, stt.model, stt.language in config.yaml
```

**IMPORTANT:** The task says "Do NOT push." So just commit locally.
