import fs from "node:fs";
import path from "node:path";
import type { Employee, JinnConfig, OrgHierarchy, OrgNode } from "../shared/types.js";
import { compactEmployeeRole } from "../shared/employee-role.js";
import { JINN_HOME, ORG_DIR, CRON_JOBS, DOCS_DIR } from "../shared/paths.js";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";

/**
 * Token budget strategy:
 *
 * Sections are split into three tiers that are assembled in order.
 * If the accumulated prompt exceeds the configurable budget (default 100K chars),
 * lower-tier sections are progressively summarized. Oversized essential
 * sections are then compacted before summarized orientation is omitted, and
 * the configured hard cap is applied deterministically as a final fallback.
 *
 *   ESSENTIAL  – identity, session, config                (always included)
 *   STANDARD   – org summary, cron summary, connectors,
 *                API ref, evolution, language              (included when budget allows)
 *   OPTIONAL   – knowledge listing, environment scan,
 *                delegation protocol                       (trimmed first when over budget)
 *
 * Knowledge and docs files are NEVER inlined — only filenames are listed.
 * The AI can read files on demand, saving ~200K+ chars per session.
 */

const DEFAULT_MAX_CONTEXT_CHARS = 100_000;

// ── Tier enum for progressive trimming ────────────────────────
const enum Tier {
  ESSENTIAL = 0,
  STANDARD = 1,
  OPTIONAL = 2,
}

interface Section {
  tier: Tier;
  marker: string; // leading text used to identify the section in trimContext
  content: string;
  summary: string; // compact fallback when budget is tight
}

/**
 * `talk` is retained as stored provenance for pre-retirement sessions, but it
 * no longer selects a distinct runtime. Historical Talk turns resume through
 * the ordinary web lifecycle so no voice-orchestrator behavior can reappear.
 */
export function runtimeSessionSource(source: string): string {
  return source === "talk" ? "web" : source;
}

export interface PlatformContextSnapshot {
  schemaVersion: 1;
  gatewayBootId: string;
  jinnSessionId: string;
  source: string;
  channel: string;
  thread: string;
  user: string;
  workingDirectory: string;
  gatewayBaseUrl: string;
  selectedEngine: string;
  resolvedModel: string;
  resolvedEffort: string;
  configuredDefaultEngine: string;
  configuredModels: Record<string, string>;
  logLevel: string;
}

export interface BuildContextOptions {
  source: string;
  channel: string;
  thread?: string;
  user: string;
  employee?: Employee;
  connectors?: string[];
  config?: JinnConfig;
  engine?: string;
  model?: string;
  effortLevel?: string;
  gatewayBootId?: string;
  sessionId?: string;
  portalName?: string;
  operatorName?: string;
  language?: string;
  channelName?: string;
  hierarchy?: OrgHierarchy;
  /** Whether the built-in Jinn MCP toolset is attached for context dieting. */
  jinnMcpAttached?: boolean;
}

function implicitEngineModel(engine: string): string | undefined {
  if (engine === "antigravity") return "Gemini 3.5 Flash (Medium)";
  if (engine === "grok") return "grok-build";
  return undefined;
}

function engineConfig(config: JinnConfig | undefined, engine: string): { model?: string; effortLevel?: string } {
  if (!config || !engine) return {};
  const configured = (config.engines as unknown as Record<string, { model?: string; effortLevel?: string } | undefined>)[engine];
  if (!configured) return {};
  return { ...configured, model: configured.model ?? implicitEngineModel(engine) };
}

function channelDisplay(opts: Pick<BuildContextOptions, "source" | "channel" | "channelName">): string {
  if (opts.channelName) return `#${opts.channelName} (${opts.channel})`;
  if (opts.source === "slack" && opts.channel.startsWith("D")) return `Direct Message (${opts.channel})`;
  return opts.channel;
}

export function buildPlatformContextSnapshot(opts: BuildContextOptions): PlatformContextSnapshot {
  const selectedEngine = opts.engine ?? opts.employee?.engine ?? opts.config?.engines.default ?? "";
  const selectedConfig = engineConfig(opts.config, selectedEngine);
  const configuredModels: Record<string, string> = {};
  if (opts.config) {
    for (const [engine, raw] of Object.entries(opts.config.engines)) {
      if (engine === "default" || !raw || typeof raw !== "object") continue;
      const model = (raw as { model?: unknown }).model;
      const resolved = typeof model === "string" && model.trim() ? model : implicitEngineModel(engine);
      if (resolved) configuredModels[engine] = resolved;
    }
  }
  const gatewayUrl = opts.config
    ? gatewayBaseUrl({ port: opts.config.gateway.port || 7777, host: opts.config.gateway.host })
    : "http://127.0.0.1:7777";

  return {
    schemaVersion: 1,
    gatewayBootId: opts.gatewayBootId ?? "",
    jinnSessionId: opts.sessionId ?? "",
    source: opts.source,
    channel: channelDisplay(opts),
    thread: opts.thread ?? "",
    user: opts.user,
    workingDirectory: JINN_HOME,
    gatewayBaseUrl: gatewayUrl,
    selectedEngine,
    resolvedModel: opts.model ?? opts.employee?.model ?? selectedConfig.model ?? "",
    resolvedEffort: opts.effortLevel ?? opts.employee?.effortLevel ?? selectedConfig.effortLevel ?? "",
    configuredDefaultEngine: opts.config?.engines.default ?? "",
    configuredModels,
    logLevel: opts.config?.logging ? opts.config.logging.level || "info" : "",
  };
}

