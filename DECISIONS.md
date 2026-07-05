# Decisions

## 2026-07-05 — Post-approve execution mirror runs as a detached process (same-port takeover)
**Status:** accepted
**Context:** The "Live activity" execution mirror streams git commits + file edits *after* approval, *during* implementation. But a Claude Code `PermissionRequest` hook MUST write its decision to stdout and `process.exit()` for the agent to begin implementing — which kills the in-process server ~1.5s after approve, before any implementation activity exists. So an in-process, hook-bound mirror can never work (symptom: `ERR_CONNECTION_REFUSED` reconnect spam + stranded stale-plan tab). This is the case the 2026-07-03 council decision flagged for "revisit" — here the hook exit isn't an edge-case interrupt, it's mandatory.
**Decision:** On approve, the hook spawns a **detached** (`node:child_process` `detached:true` + `unref()`) mirror process (`packages/server/mirror.ts`, `plannotator mirror --handoff <file>`) that outlives it and **rebinds the same port** (retry-until-the-hook-frees-it). The already-open browser tab reconnects to it with zero client changes — relative `EventSource('/api/execution/stream')` + external-annotations just reconnect. The mirror serves only what a post-approve tab needs (execution/external-annotation streams, draft, `/api/plan` with `watching:true`, images, favicon, SPA) and idle-shuts-down when the tab closes. The client honors `watching:true` to mount straight into the approved/Live-activity view and never offer review-time actions (multi-LLM review, approve/deny) the mirror can't serve.
**Alternatives:** (a) New-port switch (client re-points EventSource) — rejected: same-port takeover needs no client base-URL changes and reuses the browser's built-in reconnect. (b) Persistent per-project daemon — rejected as larger rearchitecture. (c) Drop the live promise (close tab on approve) — rejected: the user wanted the live feed.
**Consequences:** Reverses the "not detached" stance *for the mirror specifically* (the council still runs in-process — it lives during review, when the server is naturally alive; different lifecycle). Detachment survives parent `process.exit()` on macOS (verified). Gated debug hatch: `PLANNOTATOR_MIRROR_DEBUG=1` → `~/.plannotator/mirror/mirror-debug.log`. Bit by a Bun gotcha: `Bun.serve`'s port-in-use error message lacks the string `"EADDRINUSE"` (it says "Is port N in use?"), so the retry guard must match `err.code` / `/in use/` — the same latent bug still sits in `packages/server/index.ts`'s startup retry (harmless there: random local port).

## 2026-07-05 — Server-owned council runs delete their own council-done.json marker
**Status:** accepted
**Context:** council.py unconditionally writes `~/.plannotator/council-done.json` on exit as a "a shell review just finished — skip deliberation" signal (`reviewAlreadyDone` in `/api/plan`, 5-min TTL). The server-owned in-UI run spawns the same council.py, so it leaves the same marker — making the NEXT plan within 5 min silently auto-approve with no review.
**Decision:** The run manager (`createCouncilRunManager`, packages/server/multi-llm-run.ts) unlinks the marker when a server-owned run reaches terminal status. Only genuine shell runs now trip the skip.
**Alternatives:** (a) Make `reviewAlreadyDone` fire only for *foreign* council processes — rejected: the marker has no owner-pid, can't distinguish reliably, and the marker outlives the process. (b) Patch council.py to not write the marker under a server env flag — rejected: council.py is an external skill file (`~/opt/agentic-coding/...`), out of this repo's control. Owning cleanup on the plannotator side is the only self-contained fix.
**Consequences:** Marker path stays hardcoded `os.homedir()/.plannotator` (matches council.py), not `PLANNOTATOR_DATA_DIR`. Cleanup isn't unit-testable (Bun fixes `homedir()` at process start) — covered by binary smoke test only.

## 2026-07-05 — hook-decisions.log is the diagnostic for "approve didn't reach the agent"
**Status:** accepted
**Context:** A report that multi-LLM auto-approve "doesn't come back to the agent" could not be reproduced — the deployed binary + wrapper emit a correct `allow` and exit 0 through the full flow. The emit → stdout → wrapper → Claude Code handoff left no record, so which side failed was unknowable after the fact.
**Decision:** The plan hook appends every decision (approve/deny, exact emitted payload, multiLlm flag, elapsedMs, pid) to `~/.plannotator/debug/hook-decisions.log` before emitting. Ground truth for the next occurrence: `allow` line present ⇒ plannotator did its job (loss is harness/wrapper-side); absent ⇒ the hook died before emitting.
**Alternatives:** Add heartbeat/streaming to the hook (PermissionRequest hooks can't stream a partial decision); strip `permissionDecisionReason`/`updatedPermissions` to the documented schema (rejected — those fields work in real usage per prior sessions, and stripping loses the bypass-on-approve + prescriptive-reason features).

## 2026-07-03 — Council runs stay in-process (exit-handler kill), not detached
**Status:** accepted
**Context:** A terminal interrupt on the pending `ExitPlanMode` prompt kills the hook server and any in-flight council.py run (2026-07-03 incident, ea session). Choice: accept run-dies-with-server and clean up properly, or make runs survive server death.
**Decision:** Keep council.py an in-process child; the run manager kills it from a `process.on("exit")` handler (fatal signals already route through `process.exit` in the hook entry), and the UI states the ownership honestly (warning at run start, dead-server error copy on failed reconnects).
**Alternatives:** Detached process group + events persisted to disk + re-attach from a later server. Rejected for now: macOS has no `setsid(1)`, re-attach adds cross-session state and staleness questions, and the reconnect layer already covers the common failure (network/browser drops) — revisit if interrupts keep eating runs.
**Consequences:** An interrupted plan prompt still loses the run (by design, now stated in the UI). No orphaned council.py can 409-block future reviews after approve/deny exits.

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
