import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatPairedDevices,
  formatPairingSetupInstructions,
  pairingSetupResponse,
  requestPairedDevices,
  requestUnpairDevice,
} from "../pair.js";

describe("pair CLI helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("directs pairing-code creation to the authenticated local browser", () => {
    expect(pairingSetupResponse(7777)).toEqual({
      action: "create_pairing_code_in_browser",
      url: "http://127.0.0.1:7777/settings",
      section: "Pairing",
    });
  });

  it("prints browser pairing instructions without claiming the CLI minted a code", () => {
    const text = formatPairingSetupInstructions(pairingSetupResponse(7777));

    expect(text).toContain("http://127.0.0.1:7777/settings");
    expect(text).toContain("Settings > Pairing");
    expect(text).toContain("Create pairing code");
    expect(text).toContain("other device");
    expect(text).not.toContain("Code:");
    expect(text).not.toContain("gateway-token");
  });

  it("lists paired devices from the local gateway auth endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        devices: [
          { id: "device-1", name: "This Mac", current: true, lastSeenAt: "2026-06-24T10:00:00.000Z" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );

    const devices = await requestPairedDevices({
      port: 7777,
      host: "::1",
      token: "gateway-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(devices).toEqual([
      expect.objectContaining({ id: "device-1", name: "This Mac", current: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://[::1]:7777/api/auth/devices",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("unpairs a device through the shared device delete endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "ok", current: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await requestUnpairDevice({
      port: 7777,
      token: "gateway-token",
      deviceId: "device-2",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/api/auth/devices/device-2",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
        }),
      }),
    );
  });

  it("prints unpair instructions without leaking the gateway token", () => {
    const text = formatPairedDevices([
      { id: "device-1", name: "This Mac", current: true, lastSeenAt: "2026-06-24T10:00:00.000Z" },
      { id: "-device-2", name: "iPhone browser", current: false, lastSeenAt: "2026-06-24T10:05:00.000Z" },
    ]);

    expect(text).toContain("Paired browsers");
    expect(text).toContain("This Mac");
    expect(text).toContain("iPhone browser");
    expect(text).toContain("jinn unpair -- -device-2");
    expect(text).not.toContain("Create a code with jinn pair");
    expect(text).not.toContain("gateway-token");
  });
});
