#!/usr/bin/env bash
# CC approval-drop characterization harness (plan Phase 0).
#
# Reproduces the Claude Code 2.1.200+ bug where a PermissionRequest hook's
# `allow` for ExitPlanMode is discarded when the hook responds late. Each trial:
#
#   1. Creates an isolated scratch workspace + CLAUDE_CONFIG_DIR (so the live
#      ~/.ipe/ipe hook and user settings never interfere).
#   2. Registers ONLY a stub PermissionRequest hook that sleeps N seconds and
#      then emits the exact plannotator allow payload.
#   3. Drives a real interactive `claude --permission-mode plan --model haiku`
#      session inside a detached tmux session.
#   4. Classifies the ExitPlanMode outcome from the session transcript jsonl:
#      PROCEEDED (allow honored) vs REJECTED (allow dropped).
#
# Usage:
#   ./cc-approval-drop-harness.sh --durations 5,60,90,105,120,180 --reps 3
#   ./cc-approval-drop-harness.sh --durations 110 --reps 1 --keep
#
# Flags:
#   --durations LIST   comma-separated sleep seconds (default: 5,60,90,105,120,180)
#   --reps N           repetitions per duration (default: 1)
#   --base-dir DIR     where scratch dirs + results.csv go (default: mktemp -d)
#   --keep             don't delete scratch dirs / kill tmux on completion
#   --tag TAG          label appended to tmux session names + result rows
#
# Results: appends CSV rows to $BASE/results.csv:
#   duration,rep,tag,outcome,use_ts,emit_ts,result_ts,scratch,note

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
STUB="$HERE/cc-harness-stub-hook.sh"
CLASSIFY="$HERE/cc-transcript-classify.ts"

DURATIONS="5,60,90,105,120,180"
REPS=1
BASE=""
KEEP=0
TAG="t"

while [ $# -gt 0 ]; do
  case "$1" in
    --durations) DURATIONS="$2"; shift 2 ;;
    --reps) REPS="$2"; shift 2 ;;
    --base-dir) BASE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# Scratch config dirs reuse the main install's subscription OAuth. The token
# lives in the macOS Keychain (service "Claude Code-credentials"), but a
# non-default CLAUDE_CONFIG_DIR doesn't find it there — it DOES read a
# .credentials.json file inside the config dir (verified: `claude -p` answers
# on subscription billing). We copy keychain -> scratch .credentials.json per
# trial and scrub the file at trial end. .claude.json also needs oauthAccount.
OAUTH_ACCOUNT="$(python3 -c 'import json;d=json.load(open("'"$HOME"'/.claude.json"));print(json.dumps(d.get("oauthAccount") or {}))' 2>/dev/null || echo '{}')"
if [ "$OAUTH_ACCOUNT" = "{}" ]; then
  echo "ERROR: no oauthAccount in ~/.claude.json — scratch sessions cannot authenticate." >&2
  exit 1
fi
CREDS_JSON="$(security find-generic-password -w -s "Claude Code-credentials" -a "$(id -un)" 2>/dev/null)"
if [ -z "$CREDS_JSON" ]; then
  echo "ERROR: could not read 'Claude Code-credentials' from the Keychain." >&2
  exit 1
fi

[ -z "$BASE" ] && BASE="$(mktemp -d /tmp/cc-drop-harness.XXXXXX)"
mkdir -p "$BASE"
RESULTS="$BASE/results.csv"
[ -f "$RESULTS" ] || echo "duration,rep,tag,outcome,use_ts,emit_ts,result_ts,scratch,note" >"$RESULTS"

PROMPT='You are in plan mode. Do NOT launch any agents, do NOT read files, do NOT use AskUserQuestion. Write a one-paragraph plan (goal: append a greeting line to hello.txt) to the plan file if one is required, then IMMEDIATELY call ExitPlanMode. After the plan is approved, reply with exactly DONE and stop — do not edit any files.'

run_trial() {
  local N="$1" REP="$2"
  local SCRATCH WS CFG SESS
  SCRATCH="$BASE/n${N}-r${REP}-${TAG}"
  rm -rf "$SCRATCH"
  WS="$SCRATCH/ws"
  CFG="$SCRATCH/claude-config"
  SESS="ccdrop-n${N}-r${REP}-${TAG}"
  mkdir -p "$WS" "$CFG"
  echo "placeholder" >"$WS/hello.txt"

  printf '%s' "$CREDS_JSON" >"$CFG/.credentials.json"
  chmod 600 "$CFG/.credentials.json"

  # Scratch settings: ONLY the stub hook.
  cat >"$CFG/settings.json" <<EOF
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "STUB_SLEEP_SECONDS=$N STUB_LOG=$SCRATCH/stub.log $STUB",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
EOF

  # Skip onboarding + trust dialogs for the scratch workspace.
  cat >"$CFG/.claude.json" <<EOF
{
  "hasCompletedOnboarding": true,
  "theme": "dark",
  "oauthAccount": $OAUTH_ACCOUNT,
  "projects": {
    "$WS": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true,
      "allowedTools": []
    }
  }
}
EOF

  # Runner script avoids tmux send-keys quoting hell.
  cat >"$SCRATCH/run.sh" <<EOF
