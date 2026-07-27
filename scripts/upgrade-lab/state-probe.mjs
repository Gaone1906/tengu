#!/usr/bin/env node
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [mode, packageRoot, evidenceRoot] = process.argv.slice(2)
if (!new Set(["seed-old", "query-old", "query-candidate"]).has(mode) || !packageRoot || !evidenceRoot) {
  throw new Error("usage: state-probe.mjs <seed-old|query-old|query-candidate> <package-root> <evidence-root>")
}

const load = (relative) => import(pathToFileURL(path.join(packageRoot, "dist", "src", relative)).href)
const sessionKey = "upgrade-lab:representative-session"
const todoSourceRef = "upgrade-lab:representative-todo"
const workflowId = "upgrade-lab-workflow"
const cronId = "upgrade-lab-cron"
const employeeName = "lab-operator"
const workflowTitle = "Upgrade lab representative workflow"
const legacyDefinitionFile = path.join(evidenceRoot, "workflows", `${workflowId}.definition.json`)
const legacyDefinitionStore = path.join(packageRoot, "dist", "src", "workflows", "definition-store.js")
const usesLegacyWorkflowStore = fs.existsSync(legacyDefinitionStore)
const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

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
  const todos = await load("work-items/store.js")
  if (!todos.getWorkItemBySourceRef("session", todoSourceRef)) {
    todos.createWorkItem({
      title: "Upgrade lab representative Todo",
      body: "Disposable representative state.",
      status: "backlog",
      source: "session",
      sourceRef: todoSourceRef,
    })
  }
  if (usesLegacyWorkflowStore) {
    const workflows = await load("workflows/definition-store.js")
    if (!workflows.getDefinition(evidenceRoot, workflowId)) {
      workflows.createDefinition(evidenceRoot, {
        schemaVersion: 1,
        id: workflowId,
        name: workflowId,
        title: workflowTitle,
        version: 1,
        status: "active",
        nodes: [
          { id: "trigger", type: "trigger", label: "Manual", position: { x: 0, y: 0 }, trigger: { kind: "manual" } },
          { id: "step", type: "step", label: "Step", position: { x: 0, y: 140 }, actor: { kind: "engine", ref: "codex" } },
        ],
        edges: [{ id: "edge", from: "trigger", to: "step", kind: "sequence" }],
      })
    }
  } else {
    const workflows = await load("workflows/repository.js")
    const migrations = await load("workflows/repository-migrations.js")
    const database = migrations.openWorkflowDatabase()
    try {
      const repository = new workflows.WorkflowRepository(database)
      if (!repository.getDefinition(workflowId)) repository.createDefinition({ id: workflowId, title: workflowTitle })
    } finally {
      database.close()
    }
  }
}

async function snapshot() {
  sessions.initDb()
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
  if ((mode === "seed-old" || mode === "query-old") && usesLegacyWorkflowStore) {
    const workflows = await load("workflows/definition-store.js")
    const definitions = workflows.listDefinitions(evidenceRoot).filter((definition) => definition.id === workflowId)
    result.workflow = definitions.length === 1 ? {
      count: 1,
      id: definitions[0].id,
      title: definitions[0].title,
      status: definitions[0].status,
      sourceSha256: sha256File(legacyDefinitionFile),
    } : { count: definitions.length }
  } else {
    const workflows = await load("workflows/repository-migrations.js")
    const database = workflows.openWorkflowDatabase()
    try {
      const row = database.prepare("SELECT id, title, revision, enabled FROM workflow_definitions WHERE id = ?").get(workflowId)
      const reportPath = path.join(path.dirname(evidenceRoot), "workflows", "legacy-v1-import-report.json")
      const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null
      const imported = report?.definitions?.find((entry) => entry.id === workflowId)
      const legacySourcePreserved = fs.existsSync(legacyDefinitionFile)
      result.workflow = !row ? { count: 0 } : legacySourcePreserved ? {
          count: 1,
          id: row.id,
          title: row.title,
          enabled: Boolean(row.enabled),
          sourceSha256: sha256File(legacyDefinitionFile),
          legacySourcePreserved,
          importOutcome: imported?.outcome ?? null,
        } : {
          count: 1,
          id: row.id,
          title: row.title,
          revision: row.revision,
          enabled: Boolean(row.enabled),
          storage: "v2",
        }
    } finally {
      database.close()
    }
  }
  return result
}

process.stdout.write(`${JSON.stringify(await snapshot())}\n`)
