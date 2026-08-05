import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { applyGatewayEnvOverrides, gatewayFileBinding, withoutGatewayEnvValues } from "../config.js";
import type { JinnConfig } from "../types.js";

/** The container needs 0.0.0.0, which is a fact about the environment rather than a
 *  choice the user recorded — so it must not reach config.yaml on the volume. */
function configWith(gateway: Partial<JinnConfig["gateway"]>): JinnConfig {
  return { gateway: { port: 7777, host: "127.0.0.1", ...gateway } } as JinnConfig;
}

describe("applyGatewayEnvOverrides", () => {
  it("leaves the config alone when neither variable is set", () => {
    const config = configWith({});
    applyGatewayEnvOverrides(config, {});
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.gateway.port).toBe(7777);
  });

  it("takes the bind address from JINN_HOST", () => {
    const config = configWith({});
    applyGatewayEnvOverrides(config, { JINN_HOST: "0.0.0.0" });
    expect(config.gateway.host).toBe("0.0.0.0");
  });

  it("takes the port from JINN_PORT", () => {
    const config = configWith({});
    applyGatewayEnvOverrides(config, { JINN_PORT: "8080" });
    expect(config.gateway.port).toBe(8080);
  });

  it("keeps the configured port when JINN_PORT is not a usable port", () => {
    // Ignored rather than fatal: a typo in a compose file must not stop the gateway
    // booting on the port its own config names.
    for (const raw of ["0", "70000", "http", "-1", "80.5"]) {
      const config = configWith({});
      applyGatewayEnvOverrides(config, { JINN_PORT: raw });
      expect(config.gateway.port, raw).toBe(7777);
    }
  });

  it("ignores empty and whitespace-only values", () => {
    // `JINN_PORT: ${JINN_PORT:-}` in a compose file expands to an empty string, which
    // means "unset", not "port zero".
    const config = configWith({});
    applyGatewayEnvOverrides(config, { JINN_HOST: "  ", JINN_PORT: "" });
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.gateway.port).toBe(7777);
  });

  it("preserves the rest of the gateway block", () => {
    const config = configWith({ authRequired: true, streaming: true });
    applyGatewayEnvOverrides(config, { JINN_HOST: "0.0.0.0", JINN_PORT: "9000" });
    expect(config.gateway).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      authRequired: true,
      streaming: true,
    });
  });
});

/**
 * The other half: loadConfig() resolves the environment into every config object, so a
 * writer that persists one wholesale would stamp this process's binding onto the volume.
 * saveConfigAtomic routes every write here. env/file are explicit so an ambient
 * JINN_PORT — which docs/docker.md tells operators to set — cannot change these.
 */
describe("withoutGatewayEnvValues", () => {
  const env = { JINN_HOST: "0.0.0.0", JINN_PORT: "8080" };

  it("restores the file's binding in place of the environment's", () => {
    const persisted = withoutGatewayEnvValues(
      { gateway: { port: 8080, host: "0.0.0.0", authRequired: true }, portal: { onboarded: true } },
      { env, file: { host: "127.0.0.1", port: 7777 } },
    );
    expect(persisted.gateway).toEqual({ port: 7777, host: "127.0.0.1", authRequired: true });
    expect(persisted.portal).toEqual({ onboarded: true });
  });

  it("drops an overridden key the file does not have", () => {
    const persisted = withoutGatewayEnvValues(
      { gateway: { port: 7777, host: "0.0.0.0" } },
      { env: { JINN_HOST: "0.0.0.0" }, file: { port: 7777 } },
    );
    expect(persisted.gateway).toEqual({ port: 7777 });
  });

  it("keeps a value that differs from the environment's — that is a deliberate edit", () => {
    const config = { gateway: { port: 7777, host: "100.64.0.3" } };
    expect(withoutGatewayEnvValues(config, { env, file: { host: "127.0.0.1" } })).toBe(config);
  });

  it("returns the config untouched when the environment names nothing", () => {
    const config = { gateway: { port: 7777, host: "100.64.0.3" } };
    expect(withoutGatewayEnvValues(config, { env: {}, file: {} })).toBe(config);
  });

  it("never invents a gateway block", () => {
    // saveConfigAtomic also writes objects that are not whole configs (the STT handlers,
    // tests); adding `gateway: {}` to those would be a config.yaml edit nobody asked for.
    const config = { stt: { enabled: true } };
    expect(withoutGatewayEnvValues(config, { env, file: {} })).toBe(config);
  });
});

/** The file reader behind it: a hand-broken value must not be written back verbatim. */
describe("gatewayFileBinding", () => {
  let tmpHome: string;

  beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-gw-file-")); });
  afterEach(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ } });

  function write(contents: unknown): string {
    const file = path.join(tmpHome, "config.yaml");
    fs.writeFileSync(file, typeof contents === "string" ? contents : yaml.dump(contents));
    return file;
  }

  it("reads host and port", () => {
    expect(gatewayFileBinding(write({ gateway: { port: 7778, host: "127.0.0.1" } })))
      .toEqual({ host: "127.0.0.1", port: 7778 });
  });

  it("ignores values of the wrong type, including a bare `host:`", () => {
    expect(gatewayFileBinding(write("gateway:\n  host:\n  port: notaport\n"))).toEqual({});
    expect(gatewayFileBinding(write({ gateway: { host: 123, port: 7777 } }))).toEqual({ port: 7777 });
  });

  it("is empty for an absent, unreadable or gateway-less file", () => {
    expect(gatewayFileBinding(path.join(tmpHome, "absent.yaml"))).toEqual({});
    expect(gatewayFileBinding(write("gateway: [unterminated\n"))).toEqual({});
    expect(gatewayFileBinding(write({ engines: {} }))).toEqual({});
  });
});
