import fs from "node:fs";
import readline from "node:readline";
import { loadInstances, saveInstances } from "./instances.js";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runNuke(name?: string): Promise<void> {
  const instances = loadInstances().filter((i) => i.name !== "jinn");

  if (instances.length === 0) {
    console.log("No removable instances found. The default \"jinn\" instance cannot be nuked.");
    return;
  }

  // If no name provided, show list and let user pick
  if (!name) {
    console.log("\nAvailable instances:\n");
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const homeDisplay = inst.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");
      console.log(`  ${DIM}${i + 1}.${RESET} ${inst.name} ${DIM}(${homeDisplay})${RESET}`);
    }
    console.log("");

    const choice = await ask("Select instance to nuke (number or name): ");

    // Try as number first
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= instances.length) {
      name = instances[num - 1].name;
    } else {
      name = choice;
    }
  }

  if (name === "jinn") {
    console.error(`${RED}Error:${RESET} Cannot nuke the default "jinn" instance.`);
    process.exit(1);
  }

  const allInstances = loadInstances();
  const index = allInstances.findIndex((i) => i.name === name);

  if (index === -1) {
    console.error(`${RED}Error:${RESET} Instance "${name}" not found.`);
    process.exit(1);
  }

  const instance = allInstances[index];
  const homeDisplay = instance.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");

  // Check if running and stop it
  const pidFile = `${instance.home}/gateway.pid`;
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, 0);
      console.log(`\n${YELLOW}Instance "${name}" is running. Stopping it first...${RESET}`);
      process.kill(pid, "SIGTERM");
      // Wait briefly for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log(`  Stopped.`);
    } catch {
      // Process not alive, continue
    }
  }

  // Show warning
  console.log(`\n${RED}${BOLD}⚠  WARNING: THIS ACTION CANNOT BE UNDONE${RESET}\n`);
  console.log(`  This will permanently delete:`);
  console.log(`    • Instance "${name}" from the registry`);
  console.log(`    • All data in ${DIM}${homeDisplay}${RESET}`);
  console.log(`      ${DIM}(config, sessions, skills, org, logs — everything)${RESET}\n`);

  const confirmation = await ask(`Type "${BOLD}${name}${RESET}" to confirm: `);

  if (confirmation !== name) {
    console.log("\nAborted. Nothing was deleted.");
    return;
  }

  // Remove from registry
  allInstances.splice(index, 1);
  saveInstances(allInstances);

  // Delete home directory
  if (fs.existsSync(instance.home)) {
    fs.rmSync(instance.home, { recursive: true, force: true });
  }

  console.log(`\n${RED}Instance "${name}" has been nuked.${RESET} ${DIM}${homeDisplay}${RESET} deleted.`);
}
