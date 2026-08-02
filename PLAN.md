# ICI-293 — "Error: Hermes turn ended with no assistant text"

Base: `main` @ `23df25ed62acfa162a39923638eb14dbbf1d8bea`
Branch: `build/ICI-293-hermes-empty-turn`

> This file previously held the ICI-666 plan (committed to `main` by that ticket). Replaced
> here on this branch only. The stale plan on `main` is an adjacent problem — reported, not
> fixed, per taste §4.

## Is it fixed? No.

`packages/jinn/src/engines/hermes-acp.ts:219-225` is unchanged since before the Todo was
filed. The only commit touching that file since 2026-07-10 is `1e761b16`
(`feat(chat): persist todo and workflow receipts`), which does not go near this branch. And
`__tests__/hermes-acp.test.ts:389` ("treats an empty prompt completion as an error instead of
silent success") pins the current behaviour as deliberate, so nothing has quietly changed it.

## What actually happens

The branch fires whenever `resultText === ""` after `session/prompt` returns
`stopReason: "end_turn"`. Reading the hermes ACP server (`~/Projects/hermes-agent`,
`acp_adapter/server.py`) there are three unrelated conditions that all land there:

1. `final_response` is empty because the model emitted only tool calls plus reasoning.
   Hermes' own suite calls this "the canonical thinking-model shape"
   (`tests/acp/test_server.py:646`) and asserts no `agent_message_chunk` is sent. **Benign.**
2. Hermes' executor raised — `server.py:1573` logs the exception and returns `end_turn`
   with no text. **Real failure.**
3. The prompt carried no content — `server.py:1334` returns `end_turn` immediately.
   **Real failure.**

jinn collapses all three into one opaque string and, on every one of them, calls
`this.evictProc(jinnId, p)` (`hermes-acp.ts:225`) — killing a hermes process that in case 1 is
demonstrably healthy, destroying the warm ACP session and forcing a `session/load` next turn.
Case 1 is the common one, so the usual outcome is: the agent did real tool work, the user sees
`Error: Hermes turn ended with no assistant text`, and the session gets torn down for it.

## The fix (KISS)

Split the single branch into three outcomes using signal that is already on the wire — no new
protocol, no new config. `run()` tracks whether the turn produced **tool activity**
(a `tool_use`, `tool_result`, or `block` delta).

| Turn produced | Result | Evict? |
|---|---|---|
| reply text | unchanged: success | no |
| no text, but tool activity | `result: ""`, `error: undefined`, one `logger.info` naming the session + tool-call count | **no** |
| no text and no tool activity | `error` naming the stop reason, e.g. `Hermes turn ended (end_turn) with no output` | yes |

`refusal` / `cancelled` keep their existing dedicated message.

**Critical detail the implementer must not get wrong:** `usage_update` maps to a `context`
delta and hermes sends one on essentially every turn (`server.py:1690`). Counting "any delta"
as activity makes row 3 unreachable. Activity is `tool_use` / `tool_result` / `block` only;
`context` and thought chunks do not count.

### Stated assumption (per taste §4)

Row 2 returning no error means a delegated hermes child that ends on tool calls reports
"replied (no output)" to its parent instead of an error string. That is the accurate
description of what happened, and it stops a benign turn from both poisoning the transcript
with a false error and skipping `recordEngineSessionId` (`api.ts:7469`, gated on
`!result.error`). Flagged because it is a real behaviour change for delegation, not a silent
one.

## Files

- `packages/jinn/src/engines/hermes-acp.ts` — the only production change.
- `packages/jinn/src/engines/__tests__/hermes-acp.test.ts` — rewrite the existing
  `treats an empty prompt completion as an error…` test (it asserts the old behaviour) and add
  the new cases.
- `packages/jinn/src/gateway/__tests__/block-finalize.test.ts:53` — asserts the exact old
  string through `formatEngineErrorAssistantMessage`. Update the fixture string only; do not
  change `formatEngineErrorAssistantMessage` itself.

## Acceptance criteria

1. A turn that streams `tool_call` + `tool_call_update` and then ends `end_turn` with no
   `agent_message_chunk` returns `error: undefined` and `result: ""`, and `isAlive(sessionId)`
   is still `true` afterwards.
2. A turn that streams nothing but a `usage_update` and ends `end_turn` returns an `error`
   containing the stop reason `end_turn`, and `isAlive(sessionId)` is `false` (still evicted).
   This is the test that proves `context` deltas are not counted as activity.
3. A turn that streams normal answer text is unchanged: `result` is that text, `error` is
   `undefined`, process stays alive — existing test `streams text + context…` still passes.
4. `stopReason: "refusal"` and `stopReason: "cancelled"` with no text still return
   `Hermes turn ended: <stop>` and still evict.
5. No new or changed error string contains an absolute user-home path, a real person name, or
   a real project name.
6. `pnpm --filter jinn-cli test` and `pnpm typecheck` pass with no new failures against the
   pre-change baseline (capture the baseline before editing).

## Verification

Unit tests only, via the fake ACP server already in `hermes-acp.test.ts` — extend
`fakeServerEmptyPromptResult` into a parametrized variant that can emit tool frames and/or a
`usage_update`. Per taste §5.1, criteria 1 and 2 must each be shown **red before** the change
and green after; paste both outputs.

No sandbox gateway and no browser run: this is engine-internal, with no user-visible surface
beyond the assistant message text that the unit tests already cover.

## Out of scope

- The `HermesRpc.onNotification` single-callback slot (`hermes-jsonrpc.ts:31`): a concurrent
  `run()` on one session would clobber the previous turn's accumulator. Real, but a different
  bug — write it up as a follow-up Todo, do not fix here.
- The stale ICI-666 `PLAN.md` sitting on `main`.
- Any change to `formatEngineErrorAssistantMessage` or the gateway persist/notify path.
- Anything in `hermes-agent` — separate repo.
- Any refactor of `hermes-acp.ts` beyond this branch.
