/**
 * Jinn Talk — shared type contract (Concept AURA).
 *
 * This is the spine every Talk component codes against: the avatar state
 * machine, the "Lego-block" content-card primitives the assistant composes on
 * the fly, and the parallel-task tracker. Keep this file dependency-free.
 */

/** The four moods of the AURA orb. Drives every visual transition. */
export type AvatarState = "idle" | "listening" | "thinking" | "speaking"

/** A normalised audio level 0..1, fed to the listening ring / speaking morph. */
export type AudioLevel = number

// ============================================================================
// Content cards — typed primitives the assistant summons only when useful.
// Discriminated union on `type`. Every card carries a stable `id` for keyed
// mount/unmount animation.
// ============================================================================

export interface CardBase {
  id: string
  /** Small mono eyebrow label, e.g. "TASK · PRAVKO BLOG PIPELINE". */
  title?: string
  /** Optional right-aligned status word in the header, e.g. "RUNNING". */
  badge?: string
}

/** Prose / TL;DR answer block. */
export interface TextCard extends CardBase {
  type: "text"
  body: string
  /** Optional one-line distilled takeaway shown above the body. */
  tldr?: string
}

/** A single hero metric with optional delta. */
export interface StatCard extends CardBase {
  type: "stat"
  value: string
  label: string
  delta?: { dir: "up" | "down" | "flat"; value: string }
}

/** Bulleted / checklist list. */
export interface ListCard extends CardBase {
  type: "list"
  ordered?: boolean
  items: Array<{ text: string; done?: boolean }>
}

/** Single image with optional caption. */
export interface ImageCard extends CardBase {
  type: "image"
  src: string
  alt?: string
  caption?: string
}

/** A small gallery grid. */
export interface ImageGridCard extends CardBase {
  type: "image-grid"
  images: Array<{ src: string; alt?: string }>
}

/** Progress / status of a single job. */
export interface StatusCard extends CardBase {
  type: "status"
  label: string
  /** 0..1 */
  progress: number
  state: "queued" | "running" | "done" | "error"
  chips?: string[]
}

/** A live roll-up of sub-agents working in parallel. */
export interface AgentActivityCard extends CardBase {
  type: "agent-activity"
  agents: AgentActivity[]
}

/** External reference link. */
export interface LinkCard extends CardBase {
  type: "link"
  url: string
  label: string
  source?: string
}

export type Card =
  | TextCard
  | StatCard
  | ListCard
  | ImageCard
  | ImageGridCard
  | StatusCard
  | AgentActivityCard
  | LinkCard

export type CardType = Card["type"]

// ============================================================================
// Parallel-task tracker — multiple concurrent jobs the COO is running.
// ============================================================================

export type JobStatus = "queued" | "running" | "done" | "error"

export interface AgentActivity {
  id: string
  name: string
  role: string
  status: JobStatus
  detail?: string
  /** 0..1 */
  progress?: number
}

export interface TrackerTask {
  id: string
  title: string
  /** Who owns it, e.g. "pravko-lead". */
  owner: string
  status: JobStatus
  /** 0..1 */
  progress?: number
  /** Short result line shown when done. */
  result?: string
}
