import { afterEach, describe, expect, it } from "vitest";
import { buildRestartEntryArgv, restartEntryOptionsFromArgv } from "../restart-entry-options.js";

describe("restart-entry takeover option parsing", () => {
  const originalTakePort = process.env.JINN_TAKE_PORT;

  afterEach(() => {
    if (originalTakePort === undefined) delete process.env.JINN_TAKE_PORT;
    else process.env.JINN_TAKE_PORT = originalTakePort;
  });

  it("ignores inherited JINN_TAKE_PORT", () => {
    process.env.JINN_TAKE_PORT = "1";

    expect(restartEntryOptionsFromArgv(["node", "restart-entry.js", "--port", "21877"])).toEqual({
      port: 21877,
      takePort: false,
    });
  });

  it("only enables takeover from an explicit restart-entry flag", () => {
    expect(restartEntryOptionsFromArgv(["node", "restart-entry.js", "--port", "21877", "--take-port"])).toEqual({
      port: 21877,
      takePort: true,
    });
  });

  it("always serializes and parses the effective runtime port", () => {
    const argv = buildRestartEntryArgv("/tmp/restart-entry.js", { port: 21877, takePort: true });

    expect(argv).toEqual(["/tmp/restart-entry.js", "--port", "21877", "--take-port"]);
    expect(restartEntryOptionsFromArgv(["node", ...argv])).toEqual({ port: 21877, takePort: true });
  });

  it.each([
    ["missing", ["node", "restart-entry.js"]],
    ["missing value", ["node", "restart-entry.js", "--port"]],
    ["non-integer", ["node", "restart-entry.js", "--port", "12.5"]],
    ["out of range", ["node", "restart-entry.js", "--port", "70000"]],
  ])("rejects a %s effective port", (_label, argv) => {
    expect(() => restartEntryOptionsFromArgv(argv)).toThrow(/port/i);
  });
});
