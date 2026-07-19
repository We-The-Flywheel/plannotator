/**
 * Multi-LLM review run manager.
 *
 * Makes a council.py deliberation a *durable* job that outlives the plan
 * session that launched it. Two failure modes drove this design:
 *
 *   1. A dropped SSE connection used to lose the run. Fixed by buffering
 *      events and replaying from an index (`GET /stream?since=N`).
 *   2. The hook process dying — Esc on the terminal's plan prompt, a Claude
 *      Code restart, a crash — used to take the whole deliberation with it,
 *      unrecoverably, after the API spend had already been incurred. The old
 *      manager made this worse by explicitly killing council.py from a
 *      `process.on("exit")` handler.
 *
 * So the run no longer lives in the hook process's memory or process group:
 *
 *   - council.py is spawned into its OWN session (`os.setsid()` trampoline),
 *     so a signal sent to the hook's process group does not reach it.
 *   - Its stderr (progress events) and stdout (final result) are redirected
 *     straight to files under `<dataDir>/runs/<runId>/`. The child is its own
 *     writer, so nothing is lost when the parent vanishes mid-write.
 *   - A fresh server tails those files and re-attaches to a still-live run
 *     for the same plan, replaying everything from event 0.
 *
 * Orphan spend is bounded by a reaper instead of by kill-on-exit: a live run
 * is only kept if it is young and belongs to the plan being reviewed;
 * anything else is killed when the next run starts.
 *
 * One run at a time (council.py is a singleton by design — the pgrep guard in
 * the endpoints enforces that for shell-launched runs too). The completed run
 * stays in memory until the next one starts, so late reconnects and full page
 * reloads can still replay the result.
 */

import { resolve, join } from "path";
import { homedir } from "os";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

/** A live run older than this is assumed abandoned and is killed on next start. */
const MAX_RUN_AGE_MS = 20 * 60_000;
/** Finished run directories are swept once they age out. */
const RUN_DIR_TTL_MS = 24 * 60 * 60_000;
/** How often the tailer re-reads the child's event file. */
const TAIL_INTERVAL_MS = 250;

export interface CouncilRun {
  id: string;
  status: "running" | "done" | "error";
  /** Raw SSE data payloads (JSON strings), in emission order. Includes the
   *  terminal `result` / `error` event, so a replay from 0 is complete. */
  events: string[];
  startedAt: number;
}

export interface CouncilRunManager {
  /** The current (running or most recently finished) run, if any. */
  readonly run: CouncilRun | null;
  /** Locate council.py on disk. Returns null when not installed. */
  findCouncilPath(): Promise<string | null>;
  /** True when a council.py process is running that this manager did NOT
   *  start and cannot adopt (e.g. launched via the shell skill). */
  isForeignCouncilRunning(): Promise<boolean>;
  /** Re-attach to a detached run left behind by a previous plan session for
   *  this same question. Returns null when there is nothing to adopt. */
  attachLiveRun(question: string): CouncilRun | null;
  /** Spawn council.py and start buffering its events. Caller must ensure no
   *  run is already active. */
  start(question: string, councilPath: string): CouncilRun;
  /** Resolves when the run has more than `sinceLen` events, changed status,
   *  or `timeoutMs` elapsed. */
  waitForChange(sinceLen: number, timeoutMs: number): Promise<void>;
}

interface RunMeta {
  id: string;
  pid: number;
  question: string;
  startedAt: number;
}

/** Signal-0 liveness probe. */
function isAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to another user — still alive.
    return err?.code === "EPERM";
  }
}

function readMeta(dir: string): RunMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    if (typeof meta?.id === "string" && typeof meta?.pid === "number") return meta as RunMeta;
  } catch {}
  return null;
}

