/**
 * Jinn Talk — real org bridge (Phase 2).
 *
 * Implements the `OrgBridge` contract from context.ts on top of the EXISTING
 * sessions machinery, so /talk's `delegate` / `get_org_pulse` tools route real
 * work through the same path the chat UI uses — no parallel execution engine.
 *
 * Dispatch decision (see INTEGRATION.md "Sessions / delegation"):
 *   The /talk turn runs IN-PROCESS inside the gateway (agent.ts is invoked by
 *   routes.ts on the gateway), but `createOrgBridge()` is given NO ApiContext —
 *   it cannot reach the in-process `SessionManager` / `dispatchWebSessionRun`
 *   (that function is module-private to gateway/api.ts and needs the context).
 *   The supported, public dispatch entry point that INTEGRATION.md tells us to
 *   reuse is the gateway's own HTTP API: `POST /api/sessions` (create + run a
 *   child turn) which internally calls `dispatchWebSessionRun(...)` →
 *   `runWebSession(...)`. We self-call it over loopback at the live port read
 *   from `gateway.json` (GATEWAY_INFO_FILE). The same process serves that HTTP,
 *   so this is a genuine in-process dispatch — just through the front door.
 *
 *   Per the DECISION in INTEGRATION.md, the /talk turn is NOT itself a gateway
 *   Session, so `notifyParentSession` injection can't reach us. We therefore
 *   POLL the child Session's status/result via `getSession` / `getMessages`:
 *     - sync  → poll to a terminal status, return the child's last assistant text;
 *     - async → return immediately + a setInterval watcher that emits talk:task
 *               updates as the child's status/progress changes.
 */
import { getSession, getMessages, listSessions } from "../sessions/registry.js"
import { scanOrg, findEmployee } from "../gateway/org.js"
import { readGatewayInfo } from "../gateway/gateway-info.js"
import { GATEWAY_INFO_FILE } from "../shared/paths.js"
import { TALK_EVENTS } from "./protocol.js"
import type { Emit, TrackerTask, TalkTaskEvent } from "./protocol.js"
import type {
  OrgBridge,
  OrgPulse,
  DelegateOpts,
  DelegateResult,
} from "./context.js"
import type { Session } from "../shared/types.js"

// --------------------------------------------------------------------------- tuning
const SYNC_TIMEOUT_MS = 180_000 // 3 min — generous for a single COO/employee turn
const POLL_INTERVAL_MS = 1_500
const ASYNC_POLL_INTERVAL_MS = 2_500
const ASYNC_MAX_MS = 20 * 60_000 // hard ceiling so a stuck child can't leak an interval forever
const RESULT_MAX_CHARS = 600
const LIST_CAP = 8

/** Terminal session statuses — the turn is done (success or failure). */
const TERMINAL: ReadonlySet<Session["status"]> = new Set<Session["status"]>([
  "idle",
  "error",
  "interrupted",
])
/** Statuses that count as "live" work for the pulse snapshot. */
const ACTIVE: ReadonlySet<Session["status"]> = new Set<Session["status"]>([
  "running",
  "waiting",
])

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function clip(text: string, max = RESULT_MAX_CHARS): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** A short, speakable label for a delegated task. */
function taskLabel(target: string, task: string): string {
  const who = target === "coo" ? "COO" : target
  return clip(`${who}: ${task.replace(/\s+/g, " ").trim()}`, 60)
}

/**
 * Read the child session's result: prefer its last `assistant` message
 * (runWebSession persists the engine output there), then fall back to
 * `lastError` for failed turns. Returns "" when nothing is available.
 */
function readChildResult(childId: string): string {
  let assistant = ""
  try {
    const msgs = getMessages(childId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" && msgs[i].content.trim()) {
        assistant = msgs[i].content
        break
      }
    }
  } catch {
    // registry read failed — fall through to session.lastError below
  }
  if (assistant) return clip(assistant)
  const s = getSession(childId)
  if (s?.lastError) return clip(s.lastError)
  return ""
}

/**
 * Resolve a delegation target to the body for `POST /api/sessions`.
 * "coo" (default) → no employee (the default Jimbo/COO persona, claude engine).
 * A named employee → resolve via scanOrg()/findEmployee for engine + persona.
 * Throws if a named (non-coo) employee can't be found.
 */
