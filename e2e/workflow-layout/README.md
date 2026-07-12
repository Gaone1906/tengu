# Workflow layout browser verification

This suite is deliberately excluded from the default Playwright config. Run it only through `scripts/verify-workflow-layout.sh`; the wrapper creates a fake `HOME`, an isolated instance registry, a fresh Jinn home, and a candidate gateway on an explicit port at or above 8060 (8060 by default). Port 7777 and every non-sandbox origin/home are refused.

The five GPT-5.5-low author probes are additionally opt-in with `--with-authors` and require `JINN_IMPLEMENTATION_GREEN=1`. Their session database, Codex overlays, and definitions stay beneath the throwaway sandbox home. Traces and video are disabled because authorization headers must not enter retained artifacts.

The wrapper preflights both free bytes and free inodes before creating anything. The retained artifact tree keeps all sanitized environment, fixture, author, per-cell geometry/accessibility, and interaction metrics, plus exactly 64 screenshots of deterministic evidence: every canonical shape across all eight cells, dark/normal desktop+mobile run and manual states, two high-value gesture frames, and authorized/unauthorized approval evidence. Screenshots remain capped at 16 MiB. A compact line reporter and completion JSON replace duplicate HTML/JUnit reports. The entire artifact bundle is limited to 2,048 files and 128 MiB.

The default deterministic run discovers 111 browser checks: 13 checks in each of eight viewport/theme/motion cells plus seven global checks. `--with-authors` discovers 151: 18 checks in every cell plus the same seven globals. Missing checks/results, timeouts, ENOSPC, blank pages, leaked browser contexts/listeners, or a missing/blank completion record make the run hard-incomplete. Cleanup removes only paths enumerated beneath the newly-created verification root; it never scans or deletes pre-existing scratch directories. Each author session's Codex home is removed after its sanitized final response and definition are retained.

## Stable production selectors required by central integration

The harness prefers accessible roles/names. These controls must retain stable accessible names, and adding the suggested test IDs will make failures easier to diagnose:

| Surface | Required accessible name / existing ID | Suggested stable test ID |
| --- | --- | --- |
| Tidy preview | `button[name="Tidy"]` | `wf-layout-tidy` |
| Apply preview | `button[name="Apply layout"]` | `wf-layout-apply` |
| Fit all | `button[name="Fit all"]` | `wf-layout-fit-all` |
| Run reveal | `button[name="Run"]` | `wf-run-open` |
| Run JSON | label `Run input` | `wf-run-input` |
| Start run | `button[name="Start run"]` | `wf-run-start` |
| Approval | existing `wf-gate-approve` | keep existing |
| Rejection | existing `wf-gate-reject` | keep existing |
| Canvas/zoom/node | existing `wf-canvas`, `wf-zoom`, `wf-node-<id>` | keep existing |
| Connect handles | `wf-handle-out-<id>`, `wf-handle-in-<id>` | required for gesture verification |
| Selectable edge | `wf-edge-<id>` | required for Delete-key removal verification |

The central implementation must also keep `.react-flow__node` roots and `[data-node-id]` on visible semantic nodes. Expanded-envelope metrics intentionally union visible descendants so dock captions outside nominal React Flow boxes are measured.
