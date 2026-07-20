import fs from "node:fs";
import path from "node:path";
import { createInstance } from "../instances/create.js";
import { loadInstances } from "./instances.js";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function instanceHomeIsPopulated(home: string): boolean {
  return fs.existsSync(path.join(home, "config.yaml"));
}

export async function runCreate(name: string, port?: number): Promise<void> {
  try {
    const current = loadInstances().find((instance) => instance.home === process.env.JINN_HOME)
      ?? loadInstances().find((instance) => instance.name === "jinn");
    const result = await createInstance({ name, port, currentPort: current?.port ?? 7777 }, {
      cliEntry: process.argv[1],
    });
    console.log(`\n${GREEN}Workspace "${result.instance.displayName ?? result.instance.name}" created and started.${RESET}`);
    console.log(`  Home: ${DIM}${result.instance.home}${RESET}`);
    console.log(`  Port: ${DIM}${result.instance.port}${RESET}`);
    if (result.instance.accessUrls?.remote) console.log(`  Remote: ${DIM}${result.instance.accessUrls.remote}${RESET}`);
    if (result.warning) console.warn(`  ${result.warning}`);
    console.log("");
  } catch (error) {
    console.error(`${RED}Error:${RESET} ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