export function createCouncilRunManager(
  opts: { dataDir?: string } = {},
): CouncilRunManager {
  const runsRoot = join(opts.dataDir ?? getPlannotatorDataDir(), "runs");
  let run: CouncilRun | null = null;
  let waiters: (() => void)[] = [];
  /** Cancels the tail loop for a superseded run. */
  let stopTail: (() => void) | null = null;

  const notify = () => {
    const pending = waiters;
    waiters = [];
    for (const resolveWaiter of pending) resolveWaiter();
  };

  const push = (target: CouncilRun, payload: unknown) => {
    target.events.push(typeof payload === "string" ? payload : JSON.stringify(payload));
    notify();
  };

  /** List run directories with parsable metadata, newest first. */
  const listRuns = (): { dir: string; meta: RunMeta }[] => {
    if (!existsSync(runsRoot)) return [];
    const out: { dir: string; meta: RunMeta }[] = [];
    for (const name of readdirSync(runsRoot)) {
      const dir = join(runsRoot, name);
      const meta = readMeta(dir);
      if (meta) out.push({ dir, meta });
    }
    return out.sort((a, b) => b.meta.startedAt - a.meta.startedAt);
  };

  /** Kill abandoned live runs and sweep aged-out directories. `keepId` is the
   *  run we are about to adopt or have just started. */
  const reap = (keepId?: string) => {
    const now = Date.now();
    for (const { dir, meta } of listRuns()) {
      if (meta.id === keepId) continue;
      if (isAlive(meta.pid)) {
        // A live run we are not keeping is either abandoned or for a
        // different plan — either way it is burning API spend for nobody.
        if (meta.startedAt < now - MAX_RUN_AGE_MS || keepId !== undefined) {
          try {
            process.kill(-meta.pid, "SIGTERM"); // own session → kill the group
          } catch {
            try { process.kill(meta.pid, "SIGTERM"); } catch {}
          }
        }
        continue;
      }
      if (meta.startedAt < now - RUN_DIR_TTL_MS) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  };

  /**
   * Follow a run's on-disk event + result files, mirroring them into
   * `target.events` and resolving the terminal status. Works both for a run we
   * spawned and one adopted from a dead server — the only difference is
   * whether an exit code is available (`exited`) or has to be inferred from
   * the pid going away.
   */
  const tail = (target: CouncilRun, dir: string, pid: number, exited?: Promise<number>) => {
    const eventsPath = join(dir, "events.jsonl");
    const resultPath = join(dir, "result.json");
    let consumed = 0;
    let partial = "";
    let cancelled = false;
    let exitCode: number | null = null;
    exited?.then((code) => { exitCode = code; }).catch(() => { exitCode = -1; });

    const drain = () => {
      let content: string;
      try {
        content = readFileSync(eventsPath, "utf8");
      } catch {
        return; // not created yet
      }
      if (content.length <= consumed) return;
      partial += content.slice(consumed);
      consumed = content.length;
      const lines = partial.split("\n");
      partial = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          JSON.parse(trimmed);
          push(target, trimmed);
        } catch {
          push(target, { event: "log", message: trimmed });
        }
      }
    };

    const finish = () => {
      drain();
      if (partial.trim()) {
        push(target, { event: "log", message: partial.trim() });
        partial = "";
      }
      let stdout = "";
      try { stdout = readFileSync(resultPath, "utf8"); } catch {}

      let structured: any = null;
      try { structured = JSON.parse(stdout); } catch {}

      // With an exit code, trust it. Without one (adopted run), a parsable
      // result IS the success signal — a killed child leaves it empty.
      const failed = exitCode !== null ? exitCode !== 0 : structured === null;
      if (failed) {
        push(target, {
          event: "error",
          message:
            exitCode !== null && exitCode > 0
              ? `Deliberation failed (exit ${exitCode})`
              : "Deliberation ended without a result — the review process was killed.",
        });
        target.status = "error";
      } else if (structured) {
        push(target, { event: "result", ok: true, result: structured.consensus, structured });
        target.status = "done";
      } else {
        push(target, { event: "result", ok: true, result: stdout });
        target.status = "done";
      }

      // council.py unconditionally writes ~/.plannotator/council-done.json on
      // exit as a "a shell review just finished — skip deliberation" signal for
      // the next plan's UI (reviewAlreadyDone). A server-owned run is NOT a
      // shell review — the UI already ran it here — so leaving that marker makes
      // the *next* plan within 5 minutes silently auto-approve with no review.
      // Delete the marker this child just wrote so only genuine shell runs trip
      // the skip. Matches council.py's hardcoded homedir path (not the data dir).
      try {
        rmSync(resolve(homedir(), ".plannotator", "council-done.json"), { force: true });
      } catch {}
      notify();
    };

    const timer = setInterval(() => {
      if (cancelled) return;
      drain();
      if (exitCode !== null || !isAlive(pid)) {
        // Give the child's final flush a beat to land on disk before reading.
        clearInterval(timer);
        setTimeout(() => { if (!cancelled) finish(); }, 100);
      }
    }, TAIL_INTERVAL_MS);
    // Don't hold the process open on this timer alone.
    (timer as any).unref?.();

    stopTail = () => {
      cancelled = true;
      clearInterval(timer);
    };
    drain();
  };

  return {
    get run() {
      return run;
    },

    async findCouncilPath(): Promise<string | null> {
      const candidates = [
        resolve(import.meta.dir, "../../../../skills/multi-llm-deliberation/council.py"),
        resolve(process.env.HOME || homedir(), "opt/agentic-coding/skills/multi-llm-deliberation/council.py"),
      ];
      for (const p of candidates) {
        if (await Bun.file(p).exists()) return p;
      }
      return null;
    },

    async isForeignCouncilRunning(): Promise<boolean> {
      const pgrep = Bun.spawn(["pgrep", "-f", "council\\.py"], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(pgrep.stdout).text();
      await pgrep.exited;
      const hits = out
        .split("\n")
        .map((l) => parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n));
      if (!hits.length) return false;
      // A pgrep hit belonging to any run we started (this session or a
      // previous one, recorded on disk) is ours, not foreign — it is exactly
      // what attachLiveRun() re-adopts.
      const ours = new Set(listRuns().map(({ meta }) => meta.pid));
      return hits.some((pid) => !ours.has(pid));
    },

    attachLiveRun(question: string): CouncilRun | null {
      const now = Date.now();
      const candidate = listRuns().find(
        ({ meta }) =>
          meta.question === question &&
          meta.startedAt > now - MAX_RUN_AGE_MS &&
          isAlive(meta.pid),
      );
      if (!candidate) return null;
      if (run?.id === candidate.meta.id) return run;

      stopTail?.();
      const adopted: CouncilRun = {
        id: candidate.meta.id,
        status: "running",
        events: [],
        startedAt: candidate.meta.startedAt,
      };
      run = adopted;
      notify();
      reap(adopted.id);
      tail(adopted, candidate.dir, candidate.meta.pid);
      return adopted;
    },

    start(question: string, councilPath: string): CouncilRun {
      stopTail?.();
      const id = crypto.randomUUID();
      const dir = join(runsRoot, id);
      mkdirSync(dir, { recursive: true });

      const eventsFd = openSync(join(dir, "events.jsonl"), "a");
      const resultFd = openSync(join(dir, "result.json"), "a");

      // Trampoline into a NEW session before exec'ing council.py, so signals
      // aimed at the hook's process group (Esc on the plan prompt, a Claude
      // Code restart) can't reach the deliberation. Bun.spawn has no
      // `detached` option and macOS ships no setsid(1), so python does it.
      const trampoline =
        "import os, sys\n" +
        "try:\n" +
        "    os.setsid()\n" +
        "except OSError:\n" +
        "    pass\n" +
        "os.execv(sys.executable, [sys.executable, sys.argv[1], '--json', sys.argv[2]])\n";

      const proc = Bun.spawn(["python3", "-c", trampoline, councilPath, question], {
        stdout: resultFd,
        stderr: eventsFd,
        env: { ...process.env },
      });

      const newRun: CouncilRun = {
        id,
        status: "running",
        events: [],
        startedAt: Date.now(),
      };
      writeFileSync(
        join(dir, "meta.json"),
        JSON.stringify({ id, pid: proc.pid, question, startedAt: newRun.startedAt } satisfies RunMeta),
      );
      run = newRun;
      notify();

      // Kill anything else still live — this is the new run's plan now.
      reap(id);

      proc.exited.finally(() => {
        try { closeSync(eventsFd); } catch {}
        try { closeSync(resultFd); } catch {}
      });

      tail(newRun, dir, proc.pid, proc.exited);
      return newRun;
    },

    async waitForChange(sinceLen: number, timeoutMs: number): Promise<void> {
      if (!run || run.events.length > sinceLen || run.status !== "running") return;
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, timeoutMs);
        waiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    },
  };
}