export function renderPlatformSessionContext(snapshot: PlatformContextSnapshot): string {
  const lines = ["## Current session"];
  if (snapshot.jinnSessionId) lines.push(`- Session ID: ${snapshot.jinnSessionId}`);
  lines.push(`- Source: ${snapshot.source}`);
  lines.push(`- Channel: ${snapshot.channel}`);
  if (snapshot.thread) lines.push(`- Thread: ${snapshot.thread}`);
  lines.push(`- User: ${snapshot.user}`);
  lines.push(`- Working directory: ${snapshot.workingDirectory}`);
  return lines.join("\n");
}

function engineLabel(engine: string): string {
  return engine ? `${engine[0].toUpperCase()}${engine.slice(1)}` : engine;
}

export function renderPlatformConfigContext(snapshot: PlatformContextSnapshot): string {
  const lines = ["## Current configuration", `- Gateway: ${snapshot.gatewayBaseUrl}`];
  if (snapshot.configuredDefaultEngine) lines.push(`- Default engine: ${snapshot.configuredDefaultEngine}`);
  for (const [engine, model] of Object.entries(snapshot.configuredModels).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${engineLabel(engine)} model: ${model}`);
  }
  if (snapshot.logLevel) lines.push(`- Log level: ${snapshot.logLevel}`);
  if (snapshot.selectedEngine) lines.push(`- Active engine: ${snapshot.selectedEngine}`);
  if (snapshot.resolvedModel) lines.push(`- Active model: ${snapshot.resolvedModel}`);
  if (snapshot.resolvedEffort) lines.push(`- Active effort: ${snapshot.resolvedEffort}`);
  return lines.join("\n");
}

/**
 * Build a rich system prompt for engine sessions.
 * This is what makes Jinn "smart" — the engine sees all of this context
 * before responding to the user.
 */
export function buildContext(opts: BuildContextOptions): string {
  const configuredMaxChars = opts.config?.context?.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const maxChars = Number.isFinite(configuredMaxChars)
    ? Math.max(0, Math.floor(configuredMaxChars))
    : DEFAULT_MAX_CONTEXT_CHARS;
  const sections: Section[] = [];
  const platformContext = buildPlatformContextSnapshot(opts);
  const gatewayUrl = platformContext.gatewayBaseUrl;

  // Resolve personalized names from config
  const portalName = opts.portalName || opts.config?.portal?.portalName || "Jinn";
  const operatorName = opts.operatorName || opts.config?.portal?.operatorName;
  const language = opts.language || opts.config?.portal?.language || "English";

  // ── ESSENTIAL: Identity ─────────────────────────────────────
  if (opts.employee) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildEmployeeIdentity(
        opts.employee,
        portalName,
        language,
        opts.hierarchy?.nodes[opts.employee.name],
        opts.hierarchy,
        opts.jinnMcpAttached,
      ),
      summary: buildEmployeeIdentitySummary(
        opts.employee,
        opts.hierarchy?.nodes[opts.employee.name],
        opts.hierarchy,
      ),
    });
  } else {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "# You are",
      content: buildIdentity(portalName, operatorName, language),
      summary: `# You are ${portalName}\nYour working directory is \`~/.jinn\` (${JINN_HOME}).`,
    });
  }

  // ── STANDARD: Onboarding (gated on portal setup completion) ────────
  // Steady-state self-evolution guidance lives in CLAUDE.md/AGENTS.md (auto-loaded).
  // Only the dynamic onboarding flow for a fresh install is emitted here.
  if (!opts.employee) {
    const portal = opts.config?.portal;
    const setupComplete = portal?.setupComplete === true || portal?.onboarded === true;
    const onboarding = buildOnboardingContext({ portalName, operatorName, setupComplete });
    if (onboarding) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Onboarding mode",
        content: onboarding,
        summary: `## Onboarding mode\nFresh install — run the onboarding skill (see CLAUDE.md).`,
      });
    }
  }

  // ── ESSENTIAL: Session context ──────────────────────────────
  sections.push({
    tier: Tier.ESSENTIAL,
    marker: "## Current session",
    content: renderPlatformSessionContext(platformContext),
    summary: renderPlatformSessionContext(platformContext),
  });

  // ── ESSENTIAL: Configuration awareness ──────────────────────
  if (opts.config) {
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: "## Current configuration",
      content: renderPlatformConfigContext(platformContext),
      summary: renderPlatformConfigContext(platformContext),
    });
  }

  if (opts.jinnMcpAttached) {
    const engine = opts.engine ?? opts.employee?.engine ?? opts.config?.engines.default;
    sections.push({
      tier: Tier.ESSENTIAL,
      marker: opts.employee ? "## Company Identity" : "## COO Company Anchor",
      content: opts.employee
        ? buildCompanyIdentityBlock(engine, opts.jinnMcpAttached)
        : buildCooCompanyAnchor(engine, opts.jinnMcpAttached),
      summary: opts.employee
        ? buildCompanyIdentitySummary(engine)
        : buildCooCompanyAnchorSummary(engine),
    });
  }

  // ── STANDARD: Relationship-scoped role orientation ──────────
  const jinnMcpAttached = opts.jinnMcpAttached === true;
  const scopedRoster = buildScopedRosterSection(
    opts.employee,
    opts.hierarchy,
    portalName,
    jinnMcpAttached,
  );
  if (scopedRoster) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Working roster",
      content: scopedRoster,
      summary: buildScopedRosterSummary(
        opts.employee,
        opts.hierarchy,
        portalName,
        jinnMcpAttached,
      ),
    });
  }

  // ── STANDARD: Organization (COO only — employees get their chain of command) ──
  if (!opts.employee) {
    const orgCtx = buildOrgContext(opts.hierarchy, opts.jinnMcpAttached);
    if (orgCtx) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Organization",
        content: orgCtx,
        summary: `## Organization\nEmployee files are in \`${ORG_DIR}/\`. Read them directly when needed.`,
      });
    }
  }

  // ── STANDARD: Cron jobs (COO only — employees don't manage the schedule) ──
  if (!opts.employee) {
    const cronCtx = buildCronContext(opts.jinnMcpAttached);
    if (cronCtx) {
      sections.push({
        tier: Tier.STANDARD,
        marker: "## Scheduled cron",
        content: cronCtx,
        summary: opts.jinnMcpAttached
          ? cronCtx
          : "## Scheduled cron jobs\nCron definitions are in `~/.jinn/cron/jobs.json`. Read directly when needed.",
      });
    }
  }

  // ── OPTIONAL: Knowledge / docs (filenames only, never inlined)
  // GRS-020b context diet (mirrors the 017b jinnMcpAttached pattern): for
  // jinn-MCP-attached sessions the ~100-file index collapses to a 2-line
  // manifest pointing at search_knowledge/read_knowledge; everyone
  // else keeps the full index byte-identical.
  const knowledgeCtx = buildKnowledgeContext(opts.jinnMcpAttached);
  if (knowledgeCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Knowledge base",
      content: knowledgeCtx,
      summary: opts.jinnMcpAttached
        ? knowledgeCtx // the manifest is already 2 lines — trimming keeps it verbatim
        : "## Knowledge base\nKnowledge files are in `~/.jinn/knowledge/` and `~/.jinn/docs/`. Read them directly when needed.",
    });
  }

  // ── STANDARD: Language override for skills ──────────────────
  if (language !== "English") {
    sections.push({
      tier: Tier.STANDARD,
      marker: "When following skill",
      content: `When following skill instructions, always communicate with the user in ${language}, even if the skill contains English examples or dialogue.`,
      summary: `Communicate in ${language}.`,
    });
  }

  // ── STANDARD: Connectors (Slack, etc.) ──────────────────────
  if (opts.connectors && opts.connectors.length > 0) {
    sections.push({
      tier: Tier.STANDARD,
      marker: "## Available connectors",
      content: buildConnectorContext(opts.connectors, gatewayUrl, opts.jinnMcpAttached),
      summary: opts.jinnMcpAttached
        ? `## Available connectors: ${opts.connectors.join(", ")}\nUse Jinn MCP/company routing for company operations; connector configuration lives in config.`
        : `## Available connectors: ${opts.connectors.join(", ")}\nUse \`curl POST ${gatewayUrl}/api/connectors/<id>/send\` to send messages.`,
    });
  }

  // ── OPTIONAL: Local environment ─────────────────────────────
  const envCtx = buildEnvironmentContext();
  if (envCtx) {
    sections.push({
      tier: Tier.OPTIONAL,
      marker: "## Local environment",
      content: envCtx,
      summary: "## Local environment\nRun `ls ~/` to explore the local filesystem.",
    });
  }

  // Delegation protocol lives in CLAUDE.md/AGENTS.md (auto-loaded). The live
  // gateway URL + the /api/sessions endpoints needed to delegate are emitted
  // in the Gateway API reference section below, so nothing is lost here.

  // ── STANDARD: Gateway API reference (audience-scoped; full table in CLAUDE.md) ──
  const employeeNode = opts.employee ? opts.hierarchy?.nodes[opts.employee.name] : undefined;
  sections.push({
    tier: Tier.STANDARD,
    marker: `## ${portalName} Gateway API`,
    content: buildApiReference(gatewayUrl, portalName, opts.employee, employeeNode?.directReports?.length ?? 0, opts.jinnMcpAttached),
    summary: `## ${portalName} Gateway API (${gatewayUrl})\nFull endpoint reference: CLAUDE.md / AGENTS.md.`,
  });

  // ── Assemble with progressive trimming by tier ──────────────
  return trimContext(sections, maxChars);
}

