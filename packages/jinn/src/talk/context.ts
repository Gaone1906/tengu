/**
 * Jinn Talk — dependency-injection contracts (Phase 2).
 *
 * The /talk agent turn (agent.ts + tools.ts) is decoupled from the org bridge
 * (delegate/get_org_pulse) and the Kokoro TTS engine via these interfaces, so
 * each can be built independently and wired in routes.ts.
 */
import type { Emit } from "./protocol.js"

/** Compact, read-only snapshot of live org activity for get_org_pulse(). */
export interface OrgPulse {
  activeCount: number
  employees: Array<{ name: string; running: number; status?: string }>
  runningJobs: Array<{ id: string; title: string; owner: string }>
  awaitingApproval: Array<{ id: string; title: string; owner?: string }>
  /** One-line natural-language summary the agent can read aloud. */
  summary: string
}

export interface DelegateResult {
  ok: boolean
  /** Concise result text (sync delegations) for the agent to summarize aloud. */
  result?: string
  /** Tracker task id (async delegations). */
  taskId?: string
  error?: string
}

export interface DelegateOpts {
  /** "coo" (default → Jimbo, no employee persona) or an employee name. */
  target?: string
  /** async:true → return immediately + drive a talk:task that updates; default sync. */
  async?: boolean
}

/** Real org bridge: routes work through the existing sessions machinery. */
export interface OrgBridge {
  delegate(
    task: string,
    opts: DelegateOpts,
    deps: { sessionId: string; emit: Emit },
  ): Promise<DelegateResult>
  getOrgPulse(): Promise<OrgPulse>
}

/** Kokoro-82M TTS engine (sidecar-backed). */
export interface Tts {
  /** Synthesize `text`, sentence-chunked, streaming talk:audio events; resolves when fully spoken. */
  speak(sessionId: string, text: string, emit: Emit): Promise<void>
  status(): { available: boolean; downloading: boolean; progress: number; voice: string; ready: boolean }
  /** Pre-spawn the sidecar and load the model (one throwaway synth) so the first real speak is fast. No-op if weights/venv are missing. */
  warm?(): Promise<void>
  /** Download Kokoro weights on first use, emitting talk:tts:download:* events. */
  download(emit: Emit): Promise<void>
  shutdown(): void
}

/** Everything a /talk turn needs, injected by routes.ts. */
export interface TalkDeps {
  sessionId: string
  emit: Emit
  org: OrgBridge
  tts: Tts
}
