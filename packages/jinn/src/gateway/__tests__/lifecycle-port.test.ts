import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { waitForDashboardReady, waitForPortListening, waitForPortFree } from "../lifecycle.js";

/**
 * Pick a free ephemeral port by briefly binding one and reading it back.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe("waitForPortListening", () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  it("returns true once a server accepts connections on the port", async () => {
    const port = await freePort();
    const srv = net.createServer((sock) => sock.end());
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));

    const listening = await waitForPortListening(port, "127.0.0.1", 3_000);
    expect(listening).toBe(true);
  });

  it("returns false on timeout when nothing is listening", async () => {
    const port = await freePort();
    const listening = await waitForPortListening(port, "127.0.0.1", 600);
    expect(listening).toBe(false);
  });

  it("becomes true after a server starts mid-wait (verifies the daemon-bind handoff)", async () => {
    const port = await freePort();
    const srv = net.createServer((sock) => sock.end());
    servers.push(srv);
    // Start listening shortly after the wait begins — mirrors restart-entry
    // spawning the daemon and then polling until it binds.
    setTimeout(() => srv.listen(port, "127.0.0.1"), 300);

    const listening = await waitForPortListening(port, "127.0.0.1", 3_000);
    expect(listening).toBe(true);
  });
});

describe("waitForPortFree", () => {
  it("returns true when the port is already free", async () => {
    // freePort() releases the port before resolving.
    const port = await freePort();
    const free = await waitForPortFree(port, 3_000);
    expect(free).toBe(true);
  });
});

describe("waitForDashboardReady", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
  });

  it("returns true when root HTML and referenced assets load", async () => {
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<div id="root"></div><script type="module" src="/assets/index.js"></script>');
        return;
      }
      if (req.url === "/assets/index.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("console.log('ready')");
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));

    const ready = await waitForDashboardReady(port, "127.0.0.1", 1_000);
    expect(ready).toBe(true);
  });

  it("returns false when root HTML references a missing asset", async () => {
    const port = await freePort();
    const srv = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<div id="root"></div><script type="module" src="/assets/missing.js"></script>');
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(srv);
    await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));

    const ready = await waitForDashboardReady(port, "127.0.0.1", 600);
    expect(ready).toBe(false);
  });
});
