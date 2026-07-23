import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import { resolveJinnHome } from "../shared/paths.js";
import { workflowDefinitionSchema, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from "./model.js";

type LogLevel = "info" | "warn";
type LegacyRecord = Record<string, unknown>;

export interface LegacyWorkflowImportOptions {
  legacyDirectory?: string;
  log?: (level: LogLevel, message: string) => void;
}

export interface LegacyWorkflowImportResult {
  imported: number;
  failed: number;
  skipped: boolean;
}

function record(value: unknown, subject: string): LegacyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object`);
  return value as LegacyRecord;
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${subject} must be a non-empty string`);
  return value;
}

function fixed<T extends string>(value: T) {
  return { source: "fixed" as const, value };
}

function position(value: unknown): { x: number; y: number } {
  const item = record(value, "node position");
  if (typeof item.x !== "number" || !Number.isFinite(item.x)
    || typeof item.y !== "number" || !Number.isFinite(item.y)) {
    throw new Error("node position must contain finite x/y coordinates");
  }
  return { x: item.x, y: item.y };
}

function node(value: unknown): { node: WorkflowNode; position: { x: number; y: number } } {
  const item = record(value, "node");
  const id = text(item.id, "node id");
  const name = text(item.label, `node ${id} label`);
  const coordinates = position(item.position);
  if (item.type === "trigger") {
    const trigger = record(item.trigger, `trigger ${id}`);
    if (trigger.kind !== "manual") throw new Error(`trigger ${id} uses unsupported kind ${String(trigger.kind)}`);
    return { node: { id, type: "trigger", name, config: { kind: "manual" } }, position: coordinates };
  }
  if (item.type !== "step") throw new Error(`node ${id} uses unsupported type ${String(item.type)}`);
  const actor = record(item.actor, `step ${id} actor`);
  const actorKind = text(actor.kind, `step ${id} actor kind`);
  const actorRef = text(actor.ref, `step ${id} actor ref`);
  if (actorKind !== "employee" && actorKind !== "engine") throw new Error(`step ${id} uses unsupported actor kind ${actorKind}`);
  const options = item.options === undefined ? {} : record(item.options, `step ${id} options`);
  const retry = options.retry === undefined ? undefined : record(options.retry, `step ${id} retry`);
  const maxAttempts = retry?.maxAttempts;
  const timeoutMinutes = options.timeoutMinutes;
  const effort = typeof options.effort === "string"
    && ["low", "medium", "high", "xhigh"].includes(options.effort)
    ? options.effort as "low" | "medium" | "high" | "xhigh"
    : undefined;
  const config = {
    employee: fixed(actorRef),
    prompt: typeof item.instructions === "string" && item.instructions ? item.instructions : `Run ${name}.`,
    ...(actorKind === "engine" ? { engine: fixed(actorRef) } : {}),
    ...(typeof options.model === "string" ? { model: fixed(options.model) } : {}),
    ...(effort ? { effort: fixed(effort) } : {}),
    ...(Number.isInteger(maxAttempts) ? { retry: { attempts: maxAttempts as number, delaySeconds: 0, backoff: "fixed" as const } } : {}),
    ...(Number.isInteger(timeoutMinutes) ? { timeoutMinutes: timeoutMinutes as number } : {}),
  };
  return { node: { id, type: "employee", name, config }, position: coordinates };
}

function edge(value: unknown): WorkflowEdge {
  const item = record(value, "edge");
  const id = text(item.id, "edge id");
  return {
    id,
    from: { nodeId: text(item.from, `edge ${id} source`), port: item.lane === "error" ? "error" : "success" },
    to: { nodeId: text(item.to, `edge ${id} target`), port: "input" },
  };
}

function convert(value: unknown): WorkflowDefinition {
  const legacy = record(value, "legacy Workflow definition");
  const id = text(legacy.id, "Workflow id");
  const title = text(legacy.title, `Workflow ${id} title`);
  if (!Array.isArray(legacy.nodes) || !Array.isArray(legacy.edges)) throw new Error("nodes and edges must be arrays");
  const converted = legacy.nodes.map(node);
  const stamp = typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString();
  const revision = Number.isInteger(legacy.version) && (legacy.version as number) > 0 ? legacy.version as number : 1;
  const definition = {
    schemaVersion: 1,
    id,
    title,
    ...(typeof legacy.description === "string" ? { description: legacy.description } : {}),
    revision,
    enabled: false,
    nodes: converted.map((item) => item.node),
    edges: legacy.edges.map(edge),
    ui: { positions: Object.fromEntries(converted.map((item) => [item.node.id, item.position])) },
    createdAt: stamp,
    updatedAt: stamp,
  };
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "converted definition is invalid");
  return parsed.data;
}

export function importLegacyWorkflowDefinitions(
  db: Database.Database,
  options: LegacyWorkflowImportOptions = {},
): LegacyWorkflowImportResult {
  const existing = db.prepare("SELECT count(*) FROM workflow_definitions").pluck().get() as number;
  if (existing !== 0) return { imported: 0, failed: 0, skipped: true };
  const directory = options.legacyDirectory
    ?? path.join(resolveJinnHome(), "workflow-evidence", "workflows");
  if (!existsSync(directory)) return { imported: 0, failed: 0, skipped: true };
  const files = readdirSync(directory).filter((name) => name.endsWith(".definition.json")).sort();
  if (files.length === 0) return { imported: 0, failed: 0, skipped: true };
  const log = options.log ?? ((level: LogLevel, message: string) => logger[level](message));
  let imported = 0;
  let failed = 0;
  const insert = db.prepare(`INSERT INTO workflow_definitions
    (id,title,revision,enabled,retired_at,definition_json,created_at,updated_at)
    VALUES (@id,@title,@revision,0,NULL,@json,@createdAt,@updatedAt)`);
  for (const file of files) {
    const fallbackId = file.slice(0, -".definition.json".length);
    try {
      const definition = convert(JSON.parse(readFileSync(path.join(directory, file), "utf8")));
      db.transaction(() => insert.run({
        id: definition.id,
        title: definition.title,
        revision: definition.revision,
        json: JSON.stringify(definition),
        createdAt: definition.createdAt,
        updatedAt: definition.updatedAt,
      })).immediate();
      imported += 1;
      log("info", `[workflows] imported legacy Workflow ${definition.id} as a disabled v2 draft`);
    } catch (error) {
      failed += 1;
      log("warn", `[workflows] failed to import legacy Workflow ${fallbackId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { imported, failed, skipped: false };
}
