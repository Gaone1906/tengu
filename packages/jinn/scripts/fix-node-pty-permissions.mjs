// Restore the executable bit on node-pty's spawn-helper at install time.
//
// On macOS/Linux node-pty does not merely load `pty.node`; it `posix_spawn`s a
// sibling binary called `spawn-helper`. node-pty 1.x ships that helper inside
// its published tarball WITHOUT the executable bit, so without this repair every
// pty spawn dies with `posix_spawnp failed.` — a message that names neither the
// file nor the permission problem.
//
// LAYOUTS. node-pty resolves its native artifacts from `build/Release`, then
// `build/Debug`, then `prebuilds/<platform>-<arch>` (its lib/utils.js), and
// `spawn-helper` sits next to whichever `pty.node` was loaded. Which layout
// exists depends on how the package was installed:
//
//   * plain `npm install`   → prebuilds/ only, spawn-helper at mode 0644
//   * `--build-from-source` → node-pty compiles and DELETES prebuilds/, leaving
//                             build/Release with correct modes already
//
// Homebrew always passes --build-from-source, so the earlier version of this
// script — which assumed prebuilds/ existed and threw otherwise — failed the
// whole `brew install` with ENOENT. Every known layout is checked here, and a
// layout without a spawn-helper is not an error.
//
// NEVER FATAL. A permission fix-up must not be able to fail an install. When it
// cannot do its job it warns, and `repairNodePtySpawnHelper()` in
// src/shared/runtime-guard.ts repairs the same file at startup — which is also
// the only layer that helps an install where this script never ran at all.
import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform === "win32") process.exit(0); // no exec bit, no spawn-helper

const require = createRequire(import.meta.url);

let nodePtyRoot;
try {
  nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
} catch {
  process.stderr.write(
    "jinn-cli postinstall: node-pty not resolvable, skipping spawn-helper repair\n",
  );
  process.exit(0);
}

// Kept in sync with spawnHelperCandidates() in src/shared/runtime-guard.ts.
// Both darwin arches are listed because a workspace can be installed on one
// machine and mounted on another.
const candidates = [
  join(nodePtyRoot, "build", "Release", "spawn-helper"),
  join(nodePtyRoot, "build", "Debug", "spawn-helper"),
  join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  join(nodePtyRoot, "prebuilds", "darwin-arm64", "spawn-helper"),
  join(nodePtyRoot, "prebuilds", "darwin-x64", "spawn-helper"),
];

let seen = 0;
let repaired = 0;

for (const helper of new Set(candidates)) {
  let mode;
  try {
    mode = (await stat(helper)).mode;
  } catch {
    continue; // not this layout
  }
  seen += 1;
  if ((mode & 0o111) === 0o111) continue; // already executable
  try {
    await chmod(helper, (mode & 0o7777) | 0o755);
    repaired += 1;
  } catch (error) {
    process.stderr.write(
      `jinn-cli postinstall: could not chmod ${helper} (${error?.message ?? error}); ` +
        "jinn will retry this at startup\n",
    );
  }
}

if (seen === 0) {
  process.stderr.write(
    `jinn-cli postinstall: no node-pty spawn-helper found under ${nodePtyRoot}; ` +
      "jinn will retry this at startup\n",
  );
}

if (process.env.npm_config_loglevel === "verbose") {
  process.stdout.write(
    `jinn-cli postinstall: ${repaired} spawn-helper(s) repaired of ${seen} found\n`,
  );
}
