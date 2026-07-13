# Chat Microphone Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This task is constrained to inline Codex execution; do not delegate it.

**Goal:** Acknowledge a microphone press immediately with an honest starting state, then show recording only after browser capture is live, without gesture races or duplicate capture requests.

**Architecture:** Extend the existing `useStt` state machine with a synchronous `starting` phase and a single in-flight start-attempt guard. Cancellation invalidates an attempt and cleans up any stream that resolves late. `ChatInput` renders starting as a quiet accent-tinted busy control, keeps recording red/waveform-only, and treats pointer cancellation separately from a completed tap or hold.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright, Vite/Tailwind CSS 4.

## Global Constraints

- Use Codex GPT-5.6-sol xhigh only; do not delegate.
- Use a fresh sanitized `JINN_HOME` and non-7777 ports; never browse, mutate, restart, or test production `:7777`.
- Write failing tests first and implement the smallest coherent fix.
- Verify quick tap, press-hold, stop, permission delay/denial, first-use model modal, rapid repeat, 390px mobile, desktop, dark/light themes, and reduced motion.
- Do not deploy or restart production.
- Keep every repo change generic; no personal names, project names, credentials, Slack IDs, emails, or `/Users/...` paths.

---

### Task 1: Prove the missing intermediate state and cancellation races

**Files:**
- Modify: `packages/web/src/hooks/__tests__/use-stt.test.ts`
- Create: `packages/web/src/components/chat/__tests__/chat-input-mic-state.test.tsx`

**Interfaces:**
- Consumes: existing `useStt().handleMicClick()`, `stopRecording()`, and `cancelRecording()` APIs.
- Produces: executable behavior contracts for `SttState = "starting"`, single-flight capture, late-stream cleanup, denial errors, and starting-state rendering.

- [ ] **Step 1: Add deferred status and media helpers to the hook test**

```ts
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createFakeStream() {
  const track = { stop: vi.fn() }
  return {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    track,
  }
}

function installMediaMocks(options?: { getUserMedia?: () => Promise<MediaStream> }) {
  const { stream, track } = createFakeStream()
  const getUserMedia = vi.fn(options?.getUserMedia ?? (() => Promise.resolve(stream)))
  const audioSession = { type: "auto" }
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  })
  Object.defineProperty(navigator, "audioSession", {
    value: audioSession,
    configurable: true,
  })
  Object.defineProperty(window, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
  })
  Object.defineProperty(window, "MediaRecorder", {
    value: FakeMediaRecorder,
    configurable: true,
  })
  Object.defineProperty(globalThis, "MediaRecorder", {
    value: FakeMediaRecorder,
    configurable: true,
  })
  return { track, stream, getUserMedia, audioSession }
}
```

- [ ] **Step 2: Add tests that specify the new state machine**

```ts
it("acknowledges a mic request before status and permission resolve", async () => {
  const status = deferred<{ available: boolean; downloading: boolean; languages: string[] }>()
  sttStatus.mockReturnValue(status.promise)
  installMediaMocks()
  const { result } = renderHook(() => useStt())
  let start!: Promise<void>
  act(() => { start = result.current.handleMicClick() })
  expect(result.current.state).toBe("starting")
  status.resolve({ available: false, downloading: false, languages: ["en"] })
  await act(async () => { await start })
  expect(result.current.state).toBe("no-model")
})

it("stays starting until capture is live", async () => {
  const permission = deferred<MediaStream>()
  const { getUserMedia } = installMediaMocks({ getUserMedia: () => permission.promise })
  const { result } = renderHook(() => useStt())
  let start!: Promise<void>
  act(() => { start = result.current.handleMicClick() })
  await act(async () => { await flushMicrotasks() })
  expect(result.current.state).toBe("starting")
  permission.resolve(createFakeStream().stream)
  await act(async () => { await start })
  expect(getUserMedia).toHaveBeenCalledTimes(1)
  expect(result.current.state).toBe("recording")
})

it("ignores rapid repeated starts while one attempt is pending", () => {
  const status = deferred<{ available: boolean; downloading: boolean; languages: string[] }>()
  sttStatus.mockReturnValue(status.promise)
  const { result } = renderHook(() => useStt())
  act(() => { void result.current.handleMicClick(); void result.current.handleMicClick() })
  expect(sttStatus).toHaveBeenCalledTimes(1)
})

it("stops a stream that resolves after the pending start was cancelled", async () => {
  const permission = deferred<MediaStream>()
  const { stream, track } = createFakeStream()
  installMediaMocks({ getUserMedia: () => permission.promise })
  const { result } = renderHook(() => useStt())
  let start!: Promise<void>
  act(() => { start = result.current.handleMicClick() })
  await act(async () => { await flushMicrotasks() })
  await act(async () => { expect(await result.current.stopRecording()).toBeNull() })
  permission.resolve(stream)
  await act(async () => { await start })
  expect(track.stop).toHaveBeenCalledTimes(1)
  expect(result.current.state).toBe("idle")
})

it("reports microphone permission denial", async () => {
  installMediaMocks({ getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")) })
  const { result } = renderHook(() => useStt())
  await act(async () => { await result.current.handleMicClick() })
  expect(result.current.state).toBe("error")
  expect(result.current.error).toMatch(/microphone access was denied/i)
})
```

