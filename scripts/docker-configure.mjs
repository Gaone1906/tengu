// Container-only configuration, run by docker-entrypoint.sh immediately before the
// gateway starts — and ONLY then: every step rewrites state a running gateway owns
// (gateway.json, gateway.pid, .claude.json). Idempotent, writes only on change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Through the package's declared `main`, not dist/src/** directly: that tree is
// scripts/build.mjs output whose shape the package never promised, so a relative import
// into it breaks at container boot and nowhere else.
const packageJsonUrl = new URL("../packages/jinn/package.json", import.meta.url);

let loadConfig;
let resolveJinnHome;
let claudeJsonPath;
let isLoopbackHost;
try {
  const pkg = JSON.parse(fs.readFileSync(packageJsonUrl, "utf-8"));
  if (!pkg.main) throw new Error("packages/jinn/package.json declares no \"main\"");
  ({ loadConfig, resolveJinnHome, claudeJsonPath, isLoopbackHost } = await import(
    new URL(pkg.main, packageJsonUrl).href
  ));
} catch (err) {
  console.error(`docker-configure: cannot load the jinn package entry point (${err.message})`);
  process.exit(1);
}

const homeDir = os.homedir();
const jinnHome = resolveJinnHome();

let failed = false;

/** Where the resolved bind address is left for docker-entrypoint.sh to export as
 *  JINN_HOST. A bare value, read — never sourced. Not config.yaml: that sits on a volume
 *  outliving the container, and "bind every interface" is true only in here. Reaches the
 *  gateway's process tree, not a later `docker exec` session. */
const BIND_HOST_FILE = path.join(jinnHome, "container-bind-host");

function writeAtomic(file, contents, mode = 0o600) {
  const tmp = `${file}.docker-configure.tmp`;
  fs.writeFileSync(tmp, contents, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

/** Copy `file` to the first free slot: `base`, then `base.1`, `base.2`, … A fixed name
 *  is a one-shot: the second incident finds it taken, skips the copy, and the caller
 *  overwrites the original anyway. Returns the path written, or null. */
function copyToFreeSlot(file, base, limit = 20) {
  for (let i = 0; i < limit; i++) {
    const dest = i === 0 ? base : `${base}.${i}`;
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err.code !== "EEXIST") return null;
    }
  }
  return null;
}

/**
 * Loopback as a BIND ADDRESS, which is not the question isLoopbackHost asks: that one
 * parses a Host header and strips a trailing `:<port>`, so a bare "::1" comes back as
 * ":" and reads as routable. Bracket it first, as a Host header would have.
 *
 * 127.0.0.0/8 and the IPv4-mapped form are added here rather than there because
 * widening the auth check's idea of loopback would relax authentication.
 */
function isLoopbackBindAddress(host) {
  const value = host.trim().replace(/^\[(.+)\]$/, "$1");
  // "::ffff:127.0.0.1" is loopback written as IPv6; auth.ts's isLoopbackAddress()
  // strips the prefix for the same reason.
  const bare = value.replace(/^::ffff:/i, "");
  if (/^127\./.test(bare)) return true;
  return isLoopbackHost(bare.includes(":") ? `[${bare}]` : bare);
}

/**
 * Resolve the address the gateway must bind for the published port to reach it: loopback
 * in a container is the container's own, so the port resolves to nothing under a boot log
 * that reads healthy. Decided against loadConfig(), which is what the gateway will see.
 */
function configureGatewayBinding() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Fatal, not "nothing to do": skipping the rebind silently produces a dead
    // dashboard under a clean boot log. `jinn setup` has already run by here.
    console.error(`docker-configure: cannot read the gateway config: ${err.message}`);
    failed = true;
    return;
  }

  const gateway = config.gateway ?? {};

  // Before the early returns below: every path here leaves the gateway network-visible,
  // which validateGatewayExposure refuses to serve without auth — a restart loop whose
  // error tells the operator to weaken auth. `host: 0.0.0.0` returns early, so checking
  // inside the rebind branch would miss exactly the configs that hit it.
  if (gateway.authDisabled === true && gateway.insecureAllowUnauthenticatedNetwork !== true) {
    console.error(
      `docker-configure: the gateway config sets gateway.authDisabled: true, which cannot be combined with ` +
      `the published port this container needs. Remove gateway.authDisabled (the dashboard authenticates ` +
      `with the gateway token — run \`jinn pair\`), or set gateway.insecureAllowUnauthenticatedNetwork: true ` +
      `if the published port is only reachable from a network you trust.`,
    );
    failed = true;
    return;
  }

  // A bare `host:` parses as null — absent, not a deliberate choice.
  const currentHost = typeof gateway.host === "string" ? gateway.host : undefined;
  const needsRebind = !currentHost || isLoopbackBindAddress(currentHost);

  if (!needsRebind) {
    // Chosen deliberately, and reachable as long as the mapping agrees. Clear any
    // override a previous boot left, or the change never takes effect.
    clearBindHostOverride();
    console.log(`docker-configure: leaving gateway.host as ${JSON.stringify(currentHost)} (not loopback)`);
    return;
  }

  try {
    writeAtomic(BIND_HOST_FILE, "0.0.0.0\n");
  } catch (err) {
    console.error(`docker-configure: cannot write ${BIND_HOST_FILE}: ${err.message}`);
    failed = true;
    return;
  }
  console.log(
    `docker-configure: gateway will bind 0.0.0.0 via JINN_HOST ` +
    `(config says ${currentHost ? JSON.stringify(currentHost) : "nothing"}, which the published port cannot reach)`,
  );
}