#!/usr/bin/env bash
cd "$WS"
export CLAUDE_CONFIG_DIR="$CFG"
export DISABLE_AUTOUPDATER=1
# Use the subscription OAuth (oauthAccount copied into scratch .claude.json,
# token read from Keychain); an inherited API key would trigger a blocking
# "use this API key?" dialog in the fresh config dir.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
exec claude --permission-mode plan --model haiku "$PROMPT"
EOF
  chmod +x "$SCRATCH/run.sh"

  tmux kill-session -t "$SESS" 2>/dev/null
  tmux new-session -d -s "$SESS" -x 220 -y 50
  tmux send-keys -t "$SESS" "bash $SCRATCH/run.sh" Enter

  # Transcript dir: workspace path munged ([/._] -> -).
  local MUNGED TDIR
  MUNGED="$(printf '%s' "$WS" | sed 's#[/._]#-#g')"
  TDIR="$CFG/projects/$MUNGED"

  local note="" outcome="" use_ts="" emit_ts="" result_ts=""
  local t=0 transcript=""

  # The ExitPlanMode tool_use is NOT written to the transcript until the
  # permission resolves — so we can't gate on it. Instead gate on the stub
  # hook being INVOKED (proves the agent called ExitPlanMode and CC dispatched
  # the PermissionRequest hook). Wait up to 240s for the planning phase.
  local invoked=0
  while [ $t -lt 240 ]; do
    if grep -q '"kind":"stub-invoked"' "$SCRATCH/stub.log" 2>/dev/null; then
      invoked=1; break
    fi
    sleep 3; t=$((t+3))
  done

  transcript="$(ls -t "$TDIR"/*.jsonl 2>/dev/null | head -1)"

  if [ $invoked -eq 0 ]; then
    note="no-exitplanmode-called"
    tmux capture-pane -t "$SESS" -p >"$SCRATCH/pane-noplan.txt" 2>/dev/null
    outcome="SETUP_FAIL"
  else
    # Wait for the stub to emit its allow (invoked + N seconds).
    t=0
    while [ $t -lt $((N + 60)) ]; do
      grep -q '"kind":"stub-emitted"' "$SCRATCH/stub.log" 2>/dev/null && break
      sleep 2; t=$((t+2))
    done
    emit_ts="$(grep '"kind":"stub-emitted"' "$SCRATCH/stub.log" 2>/dev/null | tail -1 | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')"

    # Did CC honor the allow? Grace-poll for 40s after emit:
    #   - transcript records an ExitPlanMode result -> PROCEEDED (or REJECTED)
    #   - the "Would you like to proceed?" dialog is still on-screen -> DROPPED
    #     (the hook's allow was ignored; the interactive prompt won the race)
    local grace=0 r=""
    outcome="DROPPED"
    while [ $grace -lt 40 ]; do
      r="$(bun "$CLASSIFY" "$transcript" 2>/dev/null)"
      case "$r" in
        *'"outcome":"PROCEEDED"'*) outcome="PROCEEDED"; break ;;
        *'"outcome":"REJECTED"'*)  outcome="REJECTED";  break ;;
      esac
      # Dialog gone from the pane + agent moved on also means proceeded.
      if ! tmux capture-pane -t "$SESS" -p 2>/dev/null | grep -qE "Would you like to proceed|auto-accept edits"; then
        # Give the transcript a moment to flush the result.
        sleep 3
        r="$(bun "$CLASSIFY" "$transcript" 2>/dev/null)"
        case "$r" in
          *'"outcome":"REJECTED"'*) outcome="REJECTED" ;;
          *) outcome="PROCEEDED" ;;
        esac
        break
      fi
      sleep 4; grace=$((grace+4))
    done

    use_ts="$(printf '%s' "$r" | sed -n 's/.*"toolUseTs":"\([^"]*\)".*/\1/p')"
    result_ts="$(printf '%s' "$r" | sed -n 's/.*"resultTs":"\([^"]*\)".*/\1/p')"
    printf '%s\n' "$r" >"$SCRATCH/classify.json"
    tmux capture-pane -t "$SESS" -p >"$SCRATCH/pane-final.txt" 2>/dev/null
  fi

  echo "$N,$REP,$TAG,$outcome,$use_ts,$emit_ts,$result_ts,$SCRATCH,$note" >>"$RESULTS"
  echo "[trial n=$N rep=$REP] outcome=$outcome note=$note scratch=$SCRATCH"

  # Always scrub the copied OAuth token, even with --keep.
  rm -f "$CFG/.credentials.json"
  if [ $KEEP -eq 0 ]; then
    tmux kill-session -t "$SESS" 2>/dev/null
  fi
}

echo "harness base: $BASE"
IFS=',' read -ra DUR_ARR <<<"$DURATIONS"
for N in "${DUR_ARR[@]}"; do
  for REP in $(seq 1 "$REPS"); do
    run_trial "$N" "$REP"
  done
done

echo "--- results ($RESULTS) ---"
column -s, -t <"$RESULTS"
