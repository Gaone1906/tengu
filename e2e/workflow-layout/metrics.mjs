export const HORIZONTAL_CLEARANCE = 96
export const VERTICAL_CLEARANCE = 64
export const MOBILE_READABLE_ZOOM = 0.75
export const DESKTOP_READABLE_ZOOM = 0.65

export function assertCandidateBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error("candidate URL must be an absolute URL") }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("candidate URL must use the exact http://127.0.0.1 loopback origin")
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 7800) throw new Error("candidate port must be 7800 or higher")
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("candidate URL must be an origin without path, query, or hash")
  return url.origin
}

export function matrixCells() {
  const viewports = [
    { key: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
    { key: "mobile", width: 390, height: 844, deviceScaleFactor: 2 },
  ]
  return viewports.flatMap((viewport) => ["dark", "light"].flatMap((theme) =>
    ["normal", "reduced"].map((motion) => ({ viewport, theme, motion }))))
}

export function unionRects(rects) {
  if (!rects.length) return null
  const x = Math.min(...rects.map((rect) => rect.x))
  const y = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return { x, y, right, bottom, width: right - x, height: bottom - y }
}

export function overlapViolations(envelopes, tolerance = 1) {
  const violations = []
  for (let i = 0; i < envelopes.length; i += 1) {
    for (let j = i + 1; j < envelopes.length; j += 1) {
      const a = envelopes[i]
      const b = envelopes[j]
      const width = Math.min(a.right, b.right) - Math.max(a.x, b.x)
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)
      if (width > tolerance && height > tolerance) violations.push({ a: a.id, b: b.id, width, height, area: width * height })
    }
  }
  return violations
}

export function strictLtrViolations(edges, boxesById, clearance = HORIZONTAL_CLEARANCE) {
  const violations = []
  for (const edge of edges) {
    if (edge.kind === "loop" || edge.lane === "sub") continue
    const source = boxesById.get(edge.from)
    const target = boxesById.get(edge.to)
    if (!source || !target) {
      violations.push({ id: edge.id, from: edge.from, to: edge.to, code: "missing-envelope", gap: null })
      continue
    }
    const gap = target.x - source.right
    if (gap < clearance) violations.push({ id: edge.id, from: edge.from, to: edge.to, code: "clearance", gap, required: clearance })
  }
  return violations
}

export function verticalClearanceViolations(envelopes, clearance = VERTICAL_CLEARANCE) {
  const violations = []
  const ranks = new Map()
  for (const envelope of envelopes) {
    const rank = envelope.rank ?? Math.round(envelope.x)
    const values = ranks.get(rank) ?? []
    values.push(envelope)
    ranks.set(rank, values)
  }
  for (const values of ranks.values()) {
    values.sort((a, b) => a.y - b.y)
    for (let i = 1; i < values.length; i += 1) {
      const upper = values[i - 1]
      const lower = values[i]
      const gap = lower.y - upper.bottom
      if (gap < clearance) violations.push({ upper: upper.id, lower: lower.id, gap, required: clearance })
    }
  }
  return violations
}

export function zoomFromTransform(transform) {
  const matrix = transform?.match(/^matrix\(([-+\d.eE]+),/)
  if (matrix) return Number(matrix[1])
  const scale = transform?.match(/scale\(([-+\d.eE]+)\)/)
  return scale ? Number(scale[1]) : 1
}

export function readabilityViolations(metrics) {
  const violations = []
  const minimum = metrics.viewport === "mobile" ? MOBILE_READABLE_ZOOM : DESKTOP_READABLE_ZOOM
  if (!Number.isFinite(metrics.zoom) || metrics.zoom < minimum) violations.push({ code: "zoom", actual: metrics.zoom, required: minimum })
  if (metrics.viewport === "mobile" && !metrics.focusNodeId) violations.push({ code: "focus" })
  if (metrics.horizontalBodyOverflow > 1) violations.push({ code: "body-overflow", actual: metrics.horizontalBodyOverflow })
  for (const id of metrics.clippedLabels ?? []) violations.push({ code: "clipped-label", id })
  return violations
}

export function summarizeMetricViolations(metrics, definition) {
  const byId = new Map(metrics.envelopes.map((box) => [box.id, box]))
  return {
    overlap: overlapViolations(metrics.envelopes),
    strictLtr: strictLtrViolations(definition.edges ?? [], byId),
    vertical: verticalClearanceViolations(metrics.envelopes.filter((box) => !box.id.includes("__dock_"))),
    readability: readabilityViolations(metrics),
  }
}
