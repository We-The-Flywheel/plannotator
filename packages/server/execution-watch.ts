/**
 * Execution Watch — live activity mirror for the post-approve "watching" mode.
 *
 * After a user approves a plan, the browser tab transitions into a passive
 * mirror that streams two kinds of activity from the project's working
 * directory:
 *
 *   - git commits made since approval (polled every 5s via `git log`)
 *   - file edits (via fs.watch recursive, with filter + debounce)
 *
 * Events are pushed to subscribers over Server-Sent Events at
 * `/api/execution/stream`. A bounded snapshot (200 events, oldest dropped)
 * is replayed to late joiners so a refresh after approval doesn't lose
 * recent activity.
 *
 * This module is intentionally inert until `start(sinceMs)` is called.
 * Plan-mode callers wire it up after a successful approve so that we don't
 * spend cycles polling git or watching the filesystem during plan review.
 *
 * v0 scope: stream activity only. v1 will correlate commits with plan
 * checklist items.
 *
 * Pattern modeled on packages/server/external-annotations.ts:
 *   - Subscribers held in a Set<ReadableStreamDefaultController>
 *   - Heartbeat every 30s
 *   - Snapshot-on-connect, then live updates
 *   - cancel() cleans up subscribers; stop() tears down everything
 */

import { watch, type FSWatcher } from "node:fs";
import { relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionEvent =
  | {
      type: "commit";
      hash: string;
      shortHash: string;
      subject: string;
      /** ISO 8601 timestamp from `git log %aI`. */
      timestamp: string;
    }
  | {
      type: "edit";
      /** Path relative to cwd, normalised to forward slashes. */
      path: string;
      /** ms since epoch — when this debounced edit was emitted. */
      timestamp: number;
    };

export interface ExecutionWatch {
  /**
   * Begin watching. `sinceMs` anchors the git log query so that we only
   * surface commits made on or after approval.
   */
  start(sinceMs: number): void;
  /** Bun fetch handler. Returns a Response when the URL matches, else null. */
  handle(
    req: Request,
    url: URL,
    options?: { disableIdleTimeout?: () => void },
  ): Promise<Response | null>;
  /**
   * Number of currently-connected SSE subscribers. The detached mirror
   * server reads this to decide when the watching tab has closed and it can
   * idle-shut-down.
   */
  subscriberCount(): number;
  /** Tear down fs.watch + polling interval + active subscribers. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STREAM_PATH = "/api/execution/stream";
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_COMMENT = ":\n\n";
const GIT_POLL_INTERVAL_MS = 5_000;
const EDIT_DEBOUNCE_MS = 1_000;
const SNAPSHOT_CAP = 200;

/**
 * Path-fragment skip list. We match against the path **with leading and
 * trailing separators** added so that an entry like `/.git/` only matches
 * a directory boundary (won't catch e.g. `not-the-git-thing.txt`).
 */
const SKIP_FRAGMENTS = [
  `${sep}.git${sep}`,
  `${sep}node_modules${sep}`,
  `${sep}dist${sep}`,
  `${sep}.next${sep}`,
  `${sep}.turbo${sep}`,
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse the output of `git log --pretty=format:%H|%aI|%s` into commit
 * events. Each line is `<full-hash>|<iso-timestamp>|<subject>`. Subject
 * lines may contain literal `|` characters, so we only split into 3 parts
 * and let the remainder land in the subject.
 */
export function parseGitLog(stdout: string): Array<{
  hash: string;
  shortHash: string;
  subject: string;
  timestamp: string;
}> {
  const out: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    timestamp: string;
  }> = [];
  if (!stdout) return out;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    const firstPipe = line.indexOf("|");
    if (firstPipe < 0) continue;
    const secondPipe = line.indexOf("|", firstPipe + 1);
    if (secondPipe < 0) continue;
    const hash = line.slice(0, firstPipe);
    const timestamp = line.slice(firstPipe + 1, secondPipe);
    const subject = line.slice(secondPipe + 1);
    if (!hash || !timestamp) continue;
    out.push({
      hash,
      shortHash: hash.slice(0, 7),
      subject,
      timestamp,
    });
  }
  return out;
}

/**
 * Should this absolute path be ignored by the file watcher?
 *
 * We check fragment membership using boundary-anchored separators so that
 * a segment match (e.g. `/.git/`) doesn't accidentally hit a substring
 * like `mygit-thing/`. Both leading and trailing separators are appended
 * to the candidate path before scanning so root-relative directories also
 * match (`.git/foo` becomes `/.git/foo/`).
 */
export function shouldSkipPath(absPath: string): boolean {
  // Bracket the path with separators so `/.git/` matches both
  // `<root>/.git/...` and a path that starts with `.git/` (no leading sep).
  const padded = `${sep}${absPath}${sep}`;
  for (const frag of SKIP_FRAGMENTS) {
    if (padded.includes(frag)) return true;
  }
  return false;
}

/** Serialize an event as a single SSE `data:` frame. */
export function serializeExecutionEvent(event: ExecutionEvent | { type: "snapshot"; events: ExecutionEvent[] }): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateExecutionWatchOptions {
  /**
   * Inject a custom git runner — used by tests to feed deterministic
   * `git log` output without spawning a real process. Defaults to
   * `Bun.spawn(["git", ...args])` against `cwd`.
   */
  runGitLog?: (sinceIso: string) => Promise<string>;
  /**
   * Inject a custom watcher factory — used by tests so we don't actually
   * touch the filesystem. Defaults to `fs.watch(cwd, { recursive: true })`.
   */
  startWatcher?: (
    cwd: string,
    onEvent: (relPath: string) => void,
  ) => { close: () => void };
}

export function createExecutionWatch(
  cwd: string,
  options: CreateExecutionWatchOptions = {},
): ExecutionWatch {
  const subscribers = new Set<ReadableStreamDefaultController>();
  const encoder = new TextEncoder();

  // Bounded ring of recent events, replayed to late joiners.
  const snapshot: ExecutionEvent[] = [];

  // Track the set of commit hashes we've already emitted so the 5s poll
  // doesn't re-emit a commit that survives the `--since` cut-off due to
  // clock skew or identical-second commits.
  const emittedCommits = new Set<string>();

  // Debounce: most-recent-emit timestamp per relative path.
  const lastEmittedEdit = new Map<string, number>();

  let started = false;
  let sinceMs = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watcher: { close: () => void } | null = null;

  const runGitLog =
    options.runGitLog ??
    (async (sinceIso: string) => {
      const proc = Bun.spawn(
        [
          "git",
          "log",
          `--since=${sinceIso}`,
          "--pretty=format:%H|%aI|%s",
        ],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      // We don't surface git failures to subscribers — a missing repo is
      // a perfectly valid state for a directory that just isn't tracked.
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited.catch(() => 1),
      ]);
      return stdout;
    });

  const startWatcher =
    options.startWatcher ??
    ((dir: string, onEvent: (relPath: string) => void) => {
      let w: FSWatcher;
      try {
        w = watch(dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          // `filename` arrives relative to the watch root on macOS/Linux.
          onEvent(String(filename));
        });
      } catch {
        // fs.watch can fail (EMFILE, ENOTDIR, etc.) — degrade gracefully.
        return { close: () => {} };
      }
      // Suppress watcher errors so a transient EBADF doesn't crash the
      // server. The polling loop is unaffected.
      w.on("error", () => {});
      return { close: () => { try { w.close(); } catch {} } };
    });

  function broadcast(event: ExecutionEvent): void {
    // Append to bounded snapshot buffer
    snapshot.push(event);
    if (snapshot.length > SNAPSHOT_CAP) {
      snapshot.splice(0, snapshot.length - SNAPSHOT_CAP);
    }

    const data = encoder.encode(serializeExecutionEvent(event));
    for (const controller of subscribers) {
      try {
        controller.enqueue(data);
      } catch {
        subscribers.delete(controller);
      }
    }
  }

  async function pollGit(): Promise<void> {
    if (!started) return;
    try {
      const sinceIso = new Date(sinceMs).toISOString();
      const stdout = await runGitLog(sinceIso);
      const commits = parseGitLog(stdout);
      // Emit oldest first so subscribers see commits in chronological
      // order. `git log` returns newest-first by default.
      for (const c of commits.slice().reverse()) {
        if (emittedCommits.has(c.hash)) continue;
        emittedCommits.add(c.hash);
        broadcast({
          type: "commit",
          hash: c.hash,
          shortHash: c.shortHash,
          subject: c.subject,
          timestamp: c.timestamp,
        });
      }
    } catch {
      // Don't propagate poll failures — the next tick may succeed.
    }
  }

  function handleFsEvent(rawRelPath: string): void {
    if (!started) return;
    // Resolve to absolute, then back to a normalised relative path so we
    // can run skip-list matching against full path fragments (the OS
    // sometimes hands us a partial/segment-only path on rapid changes).
    const abs = resolve(cwd, rawRelPath);
    if (shouldSkipPath(abs)) return;

    let rel = relative(cwd, abs);
    if (!rel) return;
    // Normalise to forward slashes for cross-platform UI consumption.
    rel = rel.split(sep).join("/");

    const now = Date.now();
    const last = lastEmittedEdit.get(rel) ?? 0;
    if (now - last < EDIT_DEBOUNCE_MS) return;
    lastEmittedEdit.set(rel, now);

    broadcast({
      type: "edit",
      path: rel,
      timestamp: now,
    });
  }

  return {
    start(sinceMsArg: number): void {
      // Idempotent — repeated calls are a no-op rather than a noisy reset.
      // The first approve wins; spurious extra approves should not blow
      // away accumulated activity.
      if (started) return;
      started = true;
      sinceMs = sinceMsArg;

      // Kick off an immediate git poll so subscribers don't have to wait
      // a full interval to see the first commit.
      void pollGit();
      pollTimer = setInterval(() => void pollGit(), GIT_POLL_INTERVAL_MS);

      watcher = startWatcher(cwd, handleFsEvent);
    },

    async handle(
      req: Request,
      url: URL,
      opts?: { disableIdleTimeout?: () => void },
    ): Promise<Response | null> {
      if (url.pathname !== STREAM_PATH || req.method !== "GET") {
        return null;
      }

      opts?.disableIdleTimeout?.();

      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let ctrl: ReadableStreamDefaultController;

      const stream = new ReadableStream({
        start(controller) {
          ctrl = controller;

          // Replay the bounded snapshot so a tab opened post-approve still
          // sees the activity that happened before it connected.
          const snap = serializeExecutionEvent({
            type: "snapshot",
            events: [...snapshot],
          });
          controller.enqueue(encoder.encode(snap));

          subscribers.add(controller);

          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(HEARTBEAT_COMMENT));
            } catch {
              if (heartbeatTimer) clearInterval(heartbeatTimer);
              subscribers.delete(controller);
            }
          }, HEARTBEAT_INTERVAL_MS);
        },
        cancel() {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          subscribers.delete(ctrl);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },

    subscriberCount(): number {
      return subscribers.size;
    },

    stop(): void {
      started = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      // Close any active subscribers so the server can shut down cleanly.
      for (const controller of subscribers) {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
      subscribers.clear();
    },
  };
}
