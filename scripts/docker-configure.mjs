// Container-only configuration, run by docker-entrypoint.sh before the gateway
// starts. Every step is wrong on a workstation and required here.
// Idempotent: safe on every boot, writes only when something changed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Mirrors resolveJinnHome() in packages/jinn/src/shared/home.ts, JINN_INSTANCE
// branch included — assuming ~/.jinn would patch a file the gateway never reads.
const home = process.env.HOME ?? os.homedir();
const jinnHome = process.env.JINN_HOME
  ? path.resolve(process.env.JINN_HOME)
  : path.join(home, `.${process.env.JINN_INSTANCE || "jinn"}`);

// pnpm links `yaml` under packages/jinn/node_modules rather than hoisting it, so
// a bare import from this directory would not resolve.
const requireFromJinn = createRequire(new URL("../packages/jinn/package.json", import.meta.url));
const YAML = requireFromJinn("yaml");

let failed = false;

function writeAtomic(file, contents) {
  const tmp = `${file}.docker-configure.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * Rebind the gateway off loopback, which inside a container binds the container's
 * own loopback so a published port resolves to nothing.
 *
 * Uses the document API like patchWorkspaceConfig() in instances/create.ts, so
 * comments and quoting survive and only gateway.host is touched.
 */
function rebindGatewayHost(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    // ENOENT is expected before `jinn setup`. Anything else (EACCES on a
    // root-owned volume) must not pass for "no config yet" — skipping the rebind
    // silently is what produces a dead dashboard with a clean boot log.
    if (err.code === "ENOENT") return;
    console.error(`docker-configure: cannot read ${configPath}: ${err.message}`);
    failed = true;
    return;
  }

  const doc = YAML.parseDocument(raw);
  if (doc.errors.length) {
    console.error(`docker-configure: ${configPath} is not valid YAML: ${doc.errors[0].message}`);
    failed = true;
    return;
  }

  const current = doc.getIn(["gateway", "host"]);
  if (current === "0.0.0.0") return;

  // A bare `host:` parses as null: absent, not a deliberate choice. Treating it as
  // one would skip the rebind and leave the published port pointing at nothing.
  const absent = current === undefined || current === null;

  // A host that is neither loopback nor absent was chosen deliberately.
  if (!absent && current !== "127.0.0.1" && current !== "localhost") {
    console.log(`docker-configure: leaving gateway.host as ${JSON.stringify(current)} (not loopback)`);
    return;
  }

  // Rebinding a config that disabled auth turns a setup that is legal on loopback
  // into one the gateway refuses to start (validateGatewayExposure in gateway/auth.ts)
  // — an endless restart loop under `restart: unless-stopped`, whose error tells the
  // operator to weaken auth to undo a change made here. Stop with the real fix instead.
  if (doc.getIn(["gateway", "authDisabled"]) === true
      && doc.getIn(["gateway", "insecureAllowUnauthenticatedNetwork"]) !== true) {
    console.error(
      `docker-configure: ${configPath} sets gateway.authDisabled: true, which cannot be combined with ` +
      `the published port this container needs. Remove gateway.authDisabled (the dashboard authenticates ` +
      `with the gateway token — run \`jinn pair\`), or set gateway.insecureAllowUnauthenticatedNetwork: true ` +
      `if the published port is only reachable from a network you trust.`,
    );
    failed = true;
    return;
  }

  doc.setIn(["gateway", "host"], "0.0.0.0");
  writeAtomic(configPath, doc.toString({ lineWidth: 0 }));
  console.log(`docker-configure: gateway.host ${absent ? "set" : "->"} 0.0.0.0`);
}

/** Mirrors claudeJsonPath() in packages/jinn/src/shared/claude-settings.ts. */
function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(path.resolve(process.env.CLAUDE_CONFIG_DIR), ".claude.json")
    : path.join(home, ".claude.json");
}