- [ ] **Step 3: Add a real `ChatInput` render contract for the honest starting state**

```tsx
expect(screen.getByRole("button", { name: "Starting voice input…" })).toHaveAttribute("aria-busy", "true")
expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull()
```

- [ ] **Step 4: Run the focused tests and confirm RED**

Run: `pnpm --filter @jinn/web test -- src/hooks/__tests__/use-stt.test.ts src/components/chat/__tests__/chat-input-mic-state.test.tsx`

Expected: failures because `starting` does not exist, repeated calls are not locked, late permission can still start recording, denial falls back silently to idle, and `ChatInput` still renders idle.

### Task 2: Add a cancellable single-flight STT start attempt

**Files:**
- Modify: `packages/web/src/hooks/use-stt.ts`
- Test: `packages/web/src/hooks/__tests__/use-stt.test.ts`

**Interfaces:**
- Consumes: `api.sttStatus()`, `navigator.mediaDevices.getUserMedia()`, `MediaRecorder`, and existing cleanup/transcription behavior.
- Produces: `SttState` including `"starting"`; `handleMicClick(): Promise<void>`; safe cancellation across status/permission/setup boundaries.

- [ ] **Step 1: Add the state and in-flight attempt record**

```ts
export type SttState = "idle" | "starting" | "no-model" | "recording" | "transcribing" | "error"
interface StartAttempt { id: number; cancelled: boolean }
const startAttemptRef = useRef<StartAttempt | null>(null)
const nextStartAttemptIdRef = useRef(0)
```

- [ ] **Step 2: Enter starting synchronously and guard repeated entry**

```ts
const handleMicClick = useCallback(async () => {
  if (startAttemptRef.current || state === "recording" || state === "transcribing") return
  const attempt = { id: ++nextStartAttemptIdRef.current, cancelled: false }
  startAttemptRef.current = attempt
  setError(null)
  setState("starting")
  // Resolve model readiness, then begin capture only while this attempt remains current.
}, [state, checkStatus, startRecordingInner])
```

- [ ] **Step 3: Reject stale work at every asynchronous boundary**

```ts
const isCurrentStartAttempt = (attempt: StartAttempt) =>
  startAttemptRef.current === attempt && !attempt.cancelled && mountedRef.current

const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
if (!isCurrentStartAttempt(attempt)) {
  stream.getTracks().forEach((track) => track.stop())
  releaseCaptureAudioSession()
  return
}
```

- [ ] **Step 4: Make pending stop/cancel invalidate the attempt**

```ts
function cancelStartAttempt() {
  const attempt = startAttemptRef.current
  if (!attempt) return false
  attempt.cancelled = true
  startAttemptRef.current = null
  return true
}
```

`stopRecording()` and `cancelRecording()` call this before their recorder checks; a pending attempt resolves to idle and a stream arriving later is stopped without creating a recorder.

- [ ] **Step 5: Surface permission and capture errors**

```ts
function microphoneStartError(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Microphone access was denied. Allow access in your browser settings and try again."
  }
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone was found."
  return "Could not start voice input."
}
```

- [ ] **Step 6: Run hook tests and confirm GREEN**

Run: `pnpm --filter @jinn/web test -- src/hooks/__tests__/use-stt.test.ts`

Expected: all hook tests pass with no unhandled promises or React act warnings.

### Task 3: Render and gesture the honest starting state

**Files:**
- Modify: `packages/web/src/components/chat/chat-input.tsx`
- Test: `packages/web/src/components/chat/__tests__/chat-input-mic-state.test.tsx`
- Test: `packages/web/src/components/chat/__tests__/mic-gesture.test.ts`

