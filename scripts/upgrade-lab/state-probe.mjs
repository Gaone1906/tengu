#!/usr/bin/env node
import path from "node:path"
import { pathToFileURL } from "node:url"

const [mode, packageRoot, evidenceRoot] = process.argv.slice(2)
if (!new Set(["seed-old", "seed-candidate", "query"]).has(mode) || !packageRoot || !evidenceRoot) {
  throw new Error("usage: state-probe.mjs <seed-old|seed-candidate|query> <package-root> <evidence-root>")
}

const load = (relative) => import(pathToFileURL(path.join(packageRoot, "dist", "src", relative)).href)
const sessionKey = "upgrade-lab:representative-session"
const todoSourceRef = "upgrade-lab:representative-todo"
const workflowId = "upgrade-lab-workflow"
const cronId = "upgrade-lab-cron"
const employeeName = "lab-operator"

const sessions = await load("sessions/registry.js")
const cron = await load("cron/jobs.js")
const org = await load("gateway/org.js")

if (mode === "seed-old") {
  sessions.initDb()
  if (!sessions.getSessionBySessionKey(sessionKey)) {
    sessions.createSession({
      engine: "codex",
      source: "web",
      sourceRef: sessionKey,
      connector: "web",
      sessionKey,
      title: "Upgrade lab representative session",
      prompt: "Disposable representative state.",
    })
  }
  const others = cron.loadJobs().filter((job) => job.id !== cronId)
  cron.saveJobs([...others, {
    id: cronId,
    name: "Upgrade lab representative cron",
    enabled: false,
    schedule: "0 0 * * *",
    prompt: "fixture",
  }])
}

if (mode === "seed-candidate") {
  const todos = await load("work-items/store.js")
  const workflows = await load("workflows/definition-store.js")
  todos.createWorkItem({
    title: "Upgrade lab representative Todo",
    body: "Disposable representative state.",
    status: "backlog",
    source: "session",
    sourceRef: todoSourceRef,
  })
  if (!workflows.getDefinition(evidenceRoot, workflowId)) {
    workflows.createDefinition(evidenceRoot, {
      schemaVersion: 1,
      id: workflowId,
      name: workflowId,
      title: "Upgrade lab representative workflow",
      version: 1,
      status: "active",
      nodes: [
        { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
        { id: "step", type: "step", label: "Step", position: { x: 0, y: 140 }, actor: { kind: "engine", ref: "codex" } },
      ],
      edges: [{ id: "edge", from: "trigger", to: "step", kind: "sequence" }],
    })
  }
}

async function snapshot() {
  const session = sessions.getSessionBySessionKey(sessionKey)
  const jobs = cron.loadJobs().filter((job) => job.id === cronId)
  const employees = [...org.scanOrg().values()].filter((employee) => employee.name === employeeName)
  const result = {
    session: session ? {
      count: 1,
      id: session.id,
      sessionKey: session.sessionKey,
      title: session.title,
    } : { count: 0 },
    cron: jobs.length === 1 ? {
      count: 1,
      id: jobs[0].id,
      prompt: jobs[0].prompt,
    } : { count: jobs.length },
    org: employees.length === 1 ? {
      count: 1,
      name: employees[0].name,
      persona: employees[0].persona,
    } : { count: employees.length },
  }
  try {
    const todos = await load("work-items/store.js")
    const todo = todos.getWorkItemBySourceRef("session", todoSourceRef)
    result.todo = todo ? {
      count: 1,
      id: todo.id,
      sourceRef: todo.sourceRef,
      title: todo.title,
      status: todo.status,
    } : { count: 0 }
  } catch {
    result.todo = { count: 0 }
  }
  try {
    const workflows = await load("workflows/definition-store.js")
    const definitions = workflows.listDefinitions(evidenceRoot).filter((definition) => definition.id === workflowId)
    result.workflow = definitions.length === 1 ? {
      count: 1,
      id: definitions[0].id,
      name: definitions[0].name,
      status: definitions[0].status,
    } : { count: definitions.length }
  } catch {
    result.workflow = { count: 0 }
  }
  return result
}

process.stdout.write(`${JSON.stringify(await snapshot())}\n`)