/**
 * Warn if Claude Code's config reappears outside the volume.
 *
 * CLAUDE_CONFIG_DIR works but is undocumented (anthropics/claude-code#25762 is
 * open), so if a release stops honouring it the file silently returns to a path
 * no volume covers and state is lost on the next upgrade.
 */
function checkConfigRedirect() {
  const stray = path.join(home, ".claude.json");
  if (stray === claudeJsonPath() || !fs.existsSync(stray)) return;
  console.warn(
    `docker-configure: WARNING — ${stray} exists but CLAUDE_CONFIG_DIR should keep the config at ` +
    `${claudeJsonPath()}. That path is not on a volume, so anything written there is lost on the ` +
    `next image upgrade. See anthropics/claude-code#25762.`,
  );
}

/**
 * Record Claude Code's Bypass Permissions consent.
 *
 * The engine passes --dangerously-skip-permissions on every spawn, and Claude Code
 * answers that with a blocking dialog nothing in a PTY can dismiss, so every turn
 * hangs with "no completion signal and no recoverable transcript". 2.1.170 implied
 * the consent through global onboarding and 2.1.220 does not, so seedTrust() records
 * it explicitly for every install. This runs before the gateway anyway: it is the
 * only step that rescues an unparseable .claude.json (below) before seedTrust
 * overwrites it, and it keeps the container correct if that seeding ever moves.
 */
function acceptBypassPermissions() {
  const claudeJson = claudeJsonPath();

  let data = {};
  if (fs.existsSync(claudeJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      if (parsed && typeof parsed === "object") data = parsed;
    } catch (err) {
      // Side-copy before continuing: seedTrust() runs moments later, treats a file
      // it cannot parse as new, and overwrites it — and its .jinn-backup is
      // one-time, so by the second boot that slot is already taken.
      const rescue = `${claudeJson}.corrupt`;
      let rescued = false;
      try {
        if (!fs.existsSync(rescue)) {
          fs.copyFileSync(claudeJson, rescue, fs.constants.COPYFILE_EXCL);
          rescued = true;
        }
      } catch { /* best effort */ }
      console.warn(
        `docker-configure: WARNING — ${claudeJson} does not parse (${err.message}). ` +
        (rescued ? `Copied to ${rescue}. ` : "") +
        `MCP servers and project trust it held are not recoverable automatically.`,
      );
      // Fall through with an empty object: the file is already lost, and a clean
      // rewrite is what lets the gateway boot without the dialog.
      data = {};
    }
  }

  if (data.bypassPermissionsModeAccepted === true) return;
  data.bypassPermissionsModeAccepted = true;
  fs.mkdirSync(path.dirname(claudeJson), { recursive: true });
  writeAtomic(claudeJson, `${JSON.stringify(data, null, 2)}\n`);
  console.log("docker-configure: recorded bypassPermissionsModeAccepted");
}

/**
 * Drop pids recorded by a previous container.
 *
 * gateway.json survives an ungraceful stop, and a container restarts pids from 1,
 * so the reaper would signal numbers now held by unrelated live processes. Zeroed
 * rather than deleted because writeGatewayInfo only carries `secret` forward from
 * the previous file. staleGatewayPids also checks the recorded namespace; this
 * stays so the container is safe on its own if that ever changes.
 */
function clearStaleGatewayPids() {
  const file = path.join(jinnHome, "gateway.json");
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return; // absent (graceful shutdown removes it) or unreadable
  }
  if (!info || typeof info !== "object") return;
  if (info.pid === 0 && (!info.ptyPids || info.ptyPids.length === 0)) return;
  info.pid = 0;
  info.ptyPids = [];
  writeAtomic(file, JSON.stringify(info, null, 2));
  console.log("docker-configure: cleared stale pids from gateway.json");
}

rebindGatewayHost(path.join(jinnHome, "config.yaml"));
checkConfigRedirect();
acceptBypassPermissions();
clearStaleGatewayPids();

if (failed) process.exit(1);
