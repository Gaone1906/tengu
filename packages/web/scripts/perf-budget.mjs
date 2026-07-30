import { readFile, readdir } from "node:fs/promises"
import { gzipSync } from "node:zlib"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const assetsDir = path.join(packageRoot, "out", "assets")
const budgets = JSON.parse(await readFile(path.join(packageRoot, "perf-budgets.json"), "utf8"))
const assetNames = await readdir(assetsDir)
const failures = []

function matchAsset(pattern) {
  const [prefix, suffix] = pattern.split("*")
  const matches = assetNames.filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
  if (matches.length !== 1) {
    failures.push(`${pattern}: expected one emitted asset, found ${matches.length}`)
    return null
  }
  return matches[0]
}

console.log("Web performance budgets")
for (const [name, budget] of Object.entries(budgets.chunks)) {
  const assetName = matchAsset(budget.pattern)
  if (!assetName) continue
  const source = await readFile(path.join(assetsDir, assetName))
  const compressedBytes = gzipSync(source).byteLength
  console.log(
    `${name.padEnd(14)} ${String(compressedBytes).padStart(7)} B gzip` +
      `  (baseline ${budget.baselineGzipBytes} B, budget ${budget.budgetGzipBytes} B)`,
  )
  if (compressedBytes > budget.budgetGzipBytes) {
    failures.push(`${name}: ${compressedBytes} B gzip exceeds ${budget.budgetGzipBytes} B`)
  }
  for (const forbiddenModule of budget.forbiddenModules ?? []) {
    if (source.toString("utf8").toLowerCase().includes(forbiddenModule.toLowerCase())) {
      failures.push(`${name}: emitted chunk contains forbidden module "${forbiddenModule}"`)
    }
  }
}

const indexHtml = await readFile(path.join(packageRoot, "out", "index.html"), "utf8")
const initialAssetNames = [...indexHtml.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)]
  .map((match) => match[1])
  .filter((name, index, names) => names.indexOf(name) === index)
let initialGzipBytes = 0
for (const assetName of initialAssetNames) {
  initialGzipBytes += gzipSync(await readFile(path.join(assetsDir, assetName))).byteLength
}
console.log(
  `${"initial".padEnd(14)} ${String(initialGzipBytes).padStart(7)} B gzip` +
    `  (baseline ${budgets.initialCriticalPath.baselineGzipBytes} B,` +
    ` budget ${budgets.initialCriticalPath.budgetGzipBytes} B)`,
)
if (initialGzipBytes > budgets.initialCriticalPath.budgetGzipBytes) {
  failures.push(
    `initial critical path: ${initialGzipBytes} B gzip exceeds ` +
      `${budgets.initialCriticalPath.budgetGzipBytes} B`,
  )
}

if (failures.length > 0) {
  console.error(`\n\u001b[31mPerformance budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\u001b[0m`)
  process.exitCode = 1
} else {
  console.log("\nPerformance budget passed.")
}
