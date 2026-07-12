import { describe, test, expect, afterEach } from "bun:test";
import { resolvePlanDialogViaKeypress, __test } from "./plan-dialog";

const savedTmux = process.env.TMUX;
const savedPane = process.env.TMUX_PANE;
const savedFlag = process.env.PLANNOTATOR_PLAN_KEYPRESS;

afterEach(() => {
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
  if (savedPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = savedPane;
  if (savedFlag === undefined) delete process.env.PLANNOTATOR_PLAN_KEYPRESS;
  else process.env.PLANNOTATOR_PLAN_KEYPRESS = savedFlag;
});

describe("keyForMode", () => {
  test("acceptEdits and bypassPermissions -> option 1 (auto-accept)", () => {
    expect(__test.keyForMode("acceptEdits")).toBe("1");
    expect(__test.keyForMode("bypassPermissions")).toBe("1");
  });
  test("default / plan / undefined -> option 2 (manual approve)", () => {
    expect(__test.keyForMode("default")).toBe("2");
    expect(__test.keyForMode("plan")).toBe("2");
    expect(__test.keyForMode(undefined)).toBe("2");
  });
});

describe("resolvePlanDialogViaKeypress", () => {
  test("no-op (returns false) when not under tmux", async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    expect(await resolvePlanDialogViaKeypress("acceptEdits")).toBe(false);
  });

  test("no-op when TMUX set but TMUX_PANE missing", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    delete process.env.TMUX_PANE;
    expect(await resolvePlanDialogViaKeypress("acceptEdits")).toBe(false);
  });

  test("no-op when disabled via PLANNOTATOR_PLAN_KEYPRESS=0 (even under tmux)", async () => {
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    process.env.TMUX_PANE = "%1";
    process.env.PLANNOTATOR_PLAN_KEYPRESS = "0";
    expect(await resolvePlanDialogViaKeypress("acceptEdits")).toBe(false);
  });

  test("gives up (returns false) when dialog never appears within waitMs", async () => {
    // Under tmux but the capture-pane will not contain a dialog marker for a
    // bogus pane id; bound the wait tightly so the test is fast.
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    process.env.TMUX_PANE = "%99999"; // nonexistent pane -> capture fails
    let sleeps = 0;
    const result = await resolvePlanDialogViaKeypress("acceptEdits", {
      waitMs: 60,
      pollMs: 20,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(result).toBe(false);
    expect(sleeps).toBeGreaterThan(0);
  });
});
