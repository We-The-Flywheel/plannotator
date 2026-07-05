/**
 * Detached execution-mirror server.
 *
 * The plan-review hook is a synchronous PermissionRequest handler: it MUST
 * write its decision to stdout and exit for Claude Code to begin
 * implementation. That exit kills the in-process server — so the post-approve
 * "Live activity" mirror (git commits + file edits during implementation)
 * can never work while it is bound to the hook's lifecycle.
 *
 * This module runs the mirror as a *detached* process that outlives the hook.
 * On approve, the hook writes a small handoff JSON and spawns
 * `plannotator mirror --handoff <file>` with `detached: true` + `unref()`.
 * The detached process rebinds the *same* port the hook server was using
 * (retry-until-free), so the already-open browser tab reconnects with zero
 * client changes — its relative `EventSource('/api/execution/stream')` and the
 * external-annotations stream simply reconnect to the new listener.
 *
 * The mirror serves only what a stranded, post-approve tab needs: the
 * execution + external-annotation streams, draft (so `/api/draft` stops
 * 404ing), `/api/plan` (so a refresh still renders), images, favicon, and the
 * SPA HTML. It idle-shuts-down once the watching tab closes.
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, unlinkSync, openSync } from "node:fs";
import { join, basename } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import type { Origin } from "@plannotator/shared/agents";
import { getServerHostname, isAddressInUseError } from "./remote";
import { createExecutionWatch } from "./execution-watch";
import { createExternalAnnotationHandler } from "./external-annotations";
import { contentHash } from "./draft";
import {
  handleImage,
  handleUpload,
  handleDraftSave,
  handleDraftLoad,
  handleDraftDelete,
  handleFavicon,
} from "./shared-handlers";
import { registerSession, unregisterSession } from "./sessions";

// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------

export interface MirrorHandoff {
  /** Port the hook server was bound to — the mirror rebinds it. */
  port: number;
  /** Project working directory to watch (git + fs). */
  cwd: string;
  /** Approval timestamp (ms) — anchors the git-log `--since` query. */
  sinceMs: number;
  /** Plan markdown, served back on `/api/plan` for a post-approve refresh. */
  plan: string;
  origin: Origin;
  previousPlan?: string | null;
  versionInfo?: { version: number; totalVersions: number; project: string };
}

const MIRROR_SUBDIR = "mirror";

// Bind retry — the parent hook holds the port until it stops ~1.5s after
// spawning us. Poll aggressively so the browser's reconnect gap is minimal.
const BIND_RETRY_MS = 150;
const BIND_MAX_ATTEMPTS = 60; // ~9s ceiling

// Idle shutdown thresholds.
const IDLE_CHECK_MS = 15_000;
const STARTUP_GRACE_MS = 90_000; // tab never (re)connected → give up
const IDLE_AFTER_CONNECT_MS = 5 * 60_000; // tab closed → linger, then exit
const HARD_CAP_MS = 6 * 60 * 60_000; // absolute lifetime ceiling