// ═══════════════════════════════════════════════════════════════
// Section builders
// ═══════════════════════════════════════════════════════════════

function buildEmployeeIdentity(
  employee: Employee,
  portalName: string,
  language: string,
  node?: OrgNode,
  hierarchy?: OrgHierarchy,
  jinnMcpAttached?: boolean,
): string {
  const languageInstruction = language !== "English"
    ? `\n**Language**: Always respond in ${language}. All your communication with the user must be in ${language}.\n`
    : "";

  const chainOfCommand = buildChainOfCommand(employee, portalName, node, hierarchy, jinnMcpAttached);
  const systemContext = jinnMcpAttached
    ? `## System context
You are part of the ${portalName} AI gateway. Be proactive, take initiative, and deliver results. You're not a chatbot — you're a worker.`
    : `## System context
You are part of the ${portalName} AI gateway — a system that orchestrates AI workers. You have access to the filesystem, can run commands, call APIs, and send messages via connectors. Your working directory is \`~/.jinn\` (${JINN_HOME}).

You can:
- Read and write files in the home directory
- Run shell commands
- Call the gateway API to interact with other parts of the system
- Send messages via connectors (Slack, etc.)
- Access skills, knowledge base, and documentation
- Collaborate with other employees by mentioning them or creating sessions

Be proactive, take initiative, and deliver results. You're not a chatbot — you're a worker.`;

  return `# You are ${employee.displayName}

You are an AI employee in the ${portalName} gateway system.

## Your persona
${employee.persona}
${languageInstruction}
## Your role
- **Name**: ${employee.name}
- **Display name**: ${employee.displayName}
- **Department**: ${employee.department}
- **Rank**: ${employee.rank}
- **Engine**: ${employee.engine}
- **Model**: ${employee.model}
${chainOfCommand}
${systemContext}`;
}

