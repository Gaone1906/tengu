# Todo re-QA remediation plan

**Scope:** Frontend-only remediation of the eight findings in the independent review of `ebe21f4`. Preserve the existing Todo visual language and all unrelated work.

## Design intent

Keep the Todo ledger visually calm and unchanged while making its hidden state model honest: drafts survive transport and navigation without carrying backend identifiers, session labels follow the freshest real work, and responsive controls reset like native transient UI.

## RED → GREEN sequence

1. Add failing draft tests for field-scoped recovery across tabs, same-field recovery semantics, opaque/expiring persistence, and revert-to-baseline close. Replace full-draft journaling with a salted surrogate key, encoded dirty-field patch, baseline version, TTL cleanup, and outstanding-work-based acknowledgement.
2. Add failing history/storage tests for opaque detail references and nested scroll restoration across Back/Forward/reload. Resolve persisted references against fetched runtime items and restore the inner ledger scroll only after rows mount.
3. Add failing error-surface tests for a real 403 containing an opaque work-item ID. Route every Todo-visible error through one operator-safe redactor while preserving actionable context.
4. Add failing lifecycle-selection and invalidation tests. Select a live linked session before the newest terminal session, reuse that selector in row/detail surfaces, invalidate linked-session queries for every session lifecycle event, and poll only while active.
5. Add a failing responsive crossover test. Close/reset the mobile filter sheet on desktop crossover and restore focus to the desktop trigger without resurrecting the sheet on return to mobile.
6. Strengthen row semantic-activation tests with user-level Enter, Space, pointer, touch, and long-press interactions, asserting exactly one intended action and zero detail opens.
7. Run focused tests after each implementation slice, then full web tests, typecheck, build, whitespace and privacy/storage scans.
8. Start only a fresh sanitized preview with a pinned `JINN_HOME` and ports `7900+`; capture 390×844 and 1440×900 in dark/light and normal/reduced-motion, plus the required navigation, offline, two-tab, orientation, and lifecycle states.
9. Commit only scoped frontend/tests/artifacts changes, attach the finding-by-finding evidence, and request independent re-QA without marking the work done.

## Conflict semantics

Recovery stores only fields changed locally. On reload those local fields overlay current server data, so unrelated remote changes always survive. If the same field changed both locally and remotely, the unsaved local operator edit wins during recovery and remains dirty; the server `updatedAt` baseline is retained as conflict metadata. The current PATCH contract has no conditional-version input, so this frontend cannot truthfully promise optimistic rejection; adding server-side compare-and-swap remains a backend contract change.
