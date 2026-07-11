import path from "node:path";
import { ensureSessionCapability, MCP_GATEWAY_URL_ARG, MCP_HOME_ARG, MCP_SESSION_ID_ARG } from "./identity.js";
import { resolveMcpSessionCapabilityKeyFile } from "../shared/home.js";

export interface McpServerBootstrap {
  callerSessionId?: string;
  sessionCapability?: string;
  gatewayUrl?: string;
  jinnHome?: string;
}

/** Resolve the built-in MCP server's scoped identity from non-secret argv. */
export function resolveMcpServerBootstrap(argv: readonly string[]): McpServerBootstrap {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
    return value || undefined;
  };
  const callerSessionId = valueAfter(MCP_SESSION_ID_ARG);
  const homeArg = valueAfter(MCP_HOME_ARG);
  const jinnHome = homeArg ? path.resolve(homeArg) : undefined;
  const gatewayUrl = valueAfter(MCP_GATEWAY_URL_ARG);
  const sessionCapability = callerSessionId && jinnHome
    ? ensureSessionCapability(callerSessionId, resolveMcpSessionCapabilityKeyFile(jinnHome))
    : undefined;
  return { callerSessionId, sessionCapability, gatewayUrl, jinnHome };
}
