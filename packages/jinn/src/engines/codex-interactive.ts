import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped } from "./pty-stream.js";
import { tailTranscriptLines, type TranscriptTailer } from "./transcript-tailer.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtySnapshotSubscription, PtyViewEngine } from "./pty-view-engine.js";
import { codexCliFlags, extractCodexContextTokens } from "./codex.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
// FALLBACK ONLY: task_complete (below) is the primary completion signal; this
// quiet-window debounce settles turns whose transcript misses the marker.
const DONE_DEBOUNCE_MS = 60_000;
const TAIL_POLL_MS = 250;
const DISCOVER_POLL_MS = 200;
const DISCOVER_TIMEOUT_MS = 30 * 1000;

interface TranscriptFileStat {
  mtimeMs: number;
}

interface ActiveTurn {
  interrupt: (reason: string) => void;
  tailer?: TranscriptTailer;
  discover?: { stop: () => void };
  doneTimer?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  boundProc?: pty.IPty;
}

interface CodexSpawnParams {
  model?: string;
  effortLevel?: string;
  resumeSessionId?: string;
  cwd?: string;
  bin?: string;
  cliFlags?: string[];
}

function pasteAndSubmit(proc: pty.IPty, text: string): void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~\r`);
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(p, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function listTranscriptFiles(root = CODEX_SESSIONS_DIR): Map<string, TranscriptFileStat> {
  const files = new Map<string, TranscriptFileStat>();
  for (const file of walkJsonl(root)) {
    try {
      const stat = fs.statSync(file);
      files.set(file, { mtimeMs: stat.mtimeMs });
    } catch { /* gone */ }
  }
  return files;
}

function parseSessionIdFromFile(filePath: string): string | undefined {
  try {
    const first = fs.readFileSync(filePath, "utf-8").split("\n", 1)[0];
    const msg = JSON.parse(first);
    const id = msg?.payload?.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export function codexTranscriptLineToDeltas(line: string): {
  deltas: StreamDelta[];
  doneText?: string;
  sessionId?: string;
  contextTokens?: number;
  /** event_msg task_started — gates the terminal markers below to THIS turn. */
  taskStarted?: { turnId?: string };
  /** event_msg task_complete — the turn's deterministic end marker. */
  taskComplete?: { lastAgentMessage?: string; turnId?: string };
  /** event_msg turn_aborted — the turn was interrupted CLI-side. */
  turnAborted?: { turnId?: string };
} {
  const trimmed = line.trim();
  if (!trimmed) return { deltas: [] };
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return { deltas: [] }; }

  if (msg.type === "session_meta") {
    const id = msg?.payload?.id;
    return { deltas: [], sessionId: typeof id === "string" ? id : undefined };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "token_count") {
    // Context-meter fill = the LAST turn's input tokens (≈ the whole conversation
    // fed back to the model). NEVER fall back to total_token_usage: that's the
    // cumulative tokens billed across every turn, so on a long session it climbs
    // far past the window and renders impossible meter values like 9282k/272k.
    // When last_token_usage is absent we simply omit the update rather than show
    // a cumulative figure.
    const ctx = extractCodexContextTokens(msg.payload.info?.last_token_usage);
    return ctx ? { deltas: [{ type: "context", content: String(ctx) }], contextTokens: ctx } : { deltas: [] };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "task_started") {
    return { deltas: [], taskStarted: { turnId: typeof msg.payload.turn_id === "string" ? msg.payload.turn_id : undefined } };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "task_complete") {
    const lam = msg.payload.last_agent_message;
    return {
      deltas: [],
      taskComplete: {
        lastAgentMessage: typeof lam === "string" ? lam : undefined,
        turnId: typeof msg.payload.turn_id === "string" ? msg.payload.turn_id : undefined,
      },
    };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "turn_aborted") {
    return { deltas: [], turnAborted: { turnId: typeof msg.payload.turn_id === "string" ? msg.payload.turn_id : undefined } };
  }

  if (msg.type !== "response_item") return { deltas: [] };
  const payload = msg.payload;
  if (!payload || typeof payload !== "object") return { deltas: [] };

  if (payload.type === "function_call") {
    const name = String(payload.name || "tool");
    return {
      deltas: [{
        type: "tool_use",
        content: `Using ${name}`,
        toolName: name,
        toolId: String(payload.call_id || ""),
      }],
    };
  }

  if (payload.type === "function_call_output") {
    const activityReceiptId = extractActivityReceiptId(payload.output, {
      isError: payload.is_error === true || payload.error !== undefined,
    });
    return {
      deltas: [{
        type: "tool_result",
        content: "Done",
        toolId: String(payload.call_id || ""),
        ...(activityReceiptId ? { activityReceiptId } : {}),
      }],
    };
  }

  if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
    const text = payload.content
      .filter((b: any) => b?.type === "output_text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    if (text.trim()) return { deltas: [{ type: "text", content: text }], doneText: text };
  }

  return { deltas: [] };
}

export class CodexInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "codex" as const;
  private active = new Map<string, ActiveTurn>();
  private streams: PtyStreamManager;
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private spawnParams = new Map<string, CodexSpawnParams>();

  constructor(private lifecycle: PtyLifecycleManager) {
    this.streams = new PtyStreamManager("Codex PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    // spawnParams describes the LIVE PTY's spawn args — purge it on every release
    // (kill, eviction, sweep reap, cold respawn) so the map doesn't grow forever.
    this.lifecycle.onRelease((id) => this.spawnParams.delete(id));
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("CodexInteractiveEngine.run requires opts.sessionId");
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Codex interactive engine: a turn is already running for this session" };
    }

    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    if (opts.attachments?.length) prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");

    let codexSessionId = opts.resumeSessionId;
    let latestAnswer = "";
    let lastContextTokens: number | undefined;
    let sawTaskStarted = false;
    let startedTurnId: string | undefined;
    let settled = false;
    let resolveFn!: (r: EngineResult) => void;
    const promise = new Promise<EngineResult>((res) => { resolveFn = res; });
    const turn: ActiveTurn = { interrupt: () => {} };

    const cleanup = () => {
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      if (turn.hardTimeout) clearTimeout(turn.hardTimeout);
      turn.tailer?.stop();
      turn.discover?.stop();
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId);
    };
    const finish = (r: EngineResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn(r);
    };
    turn.interrupt = (reason: string) =>
      finish({ sessionId: codexSessionId ?? opts.resumeSessionId ?? "", result: "", error: reason });

    const onParsed = (parsed: ReturnType<typeof codexTranscriptLineToDeltas>) => {
      if (settled) return;
      if (parsed.sessionId && !codexSessionId) {
        codexSessionId = parsed.sessionId;
        this.updateSpawnResumeSessionId(jinnSessionId, codexSessionId);
      }
      if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
      if (parsed.taskStarted) {
        sawTaskStarted = true;
        startedTurnId = parsed.taskStarted.turnId ?? startedTurnId;
      }
      for (const d of parsed.deltas) {
        if (d.type === "tool_use" || d.type === "tool_result" || d.type === "status") {
          if (turn.doneTimer) {
            clearTimeout(turn.doneTimer);
            turn.doneTimer = undefined;
          }
        }
        opts.onStream?.(d);
      }
      if (parsed.taskComplete || parsed.turnAborted) {
        // A terminal marker is only trustworthy if THIS tailer saw the matching
        // task_started: a late-flushed marker from the PREVIOUS turn (or one
        // replayed from a pre-existing transcript) arrives without its start —
        // honoring it would instantly false-complete this turn with a stale
        // answer. Unmatched markers fall through to the debounce fallback.
        const turnId = parsed.taskComplete?.turnId ?? parsed.turnAborted?.turnId;
        const matches = sawTaskStarted && (!turnId || !startedTurnId || turnId === startedTurnId);
        if (!matches) {
          logger.warn(`CodexInteractiveEngine: ignoring unmatched terminal marker for ${jinnSessionId} (sawTaskStarted=${sawTaskStarted})`);
        } else if (parsed.taskComplete) {
          // Deterministic end-of-turn marker — settle now (no quiet window).
          const text = parsed.taskComplete.lastAgentMessage?.trim()
            ? parsed.taskComplete.lastAgentMessage
            : latestAnswer;
          if (!text.trim()) logger.warn(`CodexInteractiveEngine: task_complete with no text for ${jinnSessionId}`);
          finish({ sessionId: codexSessionId ?? "", result: text, numTurns: 1, contextTokens: lastContextTokens });
          return;
        } else {
          finish({ sessionId: codexSessionId ?? opts.resumeSessionId ?? "", result: latestAnswer, error: "Interrupted: codex turn aborted" });
          return;
        }
      }
      if (parsed.doneText) {
        latestAnswer = parsed.doneText;
        if (turn.doneTimer) clearTimeout(turn.doneTimer);
        turn.doneTimer = setTimeout(
          () => finish({ sessionId: codexSessionId ?? "", result: latestAnswer, numTurns: 1, contextTokens: lastContextTokens }),
          DONE_DEBOUNCE_MS,
        );
        turn.doneTimer.unref?.();
      }
    };

    const attachTail = (filePath: string, fromBeginning = false) => {
      if (turn.tailer) return;
      const fileSessionId = parseSessionIdFromFile(filePath);
      if (fileSessionId && !codexSessionId) {
        codexSessionId = fileSessionId;
        this.updateSpawnResumeSessionId(jinnSessionId, codexSessionId);
      }
      let offset = 0;
      if (!fromBeginning) {
        try { offset = fs.statSync(filePath).size; } catch { /* not created yet */ }
      }
      turn.tailer = tailTranscriptLines(
        filePath,
        offset,
        (line) => onParsed(codexTranscriptLineToDeltas(line)),
        { pollMs: TAIL_POLL_MS, label: "Codex" },
      );
    };

    this.active.set(jinnSessionId, turn);
    turn.hardTimeout = setTimeout(() => {
      finish({
        sessionId: codexSessionId ?? opts.resumeSessionId ?? "",
        result: latestAnswer,
        error: "Codex interactive turn timed out",
        contextTokens: lastContextTokens,
      });
      this.lifecycle.releaseSession(jinnSessionId);
    }, TURN_TIMEOUT_MS);
    turn.hardTimeout.unref?.();

    let warm = this.lifecycle.getWarm(jinnSessionId);
    if (warm && this.spawnParamsChanged(jinnSessionId, opts)) {
      this.lifecycle.releaseSession(jinnSessionId); // onRelease purges spawnParams
      warm = undefined;
    }
    if (codexSessionId) {
      const file = this.findTranscriptById(codexSessionId);
      if (file) attachTail(file);
    } else {
      const before = listTranscriptFiles();
      const startedAt = Date.now();
      const discover = setInterval(() => {
        const after = listTranscriptFiles();
        const fresh = [...after.entries()]
          // Only brand-new files: codex creates a fresh rollout per session. An
          // mtime-bumped PRE-EXISTING file is another process's transcript —
          // replaying its history from the beginning would hijack this turn.
          .filter(([file]) => !before.has(file))
          .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
        if (fresh.length === 1) {
          clearInterval(discover);
          attachTail(fresh[0][0], true);
        } else if (fresh.length > 1) {
          logger.warn(`CodexInteractiveEngine: ambiguous fresh transcripts for ${jinnSessionId}; waiting for a unique candidate`);
          if (Date.now() - startedAt > DISCOVER_TIMEOUT_MS) {
            clearInterval(discover);
            finish({ sessionId: "", result: "", error: "Codex interactive: multiple fresh transcripts appeared; refusing ambiguous attach" });
            this.lifecycle.releaseSession(jinnSessionId);
          }
        } else if (Date.now() - startedAt > DISCOVER_TIMEOUT_MS) {
          clearInterval(discover);
          finish({ sessionId: "", result: "", error: "Codex interactive: no session transcript appeared" });
          this.lifecycle.releaseSession(jinnSessionId);
        }
      }, DISCOVER_POLL_MS);
      discover.unref?.();
      turn.discover = { stop: () => clearInterval(discover) };
    }

    if (warm) {
      turn.boundProc = (warm as any)._proc as pty.IPty | undefined;
      this.lifecycle.turnStarted(jinnSessionId);
      if (turn.boundProc) pasteAndSubmit(turn.boundProc, prompt);
      else turn.interrupt("Interrupted: codex PTY unavailable");
    } else {
      const handle = this.spawn(jinnSessionId, opts, prompt, codexSessionId);
      turn.boundProc = (handle as any)._proc as pty.IPty | undefined;
      this.lifecycle.adopt(jinnSessionId, handle, { turnRunning: true });
      this.lifecycle.turnStarted(jinnSessionId);
    }

    return promise;
  }

  private findTranscriptById(sessionId: string): string | undefined {
    for (const file of walkJsonl(CODEX_SESSIONS_DIR)) {
      if (parseSessionIdFromFile(file) === sessionId) return file;
    }
    return undefined;
  }

  private buildEnv(sessionId?: string): Record<string, string> {
    const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true });
    env.TERM = "xterm-256color";
    if (sessionId) env.JINN_SESSION_ID = sessionId;
    return env;
  }

  private buildArgs(opts: EngineRunOpts, prompt?: string, resumeSessionId?: string): string[] {
    const args: string[] = [];
    if (resumeSessionId) args.push("resume");
    args.push("--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox");
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    if (opts.cwd) args.push("-C", opts.cwd);
    args.push(...codexCliFlags(opts.cliFlags));
    if (resumeSessionId) args.push(resumeSessionId);
    if (prompt) args.push(prompt);
    return args;
  }

  private spawnParamsChanged(jinnSessionId: string, opts: EngineRunOpts): boolean {
    const prev = this.spawnParams.get(jinnSessionId);
    if (!prev) return false;
    const norm = (v: string | undefined) => v && v !== "default" ? v : undefined;
    const flags = (v: string[] | undefined) => codexCliFlags(v).filter(Boolean);
    const sameFlags = (a: string[] | undefined, b: string[] | undefined) => {
      const aa = flags(a);
      const bb = flags(b);
      return aa.length === bb.length && aa.every((flag, i) => flag === bb[i]);
    };
    return norm(prev.model) !== norm(opts.model)
      || norm(prev.effortLevel) !== norm(opts.effortLevel)
      || norm(prev.resumeSessionId) !== norm(opts.resumeSessionId)
      || norm(prev.cwd) !== norm(opts.cwd)
      || norm(prev.bin) !== norm(opts.bin)
      || !sameFlags(prev.cliFlags, opts.cliFlags);
  }

  private updateSpawnResumeSessionId(jinnSessionId: string, resumeSessionId: string): void {
    const prev = this.spawnParams.get(jinnSessionId);
    if (prev && !prev.resumeSessionId) this.spawnParams.set(jinnSessionId, { ...prev, resumeSessionId });
  }

  private spawn(jinnSessionId: string, opts: EngineRunOpts, prompt: string | undefined, resumeSessionId: string | undefined): PtyHandle {
    const bin = resolveBin("codex", opts.bin);
    const args = this.buildArgs(opts, prompt, resumeSessionId);
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`CodexInteractiveEngine spawning ${bin} (resume: ${resumeSessionId || "none"}, geom: ${geom ? `${geom.cols}x${geom.rows}` : "default"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || JINN_HOME,
      env: this.buildEnv(jinnSessionId),
    });
    this.spawnParams.set(jinnSessionId, {
      model: opts.model,
      effortLevel: opts.effortLevel,
      resumeSessionId,
      cwd: opts.cwd,
      bin: opts.bin,
      cliFlags: opts.cliFlags,
    });
    return this.wireProcToStream(jinnSessionId, proc);
  }

  private wireProcToStream(jinnSessionId: string, proc: pty.IPty): PtyHandle {
    const handle = createPtyHandle(proc);
    this.streams.attach(jinnSessionId, proc);
    proc.onExit((event) => {
      // Identity-gated: only clean up if this PTY is still the session's current
      // warm handle (a stale PTY from a kill->respawn race must not poison the new one).
      const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(jinnSessionId, event ?? { exitCode: 0, signal: 0 });
        this.lifecycle.releaseSession(jinnSessionId); // onRelease purges spawnParams
      }
      const e = this.active.get(jinnSessionId);
      if (e && e.boundProc === proc) e.interrupt("Interrupted: codex process exited");
    });
    return handle;
  }

  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.active.has(jinnSessionId)) return;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, jinnSessionId, { cols: opts.cols, rows: opts.rows });
    const warm = this.lifecycle.getWarm(jinnSessionId);
    const nextOpts: EngineRunOpts = {
      prompt: "",
      sessionId: jinnSessionId,
      resumeSessionId: opts.engineSessionId,
      cwd: opts.cwd || JINN_HOME,
      model: opts.model,
      effortLevel: opts.effortLevel,
      bin: opts.bin,
    };
    if (warm && !this.spawnParamsChanged(jinnSessionId, nextOpts)) return;
    if (warm) this.lifecycle.releaseSession(jinnSessionId);
    const handle = this.spawn(jinnSessionId, {
      ...nextOpts,
    }, undefined, opts.engineSessionId);
    this.lifecycle.adopt(jinnSessionId, handle);
  }

  subscribeWithSnapshot(sessionId: string, cb: (data: Buffer) => void, onControl?: (event: PtyControlEvent) => void): PtySnapshotSubscription {
    return this.streams.subscribeWithSnapshot(sessionId, cb, onControl);
  }

  restartPty(sessionId: string, opts: PtyIdleSpawnOpts): void {
    this.kill(sessionId, "Interrupted: terminal restart requested");
    this.ensureIdleSpawn(sessionId, opts);
  }

  writeStdin(sessionId: string, text: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    this.streams.resize(sessionId, cols, rows);
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    try { proc?.resize(cols, rows); } catch { /* gone */ }
  }

  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    this.active.get(sessionId)?.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload). Sessions with an in-flight turn
   *  (`this.active`) are skipped so the active turn is never interrupted. */
  killIdle(): void {
    this.lifecycle.releaseIdle((id) => this.active.has(id));
  }

  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
