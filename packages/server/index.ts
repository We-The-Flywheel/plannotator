/**
 * Plannotator Shared Server
 *
 * Provides a consistent server implementation for both Claude Code and OpenCode plugins.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port to use (default: random locally, 19432 for remote)
 *   PLANNOTATOR_ORIGIN - Explicit origin override; validated against AGENT_CONFIG
 *                        in packages/shared/agents.ts. Supported values:
 *                        "claude-code", "opencode", "codex", "copilot-cli",
 *                        "gemini-cli", "pi".
 */

import type { Origin } from "@plannotator/shared/agents";
import { resolve } from "path";
import { homedir } from "os";
import { isRemoteSession, getServerHostname, getServerPort } from "./remote";
import { openEditorDiff } from "./ide";
import {
  saveToObsidian,
  saveToBear,
  saveToOctarine,
  type ObsidianConfig,
  type BearConfig,
  type OctarineConfig,
  type IntegrationResult,
} from "./integrations";
import {
  generateSlug,
  savePlan,
  saveAnnotations,
  saveFinalSnapshot,
  saveToHistory,
  getPlanVersion,
  getPlanVersionPath,
  getVersionCount,
  listVersions,
  listArchivedPlans,
  readArchivedPlan,
  type ArchivedPlan,
} from "./storage";
import { getRepoInfo } from "./repo";
import { detectProjectName } from "./project";
import { saveConfig, detectGitUser, getServerConfig } from "./config";
import { handleImage, handleUpload, handleAgents, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleFavicon, handleAutomationsRoute, type OpencodeClient } from "./shared-handlers";
import { contentHash, deleteDraft } from "./draft";
import { handleDoc, handleObsidianVaults, handleObsidianFiles, handleObsidianDoc, handleFileBrowserFiles } from "./reference-handlers";
import { templateToEntry, type AutomationEntry } from "./automations";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createExternalAnnotationHandler } from "./external-annotations";
import { createExecutionWatch } from "./execution-watch";
import { scanPlanAgainstClaudeMd, violationToAnnotationInput } from "./claude-md-rules";
import { addWaiver, removeWaiver, loadWaivers } from "./claude-md-waivers";
import { runRedTeamReview, runRedTeamReviewStreaming } from "./red-team-review";
import { evaluatePolicy } from "./policies";
import { findSimilarPastPlans, similarPlanToAnnotationInput } from "./archive-similarity";
import { isWSL } from "./browser";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export * from "./integrations";
export * from "./storage";
export { handleServerReady } from "./shared-handlers";
export { type VaultNode, buildFileTree } from "@plannotator/shared/reference-common";

// --- Helpers ---

