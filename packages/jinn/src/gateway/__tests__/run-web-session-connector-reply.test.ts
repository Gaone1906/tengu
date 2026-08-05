import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverConnectorReply } from "../api.js";
import { logger } from "../../shared/logger.js";
import type { Connector, Session } from "../../shared/types.js";

/** Build a minimal mocked connector exposing the two methods the helper uses. */
function makeConnector(name: string) {
  const target = { channel: "C123", thread: "T1" };
  const reconstructTarget = vi.fn(() => target);
  const replyMessage = vi.fn(async () => undefined);
  const connector = { name, reconstructTarget, replyMessage } as unknown as Connector;
  return { connector, reconstructTarget, replyMessage, target };
}

/** Build the minimal slice of a Session the helper reads. */
function makeSession(
  overrides: Partial<Pick<Session, "source" | "connector" | "replyContext">> & { id?: string } = {},
): Pick<Session, "source" | "connector" | "replyContext"> & { id?: string } {
  return {
    source: "slack",
    connector: "slack",
    replyContext: { channel: "C123", ts: "1700000000.0001" },
    ...overrides,
  };
}

describe("deliverConnectorReply", () => {
  let map: Map<string, Connector>;
  let slack: ReturnType<typeof makeConnector>;

  beforeEach(() => {
    slack = makeConnector("slack");
    map = new Map<string, Connector>([["slack", slack.connector]]);
  });

  it("delivers a slack reply: reconstructTarget then replyMessage once", async () => {
    const session = makeSession();
    await deliverConnectorReply(session, "hello world", map);

    expect(slack.reconstructTarget).toHaveBeenCalledTimes(1);
    expect(slack.reconstructTarget).toHaveBeenCalledWith(session.replyContext);
    expect(slack.replyMessage).toHaveBeenCalledTimes(1);
    expect(slack.replyMessage).toHaveBeenCalledWith(slack.target, "hello world");
  });

  it("does not deliver for source 'web'", async () => {
    await deliverConnectorReply(makeSession({ source: "web" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver for source 'cron'", async () => {
    await deliverConnectorReply(makeSession({ source: "cron" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver for source 'talk'", async () => {
    await deliverConnectorReply(makeSession({ source: "talk" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("delivers to a named connector instance keyed by instance id", async () => {
    const support = makeConnector("slack");
    const named = new Map<string, Connector>([["slack-support", support.connector]]);
    await deliverConnectorReply(makeSession({ connector: "slack-support" }), "hi", named);
    expect(support.reconstructTarget).toHaveBeenCalledTimes(1);
    expect(support.replyMessage).toHaveBeenCalledTimes(1);
  });

  it("logs a warning and does not call when connector missing from map", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const session = makeSession({ id: "sess-42", connector: "telegram", source: "telegram" });
    await expect(deliverConnectorReply(session, "hi", map)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("sess-42");
    expect(warn.mock.calls[0][0]).toContain("telegram");
    expect(slack.replyMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not deliver when text is empty", async () => {
    await deliverConnectorReply(makeSession(), "", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver when replyContext is missing", async () => {
    await deliverConnectorReply(makeSession({ replyContext: null }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("swallows connector errors (does not reject)", async () => {
    slack.replyMessage.mockRejectedValueOnce(new Error("boom"));
    await expect(deliverConnectorReply(makeSession(), "hi", map)).resolves.toBeUndefined();
  });
});
