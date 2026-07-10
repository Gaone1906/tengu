export function restartEntryTakePortFromArgv(argv: readonly string[] = process.argv): boolean {
  return argv.slice(2).includes("--take-port");
}
