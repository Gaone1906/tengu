import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const workflowPaths = [
  "tools/workflows/jinn-simplify.json",
  "tools/workflows/jinn-pr-review.json",
]

function parseWorkflow(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(relativePath), "utf8"))
}

function assertCanonicalShape(definition) {
  assert.equal(definition.schemaVersion, 1)
  assert.equal(typeof definition.id, "string")
  assert.equal(typeof definition.title, "string")
  assert.equal(typeof definition.revision, "number")
  assert.equal(typeof definition.enabled, "boolean")
  assert.equal(typeof definition.createdAt, "string")
  assert.equal(typeof definition.updatedAt, "string")
  assert.ok(Array.isArray(definition.nodes))
  assert.ok(Array.isArray(definition.edges))
  assert.equal(typeof definition.ui?.positions, "object")
}

function reaches(adjacency, fromId, toId) {
  const pending = [fromId]
  const visited = new Set()
  while (pending.length > 0) {
    const nodeId = pending.pop()
    if (nodeId === toId) return true
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    pending.push(...(adjacency.get(nodeId) ?? []))
  }
  return false
}

function assertWorkflowIntegrity(definition) {
  assertCanonicalShape(definition)

  const nodesById = new Map()
  for (const node of definition.nodes) {
    assert.equal(nodesById.has(node.id), false, `duplicate node id ${node.id}`)
    nodesById.set(node.id, node)
    assert.deepEqual(Object.keys(definition.ui.positions[node.id] ?? {}).sort(), ["x", "y"])
  }

  const adjacency = new Map(definition.nodes.map(({ id }) => [id, []]))
  for (const edge of definition.edges) {
    assert.ok(nodesById.has(edge.from.nodeId), `edge ${edge.id} source missing node ${edge.from.nodeId}`)
    assert.ok(nodesById.has(edge.to.nodeId), `edge ${edge.id} target missing node ${edge.to.nodeId}`)
    adjacency.get(edge.from.nodeId).push(edge.to.nodeId)
  }

  const referencePattern = /\{\{\s*node\.([a-z][a-z0-9_-]*)\.fields\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g
  for (const node of definition.nodes) {
    if (node.type !== "employee") continue
    for (const match of node.config.prompt.matchAll(referencePattern)) {
      const [, referencedNodeId, field] = match
      const referencedNode = nodesById.get(referencedNodeId)
      assert.ok(referencedNode, `${node.id} references missing node ${referencedNodeId}`)
      assert.ok(
        Object.hasOwn(referencedNode.config?.output?.fields ?? {}, field),
        `${node.id} references undeclared field ${referencedNodeId}.${field}`,
      )
      assert.ok(reaches(adjacency, referencedNodeId, node.id), `${referencedNodeId} does not precede ${node.id}`)
    }
  }
}

test("authored workflow definitions have canonical shape and valid references", () => {
  for (const workflowPath of workflowPaths) assertWorkflowIntegrity(parseWorkflow(workflowPath))
})

test("workflow integrity rejects a dangling edge", () => {
  const definition = parseWorkflow(workflowPaths[0])
  definition.edges.push({
    id: "dangling",
    from: { nodeId: definition.nodes[0].id, port: "success" },
    to: { nodeId: "missing", port: "input" },
  })

  assert.throws(() => assertWorkflowIntegrity(definition), /edge dangling target missing node missing/)
})

test("jinn-simplify encodes the remote base, budget, queue, and CI contracts", () => {
  const definition = parseWorkflow(workflowPaths[0])
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const constrain = nodes.get("constrain")
  assert.match(constrain.config.prompt, /git fetch origin/)
  assert.match(constrain.config.prompt, /git rev-parse origin\/main/)
  assert.match(constrain.config.output.fields.baseHead.description, /origin\/main/)

  for (const nodeId of ["implement-1", "implement-2"]) {
    assert.ok(Object.hasOwn(nodes.get(nodeId).config.output.fields, "budgetClaim"))
  }
  for (const nodeId of ["verify-1", "verify-2"]) {
    const node = nodes.get(nodeId)
    assert.ok(Object.hasOwn(node.config.output.fields, "budgetVerdict"))
    assert.match(node.config.prompt, /independently reproduce/)
    assert.match(node.config.prompt, /Never return `ship` with `budgetVerdict: breach`/)
    assert.doesNotMatch(node.config.prompt, /a budget breach is never a note or Minor/)
  }

  const survey = nodes.get("survey")
  assert.match(survey.config.prompt, /queue ceiling is 5/)
  assert.match(survey.config.prompt, /count is 5 or greater, decline immediately/)

  const deliver = nodes.get("deliver")
  assert.ok(Object.hasOwn(deliver.config.output.fields, "checksStatus"))
  assert.match(deliver.config.prompt, /wait for the complete CI result/)
  assert.match(deliver.config.prompt, /re-run each red job once and only once/)
  assert.match(deliver.config.prompt, /leave or convert the PR to draft/)
  assert.match(deliver.config.prompt, /Todo to `escalated`/)
})

test("jinn-pr-review keeps independent findings separate from bounded adjudication", () => {
  const definition = parseWorkflow(workflowPaths[1])
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const reviews = definition.nodes.filter((node) => node.type === "employee" && /^review-(opus|sol)$/.test(node.id))
  assert.equal(reviews.length, 2)
  assert.deepEqual(
    reviews.map((node) => [node.config.engine.value, node.config.model.value]).sort(),
    [["claude", "opus"], ["codex", "gpt-5.6-sol"]],
  )
  for (const review of reviews) {
    assert.match(review.config.prompt, /INDEPENDENT REVIEW/)
    assert.equal(Object.hasOwn(review.config.output.fields, "verdict"), false)
  }

  const verdictNodes = definition.nodes.filter((node) => Object.hasOwn(node.config?.output?.fields ?? {}, "verdict"))
  assert.deepEqual(verdictNodes.map(({ id }) => id), ["adjudicate"])
  const route = nodes.get("verdict-route")
  const routePorts = [...route.config.cases.map(({ port }) => port), route.config.defaultPort].sort()
  assert.deepEqual(routePorts, ["fix", "merge", "reject"])
  assert.deepEqual(
    definition.edges.filter((edge) => edge.from.nodeId === route.id).map((edge) => edge.from.port).sort(),
    ["fix", "merge", "reject"],
  )

  const adjudicate = nodes.get("adjudicate")
  for (const phrase of [
    "Majors never block a merge",
    "requires independent reproduction",
    "speculative inputs no caller produces",
    "performance with no measured budget",
    "more abstract or configurable",
    "coverage beyond changed lines",
    "style preference",
    "this might be needed later",
    "More than three surviving Blockers",
    "$15",
    "1 hour",
    "1 revert",
  ]) assert.match(adjudicate.config.prompt, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

  const select = nodes.get("select")
  assert.match(select.config.prompt, /ahead and not behind/)
  assert.match(select.config.prompt, /Never force-push/)
  assert.match(select.config.prompt, /Never create a merge commit on `main`/)

  const fix = nodes.get("fix-pr")
  assert.match(fix.config.prompt, /comment on the PR/)
  assert.match(fix.config.prompt, /comment on the originating Todo/)
  assert.match(fix.config.prompt, /status `executing`/)
})
