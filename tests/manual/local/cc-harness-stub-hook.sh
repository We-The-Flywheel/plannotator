#!/usr/bin/env bash
# Stub PermissionRequest hook for the CC approval-drop characterization harness.
#
# Mimics exactly what the plannotator plan hook does from Claude Code's point of
# view: consume the hook event on stdin, take STUB_SLEEP_SECONDS (the review),
# then print a single allow decision to stdout and exit 0. The payload byte-shape
# matches the real hook, including updatedPermissions.
#
# FINDING (2026-07-12): CC 2.1.199 and 2.1.207 IGNORE this allow for ExitPlanMode
# at every delay tested (0/1/3/5s) — the interactive plan dialog stays up until a
# key is pressed. It is NOT a timing race. The real fix injects the approval
# keypress (packages/server/plan-dialog.ts); see cc-plan-keypress-e2e.sh.
#
# Env:
#   STUB_SLEEP_SECONDS  delay before emitting the allow (default 5)
#   STUB_LOG            file to append event + timing lines to (optional)

set -u

SLEEP="${STUB_SLEEP_SECONDS:-5}"
LOG="${STUB_LOG:-}"

EVENT="$(cat)"

log() {
  [ -n "$LOG" ] && printf '%s\n' "$1" >>"$LOG" || true
}

log "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"kind\":\"stub-invoked\",\"pid\":$$,\"sleep\":$SLEEP}"
log "$EVENT"

sleep "$SLEEP"

PAYLOAD='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","permissionDecisionReason":"Plan approved via Plannotator. Begin implementation immediately — do not ask for further confirmation.","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}'

log "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"kind\":\"stub-emitted\",\"pid\":$$}"
printf '%s\n' "$PAYLOAD"
exit 0
