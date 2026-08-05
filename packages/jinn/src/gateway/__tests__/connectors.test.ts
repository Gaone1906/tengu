import { describe, expect, it, vi } from "vitest";
import { connectorInstancesFromConfig, createConnector } from "../server.js";
import { SlackConnector } from "../../connectors/slack/index.js";
import { DiscordConnector } from "../../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../../connectors/discord/remote.js";
import { TelegramConnector } from "../../connectors/telegram/index.js";
import { WhatsAppConnector } from "../../connectors/whatsapp/index.js";
import { SessionManager } from "../../sessions/manager.js";
import type { Connector, JinnConfig } from "../../shared/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const configWith = (connectors: Record<string, any>, stt?: JinnConfig["stt"]): JinnConfig =>
  ({ connectors, stt }) as unknown as JinnConfig;

const mixedConfig = configWith({
  slack: { appToken: "xapp-test", botToken: "xoxb-test", employee: "a-lead" },
  telegram: { botToken: "tg-test" },
  instances: [{ id: "slack-second", type: "slack", employee: "b-lead", appToken: "xapp-2", botToken: "xoxb-2" }],
});

describe("connectorInstancesFromConfig", () => {
  it("defaults legacy top-level connector ids to their type and appends instances[]", () => {
    const normalized = connectorInstancesFromConfig(mixedConfig);
    expect(normalized.map((entry) => [entry.id, entry.type])).toEqual([
      ["slack", "slack"],
      ["telegram", "telegram"],
      ["slack-second", "slack"],
    ]);
    expect(normalized[0].employee).toBe("a-lead");
    expect(normalized[0].config.id).toBe("slack");
    expect(normalized[2].employee).toBe("b-lead");
  });

  it("respects the per-type enable guards", () => {
    const ids = (config: JinnConfig): string[] => connectorInstancesFromConfig(config).map((entry) => entry.id);
    expect(ids(configWith({ slack: { appToken: "xapp-test" } }))).toEqual([]);
    expect(ids(configWith({ discord: { proxyVia: "http://127.0.0.1:1" } }))).toEqual(["discord"]);
    expect(ids(configWith({ discord: { channelId: "c1" } }))).toEqual([]);
    expect(ids(configWith({ telegram: { allowFrom: [1] } }))).toEqual([]);
    expect(ids(configWith({ whatsapp: {} }))).toEqual(["whatsapp"]);
  });

  it("forwards global stt settings to telegram connectors", () => {
    const stt = { enabled: true, model: "test-model" };
    const normalized = connectorInstancesFromConfig(configWith({ telegram: { botToken: "tg-test" } }, stt));
    expect(normalized[0].config.stt).toEqual(stt);
  });

  it("skips instances without id or type, and duplicate ids", () => {
    const normalized = connectorInstancesFromConfig(
      configWith({
        slack: { appToken: "xapp-test", botToken: "xoxb-test" },
        instances: [
          { type: "slack", appToken: "a", botToken: "b" },
          { id: "no-type" },
          { id: "slack", type: "slack", appToken: "a", botToken: "b" },
          { id: "telegram-support", type: "telegram", botToken: "tg-2" },
        ],
      }),
    );
    expect(normalized.map((entry) => entry.id)).toEqual(["slack", "telegram-support"]);
  });

  it.each([
    "",
    "Slack-Support",
    "slack support",
    "-slack",
    "_slack",
    `s${"x".repeat(64)}`,
  ])("rejects invalid connector instance id %j during normalization", (id) => {
    expect(() => connectorInstancesFromConfig(configWith({
      instances: [{ id, type: "slack", appToken: "xapp-test", botToken: "xoxb-test" }],
    }))).toThrow(/invalid connector instance id/i);
  });

  it("accepts the 64-character lowercase connector id boundary", () => {
    const id = `s${"x".repeat(63)}`;
    expect(connectorInstancesFromConfig(configWith({
      instances: [{ id, type: "slack", appToken: "xapp-test", botToken: "xoxb-test" }],
    }))[0].id).toBe(id);
  });
});

