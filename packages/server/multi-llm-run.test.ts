import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCouncilRunManager } from "./multi-llm-run";

/** Write a fake council.py that emits stderr progress events then a stdout result. */
function fakeCouncil(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "council-test-"));
  const p = join(dir, "council.py");
  writeFileSync(p, body);
  return p;
}

const HAPPY_COUNCIL = `
import json, sys, time
print(json.dumps({"event": "stage_start", "stage": "diverge", "models": ["a", "b"]}), file=sys.stderr, flush=True)
print("plain log line", file=sys.stderr, flush=True)
time.sleep(0.05)
print(json.dumps({"event": "model_done", "model": "a", "status": "success"}), file=sys.stderr, flush=True)
print(json.dumps({"consensus": "the answer", "models": []}))
`;

const FAILING_COUNCIL = `
import sys
print("boom", file=sys.stderr, flush=True)
sys.exit(2)
`;

async function waitForTerminal(manager: ReturnType<typeof createCouncilRunManager>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (manager.run?.status === "running" && Date.now() < deadline) {
    await manager.waitForChange(manager.run.events.length, 100);
  }
}

describe("multi-llm run manager", () => {
  test("buffers stderr events and terminal result, replayable from any index", async () => {
    const manager = createCouncilRunManager();
    const run = manager.start("q", fakeCouncil(HAPPY_COUNCIL));
    expect(run.status).toBe("running");
    expect(manager.run?.id).toBe(run.id);

    await waitForTerminal(manager);

    expect(run.status).toBe("done");
    const events = run.events.map((e) => JSON.parse(e));
    // stderr JSON passes through verbatim; non-JSON becomes log events
    expect(events[0]).toEqual({ event: "stage_start", stage: "diverge", models: ["a", "b"] });
    expect(events[1]).toEqual({ event: "log", message: "plain log line" });
    expect(events[2]).toEqual({ event: "model_done", model: "a", status: "success" });
    // terminal result is IN the buffer, so replay-from-0 is complete
    const last = events[events.length - 1];
    expect(last.event).toBe("result");
    expect(last.result).toBe("the answer");

    // replay semantics: slicing from any index yields the remaining events
    expect(run.events.slice(2).length).toBe(run.events.length - 2);
  });

  test("failed run ends with error event and error status", async () => {
    const manager = createCouncilRunManager();
    const run = manager.start("q", fakeCouncil(FAILING_COUNCIL));
    await waitForTerminal(manager);

    expect(run.status).toBe("error");
    const last = JSON.parse(run.events[run.events.length - 1]);
    expect(last.event).toBe("error");
    expect(last.message).toContain("exit 2");
  });

  test("waitForChange resolves on new events and immediately when already past index", async () => {
    const manager = createCouncilRunManager();
    // No run yet — resolves immediately rather than hanging
    await manager.waitForChange(0, 50);

    const run = manager.start("q", fakeCouncil(HAPPY_COUNCIL));
    // Waits until at least one event lands (well under the timeout)
    const before = Date.now();
    await manager.waitForChange(0, 4000);
    await waitForTerminal(manager);
    expect(run.events.length).toBeGreaterThan(0);
    expect(Date.now() - before).toBeLessThan(4000);

    // Terminal status: resolves immediately even with a huge timeout
    const t0 = Date.now();
    await manager.waitForChange(run.events.length, 60_000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("a new run replaces the previous one", async () => {
    const manager = createCouncilRunManager();
    const first = manager.start("q1", fakeCouncil(HAPPY_COUNCIL));
    await waitForTerminal(manager);
    const second = manager.start("q2", fakeCouncil(HAPPY_COUNCIL));
    expect(manager.run?.id).toBe(second.id);
    expect(second.id).not.toBe(first.id);
    await waitForTerminal(manager);
  });
});
