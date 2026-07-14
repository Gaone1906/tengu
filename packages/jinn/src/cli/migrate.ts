import fs from "node:fs"
import { completeInstanceMigration, stampVersionInYaml } from "../migrations/completion.js"
import { getPendingInstanceMigration } from "../migrations/service.js"
import { JINN_HOME, TEMPLATE_MIGRATIONS_DIR } from "../shared/paths.js"
import { getPackageVersion, isStrictSemver } from "../shared/version.js"
import { shouldUseMigrationNoticeColor } from "./migration-notice.js"

export { stampVersionInYaml } from "../migrations/completion.js"
export type { StampResult } from "../migrations/completion.js"

const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

export interface MigrateOptions {
  /** Deprecated compatibility flag. It prints the canonical prompt but never auto-stamps. */
  apply?: boolean
  markDone?: string | boolean
  migrationKey?: string
}

function styled(text: string, ansi: string, stream: NodeJS.WriteStream): string {
  return shouldUseMigrationNoticeColor({
    isTTY: Boolean(stream.isTTY),
    color: !("NO_COLOR" in process.env),
  }) ? `${ansi}${text}${RESET}` : text
}

function exitWith(message: string): never {
  console.error(`${styled("Error:", RED, process.stderr)} ${message}`)
  process.exit(1)
  throw new Error("unreachable")
}

export async function runMigrate(options: MigrateOptions = {}): Promise<void> {
  if (!fs.existsSync(JINN_HOME)) exitWith(`${JINN_HOME} does not exist. Run "jinn setup" first.`)
  const packageVersion = getPackageVersion()
  if (!isStrictSemver(packageVersion)) exitWith(`package version "${packageVersion}" is not a plain X.Y.Z release`)
  let pending
  try {
    pending = getPendingInstanceMigration({
      instanceHome: JINN_HOME,
      packageVersion,
      migrationsDir: TEMPLATE_MIGRATIONS_DIR,
    })
  } catch (error) {
    exitWith(error instanceof Error ? error.message : String(error))
  }

  if (options.markDone !== undefined && options.markDone !== false) {
    const target = typeof options.markDone === "string" ? options.markDone : packageVersion
    if (!isStrictSemver(target)) exitWith(`--mark-done expects a plain X.Y.Z version, got "${target}"`)
    if (!options.migrationKey) exitWith("--mark-done requires --migration-key from the canonical migration prompt")
    try {
      // Re-read the package marker immediately before the only instance write.
      const installedPackageVersion = getPackageVersion()
      completeInstanceMigration({
        instanceHome: JINN_HOME,
        installedPackageVersion,
        targetVersion: target,
        expectedMigrationKey: options.migrationKey,
        pending,
      })
    } catch (error) {
      exitWith(error instanceof Error ? error.message : String(error))
    }
    console.log(`${styled(`Marked instance as migrated to ${target}.`, GREEN, process.stdout)} ${styled("(verified receipt + snapshot)", DIM, process.stdout)}\n`)
    return
  }

  console.log(`\n${styled("Instance version:", DIM, process.stdout)} ${pending.fromVersion}`)
  console.log(`${styled("Package version:", DIM, process.stdout)}  ${pending.toVersion}\n`)
  if (!pending.required || !pending.prompt) {
    console.log(`${styled("You're up to date", GREEN, process.stdout)} — no instance migration is pending.\n`)
    return
  }
  if (options.apply) {
    console.warn(styled("--apply is deprecated and no longer launches or auto-stamps an agent.", YELLOW, process.stderr))
    console.warn(`Open the web migration handoff or give the canonical prompt below to your COO.\n`)
  }
  console.log(pending.prompt)
  console.log(`${styled("This printed the canonical prompt only. The marker remains unchanged until a verified completion receipt is present.", DIM, process.stdout)}\n`)
}

// Keep the pure helper referenced so generated declarations preserve the legacy export.
void stampVersionInYaml
