/** JSON-only gateway → browser wire vocabulary. This package owns no gateway or UI domain code. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

export interface MessageMediaWire {
  type: "image" | "audio" | "video" | "file"
  url: string
  name?: string
  mimeType?: string
  size?: number
}

export type CompanyChangedEvent =
  | { entity: "todo"; action: string; id: string; sessionId?: string; version: number; value?: JsonObject }
  | { entity: "workflow-definition"; id: string; revision: number }
  | { entity: "workflow-run"; workflowId: string; runId: string }

/** One live session's Claude usage snapshot (Tengu step 1), joined to its
 *  session/employee/todo identity. Mirrors `shared/session-telemetry.ts`'s
 *  `SessionTelemetry`, kept independent here since this package owns no
 *  gateway or UI domain types. */
export interface SessionTelemetryWire {
  sessionId: string
  employee: string | null
  employeeDisplayName?: string
  model: string | null
  workItemId: string | null
  status: string
  currentTodoTitle?: string | null
  contextUsedPct?: number
  fiveHourUsedPct?: number
  fiveHourResetsAt?: string
  sevenDayUsedPct?: number
  sevenDayResetsAt?: string
  costUsd?: number
  capturedAt?: string
  stale: boolean
}

/** Account-wide usage, MAX across live sessions in the window (see
 *  `rollupAccountLimits`) — never the freshest-file heuristic. */
export interface AccountLimitsRollupWire {
  fiveHourUsedPct?: number
  fiveHourResetsAt?: string
  sevenDayUsedPct?: number
  sevenDayResetsAt?: string
}

/** Completed/total descendants of one Todo root (Tengu step 3). */
export interface RootProgressWire {
  rootId: string
  total: number
  completed: number
  inFlight: number
  completedPct: number
}

/** Completed/total/in-flight Todos for one assignee. */
export interface EmployeeProgressWire {
  assignee: string
  total: number
  completed: number
  inFlight: number
}

export interface GatewayEventMap {
  "session:started": { sessionId: string }
  "session:created": { sessionId: string }
  "session:updated": { sessionId: string; title?: string }
  "session:deleted": { sessionId: string }
  "session:stopped": { sessionId: string }
  "session:external-turn": { sessionId: string }
  "session:interrupted": { sessionId: string; reason: string }
  "session:completed": {
    sessionId: string
    result: string | null
    error: string | null
    employee?: string
    title?: string | null
    cost?: number
    durationMs?: number
  }
  "session:delta": {
    sessionId: string
    type: "text" | "text_snapshot" | "tool_use" | "tool_result" | "status" | "error" | "context" | "block"
    content: string
    toolName?: string
    toolId?: string
    activityReceiptId?: string
    input?: string
    block?: JsonValue
  }
  "session:notification": { sessionId: string; message: string; meta?: JsonObject }
  "session:attachment": { sessionId: string; id: string; content: string; media: MessageMediaWire[]; timestamp: number }
  "session:background": {
    sessionId: string
    transportState: string
    backgroundActivity: {
      activeStreams: number
      activeAgents?: number
      activeMonitors?: number
      lastActivityAt: string
    } | null
  }
  /** Tengu steps 1–3: per-session Claude usage + Todo progress rollups, one
   *  event feeding both the Limits page and the nav-rail status dot.
   *  Broadcast on the same live-events channel as `company:changed`,
   *  debounced ~1s server-side. */
  "session:telemetry": {
    sessions: SessionTelemetryWire[]
    account: AccountLimitsRollupWire
    rootProgress: RootProgressWire[]
    employeeProgress: EmployeeProgressWire[]
    capturedAt: string
  }
  "queue:updated": { sessionId: string; sessionKey: string; depth?: number; paused?: boolean }
  "company:changed": CompanyChangedEvent
  "pins:changed": Record<string, never>
  "notes:changed": { path: string; revision: string; action: "created" | "updated" }
  "experiments:changed": {
    id: string
    action: "created" | "updated" | "reading-recorded" | "concluded"
  }
  "org:changed": Record<string, never>
  "config:reloaded": Record<string, never>
  "skills:changed": Record<string, never>
  "cron:reloaded": Record<string, never>
  "cron:run-finished": { jobId: string; status: "success" | "error" }
  "engines:updated": Record<string, never>
  "stt:download:progress": { progress: number }
  "stt:download:complete": { model: string }
  "stt:download:error": { error: string }
  "talk:audio": { sessionId: string; seq: number; mime: string; dataBase64: string; last?: boolean }
  "talk:tts:download:progress": { progress: number }
  "talk:tts:download:complete": Record<string, never>
  "talk:tts:download:error": { error: string }
}

export type GatewayEventName = keyof GatewayEventMap
export type GatewayEvent = {
  [K in GatewayEventName]: { event: K; payload: GatewayEventMap[K] }
}[GatewayEventName]
export type GatewayEventListener = (frame: GatewayEvent) => void
export type GatewayEmit = <K extends GatewayEventName>(event: K, payload: GatewayEventMap[K]) => void

