import test from "node:test"
import assert from "node:assert/strict"

import {
  assertCandidateBaseUrl,
  matrixCells,
  unionRects,
  overlapViolations,
  strictLtrViolations,
  verticalClearanceViolations,
  zoomFromTransform,
  readabilityViolations,
} from "./metrics.mjs"

test("candidate URL is an exact loopback origin on port 7800 or higher", () => {
  assert.equal(assertCandidateBaseUrl("http://127.0.0.1:7800"), "http://127.0.0.1:7800")
  for (const bad of [
    "http://127.0.0.1:7777",
    "http://localhost:7800",
    "https://127.0.0.1:7800",
    "http://127.0.0.1:7800/workflow",
    "http://127.0.0.1:7799",
    "http://127.0.0.2:7800",
  ]) assert.throws(() => assertCandidateBaseUrl(bad), /candidate|loopback|port|origin/i)
})

test("matrix covers both viewports, themes, and motion preferences", () => {
  const cells = matrixCells()
  assert.equal(cells.length, 8)
  assert.deepEqual(new Set(cells.map((x) => x.viewport.key)), new Set(["desktop", "mobile"]))
  assert.deepEqual(new Set(cells.map((x) => x.theme)), new Set(["dark", "light"]))
  assert.deepEqual(new Set(cells.map((x) => x.motion)), new Set(["normal", "reduced"]))
  assert.deepEqual(cells.find((x) => x.viewport.key === "mobile")?.viewport, {
    key: "mobile", width: 390, height: 844, deviceScaleFactor: 2,
  })
})

test("expanded envelopes union overflowing visible descendant captions", () => {
  assert.deepEqual(unionRects([
    { x: 10, y: 20, right: 56, bottom: 66 },
    { x: 4, y: 62, right: 90, bottom: 88 },
  ]), { x: 4, y: 20, right: 90, bottom: 88, width: 86, height: 68 })
})

test("overlap metrics tolerate only one CSS pixel", () => {
  const envelopes = [
    { id: "a", x: 0, y: 0, right: 100, bottom: 100 },
    { id: "touch", x: 99.5, y: 0, right: 150, bottom: 100 },
    { id: "bad", x: 98, y: 20, right: 160, bottom: 80 },
  ]
  assert.deepEqual(overlapViolations(envelopes, 1).map((x) => [x.a, x.b]), [["a", "bad"], ["touch", "bad"]])
})

test("strict LTR excludes loop and dock edges but enforces 96 flow pixels", () => {
  const boxes = new Map([
    ["a", { id: "a", x: 0, y: 0, right: 100, bottom: 80 }],
    ["b", { id: "b", x: 195, y: 0, right: 295, bottom: 80 }],
    ["c", { id: "c", x: 196, y: 120, right: 296, bottom: 200 }],
  ])
  const edges = [
    { id: "crowded", from: "a", to: "b" },
    { id: "clear", from: "a", to: "c" },
    { id: "retry", from: "c", to: "a", kind: "loop" },
    { id: "dock", from: "a", to: "c", lane: "sub" },
  ]
  assert.deepEqual(strictLtrViolations(edges, boxes, 96).map((x) => x.id), ["crowded"])
})

test("same-rank vertical envelopes reserve 64 flow pixels", () => {
  const boxes = [
    { id: "a", rank: 1, x: 200, y: 0, right: 300, bottom: 80 },
    { id: "b", rank: 1, x: 200, y: 143, right: 300, bottom: 223 },
    { id: "c", rank: 1, x: 200, y: 144, right: 300, bottom: 224 },
    { id: "other", rank: 2, x: 500, y: 0, right: 600, bottom: 80 },
  ]
  assert.deepEqual(verticalClearanceViolations(boxes.slice(0, 2), 64).map((x) => x.gap), [63])
  assert.deepEqual(verticalClearanceViolations([boxes[0], boxes[2], boxes[3]], 64), [])
})

test("zoom and readability distinguish desktop fit from mobile focus", () => {
  assert.equal(zoomFromTransform("matrix(0.8, 0, 0, 0.8, 12, 20)"), 0.8)
  assert.equal(zoomFromTransform("translate(10px, 20px) scale(0.9)"), 0.9)
  assert.deepEqual(readabilityViolations({
    viewport: "mobile", zoom: 0.74, focusNodeId: null, horizontalBodyOverflow: 2,
    clippedLabels: ["step"], canvasScrollTop: 10,
  }).map((x) => x.code), ["zoom", "focus", "body-overflow", "clipped-label"])
  assert.deepEqual(readabilityViolations({
    viewport: "desktop", zoom: 0.65, focusNodeId: "step", horizontalBodyOverflow: 0,
    clippedLabels: [], canvasScrollTop: 0,
  }), [])
})