function mirrorDir(): string {
  const dir = join(getPlannotatorDataDir(), MIRROR_SUBDIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve how to re-invoke *this* program. A compiled single-file Bun binary
 * (the shipped `plannotator` / `ipe.bin`): just exec the binary. Dev
 * (`bun run …`): exec bun against the entry script.
 */
function resolveSelfExec(): string[] {
  const execName = basename(process.execPath);
  const isBunRuntime = execName === "bun" || execName.startsWith("bun-");
  return isBunRuntime ? [process.execPath, Bun.main] : [process.execPath];
}

/**
 * Write a handoff file and spawn the detached mirror. Returns false if the
 * spawn couldn't be initiated. Never throws — the approve path must not fail
 * because the mirror couldn't launch.
 */
export function spawnDetachedMirror(handoff: MirrorHandoff): boolean {
  try {
    const file = join(
      mirrorDir(),
      `${handoff.port}-${handoff.sinceMs}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    writeFileSync(file, JSON.stringify(handoff), "utf-8");
    const [cmd, ...pre] = resolveSelfExec();
    // Debug: capture the detached child's output when PLANNOTATOR_MIRROR_DEBUG
    // is set — otherwise it's fully detached from stdio.
    let stdio: "ignore" | ["ignore", number, number] = "ignore";
    if (process.env.PLANNOTATOR_MIRROR_DEBUG) {
      try {
        const fd = openSync(join(mirrorDir(), "mirror-debug.log"), "a");
        stdio = ["ignore", fd, fd];
      } catch {}
    }
    const child = spawn(cmd, [...pre, "mirror", "--handoff", file], {
      cwd: handoff.cwd,
      detached: true,
      stdio,
      env: process.env,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Read + consume (delete) a handoff file written by `spawnDetachedMirror`. */
export function readMirrorHandoff(file: string): MirrorHandoff {
  const raw = readFileSync(file, "utf-8");
  try {
    unlinkSync(file);
  } catch {
    // Best-effort — a leftover handoff file is harmless.
  }
  return JSON.parse(raw) as MirrorHandoff;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface StartMirrorOptions extends MirrorHandoff {
  /** Embedded SPA HTML (the same bundle the hook serves). */
  htmlContent: string;
}

/**
 * Start the detached mirror server. Binds `port` (retrying until the parent
 * hook releases it), streams execution activity, and idle-shuts-down when the
 * watching tab closes. Resolves once bound (or after giving up); then runs
 * until it calls `process.exit` from the idle loop.
 */
export async function startMirrorServer(opts: StartMirrorOptions): Promise<void> {
  const { port, cwd, sinceMs, plan, origin, htmlContent } = opts;
  const previousPlan = opts.previousPlan ?? null;
  const versionInfo =
    opts.versionInfo ?? { version: 0, totalVersions: 0, project: "" };
  const draftKey = contentHash(plan);

  const dbg = (m: string) => {
    if (process.env.PLANNOTATOR_MIRROR_DEBUG) {
      console.error(`[mirror pid=${process.pid} t=${Date.now()}] ${m}`);
    }
  };
  dbg(`start port=${port} cwd=${cwd}`);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(sig, () => {
      dbg(`received ${sig} — exiting`);
      process.exit(0);
    });
  }

  const executionWatch = createExecutionWatch(cwd);
  const externalAnnotations = createExternalAnnotationHandler("plan");
  executionWatch.start(sinceMs);

  let server: ReturnType<typeof Bun.serve> | null = null;

  const shutdown = (reason = "unknown") => {
    dbg(`shutdown reason=${reason}`);
    try {
      executionWatch.stop();
    } catch {}
    try {
      server?.stop();
    } catch {}
    try {
      unregisterSession();
    } catch {}
    process.exit(0);
  };

  for (let attempt = 1; attempt <= BIND_MAX_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve({
        hostname: getServerHostname(),
        port,
        idleTimeout: 0,

        async fetch(req, srv) {
          const url = new URL(req.url);

          // Execution mirror stream — the whole point of this server.
          const execRes = await executionWatch.handle(req, url, {
            disableIdleTimeout: () => srv.timeout(req, 0),
          });
          if (execRes) return execRes;

          // External annotations — keep the tab's stream alive (fresh/empty
          // store; review-time annotations no longer matter post-approve).
          const extRes = await externalAnnotations.handle(req, url, {
            disableIdleTimeout: () => srv.timeout(req, 0),
          });
          if (extRes) return extRes;

          // Draft — nothing edits post-approve, but the app still probes it.
          if (url.pathname === "/api/draft") {
            if (req.method === "POST") return handleDraftSave(req, draftKey);
            if (req.method === "DELETE") return handleDraftDelete(draftKey, req);
            return handleDraftLoad(draftKey);
          }

          // Plan — served so a full refresh still re-renders.
          if (url.pathname === "/api/plan") {
            return Response.json({
              plan,
              origin,
              previousPlan,
              versionInfo,
              projectRoot: cwd,
              watching: true,
              sharingEnabled: false,
            });
          }

          if (url.pathname === "/api/image") return handleImage(req);
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // Done watching → shut the mirror down (let the response flush first).
          if (url.pathname === "/api/done" && req.method === "POST") {
            setTimeout(() => shutdown("api-done"), 250);
            return Response.json({ ok: true });
          }

          // AI is not wired up in the detached mirror.
          if (url.pathname === "/api/ai/capabilities" && req.method === "GET") {
            return Response.json({ available: false, providers: [] });
          }
          if (url.pathname.startsWith("/api/")) {
            return Response.json(
              { error: "Not available in watch mode" },
              { status: 404 },
            );
          }

          if (url.pathname === "/favicon.svg") return handleFavicon();

          // SPA fallthrough.
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        },

        error(err) {
          return new Response(
            `Internal Server Error: ${err instanceof Error ? err.message : String(err)}`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        },
      });
      dbg(`bound on attempt ${attempt}`);
      break;
    } catch (err) {
      // Bun's port-in-use error message doesn't contain "EADDRINUSE" (it says
      // "Is port N in use?"), so isAddressInUseError checks the code too —
      // without which the retry-until-the-parent-frees-the-port loop (the
      // whole point of the handoff) would never fire.
      const inUse = isAddressInUseError(err);
      if (inUse && attempt < BIND_MAX_ATTEMPTS) {
        if (attempt === 1 || attempt % 10 === 0) dbg(`bind attempt ${attempt}: in-use, retrying`);
        await Bun.sleep(BIND_RETRY_MS);
        continue;
      }
      // Can't bind — nothing to serve; give up quietly.
      dbg(`bind failed: ${err instanceof Error ? err.message : String(err)}`);
      shutdown("bind-failed");
      return;
    }
  }

  if (!server) {
    shutdown("no-server");
    return;
  }
  dbg("serving");

  registerSession({
    pid: process.pid,
    port,
    url: `http://localhost:${port}`,
    mode: "plan",
    project: basename(cwd) || "_unknown",
    startedAt: new Date(sinceMs).toISOString(),
    label: `watching-${basename(cwd) || "project"}`,
  });
  process.on("exit", () => {
    try {
      unregisterSession();
    } catch {}
  });

  // Idle-shutdown loop. Exit once the watching tab has closed (subscriber
  // count returns to 0 and stays there past the grace window), if it never
  // connects at all, or once the hard cap is hit. Bun.serve keeps the event
  // loop alive; this interval decides when to end it.
  const startedAt = Date.now();
  let everConnected = false;
  let zeroSince: number | null = Date.now();
  setInterval(() => {
    const n = executionWatch.subscriberCount();
    if (n > 0) {
      everConnected = true;
      zeroSince = null;
    } else if (zeroSince === null) {
      zeroSince = Date.now();
    }

    const now = Date.now();
    if (now - startedAt > HARD_CAP_MS) {
      shutdown("hard-cap");
      return;
    }
    if (zeroSince !== null) {
      const grace = everConnected ? IDLE_AFTER_CONNECT_MS : STARTUP_GRACE_MS;
      if (now - zeroSince > grace) shutdown(everConnected ? "idle-after-connect" : "startup-grace");
    }
  }, IDLE_CHECK_MS);
}
