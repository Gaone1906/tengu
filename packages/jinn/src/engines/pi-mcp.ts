import fs from "node:fs";
import path from "node:path";
import type { McpServerStdioConfig, ResolvedMcpConfig } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";

const JINN_BUILTIN_SERVER = "jinn";
const JINN_MCP_SERVER_MODULE_URL = new URL("../mcp/server.js", import.meta.url).href;
const JINN_PI_MCP_MODULE_URL = new URL("./pi-mcp.js", import.meta.url).href;

export type PiMcpExtensionHandle =
  | { attached: false }
  | { attached: true; extensionPath: string; extensionDir: string; released?: boolean };

export function projectPiTool(tool: { name: string; description: string; inputSchema: unknown }) {
  return { name: tool.name, label: `Jinn ${tool.name}`, description: tool.description, parameters: tool.inputSchema };
}

export function projectPiToolManifest(tools: Array<{ name: string; description: string; inputSchema: unknown }>) {
  return tools.map(projectPiTool);
}

function jinnServer(resolvedMcp: ResolvedMcpConfig | undefined): McpServerStdioConfig | null {
  const spec = resolvedMcp?.mcpServers?.[JINN_BUILTIN_SERVER] as (McpServerStdioConfig & { url?: unknown }) | undefined;
  if (spec && typeof spec.command === "string" && spec.command && spec.url === undefined) return spec;
  return null;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function piJinnSessionEnv(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, string> {
  const spec = jinnServer(resolvedMcp);
  const sessionId = spec?.env?.JINN_SESSION_ID;
  const capability = spec?.env?.JINN_SESSION_CAPABILITY;
  const workflowAttempt = spec?.env?.JINN_WORKFLOW_ATTEMPT;
  return sessionId && capability ? {
    JINN_SESSION_ID: sessionId,
    JINN_SESSION_CAPABILITY: capability,
    ...(workflowAttempt === "1" ? { JINN_WORKFLOW_ATTEMPT: workflowAttempt } : {}),
  } : {};
}

export function writePiJinnMcpExtension(
  resolvedMcp: ResolvedMcpConfig | undefined,
  sessionId: string,
): PiMcpExtensionHandle {
  if (!jinnServer(resolvedMcp)) return { attached: false };

  const extensionDir = path.join(JINN_HOME, "tmp", "pi-mcp", safeSessionId(sessionId));
  const extensionPath = path.join(extensionDir, "jinn-mcp-extension.ts");
  fs.mkdirSync(extensionDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(extensionPath, piExtensionSource(), { mode: 0o600 });
  try {
    fs.chmodSync(extensionPath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return { attached: true, extensionPath, extensionDir };
}

export function cleanupPiJinnMcpExtension(handle: PiMcpExtensionHandle | undefined): void {
  if (!handle || !handle.attached || handle.released) return;
  handle.released = true;
  try {
    fs.rmSync(handle.extensionDir, { recursive: true, force: true });
  } catch {
    /* best effort temp cleanup */
  }
}

function piExtensionSource(): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildTools, notesEnabledFromConfig } from ${JSON.stringify(JINN_MCP_SERVER_MODULE_URL)};
import { projectPiTool } from ${JSON.stringify(JINN_PI_MCP_MODULE_URL)};

export default function jinnMcpExtension(pi: ExtensionAPI): void {
  for (const tool of buildTools({
    notesEnabled: notesEnabledFromConfig(),
    workflowAttempt: process.env.JINN_WORKFLOW_ATTEMPT === "1",
  })) {
    pi.registerTool({
      ...projectPiTool(tool),
      async execute(_toolCallId: string, params: Record<string, unknown> | undefined) {
        const result = await tool.handler(params ?? {}, {
          gatewayUrl: process.env.JINN_GATEWAY_URL ?? "http://127.0.0.1:7777",
          token: process.env.JINN_GATEWAY_TOKEN,
          callerSessionId: process.env.JINN_SESSION_ID,
          sessionCapability: process.env.JINN_SESSION_CAPABILITY,
        });
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
}
`;
}