export const GATEWAY_EVENTS = {
  sessionStarted: "session:started",
  sessionCreated: "session:created",
  sessionUpdated: "session:updated",
  sessionDeleted: "session:deleted",
  sessionStopped: "session:stopped",
  sessionExternalTurn: "session:external-turn",
  sessionInterrupted: "session:interrupted",
  sessionCompleted: "session:completed",
  sessionDelta: "session:delta",
  sessionNotification: "session:notification",
  sessionAttachment: "session:attachment",
  sessionBackground: "session:background",
  sessionTelemetry: "session:telemetry",
  queueUpdated: "queue:updated",
  companyChanged: "company:changed",
  pinsChanged: "pins:changed",
  notesChanged: "notes:changed",
  experimentsChanged: "experiments:changed",
  orgChanged: "org:changed",
  configReloaded: "config:reloaded",
  skillsChanged: "skills:changed",
  cronReloaded: "cron:reloaded",
  cronRunFinished: "cron:run-finished",
  enginesUpdated: "engines:updated",
  sttDownloadProgress: "stt:download:progress",
  sttDownloadComplete: "stt:download:complete",
  sttDownloadError: "stt:download:error",
  talkAudio: "talk:audio",
  talkTtsDownloadProgress: "talk:tts:download:progress",
  talkTtsDownloadComplete: "talk:tts:download:complete",
  talkTtsDownloadError: "talk:tts:download:error",
} as const satisfies Record<string, GatewayEventName>

const gatewayEventNames = new Set<string>(Object.values(GATEWAY_EVENTS))

export function isGatewayEventName(value: unknown): value is GatewayEventName {
  return typeof value === "string" && gatewayEventNames.has(value)
}

type WireRecord = Record<string, unknown>

const deltaTypes = new Set<GatewayEventMap["session:delta"]["type"]>([
  "text",
  "text_snapshot",
  "tool_use",
  "tool_result",
  "status",
  "error",
  "context",
  "block",
])

