import type { Session } from "../shared/types.js";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER } from "../mcp/identity.js";

/**
 * GRS-017a — substrate guards for agent-initiated (lateral) session messaging.
 *
 * The design ruling (GRS-017 §2.4): runaway-loop protection between sessions is
 * enforced HERE, gateway-side, not by prompt doctrine — so it holds for MCP and
 * curl alike. Three guards, all deterministic, all in-memory.
 *
 * PERSISTENCE DECISION (GRS-017c, argued): guard state deliberately does NOT
 * survive a gateway restart. A storm is driven by live engine turns, and a
 * restart kills exactly those actors — the restart extinguishes the storm the
 * state was bounding. The worst case after a restart is one fresh budget
 * (4 hops / 10 sends per sender), and a crash-loop that repeatedly resets the
 * guards is a gateway-health incident, not a comm-storm — each restart cycle
 * costs seconds, which throttles harder than the window does. Durable guard
 * state would need a store + cleanup + migration: a new primitive the marginal
 * bound does not earn (catalog rule: primitive first, wrapper later).
 *
 * CONCURRENCY INVARIANT: every guard mutation (checkSendAllowed's
 * read-filter-push, recordDelivery, pruning) is SYNCHRONOUS — no await between
 * read and write — so Node's event loop serializes it; two racing HTTP requests
 * cannot both observe 9-of-10 and both pass. Do not introduce an await inside
 * these methods. Pinned by the concurrent-sends storm test.
 *
 * MEMORY BOUND: real caller ids are validated against live sessions route-side
 * (spoofed ids are refused before any guard call), so the maps are bounded by
 * the session count; lazy pruning (every {@link PRUNE_EVERY_OPS} guard ops)
 * additionally sweeps expired windows/hop tags so idle senders don't linger.
 *
 * The guards:
 *
 *   1. no-self-message (checked in prepareLateralSend, before any state changes);
 *   2. a sliding-window rate cap per SENDER across all targets;
 *   3. a relay hop budget: each delivered lateral message tags its target with an
 *      inbound hop count; the target's next lateral send is hop n+1; beyond
 *      LATERAL_MAX_HOPS the route refuses ("escalate instead of forwarding").
 *      Hop state expires (TTL) and is cleared when a genuine user/operator
 *      message reaches the session — an operator instruction resets the chain.
 *
 * Identity is the best-effort `x-jinn-caller-session` header (see mcp/identity.ts)
 * — these are anti-storm guards, NOT security boundaries (GRS-015 lesson: never
 * dress an environment value up as an authority gate).
 */

/** Max agent-initiated sends per sender per rolling window. */
export const LATERAL_MAX_SENDS = 10;
/** The rolling window for the rate cap. */
export const LATERAL_WINDOW_MS = 10 * 60_000;
/**
 * Default max relay hops a lateral chain may traverse. Raised from 4 → 12: a
 * legitimate COO ↔ implementer ↔ QA loop is a 3-actor cycle whose round-trips
 * add up fast, and a cap of 4 refused real multi-round reviews. Override per
 * install via `sessions.lateralMaxHops` in config.yaml — the guards singleton is
 * reconfigured at boot and on hot-reload. This is still a bound, not a disable:
 * config is clamped to [LATERAL_MIN_HOPS, LATERAL_HOPS_HARD_CAP].
 */
export const LATERAL_MAX_HOPS = 12;
/** Lower bound for a configured hop cap (must allow at least one hop). */
export const LATERAL_MIN_HOPS = 1;
/** Hard ceiling for a configured hop cap — config can raise the bound but never
 *  remove the runaway-loop protection entirely. */
export const LATERAL_HOPS_HARD_CAP = 64;

/** Clamp a requested hop cap into the allowed range (anti-loop: never unbounded). */
export function clampLateralMaxHops(value: number): number {
  if (!Number.isFinite(value)) return LATERAL_MAX_HOPS;
  return Math.max(LATERAL_MIN_HOPS, Math.min(LATERAL_HOPS_HARD_CAP, Math.floor(value)));
}
/** Inbound hop state older than this no longer penalizes a sender. */
export const LATERAL_HOP_TTL_MS = 30 * 60_000;
/** Lazy-prune cadence: every N guard operations, sweep expired state. */
export const PRUNE_EVERY_OPS = 256;

export type SendVerdict =
  | { ok: true; hops: number }
  | { ok: false; status: 400 | 429; error: string };

