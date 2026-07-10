import { afterEach, describe, expect, it } from "vitest";
import { restartEntryTakePortFromArgv } from "../restart-entry-options.js";

describe("restart-entry takeover option parsing", () => {
  const originalTakePort = process.env.JINN_TAKE_PORT;

  afterEach(() => {
    if (originalTakePort === undefined) delete process.env.JINN_TAKE_PORT;
    else process.env.JINN_TAKE_PORT = originalTakePort;
  });

  it("ignores inherited JINN_TAKE_PORT", () => {
    process.env.JINN_TAKE_PORT = "1";

    expect(restartEntryTakePortFromArgv(["node", "restart-entry.js"])).toBe(false);
  });

  it("only enables takeover from an explicit restart-entry flag", () => {
    expect(restartEntryTakePortFromArgv(["node", "restart-entry.js", "--take-port"])).toBe(true);
  });
});