function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || isNumber(value)
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean"
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (isNumber(value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isEmptyPayload(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0
}

function isSessionIdPayload(value: unknown): value is { sessionId: string } {
  return isRecord(value) && isString(value.sessionId)
}

function isMessageMedia(value: unknown): value is MessageMediaWire {
  return isRecord(value)
    && (value.type === "image" || value.type === "audio" || value.type === "video" || value.type === "file")
    && isString(value.url)
    && isOptionalString(value.name)
    && isOptionalString(value.mimeType)
    && isOptionalNumber(value.size)
}

function isCompanyChangedEvent(value: unknown): value is CompanyChangedEvent {
  if (!isRecord(value)) return false
  if (value.entity === "todo") {
    return isString(value.action)
      && isString(value.id)
      && isOptionalString(value.sessionId)
      && isNumber(value.version)
      && (value.value === undefined || (isRecord(value.value) && isJsonValue(value.value)))
  }
  if (value.entity === "workflow-definition") {
    return isString(value.id) && isNumber(value.revision)
  }
  if (value.entity === "workflow-run") {
    return isString(value.workflowId) && isString(value.runId)
  }
  return false
}

function isSessionTelemetryEntry(value: unknown): value is SessionTelemetryWire {
  return isRecord(value)
    && isString(value.sessionId)
    && (value.employee === null || isString(value.employee))
    && isOptionalString(value.employeeDisplayName)
    && (value.model === null || isString(value.model))
    && (value.workItemId === null || isString(value.workItemId))
    && isString(value.status)
    && (value.currentTodoTitle === undefined || value.currentTodoTitle === null || isString(value.currentTodoTitle))
    && isOptionalNumber(value.contextUsedPct)
    && isOptionalNumber(value.fiveHourUsedPct)
    && isOptionalString(value.fiveHourResetsAt)
    && isOptionalNumber(value.sevenDayUsedPct)
    && isOptionalString(value.sevenDayResetsAt)
    && isOptionalNumber(value.costUsd)
    && isOptionalString(value.capturedAt)
    && typeof value.stale === "boolean"
}

function isAccountLimitsRollup(value: unknown): value is AccountLimitsRollupWire {
  return isRecord(value)
    && isOptionalNumber(value.fiveHourUsedPct)
    && isOptionalString(value.fiveHourResetsAt)
    && isOptionalNumber(value.sevenDayUsedPct)
    && isOptionalString(value.sevenDayResetsAt)
}

function isRootProgressEntry(value: unknown): value is RootProgressWire {
  return isRecord(value)
    && isString(value.rootId)
    && isNumber(value.total)
    && isNumber(value.completed)
    && isNumber(value.inFlight)
    && isNumber(value.completedPct)
}

function isEmployeeProgressEntry(value: unknown): value is EmployeeProgressWire {
  return isRecord(value)
    && isString(value.assignee)
    && isNumber(value.total)
    && isNumber(value.completed)
    && isNumber(value.inFlight)
}

function isGatewayEventPayload(event: GatewayEventName, value: unknown): boolean {
  switch (event) {
    case "session:started":
    case "session:created":
    case "session:deleted":
    case "session:stopped":
    case "session:external-turn":
      return isSessionIdPayload(value)
    case "session:updated":
      return isRecord(value) && isString(value.sessionId) && isOptionalString(value.title)
    case "session:interrupted":
      return isRecord(value) && isString(value.sessionId) && isString(value.reason)
    case "session:completed":
      return isRecord(value)
        && isString(value.sessionId)
        && (value.result === null || isString(value.result))
        && (value.error === null || isString(value.error))
        && isOptionalString(value.employee)
        && (value.title === undefined || value.title === null || isString(value.title))
        && isOptionalNumber(value.cost)
        && isOptionalNumber(value.durationMs)
    case "session:delta":
      return isRecord(value)
        && isString(value.sessionId)
        && isString(value.type)
        && deltaTypes.has(value.type as GatewayEventMap["session:delta"]["type"])
        && isString(value.content)
        && isOptionalString(value.toolName)
        && isOptionalString(value.toolId)
        && isOptionalString(value.activityReceiptId)
        && isOptionalString(value.input)
        && (value.block === undefined || isJsonValue(value.block))
    case "session:notification":
      return isRecord(value)
        && isString(value.sessionId)
        && isString(value.message)
        && (value.meta === undefined || (isRecord(value.meta) && isJsonValue(value.meta)))
    case "session:attachment":
      return isRecord(value)
        && isString(value.sessionId)
        && isString(value.id)
        && isString(value.content)
        && Array.isArray(value.media)
        && value.media.every(isMessageMedia)
        && isNumber(value.timestamp)
    case "session:background": {
      if (!isRecord(value) || !isString(value.sessionId) || !isString(value.transportState)) return false
      if (value.backgroundActivity === null) return true
      return isRecord(value.backgroundActivity)
        && isNumber(value.backgroundActivity.activeStreams)
        && isOptionalNumber(value.backgroundActivity.activeAgents)
        && isOptionalNumber(value.backgroundActivity.activeMonitors)
        && isString(value.backgroundActivity.lastActivityAt)
    }
    case "session:telemetry":
      return isRecord(value)
        && Array.isArray(value.sessions) && value.sessions.every(isSessionTelemetryEntry)
        && isAccountLimitsRollup(value.account)
        && Array.isArray(value.rootProgress) && value.rootProgress.every(isRootProgressEntry)
        && Array.isArray(value.employeeProgress) && value.employeeProgress.every(isEmployeeProgressEntry)
        && isString(value.capturedAt)
    case "queue:updated":
      return isRecord(value)
        && isString(value.sessionId)
        && isString(value.sessionKey)
        && isOptionalNumber(value.depth)
        && isOptionalBoolean(value.paused)
    case "company:changed":
      return isCompanyChangedEvent(value)
    case "notes:changed":
      return isRecord(value)
        && isString(value.path)
        && isString(value.revision)
        && (value.action === "created" || value.action === "updated")
    case "experiments:changed":
      return isRecord(value)
        && isString(value.id)
        && (value.action === "created"
          || value.action === "updated"
          || value.action === "reading-recorded"
          || value.action === "concluded")
    case "cron:run-finished":
      return isRecord(value)
        && isString(value.jobId)
        && (value.status === "success" || value.status === "error")
    case "stt:download:progress":
    case "talk:tts:download:progress":
      return isRecord(value) && isNumber(value.progress)
    case "stt:download:complete":
      return isRecord(value) && isString(value.model)
    case "stt:download:error":
    case "talk:tts:download:error":
      return isRecord(value) && isString(value.error)
    case "talk:audio":
      return isRecord(value)
        && isString(value.sessionId)
        && isNumber(value.seq)
        && isString(value.mime)
        && isString(value.dataBase64)
        && isOptionalBoolean(value.last)
    case "pins:changed":
    case "org:changed":
    case "config:reloaded":
    case "skills:changed":
    case "cron:reloaded":
    case "engines:updated":
    case "talk:tts:download:complete":
      return isEmptyPayload(value)
  }
}

/** Decode an untrusted websocket frame into the shared discriminated union. */
export function decodeGatewayEvent(value: unknown): GatewayEvent | null {
  if (!isRecord(value) || !isGatewayEventName(value.event)) return null
  if (!isGatewayEventPayload(value.event, value.payload)) return null
  return value as GatewayEvent
}

export function isGatewayEvent(value: unknown): value is GatewayEvent {
  return decodeGatewayEvent(value) !== null
}
