#!/usr/bin/env bash
# End-to-end regression for the ExitPlanMode keypress-injection fix.
#
# Background: Claude Code 2.1.199–2.1.207 ignore a PermissionRequest `allow`
# for ExitPlanMode — the interactive plan dialog stays up until a key is
# pressed, so a Plannotator approval (browser or headless multi-LLM
# auto-approve) never unlocks the plan. The fix (packages/server/plan-dialog.ts)
# injects the approval keypress into the controlling tmux pane. This test proves
# the real compiled binary makes the plan cascade after an /api/approve.
#
# Requires: tmux, a Claude Code subscription OAuth token in the macOS Keychain
# ("Claude Code-credentials"), and an ExitPlanMode-capable claude on PATH.
#
# Usage: ./cc-plan-keypress-e2e.sh [--claude-bin PATH] [--keep]
#   --claude-bin  claude executable to drive (default: `command -v claude`)
#   --keep        leave the tmux session + scratch dir for inspection
#
# Exit 0 = PASS (keypressInjected + plan proceeded). Non-zero = FAIL.
set -u

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CLAUDE_BIN="$(command -v claude || true)"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --claude-bin) CLAUDE_BIN="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CLAUDE_BIN" ] || { echo "FAIL: no claude binary (pass --claude-bin)"; exit 1; }
command -v tmux >/dev/null || { echo "FAIL: tmux not installed"; exit 1; }

CREDS="$(security find-generic-password -w -s "Claude Code-credentials" -a "$(id -un)" 2>/dev/null)"
[ -n "$CREDS" ] || { echo "FAIL: no 'Claude Code-credentials' in Keychain"; exit 1; }
OA="$(python3 -c 'import json;print(json.dumps(json.load(open("'"$HOME"'/.claude.json")).get("oauthAccount") or {}))' 2>/dev/null)"
[ "$OA" != "{}" ] || { echo "FAIL: no oauthAccount in ~/.claude.json"; exit 1; }

# realpath so the project-trust key matches claude's resolved cwd (on macOS
# /tmp is a symlink to /private/tmp — a mismatch re-triggers the trust dialog).
SCRATCH="$(cd "$(mktemp -d /tmp/pnt-keypress-e2e.XXXXXX)" && pwd -P)"
BIN="$SCRATCH/plannotator-test"
WS="$SCRATCH/ws"; CFG="$SCRATCH/cfg"; PNT="$SCRATCH/pnt"
mkdir -p "$WS" "$CFG" "$PNT"; echo placeholder >"$WS/hello.txt"

echo "Building test binary from source..."
( cd "$REPO" && bun build apps/hook/server/index.ts --compile --outfile "$BIN" ) >/dev/null 2>&1 \
  || { echo "FAIL: could not compile binary"; exit 1; }

printf '%s' "$CREDS" >"$CFG/.credentials.json"; chmod 600 "$CFG/.credentials.json"
cat >"$CFG/settings.json" <<JSON
{ "hooks": { "PermissionRequest": [ { "matcher": "ExitPlanMode", "hooks": [ { "type": "command",
  "command": "PLANNOTATOR_DATA_DIR=$PNT PLANNOTATOR_BROWSER=/usr/bin/true PLANNOTATOR_SHARE=disabled $BIN", "timeout": 345600 } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "echo STOP-FIRED >> $SCRATCH/stop.log", "timeout": 30 } ] } ] } }
JSON
cat >"$CFG/.claude.json" <<JSON
{ "hasCompletedOnboarding": true, "theme": "dark", "oauthAccount": $OA,
  "projects": { "$WS": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } } }
JSON
cat >"$SCRATCH/run.sh" <<RUN
#!/usr/bin/env bash
cd "$WS"; export CLAUDE_CONFIG_DIR="$CFG"; export DISABLE_AUTOUPDATER=1
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
exec "$CLAUDE_BIN" --permission-mode plan --model haiku "Plan mode. No agents/reads/questions. Write a one-line plan to append a greeting to hello.txt then IMMEDIATELY call ExitPlanMode. After approval reply with exactly DONE."
RUN
chmod +x "$SCRATCH/run.sh"

SESS="pnt-keypress-e2e-$$"
tmux new-session -d -s "$SESS" -x 200 -y 50
tmux send-keys -t "$SESS" "bash $SCRATCH/run.sh" Enter

cleanup() {
  tmux kill-session -t "$SESS" 2>/dev/null
  if [ $KEEP -eq 0 ]; then sleep 1; rm -rf "$SCRATCH"; else echo "kept: $SCRATCH"; fi
}
trap cleanup EXIT

echo "Waiting for plannotator server, then approving via /api/approve..."
approved=0 outcome=FAIL
for i in $(seq 1 60); do
  sess="$(ls "$PNT/sessions/"*.json 2>/dev/null | head -1)"
  if [ $approved -eq 0 ] && [ -n "$sess" ]; then
    port="$(python3 -c "import json;print(json.load(open('$sess')).get('port',''))" 2>/dev/null)"
    if [ -n "$port" ]; then
      resp="$(curl -s -X POST "http://localhost:$port/api/approve" -H 'content-type: application/json' \
        -d '{"feedback":"","planSave":{"enabled":false},"permissionMode":"acceptEdits"}')"
      echo "  approve -> $resp"
      approved=1
    fi
  fi
  if [ $approved -eq 1 ]; then
    # Reliable "proceeded" signals: the Stop hook fired (turn ended), or the
    # plan dialog is no longer on screen. (Do NOT grep for "DONE" — the prompt
    # text itself contains it, a false positive.)
    if [ -f "$SCRATCH/stop.log" ]; then outcome=PROCEEDED; break; fi
    if [ $i -ge 3 ] && ! tmux capture-pane -t "$SESS" -p 2>/dev/null | grep -q "ready to execute"; then
      outcome=PROCEEDED; break
    fi
  fi
  sleep 3
done

kp="$(grep -o '"keypressInjected":true' "$PNT/debug/hook-decisions.log" 2>/dev/null | tail -1)"
echo "--- result: outcome=$outcome keypressInjected=${kp:-false} ---"
if [ "$outcome" = "PROCEEDED" ] && [ -n "$kp" ]; then
  echo "PASS: plan cascaded via injected keypress"
  exit 0
fi
echo "FAIL: plan did not cascade (outcome=$outcome, keypress=${kp:-none})"
tmux capture-pane -t "$SESS" -p 2>/dev/null | tail -12
exit 1