function buildEmployeeIdentitySummary(
  employee: Employee,
  node?: OrgNode,
  hierarchy?: OrgHierarchy,
): string {
  const personaLines = employee.persona
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const compactLine = (line: string): string =>
    line.length <= 200 ? line : `${line.slice(0, 199).trimEnd()}…`;
  const roleLine = personaLines[0] ? compactLine(personaLines[0]) : undefined;
  const prohibitionLines = personaLines
    .filter((line) => /(?:\bSAFETY\b|\bNEVER\b|\bMUST\s+NOT\b|\bDO\s+NOT\b|\bPROHIBITED\b)/i.test(line))
    .filter((line) => line !== personaLines[0])
    .slice(0, 3)
    .map(compactLine);
  const manager = node?.parentName
    ? hierarchy?.nodes[node.parentName]?.employee
    : undefined;

  return [
    `# You are ${employee.displayName}`,
    `Employee: ${employee.name}, ${employee.department}, ${employee.rank}`,
    roleLine,
    ...prohibitionLines,
    node?.parentName
      ? `Manager: ${manager?.displayName ?? node.parentName} (\`${node.parentName}\`)`
      : undefined,
  ].filter(Boolean).join("\n");
}

function buildCompanyIdentityBlock(
  engine: string | undefined,
  jinnMcpAttached: boolean,
): string {
  const engineName = engine ? `\`${engine}\`` : "current";
  const mcpLine = jinnMcpAttached
    ? `Your hands are the attached Jinn MCP on the ${engineName} engine - default to it to read/update the company (org, sessions, Todos, Workflows, cron, reference). Local shell/filesystem access remains available for implementation work or when MCP has no hand.`
    : "";

  return [
    "## Company Identity",
    mcpLine,
    "Pick colleagues by role/persona fit. One employee may run multiple child sessions in parallel; reuse the fit instead of spreading to unrelated employees. If none fits, propose a hire.",
    "Todos are your live work ledger - find and update your Todo; create one only for durable work you own.",
    "Workflows are reusable automations (the HOW) - use or propose one when a job is repeatable/scheduled/multi-step; Todos and Workflows are SEPARATE.",
    "You have autonomy in your lane; end your turn when waiting on another employee.",
    "Do NOT bombard the operator. Questions and approvals route to your manager/COO by default; the aCEO/operator is the exception (money, irreversible, public, legal/security, or explicit COO escalation).",
  ].filter(Boolean).join("\n");
}

function buildCompanyIdentitySummary(engine: string | undefined): string {
  const engineName = engine ? ` on the \`${engine}\` engine` : "";
  return [
    "## Company Identity",
    `Use the attached Jinn MCP${engineName} for company state and delegation.`,
    "Track durable work in Todos; use Workflows for reusable multi-step work.",
    "Route ordinary questions and approvals through your manager/COO.",
  ].join("\n");
}

function buildChainOfCommand(
  employee: Employee,
  portalName: string,
  node?: OrgNode,
  hierarchy?: OrgHierarchy,
  jinnMcpAttached?: boolean,
): string {
  if (!node || !hierarchy) return "";

  const lines: string[] = ["## Chain of command"];
  lines.push(`- **Department**: ${employee.department}`);

  // Your manager — load-bearing for escalation, always inline (design GRS-017 §3).
  if (node.parentName) {
    const parent = hierarchy.nodes[node.parentName];
    if (parent) {
      lines.push(`- **Your manager**: ${parent.employee.displayName} (\`${node.parentName}\`, ${parent.employee.rank})`);
    } else {
      lines.push(`- **Your manager**: ${node.parentName}`);
    }
  } else {
    lines.push(`- **Your manager**: ${portalName} (COO)`);
  }

  // Direct reports
  if (node.directReports.length > 0) {
    const reports = node.directReports.map((name) => {
      const r = hierarchy.nodes[name];
      return r ? `${r.employee.displayName} (\`${name}\`, ${r.employee.rank})` : name;
    });
    lines.push(`- **Your direct reports**: ${reports.join(", ")}`);
  }

  if (jinnMcpAttached) {
    // GRS-017b diet: the walked escalation-path prose is discoverable through
    // the org tools; one pointer replaces it.
    lines.push(`- **Org discovery**: find_employees / get_employee / list_employees (roster, personas, reporting lines).`);
  } else {
    // Escalation path
    const escalation: string[] = [];
    let current = node.parentName;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const mgr = hierarchy.nodes[current];
      escalation.push(mgr ? mgr.employee.displayName : current);
      current = mgr?.parentName ?? null;
    }
    escalation.push(`${portalName} (COO)`);
    const unique = [...new Set(escalation)];
    lines.push(`- **Escalation path**: ${unique.join(" → ")}`);
  }

  return "\n" + lines.join("\n") + "\n";
}

/**
 * COO identity ANCHOR — intentionally minimal. The full operating manual
 * (principles, home-dir layout, org system, delegation, toolbox, conventions)
 * lives in `CLAUDE.md` / `AGENTS.md` at `~/.jinn` and is auto-loaded by every
 * engine (claude reads CLAUDE.md; codex/agy read AGENTS.md → symlinked to
 * CLAUDE.md). We only anchor identity + point at the manual so the manual is
 * never duplicated into this prompt.
 */
export function buildIdentity(portalName: string, operatorName?: string, language?: string): string {
  const operatorLine = operatorName
    ? `\n\nThe person you are speaking with is **${operatorName}** — your operator. Address them directly, in the second person ("you"), never in the third person.`
    : "";
  const languageInstruction = language && language !== "English"
    ? `\n\n**Language**: Always respond in ${language}.`
    : "";

  return `# You are ${portalName}

You are ${portalName}, COO of ${operatorName ? `${operatorName}'s` : "the user's"} AI organization. Your full operating manual is in \`CLAUDE.md\` / \`AGENTS.md\` at \`~/.jinn\` (${JINN_HOME}) — auto-loaded by your engine. Follow it.${operatorLine}${languageInstruction}`;
}