**Interfaces:**
- Consumes: `stt.state === "starting"` and existing hook controls.
- Produces: immediate `Starting voice input…` feedback; explicit cancellation; no red/waveform until `recording`.

- [ ] **Step 1: Render starting as busy, accent-tinted, and cancellable**

```tsx
const sttStarting = stt.state === "starting"
<button
  aria-label={
    stt.state === "recording" ? "Stop recording"
    : stt.state === "transcribing" ? "Transcribing…"
    : sttStarting ? "Starting voice input…"
    : "Voice input"
  }
  aria-busy={sttStarting || stt.state === "transcribing"}
  data-state={stt.state}
  className="... transition-[scale,background-color,color] ... active:scale-[0.96]"
>
  {sttStarting ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-[stt-spin_1s_linear_infinite]">
      <path d="M12 2a10 10 0 0 1 10 10" />
    </svg>
  ) : stt.state === "recording" && stt.analyser ? (
    <MicWaveform analyser={stt.analyser} />
  ) : stt.state === "transcribing" ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-[stt-spin_1s_linear_infinite]">
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
```

Starting uses `var(--accent-fill)` + `var(--accent)`. Recording alone uses `var(--system-red)` and `MicWaveform`. The global reduced-motion rule collapses spinner/transition duration to `0.01ms`.

- [ ] **Step 2: Cancel a second press during starting and clear stale toggle intent**

```ts
if (stt.state === "starting") {
  micToggleActiveRef.current = false
  stt.cancelRecording()
  return
}

useEffect(() => {
  if (stt.state === "idle" || stt.state === "no-model" || stt.state === "error") {
    micToggleActiveRef.current = false
  }
}, [stt.state])
```

- [ ] **Step 3: Treat pointer cancellation as cancellation, not a tap**

```ts
function handleMicPointerCancel() {
  clearMicPress()
  micToggleActiveRef.current = false
  stt.cancelRecording()
}
```

- [ ] **Step 4: Run chat mic tests and confirm GREEN**

Run: `pnpm --filter @jinn/web test -- src/components/chat/__tests__/chat-input-mic-state.test.tsx src/components/chat/__tests__/mic-gesture.test.ts`

Expected: starting renders immediately and honestly; quick-tap/hold classification remains unchanged.

### Task 4: Sandbox interaction matrix and repository gates

**Files:**
- Create outside repo: `~/.jinn-mic-feedback/sandbox-artifacts/<timestamp>/verify-mic-feedback.mjs`
- Create outside repo: sandbox screenshots, traces, and a verification report.

**Interfaces:**
- Consumes: production-like sandbox gateway `:7783` and a separate Vite port.
- Produces: before/after traces and dark/light desktop/mobile screenshots.

- [ ] **Step 1: Run focused and complete web tests**

```bash
pnpm --filter @jinn/web test -- src/hooks/__tests__/use-stt.test.ts src/components/chat/__tests__/chat-input-mic-state.test.tsx src/components/chat/__tests__/mic-gesture.test.ts
pnpm --filter @jinn/web test
```

- [ ] **Step 2: Run static and build gates**

```bash
pnpm --filter @jinn/web typecheck
pnpm typecheck
pnpm build
```

- [ ] **Step 3: Verify the browser matrix with condition-based waits**

Use Playwright against the sandbox only. For each scenario, wait on `data-state`, `aria-label`, the model modal heading, or the error banner instead of sleeping except for the defined 250ms gesture threshold. Cover quick tap, hold, stop, delayed permission, denial, first-use model, rapid repeat, reduced motion, 1440×900 and 390×844, dark and light.

- [ ] **Step 4: Stage only scoped files and run the privacy audit**

```bash
git add packages/web/src/hooks/use-stt.ts packages/web/src/hooks/__tests__/use-stt.test.ts packages/web/src/components/chat/chat-input.tsx packages/web/src/components/chat/__tests__/chat-input-mic-state.test.tsx packages/web/src/components/chat/__tests__/mic-gesture.test.ts docs/superpowers/plans/2026-07-12-chat-microphone-feedback.md
git diff --cached --check
git diff --cached | grep -iE '<privacy-firewall blocked terms — see packages/jinn/src/shared/__tests__/privacy-guard.test.ts>'
```

Expected: `git diff --cached --check` exits 0; leak grep has no output.

- [ ] **Step 5: Commit the scoped fix**

```bash
git commit -m "fix(web): acknowledge microphone startup immediately"
```

Expected: one scoped commit; unrelated working-tree changes remain untouched.
