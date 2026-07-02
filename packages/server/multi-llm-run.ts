/**
 * Multi-LLM review run manager.
 *
 * Makes a council.py deliberation a server-owned job with a buffered event
 * log, so the browser can disconnect (network blip, backgrounded tab, dropped
 * SSE) and re-attach without losing the run or re-paying for it. The previous
 * design streamed council.py's stderr straight into the response — one severed
 * connection and the UI could never recover, even though the process kept
 * running to completion server-side.
 *
 * One run at a time (council.py is a singleton by design — the pgrep guard in
 * the endpoints enforces that for shell-launched runs too). The completed run
 * stays in memory until the next one starts, so late reconnects and full page
 * reloads can still replay the result.
 */

import { resolve } from "path";
import { homedir } from "os";

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
   *  start (e.g. launched via the shell skill) — we can't attach to those. */
  isForeignCouncilRunning(): Promise<boolean>;
  /** Spawn council.py and start buffering its events. Caller must ensure no
   *  run is already active. */
  start(question: string, councilPath: string): CouncilRun;
  /** Resolves when the run has more than `sinceLen` events, changed status,
   *  or `timeoutMs` elapsed. */
  waitForChange(sinceLen: number, timeoutMs: number): Promise<void>;
}

export function createCouncilRunManager(): CouncilRunManager {
  let run: CouncilRun | null = null;
  let waiters: (() => void)[] = [];

  const notify = () => {
    const pending = waiters;
    waiters = [];
    for (const resolveWaiter of pending) resolveWaiter();
  };

  const push = (target: CouncilRun, payload: unknown) => {
    target.events.push(typeof payload === "string" ? payload : JSON.stringify(payload));
    notify();
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
      if (!out.trim()) return false;
      // A pgrep hit that matches our own in-flight run isn't foreign.
      return run?.status !== "running";
    },

    start(question: string, councilPath: string): CouncilRun {
      const newRun: CouncilRun = {
        id: crypto.randomUUID(),
        status: "running",
        events: [],
        startedAt: Date.now(),
      };
      run = newRun;
      notify();

      const proc = Bun.spawn(["python3", councilPath, "--json", question], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      const stdoutPromise = new Response(proc.stdout).text();

      // Pump council.py's stderr (structured progress events / log lines)
      // into the buffer as they arrive.
      (async () => {
        const decoder = new TextDecoder();
        const reader = (proc.stderr as ReadableStream).getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                JSON.parse(trimmed);
                push(newRun, trimmed);
              } catch {
                push(newRun, { event: "log", message: trimmed });
              }
            }
          }
          if (buffer.trim()) {
            push(newRun, { event: "log", message: buffer.trim() });
          }
        } catch {
          // stderr reader error — final status comes from the exit path below
        }

        // Process final result from stdout.
        try {
          const stdout = await stdoutPromise;
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            push(newRun, { event: "error", message: `Deliberation failed (exit ${exitCode})` });
            newRun.status = "error";
          } else {
            try {
              const structured = JSON.parse(stdout);
              push(newRun, { event: "result", ok: true, result: structured.consensus, structured });
            } catch {
              push(newRun, { event: "result", ok: true, result: stdout });
            }
            newRun.status = "done";
          }
        } catch (err) {
          push(newRun, {
            event: "error",
            message: err instanceof Error ? err.message : "Deliberation failed",
          });
          newRun.status = "error";
        }
        notify();
      })();

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
