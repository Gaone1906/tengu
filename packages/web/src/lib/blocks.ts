import type { Message } from './conversations'

export type ChatBlockType =
  | 'task-list'
  | 'delegation'
  | 'dispatch'
  | 'todo-activity'
  | 'workflow-definition'
  | 'workflow-run'
export type ChatBlockStatus = 'queued' | 'dispatched' | 'running' | 'waiting' | 'done' | 'completed' | 'error'
export type ChatBlockOp = 'put' | 'patch' | 'remove'
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

/** Correlation metadata authored only by verified server mutation paths. */
export type ActivityReceipt = JsonObject & {
  id: string
  operationId: string
  toolName: string
}

export type TodoActivityPayload = JsonObject & {
  todoId: string
  action: string
  status: string
  assignee?: string | null
  actor?: string | null
  approvalState?: string | null
  updatedAt?: string
  preview?: string
  latestError?: string | null
  activityReceipt?: ActivityReceipt
}

export type WorkflowDefinitionActivityPayload = JsonObject & {
  workflowId: string
  action: string
  definitionStatus: string
  updatedAt?: string
  openPath?: string
  preview?: string
  latestError?: string | null
  activityReceipt?: ActivityReceipt
}

export type WorkflowRunActivityPayload = JsonObject & {
  workflowId: string
  runId: string
  action: string
  runStatus: string
  startedAt?: string
  endedAt?: string | null
  completedSteps?: number
  totalSteps?: number
  parkedDescription?: string
  openPath?: string
  preview?: string
  latestError?: string | null
  activityReceipt?: ActivityReceipt
}

export interface ChatBlock {
  id: string
  type: ChatBlockType
  version: number
  status?: ChatBlockStatus
  sourceEngine?: string
  title?: string
  summary?: string
  payload: JsonObject
}

export interface ChatBlockEnvelope {
  op: ChatBlockOp
  block: ChatBlock
}

/** Ephemeral UI-only provenance for a genuinely new live delegation put. */
export interface DelegationArrival {
  nonce: number
  delayMs: number
}

export function isActiveDelegationStatus(status: ChatBlockStatus | undefined): boolean {
  return status === undefined
    || status === 'queued'
    || status === 'dispatched'
    || status === 'running'
    || status === 'waiting'
}

export function isTerminalDelegationStatus(status: ChatBlockStatus | undefined): boolean {
  return status === 'done' || status === 'completed' || status === 'error'
}

const SUPPORTED_BLOCK_TYPES = new Set<ChatBlockType>([
  'task-list',
  'delegation',
  'dispatch',
  'todo-activity',
  'workflow-definition',
  'workflow-run',
])
const ACTIVITY_BLOCK_TYPES = new Set<ChatBlockType>([
  'todo-activity',
  'workflow-definition',
  'workflow-run',
])
const SUPPORTED_BLOCK_STATUSES = new Set<ChatBlockStatus>([
  'queued',
  'dispatched',
  'running',
  'waiting',
  'done',
  'completed',
  'error',
])
const FORBIDDEN_PAYLOAD_KEYS = new Set(['html', 'script', 'component', 'dangerouslySetInnerHTML'])
const MAX_ACTIVITY_TEXT_CHARS = 4_000
const MAX_STRUCTURED_MESSAGE_CHARS = 16_000
const MAX_BLOCK_CHARS = 32_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasUnsafeString(value: string): boolean {
  return /<\s*script\b/i.test(value) || /javascript\s*:/i.test(value)
}

function isSafeJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false
  if (value === null) return true
  if (typeof value === 'string') return !hasUnsafeString(value)
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length <= 250 && value.every((item) => isSafeJson(item, depth + 1))
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  if (entries.length > 100) return false
  return entries.every(([key, child]) =>
    !FORBIDDEN_PAYLOAD_KEYS.has(key)
    && /^[A-Za-z0-9_.:-]{1,80}$/.test(key)
    && isSafeJson(child, depth + 1),
  )
}

function hasRequiredPayloadText(payload: JsonObject, field: string): boolean {
  const value = payload[field]
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160
}

function hasValidActivityReceipt(block: ChatBlock): boolean {
  const receipt = block.payload.activityReceipt
  if (receipt === undefined) return true
  if (!isRecord(receipt) || receipt.id !== block.id) return false
  return ['operationId', 'toolName'].every((field) => {
    const value = receipt[field]
    return typeof value === 'string'
      && value.trim().length > 0
      && value.length <= MAX_STRUCTURED_MESSAGE_CHARS
  })
}

function hasBoundedActivityText(payload: JsonObject): boolean {
  return ['preview', 'latestError', 'error', 'errorMessage'].every((field) => {
    const value = payload[field]
    return value === undefined
      || value === null
      || (typeof value === 'string' && value.length <= MAX_ACTIVITY_TEXT_CHARS)
  })
}

function hasValidActivityPayload(block: ChatBlock, op?: ChatBlockOp): boolean {
  if (!hasBoundedActivityText(block.payload) || !hasValidActivityReceipt(block)) return false
  if (op !== 'put') return true
  const requiredFields = block.type === 'todo-activity'
    ? ['todoId', 'action', 'status']
    : block.type === 'workflow-definition'
      ? ['workflowId', 'action', 'definitionStatus']
      : ['workflowId', 'runId', 'action', 'runStatus']
  return requiredFields.every((field) => hasRequiredPayloadText(block.payload, field))
}

