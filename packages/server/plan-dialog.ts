/**
 * Claude Code plan-dialog keypress resolver.
 *
 * Claude Code 2.1.199–2.1.207 do NOT honor a PermissionRequest `allow` for
 * ExitPlanMode: after the hook emits its decision, the interactive plan dialog
 *
 *     Claude has written up a plan and is ready to execute. Would you like to proceed?
 *       1. Yes, auto-accept edits
 *       2. Yes, manually approve edits
 *       3. No, refine with Ultraplan on Claude Code on the web
 *       4. Tell Claude what to change
 *
 * stays on screen until a human presses a key. This is why a plan approved in
 * Plannotator (especially a headless multi-LLM auto-approve, with nobody at the
 * terminal) never actually unlocks — the hook's `allow` is ignored. Verified
 * empirically 2026-07-12 across CC 2.1.199 and 2.1.207: an allow emitted at
 * 0s/1s/3s/5s is all ignored; only a keypress resolves the dialog.
 *
 * When Claude Code runs inside tmux (the common case here), the hook process
 * inherits `TMUX`/`TMUX_PANE` and can inject the approval keystroke into the
 * controlling pane with `tmux send-keys`. That IS the reliable channel.
 *
 * Safety: we only send the key while the plan dialog is actually on screen
 * (polled via `tmux capture-pane`, matched on the dialog's own option text so a
 * plan body or REPL line can't be mistaken for it). Caveat: while the hook is
 * alive CC has not yet read the hook's stdout, so the dialog is up regardless
 * of whether a future CC *would* honor the `allow` — this workaround therefore
 * always injects on the broken versions it targets. If a future CC starts
 * honoring the ExitPlanMode allow again, disable this with
 * `PLANNOTATOR_PLAN_KEYPRESS=0` (env or ~/.plannotator/config.json).
 */

import { spawnSync } from "child_process";
import { appendFileSync } from "fs";
import { join } from "path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { loadConfig } from "@plannotator/shared/config";

function kpDebug(msg: string): void {
  if (!process.env.PLANNOTATOR_PLAN_KEYPRESS_DEBUG) return;
  try {
    appendFileSync(
      join(getPlannotatorDataDir(), "debug", "plan-keypress.log"),
      `${new Date().toISOString()} ${msg}\n`,
    );
  } catch {
    // best-effort
  }
}

// The dialog's own option lines — specific enough that plan/conversation prose
// captured in the pane won't false-match (unlike a generic "ready to execute").
const DIALOG_MARKERS = [
  "Yes, auto-accept edits",
  "Yes, manually approve edits",
];

/** Whether keypress injection is enabled (env wins over config; default on). */
function keypressEnabled(): boolean {
  const env = process.env.PLANNOTATOR_PLAN_KEYPRESS?.trim().toLowerCase();
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  try {
    const cfg = loadConfig() as { planKeypress?: boolean };
    if (cfg?.planKeypress === false) return false;
  } catch {
    // config is best-effort
  }
  return true;
}

function tmuxPane(): string | null {
  const pane = process.env.TMUX_PANE?.trim();
  if (!process.env.TMUX || !pane) return null;
  return pane;
}

function capturePane(pane: string): string | null {
  try {
    const out = spawnSync("tmux", ["capture-pane", "-p", "-t", pane], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (out.status !== 0) return null;
    return out.stdout ?? "";
  } catch {
    return null;
  }
}

function dialogVisible(pane: string): boolean {
  const text = capturePane(pane);
  if (text === null) return false;
  return DIALOG_MARKERS.some((m) => text.includes(m));
}

function sendKey(pane: string, key: string): boolean {
  try {
    // Send the option digit only. On Claude Code's numbered menus the digit
    // both selects and confirms, so a trailing Enter would be a stray keystroke
    // that could land on a following prompt (e.g. a per-edit permission dialog
    // in manual-approve mode). Verified: the digit alone resolves the dialog.
    const out = spawnSync("tmux", ["send-keys", "-t", pane, key], {
      timeout: 2000,
    });
    return out.status === 0;
  } catch {
    return false;
  }
}

/**
 * Which dialog option matches the approved permission mode:
 *   "1" = Yes, auto-accept edits   (acceptEdits / bypassPermissions)
 *   "2" = Yes, manually approve    (default / plan / anything else)
 * The dialog can't express bypassPermissions, so auto-accept is the closest.
 */
function keyForMode(permissionMode?: string): string {
  return permissionMode === "acceptEdits" || permissionMode === "bypassPermissions"
    ? "1"
    : "2";
}

/**
 * Resolve the ExitPlanMode dialog for an approved plan by injecting the
 * approval keypress into the controlling tmux pane. No-op (returns false) when
 * not under tmux, when disabled via PLANNOTATOR_PLAN_KEYPRESS, or when the
 * dialog never appears within waitMs.
 *
 * Caller must gate this to PLAIN approvals: an annotated approve carries
 * required updates that the keypress cannot deliver (it just proceeds with the
 * shown plan), so those must fall back to the manual channel.
 *
 * Best-effort — never throws.
 *
 * @param permissionMode the mode the user chose in Plannotator (maps to option 1/2)
 * @param opts.waitMs     how long to keep polling for the dialog (default 8s).
 *                        While this hook is alive CC has not read its stdout, so
 *                        the dialog is already on screen — this normally resolves
 *                        on the first poll. The window's only job is to ride out
 *                        a transient `capture-pane` miss; it fully elapses only
 *                        when no dialog renders (a CC that honors the allow —
 *                        set PLANNOTATOR_PLAN_KEYPRESS=0 there).
 * @param opts.pollMs     poll interval (default 250ms)
 * @param opts.sleep      injectable sleep (for tests)
 */
export async function resolvePlanDialogViaKeypress(
  permissionMode?: string,
  opts: {
    waitMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  if (!keypressEnabled()) {
    kpDebug("disabled via PLANNOTATOR_PLAN_KEYPRESS/config");
    return false;
  }
  const pane = tmuxPane();
  if (!pane) {
    kpDebug(`not under tmux (TMUX=${process.env.TMUX ? "set" : "unset"} TMUX_PANE=${process.env.TMUX_PANE ?? "unset"})`);
    return false;
  }

  const waitMs = opts.waitMs ?? 8_000;
  const pollMs = opts.pollMs ?? 250;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const key = keyForMode(permissionMode);
  const deadline = Date.now() + waitMs;

  // The dialog is normally already up (the review took time), so this resolves
  // on the first poll. The deadline only bounds latency on a CC/config where no
  // dialog renders. Only ever sends while the dialog is on screen.
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    if (dialogVisible(pane)) {
      const ok = sendKey(pane, key);
      kpDebug(`dialog visible on poll ${polls}, sent key '${key}' -> ${ok}`);
      return ok;
    }
    await sleep(pollMs);
  }
  kpDebug(`gave up after ${polls} polls; dialog never matched on pane ${pane}. last capture:\n${capturePane(pane)?.slice(-400) ?? "<capture failed>"}`);
  return false;
}

/** Exposed for unit testing the mode → key mapping. */
export const __test = { keyForMode };