function buildCooCompanyAnchor(engine?: string, jinnMcpAttached = false): string {
  const engineName = engine ? `\`${engine}\`` : "current";
  const mcpLine = jinnMcpAttached
    ? `Your ${engineName} engine has the built-in \`jinn\` MCP attached for this session. Use it as the default way to read/update company state before asking the operator or carrying state in prose.`
    : "";
  return [
    "## COO Company Anchor",
    mcpLine,
    "- Pick the employee whose role/persona matches the task. One employee may run multiple child sessions in parallel; reuse the fit instead of spreading to unrelated employees. If none fits, propose a hire.",
    "- Todos/work-items are the source of truth for task tracking: list/search/read/create/update/assign them through the MCP.",
    "- Use Workflows for multi-step or scheduled orchestration.",
    "- Use company-reference reads before asking the operator: sessions/search, knowledge, cost, and cron.",
    "- Keep the operator out of the firehose: route questions and approvals through managers/COO by default, escalating to the operator only for money, irreversible, public, legal/security, or explicit escalation cases.",
  ].filter(Boolean).join("\n");
}

function buildCooCompanyAnchorSummary(engine?: string): string {
  const engineName = engine ? ` on the \`${engine}\` engine` : "";
  return [
    "## COO Company Anchor",
    `Use the attached Jinn MCP${engineName} for company state, delegation, Todos, Workflows, and reference reads.`,
    "Match work to employee roles and keep routine coordination away from the operator.",
  ].join("\n");
}

const WORKING_ROSTER_HEADING = "## Working roster (scoped orientation; not exhaustive)";
const FULL_ROSTER_HINT = "Use `find_employees` / `list_employees` for the full roster and `get_employee` for a finalist's full persona.";