/** Load OpenRouter API key from env or ~/.env.shared */
async function loadOpenRouterKey(): Promise<string | null> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const home = process.env.HOME || homedir();
  for (const envPath of [
    resolve(home, "opt/security-mgmt/.env.shared"),
    resolve(home, ".env.shared"),
  ]) {
    try {
      const content = await Bun.file(envPath).text();
      for (const line of content.split("\n")) {
        if (line.startsWith("OPENROUTER_API_KEY=")) {
          return line.split("=", 2)[1].trim().replace(/^['"]|['"]$/g, "");
        }
      }
    } catch { /* file not found */ }
  }
  return null;
}

// --- Types ---

export interface ServerOptions {
  /** The plan markdown content */
  plan: string;
  /** Origin identifier (e.g., "claude-code", "opencode") */
  origin: Origin;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Current permission mode to preserve (Claude Code only) */
  permissionMode?: string;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Custom base URL for share links (default: https://share.plannotator.ai) */
  shareBaseUrl?: string;
  /** Base URL of the paste service API for short URL sharing */
  pasteApiUrl?: string;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
  /** OpenCode client for querying available agents (OpenCode only) */
  opencodeClient?: OpencodeClient;
  /** When set to "archive", server runs in read-only archive browser mode */
  mode?: "archive";
  /** Custom plan save path — used by archive mode to find saved plans */
  customPlanPath?: string | null;
  /** Bundled automation library (from generated.ts) */
  bundledAutomations?: AutomationEntry[];
}

export interface ServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user decision (approve/deny) */
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
  }>;
  /** Wait for user to close (archive mode only) */
  waitForDone?: () => Promise<void>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Plannotator server
 *
 * Handles:
 * - Remote detection and port configuration
 * - All API routes (/api/plan, /api/approve, /api/deny, etc.)
 * - Obsidian/Bear integrations
 * - Port conflict retries
 */
export async function startPlannotatorServer(
  options: ServerOptions
): Promise<ServerResult> {
  const { plan: initialPlan, origin, htmlContent, permissionMode, sharingEnabled = true, shareBaseUrl, pasteApiUrl, onReady, mode, customPlanPath } = options;

  // Mutable: updated when multi-LLM deliberation revises the plan
  let plan = initialPlan;

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser();

  // --- Archive mode setup ---
  let archivePlans: ArchivedPlan[] = [];
  let initialArchivePlan = "";
  let resolveDone: (() => void) | undefined;
  let donePromise: Promise<void> | undefined;

  if (mode === "archive") {
    archivePlans = listArchivedPlans(customPlanPath ?? undefined);
    initialArchivePlan = archivePlans.length > 0
      ? readArchivedPlan(archivePlans[0].filename, customPlanPath ?? undefined) ?? ""
      : "";
    donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });
  }

  // --- Plan review mode setup (skip in archive mode) ---
  const draftKey = mode !== "archive" ? contentHash(plan) : "";
  const editorAnnotations = mode !== "archive" ? createEditorAnnotationHandler() : null;
  const externalAnnotations = mode !== "archive" ? createExternalAnnotationHandler("plan") : null;
  // Live execution mirror — only relevant during plan-review sessions.
  // Inert until `start(sinceMs)` is called from the approve handler.
  const executionWatch = mode !== "archive" ? createExecutionWatch(process.cwd()) : null;
  const slug = mode !== "archive" ? generateSlug(plan) : "";

  // CLAUDE.md-aware static review: scan the plan against project + global
  // rules and seed the external-annotation store before any client connects,
  // so violations show up in the initial snapshot.
  if (mode !== "archive" && externalAnnotations) {
    try {
      const projectName = await detectProjectName();
      const violations = scanPlanAgainstClaudeMd(plan, process.cwd(), projectName ?? undefined);
      if (violations.length > 0) {
        const result = externalAnnotations.addAnnotations({
          annotations: violations.map(violationToAnnotationInput),
        });
        if ("error" in result) {
          console.error("[claude-md-rules] failed to add annotations:", result.error);
        } else {
          console.error(`[claude-md-rules] flagged ${violations.length} potential rule violation(s)`);
        }
      }
    } catch (err) {
      console.error("[claude-md-rules] scan failed:", err);
    }

    // Archive similarity: surface the most-similar past plan (if any) so the
    // user sees prior decisions on related work before re-approving.
    try {
      const similar = findSimilarPastPlans(plan, 0.15, 1);
      if (similar.length > 0) {
        const result = externalAnnotations.addAnnotations({
          annotations: similar.map(similarPlanToAnnotationInput),
        });
        if ("error" in result) {
          console.error("[archive-similarity] failed to add annotations:", result.error);
        } else {
          console.error(`[archive-similarity] surfaced ${similar.length} similar past plan(s)`);
        }
      }
    } catch (err) {
      console.error("[archive-similarity] scan failed:", err);
    }
  }

  // Lazy cache for in-session archive browsing (plan review sidebar tab)
  let cachedArchivePlans: ReturnType<typeof listArchivedPlans> | null = null;

  // Plan-specific: repo info, version history, decision promise
  let repoInfo: Awaited<ReturnType<typeof getRepoInfo>> | null = null;
  let project = "";
  let currentPlanPath = "";
  let previousPlan: string | null = null;
  let versionInfo = { version: 0, totalVersions: 0, project: "" };

  let resolveDecision: (result: {
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
  }) => void;
  let decisionPromise: Promise<{
    approved: boolean;
    feedback?: string;
    savedPath?: string;
    agentSwitch?: string;
    permissionMode?: string;
  }>;

  if (mode !== "archive") {
    repoInfo = await getRepoInfo();
    project = (await detectProjectName()) ?? "_unknown";
    const historyResult = saveToHistory(project, slug, plan);
    currentPlanPath = historyResult.path;
    previousPlan =
      historyResult.version > 1
        ? getPlanVersion(project, slug, historyResult.version - 1)
        : null;
    versionInfo = {
      version: historyResult.version,
      totalVersions: getVersionCount(project, slug),
      project,
    };

    decisionPromise = new Promise((resolve) => {
      resolveDecision = resolve;
    });
  } else {
    // Never-resolving promise — archive mode uses waitForDone instead
    decisionPromise = new Promise(() => {});
  }

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        hostname: getServerHostname(),
        port: configuredPort,

        async fetch(req, server) {
          const url = new URL(req.url);

          // API: Get a specific plan version from history
          if (url.pathname === "/api/plan/version") {
            const vParam = url.searchParams.get("v");
            if (!vParam) {
              return new Response("Missing v parameter", { status: 400 });
            }
            const v = parseInt(vParam, 10);
            if (isNaN(v) || v < 1) {
              return new Response("Invalid version number", { status: 400 });
            }
            const content = getPlanVersion(project, slug, v);
            if (content === null) {
              return Response.json({ error: "Version not found" }, { status: 404 });
            }
            return Response.json({ plan: content, version: v });
          }

          // API: List all versions for the current plan
          if (url.pathname === "/api/plan/versions") {
            return Response.json({
              project,
              slug,
              versions: listVersions(project, slug),
            });
          }

          // API: List archived plans (from ~/.plannotator/plans/)
          // Cached for session lifetime — new plans won't appear during a single review
          if (url.pathname === "/api/archive/plans" && req.method === "GET") {
            const customPath = url.searchParams.get("customPath") || undefined;
            if (!cachedArchivePlans) cachedArchivePlans = listArchivedPlans(customPath);
            return Response.json({ plans: cachedArchivePlans });
          }

          // API: Get a specific archived plan
          if (url.pathname === "/api/archive/plan" && req.method === "GET") {
            const filename = url.searchParams.get("filename");
            if (!filename) {
              return Response.json({ error: "Missing filename parameter" }, { status: 400 });
            }
            const customPath = url.searchParams.get("customPath") || undefined;
            const content = readArchivedPlan(filename, customPath);
            if (content === null) {
              return Response.json({ error: "Plan not found" }, { status: 404 });
            }
            return Response.json({ markdown: content, filepath: filename });
          }

          // API: Close archive browser (archive mode only)
          if (url.pathname === "/api/done" && req.method === "POST") {
            resolveDone?.();
            return Response.json({ ok: true });
          }

          // API: Get plan content
          if (url.pathname === "/api/plan") {
            if (mode === "archive") {
              return Response.json({
                plan: initialArchivePlan,
                origin,
                mode: "archive",
                archivePlans,
                sharingEnabled,
                shareBaseUrl,
                isWSL: wslFlag,
                serverConfig: getServerConfig(gitUser),
              });
            }
            // Check if a multi-LLM review already completed recently (e.g. via shell)
            let reviewAlreadyDone = false;
            try {
              const markerPath = resolve(homedir(), ".plannotator", "council-done.json");
              const stat = Bun.file(markerPath);
              if (await stat.exists()) {
                const marker = JSON.parse(await stat.text());
                const ageMs = Date.now() - (marker.ts ?? 0) * 1000;
                if (ageMs < 5 * 60 * 1000) {
                  reviewAlreadyDone = true;
                  // Delete marker so it's consumed only once
                  const fs = await import("fs/promises");
                  await fs.unlink(markerPath).catch(() => {});
                }
              }
            } catch {}
            return Response.json({ plan, origin, permissionMode, sharingEnabled, shareBaseUrl, pasteApiUrl, repoInfo, previousPlan, versionInfo, projectRoot: process.cwd(), isWSL: wslFlag, serverConfig: getServerConfig(gitUser), reviewAlreadyDone });
          }

          // API: Serve a linked markdown document
          if (url.pathname === "/api/doc" && req.method === "GET") {
            return handleDoc(req);
          }

          // API: Update user config (write-back to ~/.plannotator/config.json)
          if (url.pathname === "/api/config" && req.method === "POST") {
            try {
              const body = (await req.json()) as { displayName?: string; diffOptions?: Record<string, unknown>; conventionalComments?: boolean; conventionalLabels?: unknown[] | null };
              const toSave: Record<string, unknown> = {};
              if (body.displayName !== undefined) toSave.displayName = body.displayName;
              if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
              if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
              if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
              if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
              return Response.json({ ok: true });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            }
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            return handleImage(req);
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // API: Open plan diff in VS Code
          if (url.pathname === "/api/plan/vscode-diff" && req.method === "POST") {
            try {
              const body = (await req.json()) as { baseVersion: number };

              if (!body.baseVersion) {
                return Response.json({ error: "Missing baseVersion" }, { status: 400 });
              }

              const basePath = getPlanVersionPath(project, slug, body.baseVersion);
              if (!basePath) {
                return Response.json({ error: `Version ${body.baseVersion} not found` }, { status: 404 });
              }

              const result = await openEditorDiff(basePath, currentPlanPath);
              if ("error" in result) {
                return Response.json({ error: result.error }, { status: 500 });
              }
              return Response.json({ ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to open VS Code diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Detect Obsidian vaults
          if (url.pathname === "/api/obsidian/vaults") {
            return handleObsidianVaults();
          }

          // API: List Obsidian vault files as a tree
          if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
            return handleObsidianFiles(req);
          }

          // API: Read an Obsidian vault document
          if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
            return handleObsidianDoc(req);
          }

          // API: List markdown files in a directory as a tree
          if (url.pathname === "/api/reference/files" && req.method === "GET") {
            return handleFileBrowserFiles(req);
          }

          // API: Get available agents (OpenCode only)
          if (url.pathname === "/api/agents") {
            return handleAgents(options.opencodeClient);
          }

          // API: Annotation draft persistence
          if (url.pathname === "/api/draft") {
            if (req.method === "POST") return handleDraftSave(req, draftKey);
            if (req.method === "DELETE") return handleDraftDelete(draftKey);
            return handleDraftLoad(draftKey);
          }

          // API: Editor annotations (VS Code extension)
          const editorResponse = await editorAnnotations?.handle(req, url);
          if (editorResponse) return editorResponse;

          // API: External annotations (SSE-based, for any external tool)
          const externalResponse = await externalAnnotations?.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (externalResponse) return externalResponse;

          // API: Live execution mirror (SSE-based, populated post-approve)
          const executionResponse = await executionWatch?.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (executionResponse) return executionResponse;

          // API: Automations CRUD
          const automationsResponse = await handleAutomationsRoute(req, url, "plan", options.bundledAutomations || []);
          if (automationsResponse) return automationsResponse;

          // API: Save to notes (decoupled from approve/deny)
          if (url.pathname === "/api/save-notes" && req.method === "POST") {
            const results: { obsidian?: IntegrationResult; bear?: IntegrationResult; octarine?: IntegrationResult } = {};

            try {
              const body = (await req.json()) as {
                obsidian?: ObsidianConfig;
                bear?: BearConfig;
                octarine?: OctarineConfig;
              };

              // Run integrations in parallel — they're independent
              const promises: Promise<void>[] = [];
              if (body.obsidian?.vaultPath && body.obsidian?.plan) {
                promises.push(saveToObsidian(body.obsidian).then(r => { results.obsidian = r; }));
              }
              if (body.bear?.plan) {
                promises.push(saveToBear(body.bear).then(r => { results.bear = r; }));
              }
              if (body.octarine?.plan && body.octarine?.workspace) {
                promises.push(saveToOctarine(body.octarine).then(r => { results.octarine = r; }));
              }
              await Promise.allSettled(promises);

              for (const [name, result] of Object.entries(results)) {
                if (!result?.success && result) {
                  console.error(`[${name}] Save failed: ${result.error}`);
                }
              }
            } catch (err) {
              console.error(`[Save Notes] Error:`, err);
              return Response.json({ error: "Save failed" }, { status: 500 });
            }

            return Response.json({ ok: true, results });
          }

          // --- Multi-LLM Review Endpoints ---

          // API: Multi-LLM review (streaming SSE)
          if (url.pathname === "/api/multi-llm-review-stream" && req.method === "POST") {
            try {
              // Guard: skip if council.py is already running (e.g. triggered via shell skill)
              const pgrep = Bun.spawn(["pgrep", "-f", "council\\.py"], { stdout: "pipe", stderr: "pipe" });
              const pgrepOut = await new Response(pgrep.stdout).text();
              await pgrep.exited;
              if (pgrepOut.trim()) {
                return Response.json(
                  { error: "Multi-LLM review already in progress (council.py running)" },
                  { status: 409 },
                );
              }

              const body = (await req.json()) as { plan?: string; question?: string };
              const planText = body.plan || plan;
              const question = body.question || `Review this implementation plan and provide feedback on completeness, risks, and improvements:\n${planText}`;

              const councilPaths = [
                resolve(import.meta.dir, "../../../../skills/multi-llm-deliberation/council.py"),
                resolve(process.env.HOME || homedir(), "opt/agentic-coding/skills/multi-llm-deliberation/council.py"),
              ];
              let councilPath: string | null = null;
              for (const p of councilPaths) {
                if (await Bun.file(p).exists()) { councilPath = p; break; }
              }
              if (!councilPath) {
                return Response.json({ error: "council.py not found." }, { status: 404 });
              }

              const proc = Bun.spawn(["python3", councilPath, "--json", question], {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env },
              });

              const stdoutPromise = new Response(proc.stdout).text();
              const encoder = new TextEncoder();
              const decoder = new TextDecoder();

              const stream = new ReadableStream({
                async start(controller) {
                  /** Emit a single SSE event with proper double-newline termination. */
                  const emit = (data: string) => {
                    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                  };

                  // Heartbeat keeps the SSE connection alive during long model calls
                  const heartbeat = setInterval(() => {
                    try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch {}
                  }, 5_000);

                  try {
                    // Stream progress events from council.py stderr
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
                            emit(trimmed);
                          } catch {
                            emit(JSON.stringify({ event: "log", message: trimmed }));
                          }
                        }
                      }
                      if (buffer.trim()) {
                        emit(JSON.stringify({ event: "log", message: buffer.trim() }));
                      }
                    } catch { /* reader error */ }

                    // Process final result from stdout
                    const stdout = await stdoutPromise;
                    const exitCode = await proc.exited;

                    if (exitCode !== 0) {
                      emit(JSON.stringify({ event: "error", message: `Deliberation failed (exit ${exitCode})` }));
                    } else {
                      try {
                        const structured = JSON.parse(stdout);
                        emit(JSON.stringify({ event: "result", ok: true, result: structured.consensus, structured }));
                      } catch {
                        emit(JSON.stringify({ event: "result", ok: true, result: stdout }));
                      }
                    }
                  } finally {
                    clearInterval(heartbeat);
                    controller.close();
                  }
                },
              });

              // Disable Bun's idle timeout for this SSE connection — council.py can take several minutes
              server.timeout(req, 0);

              return new Response(stream, {
                headers: {
                  "Content-Type": "text/event-stream; charset=utf-8",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                },
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Streaming review failed";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Multi-LLM review (non-streaming fallback)
          if (url.pathname === "/api/multi-llm-review" && req.method === "POST") {
            try {
              // Guard: skip if council.py is already running
              const pgrep = Bun.spawn(["pgrep", "-f", "council\\.py"], { stdout: "pipe", stderr: "pipe" });
              const pgrepOut = await new Response(pgrep.stdout).text();
              await pgrep.exited;
              if (pgrepOut.trim()) {
                return Response.json(
                  { error: "Multi-LLM review already in progress (council.py running)" },
                  { status: 409 },
                );
              }

              const body = (await req.json()) as { plan?: string; question?: string };
              const planText = body.plan || plan;
              const question = body.question || `Review this implementation plan and provide feedback on completeness, risks, and improvements:\n${planText}`;

              const councilPaths = [
                resolve(import.meta.dir, "../../../../skills/multi-llm-deliberation/council.py"),
                resolve(process.env.HOME || homedir(), "opt/agentic-coding/skills/multi-llm-deliberation/council.py"),
              ];
              let councilPath: string | null = null;
              for (const p of councilPaths) {
                if (await Bun.file(p).exists()) { councilPath = p; break; }
              }
              if (!councilPath) {
                return Response.json({ error: "council.py not found. Install multi-llm-deliberation skill." }, { status: 404 });
              }

              const proc = Bun.spawn(["python3", councilPath, "--json", question], {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env },
              });

              const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
              ]);
              const exitCode = await proc.exited;

              if (exitCode !== 0) {
                console.error(`[Multi-LLM] stderr: ${stderr}`);
                return Response.json({ error: stderr || "council.py failed", exitCode }, { status: 500 });
              }

              try {
                const structured = JSON.parse(stdout);
                return Response.json({ ok: true, result: structured.consensus, structured, stderr });
              } catch {
                return Response.json({ ok: true, result: stdout, stderr });
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : "Multi-LLM review failed";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Apply multi-LLM review feedback to the plan
          if (url.pathname === "/api/apply-review" && req.method === "POST") {
            try {
              const body = (await req.json()) as { plan: string; feedback: string };
              if (!body.plan || !body.feedback) {
                return Response.json({ error: "plan and feedback are required" }, { status: 400 });
              }

              const apiKey = await loadOpenRouterKey();
              if (!apiKey) {
                return Response.json({ error: "OPENROUTER_API_KEY not set" }, { status: 500 });
              }

              const revisionPrompt = `You are revising an implementation plan based on expert review feedback.

Here is the ORIGINAL PLAN:
${body.plan}

Here is the REVIEW FEEDBACK from multiple AI models:
${body.feedback}

INSTRUCTIONS:
- Produce an UPDATED version of the plan that incorporates the valid feedback
- Keep the same markdown structure and heading hierarchy
- Add, modify, or remove sections as the feedback suggests
- Add new steps, edge cases, or considerations that were identified
- If the feedback identifies risks, add mitigation strategies
- Do NOT add a "changes made" section — just output the improved plan
- Do NOT wrap in code fences — output raw markdown
- Preserve the original plan's style and voice`;

              const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${apiKey}`,
                  "Content-Type": "application/json",
                  "HTTP-Referer": "https://github.com/backnotprop/plannotator",
                  "X-Title": "plannotator-apply-review",
                },
                body: JSON.stringify({
                  model: "google/gemini-3-flash-preview",
                  messages: [{ role: "user", content: revisionPrompt }],
                  temperature: 0.3,
                  max_tokens: 8192,
                }),
                signal: AbortSignal.timeout(120_000),
              });

              if (!orResponse.ok) {
                const errBody = await orResponse.text();
                console.error(`[Apply Review] OpenRouter error: ${orResponse.status} ${errBody}`);
                return Response.json({ error: `OpenRouter API error: ${orResponse.status}` }, { status: 502 });
              }

              const orData = (await orResponse.json()) as { choices?: { message?: { content?: string } }[]; content?: string };
              const revisedPlan = orData.choices?.[0]?.message?.content || orData.content || (typeof orData === "string" ? orData : null);

              if (!revisedPlan) {
                return Response.json({ error: "No response from revision model" }, { status: 502 });
              }

              // Update the server's plan so approve/deny use the revised version
              plan = revisedPlan;

              const historyResult = saveToHistory(project, slug, revisedPlan);
              const newVersionInfo = {
                version: historyResult.version,
                totalVersions: getVersionCount(project, slug),
                project,
              };

              return Response.json({ ok: true, plan: revisedPlan, previousPlan: body.plan, versionInfo: newVersionInfo });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Apply review failed";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Adversarial ("red-team") review — runs AFTER consensus has
          // been applied. Single cheap model whose only job is to find what
          // the council missed. Never blocks approval; UI fires fetch-and-forget.
          if (url.pathname === "/api/red-team-review" && req.method === "POST") {
            try {
              const body = (await req.json()) as { plan?: unknown; consensus?: unknown };
              const planText = body.plan;
              const consensus = body.consensus;
              if (typeof planText !== "string" || planText.trim().length === 0) {
                return Response.json({ error: "plan is required (non-empty string)" }, { status: 400 });
              }
              if (typeof consensus !== "string" || consensus.trim().length === 0) {
                return Response.json({ error: "consensus is required (non-empty string)" }, { status: 400 });
              }

              const result = await runRedTeamReview(planText, consensus);
              return Response.json(result);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Red-team review failed";
              console.error("[red-team]", err);
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Streaming adversarial review — same logic as /api/red-team-review
          // but emits SSE chunks so the UI can render findings token-by-token.
          if (url.pathname === "/api/red-team-review-stream" && req.method === "POST") {
            try {
              const body = (await req.json()) as { plan?: unknown; consensus?: unknown };
              const planText = body.plan;
              const consensus = body.consensus;
              if (typeof planText !== "string" || planText.trim().length === 0) {
                return Response.json({ error: "plan is required (non-empty string)" }, { status: 400 });
              }
              if (typeof consensus !== "string" || consensus.trim().length === 0) {
                return Response.json({ error: "consensus is required (non-empty string)" }, { status: 400 });
              }

              server.timeout(req, 0);
              const encoder = new TextEncoder();
              const stream = new ReadableStream({
                start(controller) {
                  const send = (event: object) => {
                    try {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                    } catch { /* controller closed */ }
                  };
                  runRedTeamReviewStreaming(planText, consensus, {
                    onChunk: (chunk) => send({ event: "chunk", text: chunk }),
                    onDone: ({ modelId, durationMs }) => {
                      send({ event: "done", modelId, durationMs });
                      try { controller.close(); } catch { /* already closed */ }
                    },
                    onError: (err) => {
                      console.error("[red-team-stream]", err);
                      send({ event: "error", message: err.message });
                      try { controller.close(); } catch { /* already closed */ }
                    },
                  });
                },
              });

              return new Response(stream, {
                headers: {
                  "Content-Type": "text/event-stream; charset=utf-8",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                },
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Red-team stream failed";
              console.error("[red-team-stream]", err);
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: CLAUDE.md rule waivers — list / add / remove per project
          if (url.pathname === "/api/claude-md-rules/waive" && req.method === "GET") {
            const proj = (await detectProjectName()) ?? "default";
            return Response.json({ waived: loadWaivers(proj) });
          }
          if (url.pathname === "/api/claude-md-rules/waive" && req.method === "POST") {
            try {
              const body = (await req.json()) as { ruleId?: unknown };
              if (typeof body.ruleId !== "string" || !body.ruleId) {
                return Response.json({ error: "ruleId required (string)" }, { status: 400 });
              }
              const proj = (await detectProjectName()) ?? "default";
              const list = addWaiver(proj, body.ruleId);
              return Response.json({ waived: list });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
          }
          if (url.pathname === "/api/claude-md-rules/waive" && req.method === "DELETE") {
            const ruleId = url.searchParams.get("ruleId");
            if (!ruleId) return Response.json({ error: "?ruleId= required" }, { status: 400 });
            const proj = (await detectProjectName()) ?? "default";
            const list = removeWaiver(proj, ruleId);
            return Response.json({ waived: list });
          }

          // API: Evaluate auto-approval policy against the current plan
          if (url.pathname === "/api/policies/evaluate" && req.method === "POST") {
            try {
              const body = (await req.json()) as { plan?: unknown };
              const planText = typeof body.plan === "string" ? body.plan : plan;
              const proj = (await detectProjectName()) ?? "default";
              const decision = evaluatePolicy(planText, proj);
              return Response.json(decision);
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
          }

          // API: OpenRouter balance check
          if (url.pathname === "/api/openrouter/balance" && req.method === "GET") {
            try {
              const apiKey = await loadOpenRouterKey();
              if (!apiKey) {
                return Response.json({ ok: false, error: "OPENROUTER_API_KEY not set" }, { status: 500 });
              }

              const resp = await fetch("https://openrouter.ai/api/v1/auth/key", {
                headers: { "Authorization": `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(10_000),
              });

              if (!resp.ok) {
                return Response.json({ ok: false, error: `OpenRouter returned ${resp.status}` }, { status: 502 });
              }

              const data = (await resp.json()) as { data?: unknown };
              return Response.json({ ok: true, data: data.data || data });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Balance check failed";
              return Response.json({ ok: false, error: message }, { status: 500 });
            }
          }

          // API: Approve plan
          if (url.pathname === "/api/approve" && req.method === "POST") {
            // Check for note integrations and optional feedback
            let feedback: string | undefined;
            let agentSwitch: string | undefined;
            let requestedPermissionMode: string | undefined;
            let planSaveEnabled = true; // default to enabled for backwards compat
            let planSaveCustomPath: string | undefined;
            try {
              const body = (await req.json().catch(() => ({}))) as {
                obsidian?: ObsidianConfig;
                bear?: BearConfig;
                octarine?: OctarineConfig;
                feedback?: string;
                agentSwitch?: string;
                planSave?: { enabled: boolean; customPath?: string };
                permissionMode?: string;
              };

              // Capture feedback if provided (for "approve with notes")
              if (body.feedback) {
                feedback = body.feedback;
              }

              // Capture agent switch setting for OpenCode
              if (body.agentSwitch) {
                agentSwitch = body.agentSwitch;
              }

              // Capture permission mode from client request (Claude Code)
              if (body.permissionMode) {
                requestedPermissionMode = body.permissionMode;
              }

              // Capture plan save settings
              if (body.planSave !== undefined) {
                planSaveEnabled = body.planSave.enabled;
                planSaveCustomPath = body.planSave.customPath;
              }

              // Run integrations in parallel — they're independent
              const integrationResults: Record<string, IntegrationResult> = {};
              const integrationPromises: Promise<void>[] = [];
              if (body.obsidian?.vaultPath && body.obsidian?.plan) {
                integrationPromises.push(saveToObsidian(body.obsidian).then(r => { integrationResults.obsidian = r; }));
              }
              if (body.bear?.plan) {
                integrationPromises.push(saveToBear(body.bear).then(r => { integrationResults.bear = r; }));
              }
              if (body.octarine?.plan && body.octarine?.workspace) {
                integrationPromises.push(saveToOctarine(body.octarine).then(r => { integrationResults.octarine = r; }));
              }
              await Promise.allSettled(integrationPromises);

              for (const [name, result] of Object.entries(integrationResults)) {
                if (!result?.success && result) {
                  console.error(`[${name}] Save failed: ${result.error}`);
                }
              }
            } catch (err) {
              // Don't block approval on integration errors
              console.error(`[Integration] Error:`, err);
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              const annotations = feedback || "";
              if (annotations) {
                saveAnnotations(slug, annotations, planSaveCustomPath);
              }
              savedPath = saveFinalSnapshot(slug, "approved", plan, annotations, planSaveCustomPath);
            }

            // Clean up draft on successful submit
            deleteDraft(draftKey);

            // Use permission mode from client request if provided, otherwise fall back to hook input
            const effectivePermissionMode = requestedPermissionMode || permissionMode;
            resolveDecision({ approved: true, feedback, savedPath, agentSwitch, permissionMode: effectivePermissionMode });

            // Kick off the live execution mirror — anchored at approval time
            // so we only surface activity that happened *after* approval.
            // Deny path intentionally does NOT start the watcher.
            executionWatch?.start(Date.now());

            return Response.json({ ok: true, savedPath });
          }

          // API: Deny with feedback
          if (url.pathname === "/api/deny" && req.method === "POST") {
            let feedback = "Plan rejected by user";
            let planSaveEnabled = true; // default to enabled for backwards compat
            let planSaveCustomPath: string | undefined;
            try {
              const body = (await req.json()) as {
                feedback?: string;
                planSave?: { enabled: boolean; customPath?: string };
              };
              feedback = body.feedback || feedback;

              // Capture plan save settings
              if (body.planSave !== undefined) {
                planSaveEnabled = body.planSave.enabled;
                planSaveCustomPath = body.planSave.customPath;
              }
            } catch {
              // Use default feedback
            }

            // Save annotations and final snapshot (if enabled)
            let savedPath: string | undefined;
            if (planSaveEnabled) {
              saveAnnotations(slug, feedback, planSaveCustomPath);
              savedPath = saveFinalSnapshot(slug, "denied", plan, feedback, planSaveCustomPath);
            }

            deleteDraft(draftKey);
            resolveDecision({ approved: false, feedback, savedPath });
            return Response.json({ ok: true, savedPath });
          }

          // Favicon
          if (url.pathname === "/favicon.svg") return handleFavicon();

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        },

        error(err) {
          console.error("[plannotator] Server error:", err);
          return new Response(
            `Internal Server Error: ${err instanceof Error ? err.message : String(err)}`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        },
      });

      break; // Success, exit retry loop
    } catch (err: unknown) {
      const isAddressInUse =
        err instanceof Error && err.message.includes("EADDRINUSE");

      if (isAddressInUse && attempt < MAX_RETRIES) {
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }

      if (isAddressInUse) {
        const hint = isRemote ? " (set PLANNOTATOR_PORT to use different port)" : "";
        throw new Error(`Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`);
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start server");
  }

  const port = server.port!;
  const serverUrl = `http://localhost:${port}`;

  // Notify caller that server is ready
  if (onReady) {
    onReady(serverUrl, isRemote, port);
  }

  return {
    port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    ...(donePromise && { waitForDone: () => donePromise }),
    stop: () => {
      // Tear down the execution watcher first so its fs.watch handle and
      // poll interval are released before the HTTP server goes away.
      executionWatch?.stop();
      server.stop();
    },
  };
}
