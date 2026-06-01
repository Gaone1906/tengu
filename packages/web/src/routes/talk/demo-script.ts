/**
 * Jinn Talk — scripted demo driver (Concept AURA).
 *
 * A mocked voice loop that walks idle → listening → thinking → speaking, spawns
 * example "Lego-block" content cards, and drives the parallel-task tracker
 * through queued → running → done. NO real gateway / STT / TTS wiring here —
 * this is the visual proof of concept. `speak()` is provided by the page (Web
 * Speech API today) so the reply is actually voiced where supported.
 */
import type { AvatarState, Card, TrackerTask } from "./types"
import type { TranscriptEntry } from "./transcript"

export interface DemoControls {
  setState: (s: AvatarState) => void
  setEntries: (e: TranscriptEntry[]) => void
  setCards: (c: Card[]) => void
  setTasks: (t: TrackerTask[]) => void
  speak: (text: string) => Promise<void>
}

const USER_QUESTION = "What's running across the org right now?"
const ASSISTANT_REPLY =
  "Three jobs are in flight. Pravko's blog pipeline is mid-draft, the ventures scout just wrapped its cycle, and Movekit support has one ticket waiting on your approval."

/** Tracker snapshots, advanced over the course of the reply. */
const TASKS_THINKING: TrackerTask[] = [
  { id: "t-pravko", title: "Pravko blog pipeline", owner: "pravko-lead", status: "running", progress: 0.34 },
  { id: "t-ventures", title: "Ventures niche scout", owner: "ventures-lead", status: "running", progress: 0.72 },
  { id: "t-movekit", title: "Movekit support triage", owner: "movekit-lead", status: "queued" },
]

const TASKS_MID: TrackerTask[] = [
  { id: "t-pravko", title: "Pravko blog pipeline", owner: "pravko-lead", status: "running", progress: 0.61 },
  { id: "t-ventures", title: "Ventures niche scout", owner: "ventures-lead", status: "done", progress: 1, result: "4 niches scored · 1 flagged promising" },
  { id: "t-movekit", title: "Movekit support triage", owner: "movekit-lead", status: "running", progress: 0.25 },
]

const TASKS_FINAL: TrackerTask[] = [
  { id: "t-pravko", title: "Pravko blog pipeline", owner: "pravko-lead", status: "running", progress: 0.86 },
  { id: "t-ventures", title: "Ventures niche scout", owner: "ventures-lead", status: "done", progress: 1, result: "4 niches scored · 1 flagged promising" },
  { id: "t-movekit", title: "Movekit support triage", owner: "movekit-lead", status: "done", progress: 1, result: "Draft ready — awaiting your ✅" },
]

/** Cards the assistant composes while speaking. */
const DEMO_CARDS: Card[] = [
  {
    id: "c-agents",
    type: "agent-activity",
    title: "ORG · LIVE AGENTS",
    badge: "3 ACTIVE",
    agents: [
      { id: "a1", name: "pravko-lead", role: "blog pipeline", status: "running", detail: "phase 2/3 · drafting", progress: 0.86 },
      { id: "a2", name: "ventures-lead", role: "niche scout", status: "done", detail: "cycle complete" },
      { id: "a3", name: "movekit-lead", role: "support triage", status: "done", detail: "1 draft awaiting ✅" },
    ],
  },
  {
    id: "c-stat",
    type: "stat",
    title: "PRAVKO · THIS WEEK",
    value: "12",
    label: "keywords tracked",
    delta: { dir: "up", value: "+3" },
  },
  {
    id: "c-next",
    type: "list",
    title: "NEXT UP",
    badge: "QUEUE",
    items: [
      { text: "Publish Pravko draft — tomorrow 09:00", done: false },
      { text: "Approve Movekit support reply", done: false },
      { text: "Review ventures niche shortlist", done: false },
    ],
  },
]

type Cancelled = { current: boolean }

/**
 * Run the scripted conversation. Returns a cancel function that stops all
 * pending steps and resets to idle.
 */
export function runDemo(c: DemoControls): () => void {
  const timers: ReturnType<typeof setTimeout>[] = []
  const cancelled: Cancelled = { current: false }
  const at = (ms: number, fn: () => void) => {
    timers.push(setTimeout(() => { if (!cancelled.current) fn() }, ms))
  }

  // Reset.
  c.setCards([])
  c.setEntries([])
  c.setTasks([])
  c.setState("idle")

  // 1) Listening — the user speaks.
  at(250, () => {
    c.setState("listening")
    c.setEntries([{ id: "u1", role: "user", text: USER_QUESTION }])
  })

  // 2) Thinking — dispatch to the org, tracker lights up.
  at(2400, () => {
    c.setState("thinking")
    c.setTasks(TASKS_THINKING)
  })

  // 3) Speaking — voiced reply + composed cards.
  at(4300, () => {
    c.setState("speaking")
    c.setEntries([
      { id: "u1", role: "user", text: USER_QUESTION },
      { id: "a1", role: "assistant", text: ASSISTANT_REPLY },
    ])
    // Voice it (Web Speech where available). When the speech ends, settle.
    c.speak(ASSISTANT_REPLY)
      .then(() => { if (!cancelled.current) c.setState("idle") })
      .catch(() => {})
  })
  at(4800, () => c.setCards(DEMO_CARDS))
  at(5600, () => c.setTasks(TASKS_MID))
  at(8200, () => c.setTasks(TASKS_FINAL))

  // 4) Safety net: settle to idle even if speech never reports completion.
  at(15000, () => c.setState("idle"))

  return () => {
    cancelled.current = true
    timers.forEach(clearTimeout)
  }
}
