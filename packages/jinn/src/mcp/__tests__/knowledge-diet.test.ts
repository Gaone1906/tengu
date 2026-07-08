import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * GRS-020b — THE KNOWLEDGE-INDEX DIET, MEASURED (this slice's acceptance,
 * mirroring the 017b method in context-diet.test.ts).
 *
 * Method: seed the temp JINN_HOME with a knowledge library at the operator's
 * real scale (~100 knowledge files + 8 docs), build the REAL bootstrap twice —
 * `jinnMcpAttached: false` (today's per-file index) vs `true` (the 2-line
 * manifest) — and compare the saving against the tools/list schema cost of
 * the two knowledge tools this slice adds. Tokens = ceil(chars/4), applied
 * identically to both sides.
 *
 * Pins:
 *   1. BYTE-IDENTITY for non-attached sessions: flag false === flag absent,
 *      AND the index block matches the legacy format exactly (reconstructed
 *      from the same directory listing).
 *   2. The index is genuinely GONE when attached (no filename survives), the
 *      manifest points at search_knowledge.
 *   3. SLICE GATE: saving − (2 knowledge tool schemas) > 0.
 */

// Isolated home BEFORE imports (paths.ts resolves JINN_HOME at module load).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-knowledge-diet-home-"));
process.env.JINN_HOME = home;

type ContextMod = typeof import("../../sessions/context.js");
type ServerMod = typeof import("../server.js");

let buildContext: ContextMod["buildContext"];
let buildTools: ServerMod["buildTools"];

const KNOWLEDGE_COUNT = 100;
const DOCS_COUNT = 8;

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Realistic filename shapes + sizes (the live library averages ~13 KB/file). */
function seedLibrary(): void {
  fs.mkdirSync(path.join(home, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(home, "docs"), { recursive: true });
  for (let i = 0; i < KNOWLEDGE_COUNT; i++) {
    const name = `research-topic-${String(i).padStart(3, "0")}-competitive-landscape-2026.md`;
    fs.writeFileSync(path.join(home, "knowledge", name), `# Topic ${i}\n\n${"x".repeat(8_000 + i * 50)}\n`);
  }
  for (let i = 0; i < DOCS_COUNT; i++) {
    fs.writeFileSync(path.join(home, "docs", `platform-area-${i}.md`), `# Area ${i}\n\n${"y".repeat(2_000)}\n`);
  }
}

beforeAll(async () => {
  seedLibrary();
  ({ buildContext } = await import("../../sessions/context.js"));
  ({ buildTools } = await import("../server.js"));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config: any = {
  gateway: { port: 7777 },
  engines: { default: "codex" },
  // No trimming — the measurement compares full prompts.
  context: { maxChars: 1_000_000 },
};

function buildBootstrap(jinnMcpAttached?: boolean): string {
  return buildContext({
    source: "web",
    channel: "web:test",
    user: "operator",
    sessionId: "knowledge-diet-session",
    config,
    ...(jinnMcpAttached === undefined ? {} : { jinnMcpAttached }),
  });
}

/** The legacy index block, reconstructed byte-for-byte from the same listing
 *  the builder reads — pins that non-attached output kept the exact format. */
function expectedLegacyIndex(): string {
  const lines: string[] = [
    "## Knowledge base",
    "Knowledge files are in `~/.jinn/knowledge/` and `~/.jinn/docs/`. Read them directly when needed.",
    "",
  ];
  for (const label of ["docs", "knowledge"]) {
    const files = fs
      .readdirSync(path.join(home, label))
      .filter((f) => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".yaml"));
    lines.push(`**${label}/** (${files.length} files):`);
    for (const f of files) {
      const stat = fs.statSync(path.join(home, label, f));
      lines.push(`- \`${f}\` (${(stat.size / 1024).toFixed(1)} KB)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function schemaTokens(names?: string[]): number {
  const tools = buildTools()
    .filter((t) => !names || names.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  return approxTokens(JSON.stringify(tools));
}

const NEW_IN_THIS_SLICE = ["search_knowledge", "read_knowledge"];

describe("the measured knowledge-index diet", () => {
  it("flag off (or absent) leaves the bootstrap byte-identical, including the exact legacy index format", () => {
    const off = buildBootstrap(false);
    const absent = buildBootstrap(undefined);
    expect(off).toBe(absent);
    expect(off).toContain(expectedLegacyIndex().trimEnd());
    expect(off).toContain("research-topic-042-competitive-landscape-2026.md");
  });

  it("with the belt attached, the index is genuinely GONE and the manifest points at the tools", () => {
    const before = buildBootstrap(false);
    const after = buildBootstrap(true);
    expect(before).toContain("research-topic-042-competitive-landscape-2026.md");
    expect(after).not.toContain("research-topic-042-competitive-landscape-2026.md");
    expect(after).not.toContain("platform-area-3.md");
    expect(after).not.toContain("(100 files)");
    expect(after).toContain("## Knowledge base");
    expect(after).toContain("search_knowledge");
    expect(after).toContain("read_knowledge { path }");
  });

  it("SLICE GATE: the index saving exceeds the schema cost of the two knowledge tools", () => {
    const before = approxTokens(buildBootstrap(false));
    const after = approxTokens(buildBootstrap(true));
    const saving = before - after;
    const cost = schemaTokens(NEW_IN_THIS_SLICE);
    expect(saving).toBeGreaterThan(0);
    expect(saving - cost).toBeGreaterThan(0);
  });

  it("prints the measurement ledger (the committed snapshot's source)", () => {
    const before = approxTokens(buildBootstrap(false));
    const after = approxTokens(buildBootstrap(true));
    const measurement = {
      method: `approxTokens = ceil(chars/4); ${KNOWLEDGE_COUNT} knowledge + ${DOCS_COUNT} docs files (operator scale)`,
      bootstrap: { before, after, saving: before - after },
      schemaCosts: { knowledgeTools: schemaTokens(NEW_IN_THIS_SLICE), fullBelt: schemaTokens() },
      ledger: { sliceGate_savingMinusKnowledgeTools: before - after - schemaTokens(NEW_IN_THIS_SLICE) },
    };
    // eslint-disable-next-line no-console
    console.log(`GRS-020b-DIET-MEASUREMENT ${JSON.stringify(measurement, null, 2)}`);
    expect(measurement.ledger.sliceGate_savingMinusKnowledgeTools).toBeGreaterThan(0);
  });
});
