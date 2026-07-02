# Decisions

## 2026-07-03 — Multi-LLM review reconnect via server-owned job model
**Status:** accepted
**Context:** Dropped SSE connections killed in-flight council.py reviews in the UI even though the process finished server-side (Chrome fetch-reader "network error", 409 dead-end on retry).
**Decision:** Council runs are server-owned jobs with a buffered event log (`packages/server/multi-llm-run.ts`); clients start/attach via `/api/multi-llm-review/start` and resume streams with `?since=N`; the client retries network failures with backoff.
**Alternatives:** Minimal fix — poll pgrep + `council-done.json` after a stream error. Rejected: no live log replay, no attach semantics, leaves the 409 dead-end.
**Consequences:** One run buffered in memory at a time; completed run evicted on next start. Legacy `POST /api/multi-llm-review-stream` kept as start-or-attach alias.

## 2026-07-03 — Upstream merges use the regraft strategy, never favor-HEAD
**Status:** accepted
**Context:** The 2026-05-15 merge (062ea903) resolved conflicts in heavily-rewritten files by "favoring HEAD", silently deleting upstream 0.19.x content; git then carried those deletions through later merges as ours-deleted/theirs-unchanged auto-resolutions.
**Decision:** For files upstream has heavily rewritten, `git checkout upstream/main -- <file>` and re-apply fork customizations on top; afterwards verify with per-file `git diff upstream/main | grep '^-'` keyword filtering and route-set diffs.
**Alternatives:** Favor-HEAD conflict resolution (loses upstream work invisibly); rebasing fork commits onto upstream (rewrites published history, breaks the merge-commit audit trail).
**Consequences:** Fork features must stay small and enumerable per file (documented in the project memory `upstream-merge-regraft-strategy`); fork-only Bun routes must be allowlisted in `tests/parity/route-parity.test.ts`.
