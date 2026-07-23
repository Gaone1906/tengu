import type { Employee, JinnConfig, ResolvedMcpConfig } from "../shared/types.js";
import { attachSessionIdentity } from "../mcp/identity.js";
import { isMcpCapableEngine, resolveMcpServers, writeMcpConfigFile } from "../mcp/resolver.js";

export interface EngineRunMcp {
  mcpConfigPath?: string;
  resolvedMcp?: ResolvedMcpConfig;
}

export function resolveEngineRunMcp(opts: {
  config: JinnConfig;
  employee?: Employee;
  engine: string;
  sessionId: string;
  workflowAttempt?: boolean;
}): EngineRunMcp {
  if (!isMcpCapableEngine(opts.engine)) return {};

  const mcpConfig = resolveMcpServers(opts.config.mcp, opts.employee, opts.engine);
  if (Object.keys(mcpConfig.mcpServers).length === 0) return {};

  const resolvedMcp = attachSessionIdentity(mcpConfig, opts.sessionId, {
    workflowAttempt: opts.workflowAttempt,
  });
  return {
    resolvedMcp,
    ...(opts.engine === "claude" ? { mcpConfigPath: writeMcpConfigFile(resolvedMcp, opts.sessionId) } : {}),
  };
}
