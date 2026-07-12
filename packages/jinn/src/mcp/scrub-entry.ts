#!/usr/bin/env node
/**
 * GRS-018 hardening (§3a) — env-scrub launcher for third-party MCP servers.
 *
 * Invoked as: node scrub-entry.js <realCommand> [realArgs...]
 *
 * Deletes JINN_GATEWAY_TOKEN from this process's environment, then execs the
 * real MCP server command with the scrubbed env, wiring stdio straight through
 * so the JSON-RPC stream is untouched. The child third-party server therefore
 * never sees the gateway bearer token (which the vendor CLI would otherwise
 * forward via full-env inheritance). The non-secret JINN_GATEWAY_URL is left in
 * place. This launcher is jinn's own trusted code; only the wrapped child is
 * the untrusted third-party process.
 *
 * Faithful transparency: forwards terminating signals to the child, propagates
 * the child's exit code, and re-raises the child's terminating signal on itself
 * so the vendor CLI's process supervision sees the true cause of death.
 */
import { spawn } from "node:child_process";
import { createMcpTempSandbox } from "./temp-sandbox.js";

const [realCommand, ...realArgs] = process.argv.slice(2);

if (!realCommand) {
  process.stderr.write("scrub-entry: no command to launch\n");
  process.exit(2);
}

// First security boundary: strip the gateway bearer before the untrusted child runs.
delete process.env.JINN_GATEWAY_TOKEN;

// External MCPs also get a launcher-owned temp root. Browser drivers can leak
// launch artifacts when setup fails before their cleanup hook is registered;
// containing them here makes their lifetime no longer than the MCP process.
const tempSandbox = createMcpTempSandbox(process.env);
process.on("exit", tempSandbox.cleanup);

const child = spawn(realCommand, realArgs, { stdio: "inherit", env: tempSandbox.env });

const FORWARD_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
for (const sig of FORWARD_SIGNALS) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* child already gone */ }
  });
}

child.on("error", (err) => {
  process.stderr.write(`scrub-entry: failed to launch ${realCommand}: ${err.message}\n`);
  tempSandbox.cleanup();
  process.exit(127);
});

child.on("exit", (code, signal) => {
  tempSandbox.cleanup();
  if (signal) {
    // Re-raise the child's terminating signal on ourselves so the parent sees
    // the true cause (matches `exec`-style transparency). Remove our own
    // forwarding handler first so the signal restores its DEFAULT disposition
    // (terminate) instead of just re-invoking the now-dead-child forwarder.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