function clearBindHostOverride() {
  try {
    fs.unlinkSync(BIND_HOST_FILE);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`docker-configure: cannot remove ${BIND_HOST_FILE}: ${err.message}`);
      failed = true;
    }
  }
}

/**
 * Warn if Claude Code's config reappears outside the volume, keep a copy, restore the
 * redirect. CLAUDE_CONFIG_DIR is undocumented (anthropics/claude-code#25762), so a
 * release that stops honouring it writes to ~/.claude.json — a symlink into the volume,
 * unless the write replaced it with a real file in the container layer. Copy rather than
 * warn, because that layer does not survive the rebuild that upgrades the image; relink,
 * or every later boot copies it again until the 20 slots are gone.
 */
function checkConfigRedirect() {
  const stray = path.join(homeDir, ".claude.json");
  const target = claudeJsonPath();
  if (stray === target) return;

  let stat;
  try {
    stat = fs.lstatSync(stray);
  } catch {
    return; // absent: the redirect is holding
  }
  if (stat.isSymbolicLink()) {
    // The image's link into the volume: writes through it are already persistent.
    let linked;
    try {
      linked = path.resolve(homeDir, fs.readlinkSync(stray));
    } catch { /* unreadable link */ }
    if (linked === target) return;
    console.warn(
      `docker-configure: WARNING — ${stray} links to ${linked ?? "an unreadable target"} rather than ` +
      `${target}, so a config written there if CLAUDE_CONFIG_DIR ever stops working would not be on a volume.`,
    );
    return;
  }

  const saved = copyToFreeSlot(stray, `${target}.stray`);
  // Only ever replace the file once its contents are safely on the volume.
  const relinked = saved !== null && restoreConfigLink(stray, target);
  console.warn(
    `docker-configure: WARNING — ${stray} is a real file, so CLAUDE_CONFIG_DIR is no longer keeping ` +
    `Claude Code's config at ${target}. That path is in the container layer, which is discarded by the ` +
    `next \`docker compose up -d --build\`. ` +
    (saved
      ? `Copied to ${saved} on the volume; merge what you need back into ${target}. `
      : `It could NOT be copied onto the volume, so the next upgrade loses it. `) +
    (relinked
      ? `The symlink into the volume has been restored. `
      : `The symlink into the volume could NOT be restored, so this will recur on the next boot. `) +
    `See anthropics/claude-code#25762.`,
  );
}

function restoreConfigLink(stray, target) {
  try {
    fs.unlinkSync(stray);
    fs.symlinkSync(target, stray);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record Claude Code's Bypass Permissions consent, which the engine's
 * --dangerously-skip-permissions otherwise answers with a dialog no PTY can dismiss.
 * seedTrust() does this too; kept here because it is the only step that rescues an
 * unparseable .claude.json before seedTrust overwrites it.
 */
function acceptBypassPermissions() {
  const claudeJson = claudeJsonPath();

  let data = {};
  if (fs.existsSync(claudeJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      if (parsed && typeof parsed === "object") data = parsed;
    } catch (err) {
      // Side-copy first: seedTrust() runs moments later and overwrites what it cannot
      // parse, and its one-time .jinn-backup slot is taken by the second boot.
      const rescue = copyToFreeSlot(claudeJson, `${claudeJson}.corrupt`);
      console.warn(
        `docker-configure: WARNING — ${claudeJson} does not parse (${err.message}). ` +
        (rescue
          ? `Copied to ${rescue}. `
          : `It could NOT be copied aside, so this copy of it is gone. `) +
        `MCP servers and project trust it held are not recoverable automatically.`,
      );
      // The file is lost either way; a clean rewrite at least clears the dialog.
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
 * Drop the pid state a previous container left on the volume. Nothing of ours runs yet,
 * and a container restarts pids from 1, so every recorded number now names an unrelated
 * live process — one that answers kill(pid, 0), making `jinn start` hand the restart to a
 * detached helper and return, which exits PID 1 into a restart loop that never serves.
 *
 * gateway.json is zeroed rather than deleted so its secret and bearer credential survive;
 * only process identifiers are invalid across the container boundary.
 */
function clearStalePidState() {
  const pidFile = path.join(jinnHome, "gateway.pid");
  try {
    fs.unlinkSync(pidFile);
    console.log("docker-configure: removed stale gateway.pid");
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`docker-configure: cannot remove ${pidFile}: ${err.message}`);
      failed = true;
    }
  }

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

/**
 * Run one step, turning an unexpected throw into an explanation — an EACCES on a
 * bind-mounted `.claude` otherwise loops the container forever on a raw stack trace.
 * `fatal` separates steps the gateway cannot boot without from lost diagnostics.
 */
function step(name, fn, { fatal }) {
  try {
    fn();
  } catch (err) {
    const message = `docker-configure: ${name} failed: ${err.message}`;
    if (fatal) {
      console.error(`${message} — the gateway cannot start without it.`);
      failed = true;
    } else {
      console.warn(`${message} — continuing without it.`);
    }
  }
}

step("resolving the gateway bind address", configureGatewayBinding, { fatal: true });
step("checking the Claude Code config redirect", checkConfigRedirect, { fatal: false });
step("recording the Bypass Permissions consent", acceptBypassPermissions, { fatal: true });
step("clearing stale pid state", clearStalePidState, { fatal: true });

if (failed) process.exit(1);
