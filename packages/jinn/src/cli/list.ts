import { loadInstances, ensureDefaultInstance } from "./instances.js";
import { getInstanceStatus, resolveInstanceEndpoint } from "../gateway/lifecycle.js";
import path from "node:path";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function runList(): Promise<void> {
  ensureDefaultInstance();
  const instances = loadInstances();

  if (instances.length === 0) {
    console.log("No instances found. Run \"jinn setup\" to create the default instance.");
    return;
  }

  console.log("\nJinn Instances\n");
  console.log(`  ${"Name".padEnd(16)} ${"Port".padEnd(8)} ${"Status".padEnd(12)} Home`);
  console.log(`  ${"─".repeat(16)} ${"─".repeat(8)} ${"─".repeat(12)} ${"─".repeat(30)}`);

  for (const inst of instances) {
    // Not a bare kill(pid, 0): a recycled number answers for an unrelated process and
    // prints a dead instance green. Against THIS instance's endpoint, since the defaults
    // inside getInstanceStatus describe the ambient one.
    const endpoint = resolveInstanceEndpoint(inst.home, inst.port);
    const status = getInstanceStatus(
      path.join(inst.home, "gateway.pid"),
      endpoint.port,
      endpoint.host,
    ).running
      ? "running"
      : "stopped";

    const statusColor = status === "running" ? GREEN : RED;
    const homeDisplay = inst.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");
    // The resolved port, so the column cannot disagree with the status beside it.
    console.log(
      `  ${inst.name.padEnd(16)} ${String(endpoint.port).padEnd(8)} ${statusColor}${status.padEnd(12)}${RESET} ${DIM}${homeDisplay}${RESET}`
    );
  }
  console.log("");
}
