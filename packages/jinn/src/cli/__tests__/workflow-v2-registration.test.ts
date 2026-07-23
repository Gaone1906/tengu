import fs from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { buildProgram } from "../../../bin/jinn.js";

const EXPECTED: Record<string, string[]> = {
  list: ["--cursor", "--limit", "--json"], get: ["--json"], create: ["--file", "--json"],
  update: ["--file", "--expected-revision", "--json"], duplicate: ["--id", "--title", "--json"],
  retire: ["--expected-revision", "--json"], enable: ["--expected-revision", "--json"],
  disable: ["--expected-revision", "--json"], run: ["--input", "--idempotency-key", "--json"],
  runs: ["--cursor", "--limit", "--status", "--json"], "show-run": ["--json"],
  cancel: ["--reason", "--json"], rerun: ["--definition", "--idempotency-key", "--json"],
  approve: ["--expected-revision", "--reason", "--json"], reject: ["--expected-revision", "--reason", "--json"],
  retry: ["--idempotency-key", "--json"],
  event: ["--fire-id", "--payload", "--json"],
};

describe("Workflow v2 Commander registration", () => {
  it("keeps every CLI FunctionLike within the Task14 KISS caps", () => {
    const file = new URL("../../../bin/jinn.ts", import.meta.url);
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const violations: string[] = [];
    const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);
    const visit = (node: ts.Node): void => {
      if (isFunctionLike(node)) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        const name = node.name && ts.isIdentifier(node.name) ? node.name.text : `${ts.SyntaxKind[node.kind]}@${start}`;
        if (end - start + 1 > 80) violations.push(`${name}: ${end - start + 1} lines`);
        if (node.parameters.length > 5) violations.push(`${name}: ${node.parameters.length} positional params`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(violations).toEqual([]);
  });

  it("builds every command with the exact Task14 flags", () => {
    const workflow = buildProgram().commands.find((command) => command.name() === "workflow")!;
    expect(workflow.commands.map((command) => command.name())).toEqual(Object.keys(EXPECTED));
    for (const command of workflow.commands) {
      const flags = command.options.map((option) => option.long);
      expect(flags, command.name()).toEqual(EXPECTED[command.name()]);
      expect(command.helpInformation()).toContain(`Usage: jinn workflow ${command.name()}`);
    }
  });

  it.each(Object.keys(EXPECTED))("parses workflow %s --help without loading a handler", (name) => {
    const program = buildProgram();
    const override = (command: typeof program): void => { command.exitOverride(); for (const child of command.commands) override(child); };
    override(program);
    program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
    expect(() => program.parse(["node", "jinn", "workflow", name, "--help"]))
      .toThrow(expect.objectContaining({ code: "commander.helpDisplayed" }));
  });
});
