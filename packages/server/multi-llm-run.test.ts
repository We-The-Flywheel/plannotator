import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCouncilRunManager } from "./multi-llm-run";

/** Isolated data dir so run state never touches the real ~/.plannotator/runs. */
function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "council-data-"));
}

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

/** Same shape as HAPPY_COUNCIL but slow enough to still be mid-flight when a
 *  second manager tries to adopt it. */
const SLOW_COUNCIL = `
import json, sys, time
print(json.dumps({"event": "stage_start", "stage": "diverge", "models": ["a", "b"]}), file=sys.stderr, flush=True)
time.sleep(1.5)
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
    const manager = createCouncilRunManager({ dataDir: tempDataDir() });
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
    const manager = createCouncilRunManager({ dataDir: tempDataDir() });
    const run = manager.start("q", fakeCouncil(FAILING_COUNCIL));
    await waitForTerminal(manager);

    expect(run.status).toBe("error");
    const last = JSON.parse(run.events[run.events.length - 1]);
    expect(last.event).toBe("error");
    expect(last.message).toContain("exit 2");
  });

  test("waitForChange resolves on new events and immediately when already past index", async () => {
    const manager = createCouncilRunManager({ dataDir: tempDataDir() });
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

  // NOTE: the post-run cleanup of council.py's ~/.plannotator/council-done.json
  // marker is intentionally NOT unit-tested here. The manager resolves the marker
  // via os.homedir(), which Bun fixes at process start and does not re-read from a
  // mutated process.env.HOME — so an in-process test cannot redirect it to a temp
  // dir and would delete the real user's marker. It is covered end-to-end by the
  // binary smoke test (isolated HOME set at spawn), which is authoritative here.

  test("the deliberation runs in its own session, out of the hook's process group", async () => {
    const dataDir = tempDataDir();
    const m = createCouncilRunManager({ dataDir });
    m.start("q", fakeCouncil(SLOW_COUNCIL));

    // Read the pid the manager recorded, then ask the OS for its process group.
    const runsRoot = join(dataDir, "runs");
    const runDir = join(runsRoot, readdirSync(runsRoot)[0]);
    const { pid } = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));

    const proc = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
    const childPgid = parseInt(proc.stdout.toString().trim(), 10);

    // This is the whole point: a signal to OUR group cannot reach it.
    expect(childPgid).toBeGreaterThan(0);
    expect(childPgid).not.toBe(process.pid);
    await waitForTerminal(m, 8000);
  });

  test("a run outlives its manager and is re-adopted by a fresh one", async () => {
    const dataDir = tempDataDir();
    const question = "review this plan";

    // Session 1 starts a deliberation, then "dies" — we simply abandon the
    // manager, the way a killed hook process would.
    const dying = createCouncilRunManager({ dataDir });
    const original = dying.start(question, fakeCouncil(SLOW_COUNCIL));

    // Session 2 comes up against the same data dir and re-attaches.
    const fresh = createCouncilRunManager({ dataDir });
    const adopted = fresh.attachLiveRun(question);
    expect(adopted).not.toBeNull();
    expect(adopted!.id).toBe(original.id);

    // It sees the full history from event 0, plus the terminal result — the
    // review is recovered, not re-run.
    await waitForTerminal(fresh, 8000);
    expect(fresh.run?.status).toBe("done");
    const events = fresh.run!.events.map((e) => JSON.parse(e));
    expect(events[0]).toEqual({ event: "stage_start", stage: "diverge", models: ["a", "b"] });
    expect(events[events.length - 1].result).toBe("the answer");
  });

  test("a live run for a different question is not adopted", async () => {
    const dataDir = tempDataDir();
    const first = createCouncilRunManager({ dataDir });
    first.start("question A", fakeCouncil(SLOW_COUNCIL));

    const second = createCouncilRunManager({ dataDir });
    expect(second.attachLiveRun("question B")).toBeNull();
  });

  test("a new run replaces the previous one", async () => {
    const manager = createCouncilRunManager({ dataDir: tempDataDir() });
    const first = manager.start("q1", fakeCouncil(HAPPY_COUNCIL));
    await waitForTerminal(manager);
    const second = manager.start("q2", fakeCouncil(HAPPY_COUNCIL));
    expect(manager.run?.id).toBe(second.id);
    expect(second.id).not.toBe(first.id);
    await waitForTerminal(manager);
  });
});