function resolveTarget(target: string): {
  engine: string
  employee?: string
  model?: string
} {
  if (!target || target === "coo") return { engine: "claude" }
  const registry = scanOrg()
  const emp = findEmployee(target, registry)
  if (!emp) {
    throw new Error(
      `unknown delegate target "${target}" (use "coo" or a valid employee name)`,
    )
  }
  const out: { engine: string; employee?: string; model?: string } = {
    engine: emp.engine || "claude",
    employee: emp.name,
  }
  if (emp.model) out.model = emp.model
  return out
}

/**
 * Create + start a child session via the gateway's own HTTP API (loopback).
 * This is the exact public dispatch path the chat UI uses: the POST handler
 * runs `dispatchWebSessionRun` → `runWebSession`, which persists the assistant
 * reply and flips the session to a terminal status. Returns the child id.
 */
async function spawnChild(args: {
  task: string
  parentSessionId: string
  engine: string
  employee?: string
  model?: string
}): Promise<string> {
  const info = readGatewayInfo(GATEWAY_INFO_FILE)
  if (!info?.port) {
    throw new Error("gateway port unavailable (gateway.json missing/unreadable)")
  }
  const body: Record<string, unknown> = {
    engine: args.engine,
    prompt: args.task,
    parentSessionId: args.parentSessionId,
  }
  if (args.employee) body.employee = args.employee
  if (args.model) body.model = args.model

  const res = await fetch(`http://127.0.0.1:${info.port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`POST /api/sessions failed (${res.status})${detail ? `: ${clip(detail, 160)}` : ""}`)
  }
  const created = (await res.json()) as { id?: string }
  if (!created?.id) throw new Error("gateway did not return a child session id")
  return created.id
}

function progressForStatus(status: Session["status"]): number {
  if (TERMINAL.has(status)) return 1
  if (status === "waiting") return 0.4
  return 0.5 // running
}

export function createOrgBridge(): OrgBridge {
  /** Drive talk:task updates for an async delegation until the child terminates. */
  function startAsyncWatcher(
    childId: string,
    label: string,
    owner: string,
    sessionId: string,
    emit: Emit,
  ): void {
    const startedAt = Date.now()
    let lastStatus: Session["status"] | "" = ""
    const emitTask = (task: TrackerTask) => {
      const payload: TalkTaskEvent = { sessionId, task }
      emit(TALK_EVENTS.task, payload)
    }

    const timer = setInterval(() => {
      let session: Session | undefined
      try {
        session = getSession(childId)
      } catch {
        session = undefined
      }

      // Child vanished (deleted) or we've blown the ceiling → finalize as error.
      if (!session || Date.now() - startedAt > ASYNC_MAX_MS) {
        clearInterval(timer)
        emitTask({
          id: childId,
          label,
          owner,
          status: "error",
          progress: 1,
          result: session
            ? "still running after the time limit"
            : "session no longer exists",
        })
        return
      }

      if (TERMINAL.has(session.status)) {
        clearInterval(timer)
        const result = readChildResult(childId)
        emitTask({
          id: childId,
          label,
          owner,
          status: session.status === "error" ? "error" : "done",
          progress: 1,
          ...(result ? { result } : {}),
        })
        return
      }

      // Still running — emit a progress tick only when status actually changed,
      // to avoid spamming the surface every interval.
      if (session.status !== lastStatus) {
        lastStatus = session.status
        emitTask({
          id: childId,
          label,
          owner,
          status: "running",
          progress: progressForStatus(session.status),
        })
      }
    }, ASYNC_POLL_INTERVAL_MS)

    // Don't keep the gateway event loop alive purely for this poller.
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      ;(timer as { unref: () => void }).unref()
    }
  }

  return {
    async delegate(
      task: string,
      opts: DelegateOpts,
      deps: { sessionId: string; emit: Emit },
    ): Promise<DelegateResult> {
      const { sessionId, emit } = deps
      const target = opts.target?.trim() || "coo"
      try {
        const resolved = resolveTarget(target)
        const childId = await spawnChild({
          task,
          parentSessionId: sessionId,
          engine: resolved.engine,
          ...(resolved.employee ? { employee: resolved.employee } : {}),
          ...(resolved.model ? { model: resolved.model } : {}),
        })

        // ---------------------------------------------------------- async path
        if (opts.async) {
          const label = taskLabel(target, task)
          const initial: TrackerTask = {
            id: childId,
            label,
            owner: target,
            status: "running",
            progress: 0.1,
          }
          emit(TALK_EVENTS.task, { sessionId, task: initial } as TalkTaskEvent)
          startAsyncWatcher(childId, label, target, sessionId, emit)
          return { ok: true, taskId: childId }
        }

        // ----------------------------------------------------------- sync path
        const deadline = Date.now() + SYNC_TIMEOUT_MS
        for (;;) {
          await sleep(POLL_INTERVAL_MS)
          const session = getSession(childId)
          if (!session) {
            return { ok: false, error: "child session disappeared before completing" }
          }
          if (TERMINAL.has(session.status)) {
            const result = readChildResult(childId)
            if (session.status === "error") {
              return {
                ok: false,
                error: result || session.lastError || "delegated turn failed",
              }
            }
            return { ok: true, result: result || "(no output returned)" }
          }
          if (Date.now() >= deadline) {
            return {
              ok: false,
              error: `still running after ${Math.round(SYNC_TIMEOUT_MS / 1000)}s (task id ${childId})`,
            }
          }
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async getOrgPulse(): Promise<OrgPulse> {
      try {
        const sessions = listSessions()

        // Active (running/waiting) sessions, newest-first (listSessions order).
        const active = sessions.filter((s) => ACTIVE.has(s.status))

        // Count active work per employee (sessions with no employee = COO/direct).
        const runningByEmployee = new Map<string, number>()
        for (const s of active) {
          const key = s.employee && s.employee.trim() ? s.employee : "coo"
          runningByEmployee.set(key, (runningByEmployee.get(key) ?? 0) + 1)
        }

        // Employee rows: only those currently doing work, plus COO if active.
        const employeeRows: OrgPulse["employees"] = []
        for (const [name, running] of runningByEmployee) {
          if (running <= 0) continue
          // status of the most recent active session for this owner
          const sample = active.find(
            (s) => (s.employee && s.employee.trim() ? s.employee : "coo") === name,
          )
          const row: { name: string; running: number; status?: string } = {
            name,
            running,
          }
          if (sample?.status) row.status = sample.status
          employeeRows.push(row)
        }
        employeeRows.sort((a, b) => b.running - a.running)
        const cappedEmployees = employeeRows.slice(0, LIST_CAP)

        // Running jobs strip — one row per active session (title + owner).
        const runningJobs: OrgPulse["runningJobs"] = active
          .slice(0, LIST_CAP)
          .map((s) => ({
            id: s.id,
            title: s.title?.trim() || s.id.slice(0, 8),
            owner: s.employee && s.employee.trim() ? s.employee : "coo",
          }))

        // Awaiting approval: no first-class "approval" queue is readily exposed
        // in-process (Slack-reaction approvals live outside the session registry),
        // so this is best-effort empty per the contract.
        const awaitingApproval: OrgPulse["awaitingApproval"] = []

        const activeCount = active.length
        const summary = buildSummary(activeCount, cappedEmployees, awaitingApproval)

        return {
          activeCount,
          employees: cappedEmployees,
          runningJobs,
          awaitingApproval,
          summary,
        }
      } catch (err) {
        // Never throw out of the pulse — return a degraded-but-valid snapshot.
        const msg = err instanceof Error ? err.message : String(err)
        return {
          activeCount: 0,
          employees: [],
          runningJobs: [],
          awaitingApproval: [],
          summary: `Couldn't read live org activity (${clip(msg, 80)}).`,
        }
      }
    },
  }
}

/** One natural sentence the agent reads aloud from the pulse. */
function buildSummary(
  activeCount: number,
  employees: OrgPulse["employees"],
  awaitingApproval: OrgPulse["awaitingApproval"],
): string {
  const approvalClause =
    awaitingApproval.length > 0
      ? `${awaitingApproval.length} awaiting approval`
      : "nothing awaiting approval"

  if (activeCount === 0) {
    return `Nothing running right now — ${approvalClause}.`
  }

  const names = employees.map((e) => e.name).slice(0, 3)
  const who =
    names.length === 0
      ? ""
      : names.length === 1
        ? ` — ${names[0]} is active`
        : ` — ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are active`

  const jobWord = activeCount === 1 ? "job" : "jobs"
  return `${activeCount} ${jobWord} running${who}; ${approvalClause}.`
}