export function isChatBlock(value: unknown): value is ChatBlock {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(value.id.trim())) return false
  if (typeof value.type !== 'string' || !SUPPORTED_BLOCK_TYPES.has(value.type as ChatBlockType)) return false
  if (typeof value.version !== 'number' || !Number.isFinite(value.version)) return false
  if (!isRecord(value.payload) || !isSafeJson(value.payload)) return false
  if (value.status !== undefined && (
    typeof value.status !== 'string'
    || !SUPPORTED_BLOCK_STATUSES.has(value.status as ChatBlockStatus)
  )) return false
  if (ACTIVITY_BLOCK_TYPES.has(value.type as ChatBlockType)) {
    return hasValidActivityPayload(value as unknown as ChatBlock)
  }
  return true
}

export function isBlockEnvelope(value: unknown): value is ChatBlockEnvelope {
  if (!isRecord(value)) return false
  if (value.op !== 'put' && value.op !== 'patch' && value.op !== 'remove') return false
  if (!isChatBlock(value.block)) return false
  if (JSON.stringify(value).length > MAX_BLOCK_CHARS) return false
  if (!ACTIVITY_BLOCK_TYPES.has(value.block.type)) return true
  if (value.op === 'put' && (
    typeof value.block.title !== 'string'
    || !value.block.title.trim()
    || value.block.title.length > 160
    || value.block.status === undefined
  )) return false
  return hasValidActivityPayload(value.block, value.op)
}

export function blockFallbackContent(block: ChatBlock): string {
  const prefix = block.title || block.summary || block.type
  if (block.type === 'task-list') {
    const items = Array.isArray(block.payload.items) ? block.payload.items : []
    return `${prefix}: ${items.length} item${items.length === 1 ? '' : 's'}`
  }
  if (block.type === 'delegation') {
    return typeof block.payload.title === 'string' && block.payload.title.trim()
      ? block.payload.title
      : prefix
  }
  if (block.type === 'dispatch') {
    return typeof block.payload.preview === 'string' && block.payload.preview.trim()
      ? `Followed up: ${block.payload.preview}`
      : 'Followed up'
  }
  if (block.type === 'todo-activity') {
    const status = typeof block.payload.status === 'string' && block.payload.status.trim()
      ? block.payload.status.replace(/[_-]+/g, ' ')
      : block.status ?? 'updated'
    return `Todo “${prefix}” · ${status}`
  }
  if (block.type === 'workflow-definition') {
    const action = typeof block.payload.action === 'string' && block.payload.action.trim()
      ? block.payload.action.replace(/[_-]+/g, ' ')
      : 'updated'
    const detail = action === 'updated' ? `updated to v${block.version}` : action
    return `Workflow “${prefix}” · ${detail}`
  }
  if (block.type === 'workflow-run') {
    const runStatus = typeof block.payload.runStatus === 'string' && block.payload.runStatus.trim()
      ? block.payload.runStatus
      : block.status ?? 'updated'
    const detail = runStatus === 'parked'
      ? 'waiting for approval'
      : runStatus.replace(/[_-]+/g, ' ')
    return `Workflow “${prefix}” · ${detail}`
  }
  return prefix
}

export function mergeBlock(existing: ChatBlock, patch: ChatBlock): ChatBlock {
  if (patch.version < existing.version) return existing
  return {
    ...existing,
    ...patch,
    id: existing.id,
    type: existing.type,
    version: patch.version ?? existing.version,
    payload: {
      ...existing.payload,
      ...patch.payload,
    },
  }
}

function blockFallbackCandidates(block: ChatBlock): string[] {
  return [
    blockFallbackContent(block),
    block.title,
    block.summary,
    block.type,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function isSyntheticBlockMessage(message: Message, block: ChatBlock | undefined): boolean {
  if (!block) return false
  if (message.id.startsWith(`block-${block.id}-`)) return true
  const content = message.content.trim()
  return blockFallbackCandidates(block).some((candidate) => candidate.trim() === content)
}

export function applyBlockEnvelopeToMessages(
  messages: Message[],
  envelope: ChatBlockEnvelope,
  fallback: string,
  timestamp: number = Date.now(),
): Message[] {
  const existingIndex = messages.findIndex((message) =>
    Array.isArray(message.blocks) && message.blocks.some((block) => block.id === envelope.block.id),
  )

  if (envelope.op === 'remove') {
    if (existingIndex < 0) return messages
    return messages.flatMap((message, index) => {
      if (index !== existingIndex) return [message]
      const oldBlock = (message.blocks || []).find((block) => block.id === envelope.block.id)
      const blocks = (message.blocks || []).filter((block) => block.id !== envelope.block.id)
      if (blocks.length > 0) return [{ ...message, blocks }]
      if (isSyntheticBlockMessage(message, oldBlock)) return []
      const next = { ...message }
      delete next.blocks
      return [next]
    })
  }

  if (existingIndex >= 0) {
    const existingBlock = (messages[existingIndex]?.blocks || [])
      .find((block) => block.id === envelope.block.id)
    if (envelope.op === 'patch' && existingBlock && envelope.block.version < existingBlock.version) {
      return messages
    }
    return messages.map((message, index) => {
      if (index !== existingIndex) return message
      const oldBlock = (message.blocks || []).find((block) => block.id === envelope.block.id)
      const blocks = (message.blocks || []).map((block) =>
        block.id === envelope.block.id
          ? envelope.op === 'patch' ? mergeBlock(block, envelope.block) : envelope.block
          : block,
      )
      const target = blocks.find((block) => block.id === envelope.block.id) || envelope.block
      return {
        ...message,
        content: isSyntheticBlockMessage(message, oldBlock)
          ? fallback || blockFallbackContent(target)
          : message.content,
        timestamp,
        blocks,
      }
    })
  }

  const content = fallback || blockFallbackContent(envelope.block)
  return [
    ...messages,
    {
      id: `block-${envelope.block.id}-${timestamp}`,
      role: 'assistant',
      content,
      timestamp,
      blocks: [envelope.block],
    },
  ]
}
