# Workflow layout browser verification

This suite is deliberately excluded from the default Playwright config. Run it only through `scripts/verify-workflow-layout.sh`; the wrapper creates a fake `HOME`, an isolated instance registry, a fresh Jinn home, and a candidate gateway on an explicit port at or above 7800.

The five GPT-5.5-low author probes are additionally opt-in with `--with-authors` and require `JINN_IMPLEMENTATION_GREEN=1`. Their session database, Codex overlays, and definitions stay beneath the throwaway sandbox home. Traces and video are disabled because authorization headers must not enter retained artifacts.

The retained artifact tree contains sanitized environment metadata, fixture requests/responses, author session records when enabled, per-cell geometry/accessibility JSON, interaction records, PNGs for each lifecycle state, JUnit output, and an HTML report. The default deterministic run discovers 110 browser checks; `--with-authors` discovers 150. The wrapper stops only its fake-home registry entry, scrubs Codex/gateway capability material, and prints the retained paths on exit.

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