export interface SessionCommGuards {
  /** Check rate + hop budget for a sender; on success RECORDS the send (consumes
   *  window capacity) and returns the outbound hop count to stamp. Refusals
   *  consume nothing. */
  checkSendAllowed(callerId: string): SendVerdict;
  /** Record that a lateral message with the given hop count reached a target. */
  recordDelivery(targetId: string, hops: number): void;
  /** Reset a session's relay chain (a genuine user/operator message arrived). */
  clearInboundHop(sessionId: string): void;
  /** Live map sizes — ops/tests introspection (spoof-flood no-growth proof). */
  stats(): { senders: number; hopEntries: number };
  /** The current relay-hop cap for this guard instance. */
  maxHops(): number;
  /** Reconfigure the relay-hop cap (config apply at boot + hot-reload). Clamped
   *  to [LATERAL_MIN_HOPS, LATERAL_HOPS_HARD_CAP]. Does not touch storm state. */
  setMaxHops(value: number): void;
  /** Test/ops escape hatch: drop all in-memory storm state (NOT the hop cap). */
  reset(): void;
}

export function createSessionCommGuards(
  now: () => number = Date.now,
  initialMaxHops: number = LATERAL_MAX_HOPS,
): SessionCommGuards {
  const sends = new Map<string, number[]>(); // sender id → send timestamps in window
  const inboundHop = new Map<string, { hops: number; at: number }>();
  let maxHops = clampLateralMaxHops(initialMaxHops);
  let opsSincePrune = 0;

  function inboundHopOf(id: string): number {
    const rec = inboundHop.get(id);
    if (!rec) return 0;
    if (now() - rec.at > LATERAL_HOP_TTL_MS) {
      inboundHop.delete(id);
      return 0;
    }
    return rec.hops;
  }

  /** Sweep expired window entries + hop tags every PRUNE_EVERY_OPS guard ops so
   *  idle senders don't linger. Synchronous (concurrency invariant above). */
  function maybePrune(): void {
    if (++opsSincePrune < PRUNE_EVERY_OPS) return;
    opsSincePrune = 0;
    const t = now();
    for (const [id, arr] of sends) {
      const live = arr.filter((ts) => t - ts < LATERAL_WINDOW_MS);
      if (live.length === 0) sends.delete(id);
      else if (live.length !== arr.length) sends.set(id, live);
    }
    for (const [id, rec] of inboundHop) {
      if (t - rec.at > LATERAL_HOP_TTL_MS) inboundHop.delete(id);
    }
  }

  return {
    checkSendAllowed(callerId: string): SendVerdict {
      maybePrune();
      const hops = inboundHopOf(callerId) + 1;
      if (hops > maxHops) {
        return {
          ok: false,
          status: 400,
          error:
            `hop budget exhausted: this message would be relay hop ${hops} of a lateral chain (max ${maxHops}). ` +
            `Stop forwarding — escalate to your parent session or the operator with a summary instead.`,
        };
      }
      const t = now();
      const window = (sends.get(callerId) ?? []).filter((ts) => t - ts < LATERAL_WINDOW_MS);
      if (window.length >= LATERAL_MAX_SENDS) {
        const retryMs = LATERAL_WINDOW_MS - (t - window[0]);
        sends.set(callerId, window);
        return {
          ok: false,
          status: 429,
          error:
            `lateral-send rate cap: ${LATERAL_MAX_SENDS} agent-initiated messages per ${Math.round(LATERAL_WINDOW_MS / 60_000)} minutes. ` +
            `Retry in ~${Math.max(1, Math.ceil(retryMs / 1000))}s, or end your turn and let replies wake you instead of messaging in a loop.`,
        };
      }
      window.push(t);
      sends.set(callerId, window);
      return { ok: true, hops };
    },

    recordDelivery(targetId: string, hops: number): void {
      maybePrune();
      inboundHop.set(targetId, { hops, at: now() });
    },

    clearInboundHop(sessionId: string): void {
      inboundHop.delete(sessionId);
    },

    stats(): { senders: number; hopEntries: number } {
      return { senders: sends.size, hopEntries: inboundHop.size };
    },

    maxHops(): number {
      return maxHops;
    },

    setMaxHops(value: number): void {
      maxHops = clampLateralMaxHops(value);
    },

    reset(): void {
      sends.clear();
      inboundHop.clear();
      opsSincePrune = 0;
    },
  };
}

/** The gateway's singleton guard state (api.ts routes use this instance). */
export const sessionCommGuards: SessionCommGuards = createSessionCommGuards();

export type LateralSendPlan =
  | { ok: true; prompt: string; displayMessage: string; hops: number }
  | { ok: false; status: 400 | 429; error: string };

