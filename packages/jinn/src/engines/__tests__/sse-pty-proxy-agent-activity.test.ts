import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN_AGENT_SENTINEL, SsePtyProxy } from "../sse-pty-proxy.js";

function callProxy(port: number, path: string, body: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "POST", agent: false },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function until(fn: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not reached within 2s");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SsePtyProxy agent activity", () => {
  const proxies: SsePtyProxy[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) proxy.stop();
    await Promise.all(servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ));
  });

  it("separates three agent requests from five concurrent upstream streams", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      void gate.then(() => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = new SsePtyProxy("test", () => {}, {
      requestFn: http.request,
      upstream: { hostname: "127.0.0.1", port: upstreamPort },
      primaryAgent: false,
    });
    proxies.push(proxy);
    const port = await proxy.start();

    const requests = [
      callProxy(port, "/v1/messages", { tools: [{}], system: MAIN_AGENT_SENTINEL }),
      callProxy(port, "/v1/messages?beta=true", { tools: [{}], system: "subagent one" }),
      callProxy(port, "/v1/messages", { tools: [{}], system: "subagent two" }),
      callProxy(port, "/v1/messages/count_tokens", { tools: [{}], system: MAIN_AGENT_SENTINEL }),
      callProxy(port, "/v1/messages", { system: MAIN_AGENT_SENTINEL }),
    ];

    await until(() => proxy.activeStreams === 5);
    const peak = {
      activeStreams: proxy.activeStreams,
      activeAgents: proxy.activeAgents,
    };
    release();
    await Promise.all(requests);

    expect(peak.activeStreams).toBe(5);
    expect(peak.activeAgents).toBe(3);
    expect(proxy.activeStreams).toBe(0);
    expect(proxy.activeAgents).toBe(0);
  });
});
