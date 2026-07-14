export interface RestartEntryOptions {
  port: number;
  takePort: boolean;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export function buildRestartEntryArgv(
  entryScript: string,
  options: { port: number; takePort?: boolean },
): string[] {
  if (!validPort(options.port)) throw new Error(`invalid restart-entry port: ${String(options.port)}`);
  const argv = [entryScript, "--port", String(options.port)];
  if (options.takePort) argv.push("--take-port");
  return argv;
}

export function restartEntryOptionsFromArgv(argv: readonly string[] = process.argv): RestartEntryOptions {
  const args = argv.slice(2);
  const portIndex = args.indexOf("--port");
  if (portIndex < 0 || portIndex === args.length - 1) throw new Error("restart-entry requires an explicit --port");
  const rawPort = args[portIndex + 1];
  if (!/^\d+$/.test(rawPort)) throw new Error(`invalid restart-entry port: ${rawPort}`);
  const port = Number(rawPort);
  if (!validPort(port)) throw new Error(`invalid restart-entry port: ${rawPort}`);
  return { port, takePort: args.includes("--take-port") };
}

export function restartEntryTakePortFromArgv(argv: readonly string[] = process.argv): boolean {
  return restartEntryOptionsFromArgv(argv).takePort;
}
