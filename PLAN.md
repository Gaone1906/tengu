# ICI-676 round 3 — share the STT *settings*, not just the model file

Branch `build/ICI-676-shared-stt-settings` off `df6f409a` (main).

## What already shipped, and why the Todo came back

Round 1/2 moved the Whisper model out of `JINN_HOME/models/whisper` into the host data
dir (`~/Library/Application Support/Jinn/models/whisper`), with legacy adoption on boot.
That landed at `bd427c52` and it works. Verified live, read-only, before planning:

- shared dir holds `ggml-small.bin` (adopted 2026-08-03 17:46, matching the 7777 boot time)
- a simulated foreign `JINN_HOME` resolves the shared dir and reports `available: true`
- `GET /api/stt/status` on **7850** → `{"available":true,"model":"small",...,"languages":["en"]}`
- `GET /api/stt/status` on **7860** → identical

So the download prompt the Todo describes is gone. The operator re-armed the Todo with no
comment, so the requirement is still the Todo body: *"only .jinn has the STT capability …
fix that so that it is shared easily. KISS."*

What is still per-instance is the **STT settings block**:

| | `~/.jinn/config.yaml` | every other instance |
|---|---|---|
| `stt.enabled` | `true` | absent |
| `stt.model` | `small` | absent → default `small` |
| `stt.languages` | `[en, bg]` | absent → default `["en"]` |

`packages/jinn/template/config.yaml` ships no `stt` block, so a new instance never gets one.
Consequence on every non-`.jinn` instance: the language pill never renders
(`chat-input.tsx` / `note-mic.tsx` gate on `stt.languages.length > 1`) and every dictation is
forced through `-l en`. The operator dictates in Bulgarian. That is the live remainder of
"only .jinn has the STT capability".

Adjacent, reported not fixed: `~/.jinn/config.yaml` line 220 sets `stt.modelsDir:
~/.jinn/models/whisper/`. `modelsDir` is read by **no code in the repo** — grep across
`packages/**` returns nothing, and it is not in the `stt` type in `shared/types.ts`. It is
silently ignored. We deliberately do **not** start honouring it: its current value points
back into `~/.jinn`, so honouring it would re-break the fix that already landed. The
operator should delete that line; flagged on the Todo.

## The change

Mirror the shape that already shipped for the model file — one host-level artefact, with
the per-home value treated as a legacy seed.

**New `packages/jinn/src/stt/settings-store.ts`**

- `resolveSttSettingsPath(options)` → `<hostDataDir>/stt.json`, `JINN_STT_SETTINGS` env
  override for tests. Same `HostPathOptions` shape as `resolveSttModelsDir`.
- `readSharedSttSettings(path)` → `{ enabled?, model?, languages? } | null`. Unknown keys
  dropped. Malformed / unreadable → `null` (warn, never throw — this runs at boot).
- `writeSharedSttSettings(path, settings)` → atomic `tmp` + `rename`, mode `0600`, matching
  `writeDirectory` in `instances/directory.ts`. Several gateways share this file.
- `seedSharedSttSettings(path, localStt)` → create-only (`wx`). No-ops when the file exists
  or when `localStt` is empty, so an instance with no `stt` block can never seed.
- `resolveEffectiveSttSettings(shared, localStt)` → shared wins when present; otherwise the
  local block; otherwise `{ model: "small", languages: ["en"] }`. One source of truth, which
  is the KISS the Todo asks for.

**Wiring**

- `stt/stt.ts` — `initStt()` also seeds the shared settings file from `config.stt`.
- `gateway/api.ts`
  - `GET /api/stt/status` — resolve effective settings instead of reading `config.stt` alone.
  - `POST /api/stt/download` — on success write `{enabled:true, model}` to the shared file
    instead of the instance's `config.yaml`.
  - `PUT /api/stt/config` — write `languages` to the shared file.
  - `POST /api/stt/transcribe` — pick model/language from effective settings.
- `shared/paths.ts` — export `STT_SETTINGS_FILE` next to `STT_MODELS_DIR`.

No UI change. Once a secondary instance reports two languages the existing pill renders
itself.

## Acceptance criteria

1. `resolveSttSettingsPath()` resolves inside the host data dir and outside every
   `JINN_HOME`; two different homes resolve to the same absolute path.
2. With a shared settings file present, `GET /api/stt/status` on an instance whose
   `config.yaml` has **no** `stt` block returns the shared `model` and `languages`.
3. On boot, an instance whose `config.yaml` *has* an `stt` block creates the shared file
   when it is absent, carrying only `enabled` / `model` / `languages`.
4. Seeding never overwrites an existing shared file, and an instance with no `stt` block
   never creates one.
5. `PUT /api/stt/config {languages:[...]}` writes the shared file atomically; a second
   gateway on a different home returns the new languages from `GET /api/stt/status`
   **without a restart**.
6. `POST /api/stt/download` success records `{enabled:true, model}` into the shared file.
7. A malformed or unreadable shared file degrades to `{model:"small", languages:["en"]}`
   with a warning; `initStt()` does not throw.
8. No shared file and no local `stt` block still yields `model: "small"`,
   `languages: ["en"]` — unchanged from today.
9. Two sandbox gateways on separate throwaway `JINN_HOME`s and non-prod ports (7778+) both
   report identical `languages` from the shared file; changing languages on one is visible
   on the other's next `GET /api/stt/status`. Evidence: both status JSONs, before and after.
10. `pnpm typecheck` clean. `pnpm --filter jinn-cli test` reports **zero failed tests**; any
    file that fails is re-run alone to prove it was machine load, per the round-2 finding
    that the full shared gate is unreliable under pipeline parallelism. The web suite is
    excluded by diffstat — this change touches no web file.

## Tests

`packages/jinn/src/stt/__tests__/settings-store.test.ts` — unit, `tmpdir`-scoped, no network:
path resolution across two homes (AC1); read of a valid file, an unknown-key file, a
malformed file, a missing file (AC7); create-only seeding, including the file-exists and
empty-local no-ops (AC3, AC4); atomic write leaves no `.tmp` behind and preserves the old
content when the write throws (AC5); precedence table for
`resolveEffectiveSttSettings` covering shared-only, local-only, both, neither (AC2, AC8).

Per taste §5.1: AC5's "a second instance sees it without a restart" gets a test that fails
before the wiring change — the handler writes `config.yaml` today, so a test asserting the
shared file changed goes red on the current code first, then green.

API handler coverage for AC2/AC5/AC6 goes in the existing gateway API test file if one
already covers `/api/stt/*`; otherwise the store-level tests plus the two-gateway sandbox
run in AC9 carry it, rather than standing up a new API harness for three endpoints.

## Out of scope

- Any UI change.
- Honouring `stt.modelsDir` (see above) — reported, not built.
- Sharing the `whisper-cli` / `ffmpeg` installs. Those are machine-level already.
- TTS / `talk` settings.
- The `packages/web` test suite and any pre-existing full-suite flake outside these files.
- Reaching into another instance's `JINN_HOME` at runtime.

## Safety

Ports 7777 and 7788 untouched. QA runs on throwaway `JINN_HOME`s at 7778+ via
`jinn-sandbox`, each `config.yaml` port-checked before boot, destroyed afterwards even on
failure. `JINN_STT_SETTINGS` and `JINN_STT_MODELS_DIR` point at scratch paths during QA so
the host-shared `stt.json` and the real 487 MB model are never written to or moved. Only
PIDs we started get killed. Leak-grep the staged diff before commit — no real names,
  project names, or absolute home paths under `packages/**`.