describe("createConnector", () => {
  const build = (type: string, config: Record<string, unknown> = {}): Connector =>
    createConnector({ id: `${type}-1`, type, config: { ...config, id: `${type}-1` } });

  it("dispatches every supported type to its connector class", () => {
    expect(build("slack", { appToken: "xapp-test", botToken: "xoxb-test" })).toBeInstanceOf(SlackConnector);
    expect(build("discord", { botToken: "d-test" })).toBeInstanceOf(DiscordConnector);
    expect(createConnector({ id: "discord", type: "discord", config: { id: "discord", proxyVia: "http://127.0.0.1:1" } })).toBeInstanceOf(RemoteDiscordConnector);
    expect(build("telegram", { botToken: "tg-test" })).toBeInstanceOf(TelegramConnector);
    expect(build("whatsapp")).toBeInstanceOf(WhatsAppConnector);
  });

  it("carries the instance id on id while name stays the type literal", () => {
    const slack = build("slack", { appToken: "xapp-test", botToken: "xoxb-test" });
    expect([slack.id, slack.name]).toEqual(["slack-1", "slack"]);
    const discord = build("discord", { botToken: "d-test" });
    expect([discord.id, discord.name]).toEqual(["discord-1", "discord"]);
  });

  it("rejects an unknown type", () => {
    expect(() => build("carrier-pigeon")).toThrow(/Unknown connector type "carrier-pigeon"/);
  });

  it("rejects named Remote Discord until authenticated identity is supported", () => {
    expect(() => build("discord", { proxyVia: "http://127.0.0.1:1" }))
      .toThrow(/named Remote Discord.*not supported/i);
  });

  it("keeps legacy Remote Discord identity and proxy addressing byte-identical", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "m1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const remote = createConnector({
        id: "discord",
        type: "discord",
        config: { id: "discord", proxyVia: "http://127.0.0.1:7788" },
      });
      expect([remote.id, remote.name]).toEqual(["discord", "discord"]);
      await remote.sendMessage({ channel: "C1" }, "hello");
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:7788/api/connectors/discord/proxy",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the local-to-remote Discord session key on the legacy discord prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const local = build("discord", { botToken: "d-test" }) as DiscordConnector;
      await (local as unknown as { proxyToRemote(url: string, message: unknown): Promise<void> }).proxyToRemote(
        "http://127.0.0.1:7788",
        {
          id: "M1",
          content: "hello",
          attachments: new Map(),
          author: { id: "U1", username: "tester" },
          guild: { id: "G1" },
          channel: {
            id: "C1",
            name: "general",
            isDMBased: () => false,
            isThread: () => false,
            isTextBased: () => true,
          },
        },
      );
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(request.body)).sessionKey).toBe("discord:C1");
      expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:7788/api/connectors/discord/incoming");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("connector wiring", () => {
  const stubConnector = (start: () => Promise<void>): Connector =>
    ({ name: "stub", start, stop: async () => {}, sendMessage: async () => undefined, onMessage: () => {} }) as unknown as Connector;

  it("registers a connector before start resolves, so a hung handshake cannot block boot", async () => {
    const registry = new Map<string, Connector>();
    const hung = stubConnector(() => new Promise<void>(() => {}));
    // Mirrors server.ts: register first, then fire-and-forget start().
    registry.set("hung", hung);
    const pending = hung.start().catch(() => {});
    expect(registry.has("hung")).toBe(true);
    expect(await Promise.race([pending, Promise.resolve("still-booting")])).toBe("still-booting");
  });

  it("keeps a rejecting start() from throwing into the boot path", async () => {
    const failing = stubConnector(async () => {
      throw new Error("handshake refused");
    });
    let logged: string | undefined;
    expect(() => {
      failing.start().catch((err: unknown) => {
        logged = err instanceof Error ? err.message : String(err);
      });
    }).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logged).toBe("handshake refused");
  });

  it("derives session-context connector names from the live registry", () => {
    const registry = new Map<string, Connector>();
    for (const instance of connectorInstancesFromConfig(mixedConfig)) {
      registry.set(instance.id, stubConnector(async () => {}));
    }
    const manager = new SessionManager(mixedConfig, new Map(), "connector-names-boot");
    manager.setConnectorProvider(() => registry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = (): string[] => (manager as any).connectorNames();

    expect(names()).toEqual(["slack", "telegram", "slack-second"]);

    // A reload replaces the registry contents; the context list must follow.
    registry.delete("telegram");
    registry.set("discord-ops", stubConnector(async () => {}));
    expect(names()).toEqual(["slack", "slack-second", "discord-ops"]);
  });
});