function rosterRole(employee: Employee): string {
  const role = compactEmployeeRole(employee.persona) ?? employee.displayName;
  return role.replace(/[`|]/g, "").replace(/\s+/g, " ").trim();
}

function rosterRow(employee: Employee, includeEngine: boolean): string {
  const engine = includeEngine ? ` · ${employee.engine}` : "";
  return `- \`${employee.name}\` — ${rosterRole(employee)} · ${employee.department}${engine}`;
}

function stablePriority(
  names: string[],
  hierarchy: OrgHierarchy,
  score: (node: OrgNode) => number,
): string[] {
  return names
    .map((name, index) => ({ name, index, score: score(hierarchy.nodes[name]) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ name }) => name);
}

function topLevelRosterNames(hierarchy: OrgHierarchy, employee?: Employee): string[] {
  const executiveName = hierarchy.root ?? (employee?.rank === "executive" ? employee.name : null);
  const executive = executiveName ? hierarchy.nodes[executiveName] : undefined;
  const roots = hierarchy.sorted.filter((name) => hierarchy.nodes[name]?.parentName === null && name !== executiveName);
  const names = executive?.directReports.length
    ? [...executive.directReports, ...roots]
    : hierarchy.sorted.filter((name) => hierarchy.nodes[name]?.parentName === null);
  return [...new Set(names)].filter((name) => name !== employee?.name && hierarchy.nodes[name]);
}

function appendRosterGroup(
  lines: string[],
  heading: string,
  names: string[],
  hierarchy: OrgHierarchy,
  cap: number,
  jinnMcpAttached: boolean,
  includeEngine = false,
): void {
  if (names.length === 0 || cap === 0) return;
  const shown = names.slice(0, cap);
  lines.push("", `${heading}:`);
  for (const name of shown) lines.push(rosterRow(hierarchy.nodes[name].employee, includeEngine));
  const omitted = names.length - shown.length;
  if (omitted > 0) {
    lines.push(jinnMcpAttached ? `+${omitted} more — use \`list_employees\`.` : `+${omitted} more not shown.`);
  }
}

function renderScopedRoster(
  employee: Employee | undefined,
  hierarchy: OrgHierarchy | undefined,
  portalName: string,
  compact: boolean,
  jinnMcpAttached: boolean,
): string | null {
  if (!hierarchy || Object.keys(hierarchy.nodes).length === 0) return null;
  const lines = [WORKING_ROSTER_HEADING];

  if (!employee || employee.rank === "executive") {
    let names = topLevelRosterNames(hierarchy, employee);
    names = stablePriority(names, hierarchy, (node) => {
      if (node.directReports.length > 0) return 0;
      if (node.employee.rank === "manager") return 1;
      return 2;
    });

    if (employee?.rank === "executive") {
      const node = hierarchy.nodes[employee.name];
      if (node?.parentName && hierarchy.nodes[node.parentName]) {
        appendRosterGroup(lines, "Your manager", [node.parentName], hierarchy, 1, jinnMcpAttached);
      }
    }
    appendRosterGroup(lines, "Top-level employees", names, hierarchy, compact ? 6 : 20, jinnMcpAttached, true);
  } else {
    const node = hierarchy.nodes[employee.name];
    if (!node) return null;

    if (node.parentName && hierarchy.nodes[node.parentName]) {
      appendRosterGroup(lines, "Your manager", [node.parentName], hierarchy, 1, jinnMcpAttached);
    } else {
      lines.push("", "Your manager:", `- ${portalName} (COO) — Company coordination and escalation · company`);
    }

    const isReportHolder = node.directReports.length > 0;
    if (isReportHolder) {
      appendRosterGroup(lines, "Your direct reports", node.directReports, hierarchy, compact ? 4 : 12, jinnMcpAttached);

      const peerNames = node.parentName && hierarchy.nodes[node.parentName]
        ? hierarchy.nodes[node.parentName].directReports.filter((name) => name !== employee.name)
        : hierarchy.sorted.filter((name) => {
            const peer = hierarchy.nodes[name];
            return peer.parentName === null && name !== employee.name;
          });
      const prioritizedPeers = stablePriority(peerNames, hierarchy, (peer) => {
        if (peer.directReports.length > 0) return 0;
        if (peer.employee.rank === "manager") return 1;
        return 2;
      });
      appendRosterGroup(lines, "Your peers", prioritizedPeers, hierarchy, compact ? 0 : 6, jinnMcpAttached);
    } else {
      const siblingNames = node.parentName && hierarchy.nodes[node.parentName]
        ? hierarchy.nodes[node.parentName].directReports.filter((name) => name !== employee.name)
        : hierarchy.sorted.filter((name) => {
            const sibling = hierarchy.nodes[name];
            return sibling.parentName === null && name !== employee.name && sibling.employee.department === employee.department;
          });
      const prioritizedSiblings = stablePriority(
        siblingNames,
        hierarchy,
        (sibling) => sibling.employee.department === employee.department ? 0 : 1,
      );
      appendRosterGroup(lines, "Your siblings", prioritizedSiblings, hierarchy, compact ? 4 : 8, jinnMcpAttached);
    }
  }

  if (jinnMcpAttached) lines.push("", FULL_ROSTER_HINT);
  return lines.join("\n");
}

/** Build the bounded role-oriented slice injected into fresh session context. */
export function buildScopedRosterSection(
  employee: Employee | undefined,
  hierarchy: OrgHierarchy | undefined,
  portalName = "Jinn",
  jinnMcpAttached = false,
): string | null {
  return renderScopedRoster(employee, hierarchy, portalName, false, jinnMcpAttached);
}

function buildScopedRosterSummary(
  employee: Employee | undefined,
  hierarchy: OrgHierarchy | undefined,
  portalName: string,
  jinnMcpAttached: boolean,
): string {
  return renderScopedRoster(employee, hierarchy, portalName, true, jinnMcpAttached)
    ?? (jinnMcpAttached ? `${WORKING_ROSTER_HEADING}\n${FULL_ROSTER_HINT}` : WORKING_ROSTER_HEADING);
}

function buildOrgContext(
  hierarchy?: OrgHierarchy,
  jinnMcpAttached?: boolean,
): string | null {
  try {
    // GRS-017b diet: with the jinn belt attached, the pasted roster tree is
    // replaced by a short manifest pointing at the org tools. The employee
    // COUNT stays (cheap, orients scale); everything else is discoverable.
    if (jinnMcpAttached && hierarchy && Object.keys(hierarchy.nodes).length > 0) {
      const count = Object.keys(hierarchy.nodes).length;
      return [
        `## Organization (${count} employee(s))`,
        `Use MCP org tools for roster, personas, and reporting lines: list_employees, find_employees, get_employee.`,
        `Create or change employees through the company/management tools; keep normal MCP-attached company work on the tool surface.`,
      ].join("\n");
    }
    if (hierarchy && Object.keys(hierarchy.nodes).length > 0) {
      const MAX_DEPTH = 3;
      const count = Object.keys(hierarchy.nodes).length;
      const lines: string[] = [`## Organization (${count} employee(s))`];

      let deepCount = 0;
      for (const name of hierarchy.sorted) {
        const node = hierarchy.nodes[name];
        if (node.depth >= MAX_DEPTH) {
          deepCount++;
          continue;
        }
        const emp = node.employee;
        const indent = "  ".repeat(node.depth);
        lines.push(`${indent}- **${emp.displayName}** (${name}) — ${emp.department}, ${emp.rank}`);
      }
      if (deepCount > 0) {
        lines.push(`${"  ".repeat(MAX_DEPTH)}- ... and ${deepCount} more at deeper levels`);
      }

      lines.push(
        `\nFull persona/details: \`GET /api/org/employees/:name\` or the YAML under \`${ORG_DIR}/\`. ` +
        `Create new employees by writing YAML files there. ` +
        `For non-MCP maintenance, editing YAML in \`~/.jinn/org/\` is available; keep hand-editing roster files narrow and format-preserving.`,
      );
      return lines.join("\n");
    }

    // Fallback: filesystem-based flat rendering (backwards compat)
    // Recursively collect all employee yaml files (skip department.yaml)
    const employeeFiles: { fullPath: string; name: string }[] = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (
          (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
          entry.name !== "department.yaml"
        ) {
          employeeFiles.push({ fullPath, name: entry.name.replace(/\.ya?ml$/, "") });
        }
      }
    }

    scanDir(ORG_DIR);
    if (employeeFiles.length === 0) return null;

    const lines: string[] = [`## Organization (${employeeFiles.length} employee(s))`];
    for (const { fullPath, name } of employeeFiles) {
      const content = fs.readFileSync(fullPath, "utf-8");
      const displayMatch = content.match(/displayName:\s*(.+)/);
      const deptMatch = content.match(/department:\s*(.+)/);
      const rankMatch = content.match(/rank:\s*(.+)/);
      lines.push(`- **${displayMatch?.[1] || name}** (${name}) — ${deptMatch?.[1] || "unassigned"}, ${rankMatch?.[1] || "employee"}`);
    }
    lines.push(
      `\nFull persona/details: \`GET /api/org/employees/:name\` or the YAML under \`${ORG_DIR}/\`. ` +
      `Create new employees by writing YAML files there. ` +
      `For non-MCP maintenance, editing YAML in \`~/.jinn/org/\` is available; keep hand-editing roster files narrow and format-preserving.`,
    );
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Cron context: shows only enabled jobs inline, with a count of disabled jobs.
 * Previously listed all 77+ jobs; now only active ones are shown to save tokens.
 */
function buildCronContext(jinnMcpAttached = false): string | null {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    const jobs = JSON.parse(raw);
    if (!Array.isArray(jobs) || jobs.length === 0) return null;

    const enabled = jobs.filter((j: any) => j.enabled !== false);
    const disabledCount = jobs.length - enabled.length;
    if (jinnMcpAttached) {
      return [
        `## Scheduled cron jobs (${enabled.length} active, ${disabledCount} disabled)`,
        "Read schedules/status with `list_cron_jobs`; read runs with `get_cron_run_history { id }`. Schedule edits stay operator/COO operations.",
      ].join("\n");
    }

    const lines: string[] = [`## Scheduled cron jobs (${enabled.length} active, ${disabledCount} disabled)`];
    for (const job of enabled) {
      lines.push(`- **${job.name}**: \`${job.schedule}\`${job.employee ? ` → ${job.employee}` : ""}`);
    }
    if (disabledCount > 0) {
      lines.push(`\n_${disabledCount} disabled jobs not shown. See \`~/.jinn/cron/jobs.json\` for the full list._`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Knowledge context: lists filenames and sizes only — never inlines content.
 * The AI reads files on demand. This saves ~200K+ chars compared to full inlining.
 *
 * The listing (readdir + per-file stat over ~100 files) runs on every session
 * turn, so the built section is cached with a short TTL.
 */
const KNOWLEDGE_CACHE_TTL_MS = 30_000;
let knowledgeCache: { builtAt: number; value: string | null } | null = null;

/**
 * GRS-020b context diet: when the session's engine carries the built-in `jinn`
 * MCP toolset, the full per-file index (~1,200 tokens at the operator's real
 * scale) is replaced by this 2-line manifest — the agent searches on demand
 * instead of carrying the whole catalog every turn. Gated on the SAME
 * existence check as the index (no knowledge files → no section at all), and
 * non-attached sessions keep the index byte-identical (pinned in
 * mcp/__tests__/knowledge-diet.test.ts).
 */
const KNOWLEDGE_MCP_MANIFEST = [
  "## Knowledge base",
  "Search company knowledge in `knowledge/` + `docs/` with `search_knowledge`; `read_knowledge { path }` can read any relative file inside the Jinn instance.",
].join("\n");

function buildKnowledgeContext(jinnMcpAttached?: boolean): string | null {
  if (!knowledgeCache || Date.now() - knowledgeCache.builtAt >= KNOWLEDGE_CACHE_TTL_MS) {
    knowledgeCache = { builtAt: Date.now(), value: buildKnowledgeContextUncached() };
  }
  if (knowledgeCache.value === null) return null;
  return jinnMcpAttached ? KNOWLEDGE_MCP_MANIFEST : knowledgeCache.value;
}

function buildKnowledgeContextUncached(): string | null {
  const dirs = [
    { dir: DOCS_DIR, label: "docs" },
    { dir: path.join(JINN_HOME, "knowledge"), label: "knowledge" },
  ];
  const entries: { name: string; dir: string; sizeKb: string }[] = [];

  for (const { dir, label } of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f =>
        f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml"),
      );
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(dir, f));
          entries.push({
            name: f,
            dir: label,
            sizeKb: (stat.size / 1024).toFixed(1),
          });
        } catch {
          entries.push({ name: f, dir: label, sizeKb: "?" });
        }
      }
    } catch {
      // dir doesn't exist
    }
  }

  if (entries.length === 0) return null;

  const lines: string[] = [
    `## Knowledge base`,
    `Knowledge files are in \`~/.jinn/knowledge/\` and \`~/.jinn/docs/\`. Read them directly when needed.`,
    ``,
  ];

  // Group by directory
  for (const label of ["docs", "knowledge"]) {
    const group = entries.filter(e => e.dir === label);
    if (group.length === 0) continue;
    lines.push(`**${label}/** (${group.length} files):`);
    for (const e of group) {
      lines.push(`- \`${e.name}\` (${e.sizeKb} KB)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildConnectorContext(connectors: string[], gatewayUrl: string, jinnMcpAttached?: boolean): string {
  if (jinnMcpAttached) {
    return [
      `## Available connectors: ${connectors.join(", ")}`,
      `Use \`send_connector_message\` to send through a configured connector; connector configuration lives in \`config.yaml\`.`,
    ].join("\n");
  }
  return [
    `## Available connectors: ${connectors.join(", ")}`,
    `Send a message: \`curl -X POST ${gatewayUrl}/api/connectors/<id>/send -H "Authorization: Bearer $JINN_GATEWAY_TOKEN" -H 'Content-Type: application/json' -d '{"channel":"CHANNEL_ID","text":"message"}'\` (add \`"thread":"THREAD_TS"\` for a threaded reply).`,
    `Channel IDs are in \`~/.jinn/config.yaml\`. You may send proactively (completed tasks, errors, status updates). Details: CLAUDE.md / AGENTS.md.`,
  ].join("\n");
}

function buildEnvironmentContext(): string | null {
  return [
    "## Local environment",
    "When a task depends on local tools or projects, inspect them on demand in `~/.jinn/`, `~/.claude/`, `~/.codex/`, `~/.openclaw/`, and `~/Projects/` before concluding they are unavailable.",
  ].join("\n");
}

/**
 * Operator-aware onboarding directive, gated on portal.setupComplete.
 * Legacy installs that only have portal.onboarded are handled by buildContext.
 * Returns null once the setup conversation is complete — no repeat noise on steady-state sessions.
 */
export function buildOnboardingContext(opts: {
  portalName: string;
  operatorName?: string;
  setupComplete: boolean;
}): string | null {
  if (opts.setupComplete) return null;
  const { portalName, operatorName } = opts;
  const name = operatorName ? operatorName : "your operator";
  return [
    `## Onboarding mode`,
    `This is a fresh ${portalName} install and you have NOT yet completed onboarding ${operatorName ? `with ${operatorName}` : ""}.`,
    operatorName
      ? `You already know their name is **${operatorName}** (from setup) — greet them by name and DO NOT ask for their name again.`
      : `Ask the user's name once, then use it.`,
    `Run the **onboarding** skill (\`skills/onboarding/SKILL.md\`): a warm, multi-turn, game-like setup where you and ${name} get to know each other and build their org together. Speak in the second person.`,
    `Each beat must offer an explicit skip ("just say 'skip' or 'later'"). Never trap ${name}.`,
    `When onboarding wraps, set \`portal.setupComplete: true\` in \`config.yaml\` so this never repeats.`,
  ].join("\n");
}

/**
 * Audience-scoped Gateway API reference. The FULL endpoint table lives in
 * CLAUDE.md/AGENTS.md (auto-loaded by every engine) — injecting it here too
 * was pure duplication. What remains dynamic is the live base URL and the
 * short list of calls each audience actually makes.
 */
function buildApiReference(
  gatewayUrl: string,
  portalName: string,
  employee?: Employee,
  directReportCount = 0,
  jinnMcpAttached?: boolean,
): string {
  const header = `## ${portalName} Gateway API (base URL: ${gatewayUrl})`;
  if (jinnMcpAttached) {
    return [
      header,
      `Use the attached Jinn MCP tools for company operations (sessions, delegation, Todos, Workflows, org, reference reads, and managed files).`,
      `Use \`publish_attachment\` to present a local file or image in this chat. Viewing a file yourself does not send it to the operator.`,
      `The full HTTP endpoint reference remains in CLAUDE.md / AGENTS.md for gateway maintenance and non-MCP fallback.`,
    ].join("\n");
  }
  const authLine =
    `Privileged endpoints (everything below) require auth: add \`-H "Authorization: Bearer $JINN_GATEWAY_TOKEN"\`. \`$JINN_GATEWAY_TOKEN\`, \`$JINN_GATEWAY_URL\` (base URL), and \`$JINN_SESSION_ID\` are already exported in your environment — use them directly. For privileged calls made from inside this session, also add \`-H "X-Jinn-Session-Id: $JINN_SESSION_ID"\` so restart/interrupt accounting can identify this turn. (The web UI authenticates via cookie instead.)`;
  const attachmentsLine =
    `- Push a file/image into this chat (web view): \`curl -X POST "$JINN_GATEWAY_URL"/api/sessions/<your-session-id>/attachments -H "Authorization: Bearer $JINN_GATEWAY_TOKEN" -H 'Content-Type: application/json' -d '{"path":"/abs/path","text":"caption"}'\``;
  if (!employee) {
    return `${header}\n${authLine}\nThe full endpoint reference is in CLAUDE.md / AGENTS.md (auto-loaded). Substitute the base URL above.\n${attachmentsLine}`;
  }
  // Anyone who manages reports needs the delegation endpoints — rank alone undercounts (seniors can have reportsTo'd reports).
  if (employee.rank === "manager" || employee.rank === "executive" || directReportCount > 0) {
    return [
      header,
      authLine,
      `- Delegate to another employee: \`curl -X POST "$JINN_GATEWAY_URL"/api/sessions -H "Authorization: Bearer $JINN_GATEWAY_TOKEN" -H 'Content-Type: application/json' -d '{"prompt":"...","employee":"...","parentSessionId":"<your-id>"}'\``,
      `- Follow up on a child session: \`POST "$JINN_GATEWAY_URL/api/sessions/:id/message"\` with \`{message}\` (same auth header)`,
      `- Read a child's latest replies: \`GET "$JINN_GATEWAY_URL/api/sessions/:id?last=N"\` (same auth header)`,
      `- Valid \`employee\` values are the slugs in your chain of command, \`GET "$JINN_GATEWAY_URL/api/org"\`, or \`ls ${ORG_DIR}/\``,
      `- Non-MCP org maintenance: editing YAML in \`~/.jinn/org/\` is available for hand-editing roster files when needed.`,
      attachmentsLine,
      `Full endpoint table: CLAUDE.md / AGENTS.md.`,
    ].join("\n");
  }
  return [header, authLine, attachmentsLine, `Full endpoint table: CLAUDE.md / AGENTS.md.`].join("\n");
}

/**
 * Progressive trimming by tier. Summaries preserve orientation first, then
 * oversized essentials are compacted before lower tiers are omitted. An exact
 * final bound handles pathological configurations.
 */
function trimContext(sections: Section[], maxChars: number): string {
  if (maxChars === 0) return "";

  const parts: Array<string | null> = sections.map(s => s.content);
  const assemble = (): string => parts.filter((part): part is string => Boolean(part)).join("\n\n");
  let result = assemble();
  if (result.length <= maxChars) return result;

  // Preserve orientation with compact summaries before omitting whole tiers.
  // Oversized personas and voice instructions can dominate the budget. Compact
  // them before dropping summarized orientation such as the scoped roster.
  for (let i = sections.length - 1; i >= 0; i--) {
    if (result.length <= maxChars) break;
    if (sections[i].tier === Tier.ESSENTIAL && sections[i].summary) {
      parts[i] = sections[i].summary;
      result = assemble();
    }
  }

  for (const tier of [Tier.OPTIONAL, Tier.STANDARD]) {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (result.length <= maxChars) break;
      if (sections[i].tier === tier && sections[i].summary) {
        parts[i] = sections[i].summary;
        result = assemble();
      }
    }
  }

  for (const tier of [Tier.OPTIONAL, Tier.STANDARD]) {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (result.length <= maxChars) break;
      if (sections[i].tier === tier) {
        parts[i] = null;
        result = assemble();
      }
    }
  }

  if (result.length <= maxChars) return result;

  const marker = "\n\n[Context truncated to context.maxChars]";
  if (maxChars <= marker.length) return result.slice(0, maxChars);
  return `${result.slice(0, maxChars - marker.length).trimEnd()}${marker}`.slice(0, maxChars);
}
