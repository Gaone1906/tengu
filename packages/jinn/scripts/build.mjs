#!/usr/bin/env node
/**
 * Cross-platform build for jinn-cli.
 *
 * This was a shell one-liner (`rm -rf … && tsc && mkdir -p … && cp …`). npm and
 * pnpm run package scripts through the platform shell, which on Windows is cmd —
 * where none of those commands exist, so `pnpm build` failed with "The syntax of
 * the command is incorrect" and the repo could not be built there at all. Node's
 * own fs APIs do the same work on every platform.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEventsRoot = path.resolve(packageRoot, "../gateway-events");
const dist = path.join(packageRoot, "dist");
const require = createRequire(import.meta.url);

/** Run TypeScript's own entry with the current Node. Resolving the JS entry
 *  instead of the `tsc` shim keeps this shell-free, which avoids both the
 *  Windows .CMD resolution problem and shell argument concatenation. */
function runTsc(args, cwd = packageRoot) {
  const tsc = require.resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. Build the neutral protocol explicitly. A package-local CLI build must not
//    depend on an ignored workspace dist left behind by a prior root build.
runTsc(["-p", "tsconfig.json"], gatewayEventsRoot);

// 2. Clear only the compiled output. dist/web is produced separately by
//    scripts/sync-web-dist.mjs and must survive a package rebuild.
for (const dir of ["bin", "src"]) {
  fs.rmSync(path.join(dist, dir), { recursive: true, force: true });
}

// 3. Compile.
runTsc(["-p", "tsconfig.build.json"]);

// 4. Embed the neutral gateway protocol runtime and declaration. Backend source
//    consumes the workspace package through src/shared/gateway-events.ts, but
//    jinn-cli is published independently. Copying both canonical artifacts into
//    that relative module keeps shipped JavaScript and declarations aligned.
const gatewayEventsRuntime = path.join(gatewayEventsRoot, "dist", "index.js");
const gatewayEventsDeclaration = path.join(gatewayEventsRoot, "dist", "index.d.ts");
const embeddedGatewayEventsRuntime = path.join(dist, "src", "shared", "gateway-events.js");
const embeddedGatewayEventsDeclaration = path.join(dist, "src", "shared", "gateway-events.d.ts");
const runtimeText = fs.readFileSync(gatewayEventsRuntime, "utf8")
  .replace(/\n?\/\/# sourceMappingURL=index\.js\.map\s*$/, "\n");
const declarationText = fs.readFileSync(gatewayEventsDeclaration, "utf8")
  .replace(/\n?\/\/# sourceMappingURL=index\.d\.ts\.map\s*$/, "\n");
fs.writeFileSync(embeddedGatewayEventsRuntime, runtimeText);
fs.writeFileSync(embeddedGatewayEventsDeclaration, declarationText);
fs.rmSync(`${embeddedGatewayEventsRuntime}.map`, { force: true });
fs.rmSync(`${embeddedGatewayEventsDeclaration}.map`, { force: true });

// 5. Copy the Talk assets tsc does not emit (Markdown + Python live beside the
//    TypeScript). Missing files are not an error: they are optional extras.
const talkSource = path.join(packageRoot, "src", "talk");
const talkTarget = path.join(dist, "src", "talk");
fs.mkdirSync(talkTarget, { recursive: true });
let copied = 0;
try {
  for (const entry of fs.readdirSync(talkSource)) {
    if (!/\.(md|py)$/i.test(entry)) continue;
    fs.copyFileSync(path.join(talkSource, entry), path.join(talkTarget, entry));
    copied += 1;
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log(`build: compiled to dist/, embedded gateway protocol, copied ${copied} talk asset(s)`);
