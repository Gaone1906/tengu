import { describe, expect, it } from "vitest";
import { startupGatewayPids } from "../gateway-info.js";

describe("gateway startup PID policy", () => {
  const recorded = { pid: 41, ptyPids: [42, 43] };

  it("never treats old runtime PIDs as signalable during container startup", () => {
    expect(startupGatewayPids(recorded, 99, { JINN_CONTAINER: "1" })).toEqual([]);
  });

  it("retains current-main stale PID selection for host startup", () => {
    expect(startupGatewayPids(recorded, 42, {})).toEqual([43, 41]);
  });
});
