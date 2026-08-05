import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-whatsapp-identity-"));
process.env.JINN_HOME = testHome;

const mocks = vi.hoisted(() => {
  const eventOn = vi.fn();
  const useMultiFileAuthState = vi.fn(async (_authDir: string) => ({ state: {}, saveCreds: vi.fn() }));
  const socket = {
    ev: { on: eventOn },
    end: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
  };
  return {
    eventOn,
    useMultiFileAuthState,
    makeWASocket: vi.fn(() => socket),
  };
});

vi.mock("@whiskeysockets/baileys", () => ({
  default: mocks.makeWASocket,
  Browsers: { macOS: vi.fn(() => ["macOS", "Chrome", "test"]) },
  DisconnectReason: { loggedOut: 401 },
  fetchLatestWaWebVersion: vi.fn().mockResolvedValue({ version: undefined }),
  useMultiFileAuthState: mocks.useMultiFileAuthState,
  downloadMediaMessage: vi.fn(),
}));

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const { WhatsAppConnector } = await import("../index.js");

describe("WhatsAppConnector identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves legacy auth storage and isolates named default auth state", async () => {
    const legacy = new WhatsAppConnector({});
    const support = new WhatsAppConnector({ id: "whatsapp-support" });
    const operations = new WhatsAppConnector({ id: "whatsapp-operations" });

    await legacy.start();
    await support.start();
    await operations.start();

    const authRoot = path.join(testHome, ".whatsapp-auth");
    expect(mocks.useMultiFileAuthState.mock.calls.map(([authDir]) => authDir)).toEqual([
      authRoot,
      path.join(authRoot, "whatsapp-support"),
      path.join(authRoot, "whatsapp-operations"),
    ]);
    expect(fs.existsSync(authRoot)).toBe(true);
    expect(fs.existsSync(path.join(authRoot, "whatsapp-support"))).toBe(true);
    expect(fs.existsSync(path.join(authRoot, "whatsapp-operations"))).toBe(true);
  });
});