/** One-line word-boundary trim for the human-facing banner. */
function clip(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Apply the lateral-send guards and build the injected message for an
 * agent-initiated send: the ENGINE prompt carries full sender identity, the hop
 * tag, the verbatim message, and a reply hint; `displayMessage` is the clean
 * banner the web UI shows. Deterministic text from record fields only.
 * On success the sender's window capacity is consumed; the caller then
 * `guards.recordDelivery(targetId, hops)` when it accepts the send (conservative
 * if a later step fails — an over-recorded hop only tightens the budget).
 */
export function prepareLateralSend(opts: {
  caller: Session;
  targetSessionId: string;
  message: string;
  guards: SessionCommGuards;
}): LateralSendPlan {
  const { caller, targetSessionId, message, guards } = opts;
  if (caller.id === targetSessionId) {
    return {
      ok: false,
      status: 400,
      error: "cannot message your own session — write your conclusion in your reply instead.",
    };
  }
  const verdict = guards.checkSendAllowed(caller.id);
  if (!verdict.ok) return verdict;

  const senderLabel = caller.employee || caller.source || "session";
  // Relayed messages (hop > 1) carry the hop tag in the human banner too, so an
  // operator watching a chain sees how deep it runs; first-hop banners stay clean.
  const hopTag = ` [hop ${verdict.hops}/${guards.maxHops()}]`;
  const prompt =
    `📨 Message from session ${caller.id} (${senderLabel})${hopTag}:\n\n` +
    `${message}\n\n` +
    `To reply: send_to_session { sessionId: "${caller.id}" }. ` +
    `If this exchange is going in circles, stop and report to your parent session or the operator instead of forwarding.`;
  const displayMessage = `📨 From ${senderLabel}${verdict.hops > 1 ? hopTag : ""}: ${clip(message)}`;
  return { ok: true, prompt, displayMessage, hops: verdict.hops };
}

/**
 * Is `sessionId` a strict descendant of `ancestorId`? Walks parentSessionId
 * upward with a cycle/depth guard. Self is NOT a descendant. Used to scope
 * agent-initiated stops to the caller's own subtree.
 */
export function isDescendantOf(
  sessionId: string,
  ancestorId: string,
  getSession: (id: string) => Session | undefined,
): boolean {
  const seen = new Set<string>([sessionId]);
  let current = getSession(sessionId);
  for (let depth = 0; depth < 64 && current?.parentSessionId; depth++) {
    const parentId = current.parentSessionId;
    if (parentId === ancestorId) return true;
    if (seen.has(parentId)) return false; // cycle
    seen.add(parentId);
    current = getSession(parentId);
  }
  return false;
}

/** Normalize a node header value to a trimmed string (first value wins). */
export function headerString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || undefined;
}

function hasHeader(headers: Record<string, string | string[] | undefined>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(headers, name);
}

/**
 * GRS-017 codex finding 2 — who is on the other end of a session-comm request?
 *
 *   - `session`: a declared caller identity (`x-jinn-caller-session`). For
 *     scoped tool writes, this is accepted only when the paired
 *     `x-jinn-session-capability` verifies against the gateway's per-session
 *     capability registry. The capability requirement keys off the identity
 *     claim itself, not the tool marker, so raw curl cannot spoof a session by
 *     omitting `x-jinn-tool-call`.
 *   - `unidentified-tool`: the tool-origin marker WITHOUT a verified bound
 *     identity. An MCP tool always runs on behalf of a session, so a marker with
 *     no identity/capability means the identity got LOST or spoofed — the routes
 *     must FAIL CLOSED (403), never fall through to the operator path.
 *   - `operator`: no session claim AND the caller has already proved gateway
 *     bearer/cookie authority. Absence of identity is never privilege.
 *   - `unauthenticated`: no verified operator auth and no scoped session
 *     identity. Mutation routes must fail this principal closed.
 */
export type CallerIdentity =
  | { kind: "operator" }
  | { kind: "session"; callerId: string }
  | { kind: "unidentified-tool" }
  | { kind: "unauthenticated" };

export interface CallerIdentityOptions {
  sessionExists?: (sessionId: string) => boolean;
  verifySessionCapability?: (sessionId: string, capability: string) => boolean;
  requireCapability?: boolean;
  operatorAuthenticated?: boolean;
}

export function resolveCallerIdentity(
  headers: Record<string, string | string[] | undefined>,
  options?: ((sessionId: string) => boolean) | CallerIdentityOptions,
): CallerIdentity {
  const opts: CallerIdentityOptions = typeof options === "function" ? { sessionExists: options } : options ?? {};
  const toolHeaderPresent = hasHeader(headers, TOOL_CALL_HEADER);
  const callerHeaderPresent = hasHeader(headers, CALLER_SESSION_HEADER);
  const toolMarker = headerString(headers[TOOL_CALL_HEADER]);
  const callerId = headerString(headers[CALLER_SESSION_HEADER]);
  if ((toolHeaderPresent && !toolMarker) || (callerHeaderPresent && !callerId)) {
    return { kind: "unidentified-tool" };
  }
  const isToolCall = !!toolMarker;
  if (callerId) {
    if (opts.sessionExists && !opts.sessionExists(callerId)) return { kind: "unidentified-tool" };
    if (opts.requireCapability) {
      const capability = headerString(headers[CALLER_SESSION_CAPABILITY_HEADER]);
      if (!capability || !opts.verifySessionCapability?.(callerId, capability)) return { kind: "unidentified-tool" };
    }
    return { kind: "session", callerId };
  }
  if (isToolCall) return { kind: "unidentified-tool" };
  return opts.operatorAuthenticated ? { kind: "operator" } : { kind: "unauthenticated" };
}
