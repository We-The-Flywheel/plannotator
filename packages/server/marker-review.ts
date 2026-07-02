import {
  profileHasCustomSection,
  type ResolvedReviewProfile,
} from "@plannotator/shared/review-profiles";
import {
  transformSeverityFindings,
  type ReviewSeverity,
  type ReviewFinding,
  type ReviewAnnotationInput,
} from "./review-findings";

/**
 * Marker Review Engines — the shared machinery for review CLIs that expose NO
 * schema-validation flag, so their final review output is prose. Cursor (the
 * `agent` binary) and OpenCode (`opencode run`) are the two. Because they can't
 * be told to emit validated structured output, they are instead told to emit a
 * marker-delimited JSON block, and we extract the LAST complete block from the
 * reconstructed canonical text.
 *
 * Everything else — the finding model (nullable file/line/end_line, classified
 * into line/whole-file/general by classifyFindingPlacement), custom review
 * profiles, and the transform into external annotations — is IDENTICAL to
 * Claude/Codex. The ONLY per-engine differences are captured in the
 * `MarkerEngine` descriptor: the binary, how to build argv, how to pull text
 * out of one stream event, how to discover models, and how to format a live log
 * line. There is exactly ONE copy of every shared piece below.
 *
 * PI-SAFETY: This file is vendored into the Pi (Node) build via vendor.sh, so it
 * MUST contain ZERO Bun.* / Bun-only APIs. The model-discovery SPAWN lives in
 * each runtime's agent-jobs adapter; this module only provides parseModels +
 * buildArgv + modelsArgv (pure data/functions).
 */

// ---------------------------------------------------------------------------
// Per-job marker — the JSON payload is delimited by tags carrying a random,
// per-job nonce: <plannotator-review-json:NONCE> … </plannotator-review-json:NONCE>.
//
// Why the nonce: in review mode the diff (and the model's own prose) is
// untrusted text that routinely contains the bare string "plannotator-review-json"
// — e.g. when reviewing this very module, or when the model echoes the contract
// example. A static tag let those echoed mentions be mistaken for the real
// delimiter, so extraction grabbed prose instead of the payload and valid
// reviews failed. The nonce is generated at prompt-build time, embedded in the
// output contract the model copies, and recovered from the stored prompt at
// parse time, so only the model's genuine payload can match.
// ---------------------------------------------------------------------------

const MARKER_TAG = "plannotator-review-json";

/** Open delimiter for a job's nonce. */
export function markerOpen(nonce: string): string {
  return `<${MARKER_TAG}:${nonce}>`;
}
/** Close delimiter for a job's nonce. */
export function markerClose(nonce: string): string {
  return `</${MARKER_TAG}:${nonce}>`;
}

/** Generate an unguessable per-job marker nonce (matches html-assets token style). */
export function makeMarkerNonce(): string {
  return "pn" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Recover the nonce embedded in a composed prompt's marker contract. Returns
 * null when absent — the parser then fails closed, since no payload can be
 * trusted without the expected delimiter.
 */
export function extractMarkerNonce(prompt: string): string | null {
  const m = new RegExp(`<${MARKER_TAG}:(pn[0-9a-f]{12})>`).exec(prompt);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Finding model — IDENTICAL to ClaudeFinding: nullable file/line/end_line so a
// finding can be a line issue (file + line), a whole-file issue (file, line
// null), or a general review-level note (both null). Nothing is dropped.
// ---------------------------------------------------------------------------

// Marker findings ARE review findings — reuse the one shared shape from
// review-findings.ts (this module already imports its transform) rather than
// keeping a byte-identical copy that could silently diverge.
export type MarkerSeverity = ReviewSeverity;
export type MarkerFinding = ReviewFinding;

export interface MarkerReviewSummary {
  correctness: string;
  explanation: string;
  confidence: number;
}

export interface MarkerReviewOutput {
  findings: MarkerFinding[];
  summary: MarkerReviewSummary;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "important",
  "nit",
  "pre_existing",
]);

// ---------------------------------------------------------------------------
// Schema validator — hand-rolled (no Ajv): marker output is prompt-enforced, so
// validation is the floor that turns prose back into a trusted object. Mirrors
// the claude-review.ts schema, which uses type [string,null] for file/line/
// end_line: a missing or null placement is VALID (whole-file / general note).
// Empty findings are valid as long as the JSON is valid and the summary is.
// ---------------------------------------------------------------------------

/**
 * Read a line coordinate that may be a finite integer, null, or absent. The
 * marker block is prompt-enforced, so a fractional/NaN/Infinity line is garbage
 * we will not trust as an annotation coordinate — it is rejected here.
 */
function optionalNullableInteger(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "number" && Number.isInteger(value)) return { ok: true, value };
  return { ok: false };
}

/** Read a value that may be a string, null, or absent — anything else is invalid. */
function optionalNullableString(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false };
}

/**
 * Validate a parsed object against the marker review schema. Returns the typed
 * output, or null if the shape is invalid. file/line/end_line are nullable —
 * absent or null is accepted (whole-file or general findings).
 */
export function validateMarkerReviewOutput(parsed: unknown): MarkerReviewOutput | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.findings)) return null;

  const summary = obj.summary;
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  if (typeof s.correctness !== "string") return null;
  if (typeof s.explanation !== "string") return null;
  if (typeof s.confidence !== "number" || !Number.isFinite(s.confidence)) return null;

  const findings: MarkerFinding[] = [];
  for (const raw of obj.findings) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;

    if (typeof f.severity !== "string" || !VALID_SEVERITIES.has(f.severity)) return null;
    if (typeof f.description !== "string") return null;

    const file = optionalNullableString(f.file);
    if (!file.ok) return null;
    const line = optionalNullableInteger(f.line);
    if (!line.ok) return null;
    const endLine = optionalNullableInteger(f.end_line);
    if (!endLine.ok) return null;

    findings.push({
      severity: f.severity as MarkerSeverity,
      file: file.value,
      line: line.value,
      end_line: endLine.value,
      description: f.description,
      reasoning: typeof f.reasoning === "string" ? f.reasoning : "",
    });
  }

  return {
    findings,
    summary: {
      correctness: s.correctness,
      explanation: s.explanation,
      // Clamp to [0,1] — the model occasionally reports out-of-range confidence.
      confidence: Math.max(0, Math.min(1, s.confidence)),
    },
  };
}

// ---------------------------------------------------------------------------
// MarkerEngine descriptor — the ONLY per-engine surface. Six fields.
// ---------------------------------------------------------------------------

export interface MarkerModel {
  id: string;
  label: string;
}

/** One parsed stream event, opaque to the shared reducer (each engine reads it). */
export type MarkerStreamEvent = Record<string, unknown>;

export interface MarkerEngine {
  /** Stable engine id — also the provider id used by the server. */
  id: "cursor" | "opencode";
  /** Display name for the capabilities/provider listing (e.g. "Cursor CLI"). */
  name: string;
  /** The CLI binary to spawn (NOTE: cursor's binary is `agent`). */
  binary: string;
  /** Author string stamped on every annotation this engine produces. */
  author: string;
  /** Build the full argv (binary + flags + trailing prompt) for a review run. */
  buildArgv: (prompt: string, model?: string, cwd?: string) => string[];
  /** Pull readable text out of one parsed stream event, or null if none. */
  extractText: (event: MarkerStreamEvent) => string | null;
  /** Argv (after the binary) for model discovery, e.g. ["models"]. */
  modelsArgv: string[];
  /** Parse the model-discovery stdout into a catalog. */
  parseModels: (stdout: string) => MarkerModel[];
  /** Format one stream line for the live log, or null to skip it. */
  formatLogEvent: (event: MarkerStreamEvent) => string | null;
}

// ---------------------------------------------------------------------------
// Cursor engine helpers
// ---------------------------------------------------------------------------

/**
 * A Cursor partial-output assistant event is a real new text delta only when
 * `timestamp_ms` is present AND `model_call_id` is absent. Every other assistant
 * flush is a duplicate re-emission (pre-tool-call flush or end-of-turn flush).
 */
function cursorIsRealAssistantDelta(event: MarkerStreamEvent): boolean {
  return event.timestamp_ms !== undefined && event.model_call_id === undefined;
}

/** Pull readable text out of a Cursor assistant event's content (string or parts). */
function cursorAssistantText(event: MarkerStreamEvent): string {
  if (typeof event.text === "string") return event.text;
  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type?: string; text?: string } => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

/**
 * Cursor `extractText` for the canonical-text reducer: append a real new delta
 * (timestamp_ms present, model_call_id absent). The no-timestamp branch KEEPS
 * the end-of-turn flush — it covers both partial-streaming-disabled output (the
 * full message arrives once) and the enabled-mode final flush, and is a
 * parse-robustness safety net (extractLastMarkerBlock takes the LAST block, so a
 * duplicate is harmless). result events carry the final text too.
 *
 * This is deliberately MORE lenient than cursorFormatLogEvent, which drops the
 * flush so live logs don't repeat the whole assistant output. Do not unify them.
 */
function cursorExtractText(event: MarkerStreamEvent): string | null {
  if (event.type === "assistant") {
    if (event.timestamp_ms !== undefined) {
      if (cursorIsRealAssistantDelta(event)) return cursorAssistantText(event);
      return null;
    }
    if (event.model_call_id === undefined) return cursorAssistantText(event);
    return null;
  }
  if (event.type === "result") {
    if (typeof event.result === "string") return event.result;
    if (typeof event.text === "string") return event.text;
    return null;
  }
  return null;
}

/**
 * Parse `agent models` / `agent --list-models` output into a model catalog. The
 * CLI prints one model per line as `<id> - <Label>`, wrapped by an "Available
 * models" header and a "Tip: ..." footer. Returns [] when no model lines are
 * present (e.g. unauthenticated: "No models available...").
 */
function cursorParseModels(stdout: string): MarkerModel[] {
  if (!stdout) return [];
  const models: MarkerModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    // `id - Label` — id is a single whitespace-free token; the separator is
    // " - " with surrounding spaces (model ids contain hyphens but never " - ").
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1];
    const label = match[2].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}

/**
 * Format one Cursor `stream-json` event for the LiveLogViewer. Applies the same
 * partial-output dedup rule as the reducer: an assistant delta is shown only
 * when `timestamp_ms` is present and `model_call_id` is absent.
 */
function cursorFormatLogEvent(event: MarkerStreamEvent): string | null {
  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        const model = typeof event.model === "string" ? event.model : undefined;
        const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
        const bits = ["[init]"];
        if (model) bits.push(`model=${model}`);
        if (sessionId) bits.push(`session=${sessionId}`);
        return bits.join(" ");
      }
      return null;
    }
    case "assistant": {
      if (!cursorIsRealAssistantDelta(event)) return null;
      const text = cursorAssistantText(event);
      return text ? text : null;
    }
    case "tool_call": {
      const name = typeof event.name === "string" ? event.name : "tool";
      if (event.subtype === "completed") {
        return `[${name}] completed`;
      }
      const args =
        typeof event.args === "string"
          ? event.args.slice(0, 100)
          : event.args !== undefined
            ? JSON.stringify(event.args).slice(0, 100)
            : "";
      return `[${name}] ${args}`.trimEnd();
    }
    case "result": {
      const duration =
        typeof event.duration_ms === "number" ? `${event.duration_ms}ms` : undefined;
      const requestId = typeof event.request_id === "string" ? event.request_id : undefined;
      const bits = ["[result]"];
      if (duration) bits.push(duration);
      if (requestId) bits.push(`request=${requestId}`);
      return bits.length > 1 ? bits.join(" ") : null;
    }
    default:
      return null;
  }
}

/**
 * Build the `agent -p` command. NOTE the binary is `agent`, NOT `cursor`.
 *
 * Read-only posture comes entirely from `--mode ask` + `--sandbox enabled` and
 * the absence of `--force`/`--yolo`. `--trust` is required in headless print
 * mode: without it Cursor stops on an interactive workspace-trust prompt that a
 * background job can never answer. The prompt is the trailing positional arg —
 * `agent` reads task text from argv, not stdin. `--model` is omitted when the
 * model is `Auto`/empty so Cursor uses its default model selection. `--workspace`
 * is set to the launch cwd when provided.
 */
function cursorBuildArgv(prompt: string, model?: string, cwd?: string): string[] {
  // `auto` is Cursor's default model id — omit --model so the CLI chooses.
  const useModel = !!model && model.toLowerCase() !== "auto";
  return [
    "agent",
    "-p",
    "--mode",
    "ask",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    ...(cwd ? ["--workspace", cwd] : []),
    "--sandbox",
    "enabled",
    ...(useModel ? ["--model", model] : []),
    // Prompt is the trailing positional arg — agent reads it from argv, not stdin.
    prompt,
  ];
}

// ---------------------------------------------------------------------------
// OpenCode engine helpers
// ---------------------------------------------------------------------------

/**
 * OpenCode `extractText`: the assistant text arrives in `type: "text"` events
 * carrying `part.text` (each finalized once). No partial-output dedup is needed —
 * just return the text part. tool_use / step_start / step_finish / reasoning /
 * error events carry no review text.
 */
function opencodeExtractText(event: MarkerStreamEvent): string | null {
  if (event.type === "text") {
    const part = event.part as { text?: unknown } | undefined;
    if (typeof part?.text === "string") return part.text;
  }
  return null;
}

/**
 * Parse `opencode models` output into a model catalog. The CLI prints one model
 * id per line as `provider/model`. Returns [] when there are no model lines
 * (e.g. unauthenticated / no providers configured).
 */
function opencodeParseModels(stdout: string): MarkerModel[] {
  if (!stdout) return [];
  const models: MarkerModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const id = rawLine.trim();
    // A model id is `provider/model` and may carry extra `/` segments (e.g.
    // OpenRouter's `openrouter/deepseek/deepseek-chat-v3`): a leading provider,
    // a slash, then a non-empty remainder, all whitespace-free.
    if (!id || /\s/.test(id) || !/^[^/\s]+\/\S+$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

/**
 * Format one `opencode run --format json` event for the LiveLogViewer. Returns a
 * human-readable string, or null if the event should be skipped.
 */
function opencodeFormatLogEvent(event: MarkerStreamEvent): string | null {
  const part = event.part as
    | { text?: unknown; tool?: unknown; state?: { status?: unknown } }
    | undefined;
  switch (event.type) {
    case "text": {
      const text = typeof part?.text === "string" ? part.text.trim() : "";
      return text ? text : null;
    }
    case "tool_use": {
      const tool = typeof part?.tool === "string" ? part.tool : "tool";
      const status = typeof part?.state?.status === "string" ? part.state.status : "";
      return `[${tool}] ${status}`.trimEnd();
    }
    case "error": {
      return "[error] session error";
    }
    default:
      // step_start / step_finish / reasoning — skipped for live logs.
      return null;
  }
}

/**
 * Build the `opencode run` command.
 *
 * `--format json` emits NDJSON events we capture on stdout. `--agent plan` is
 * OpenCode's read-oriented agent — a sensible default for review (it does not
 * edit). `--dir <cwd>` matches the spawn cwd. The message (prompt) is the
 * trailing positional arg. `--model` is `provider/model` and is omitted when
 * empty so OpenCode uses the configured default.
 */
function opencodeBuildArgv(prompt: string, model?: string, cwd?: string): string[] {
  const useModel = !!model && model.trim().length > 0;
  return [
    "opencode",
    "run",
    "--format",
    "json",
    "--agent",
    "plan",
    ...(useModel ? ["--model", model] : []),
    ...(cwd ? ["--dir", cwd] : []),
    // Message (prompt) is the trailing positional arg.
    prompt,
  ];
}

// ---------------------------------------------------------------------------
// The two descriptors + registry.
// ---------------------------------------------------------------------------

const CURSOR_ENGINE: MarkerEngine = {
  id: "cursor",
  name: "Cursor CLI",
  binary: "agent",
  author: "Cursor",
  buildArgv: cursorBuildArgv,
  extractText: cursorExtractText,
  modelsArgv: ["models"],
  parseModels: cursorParseModels,
  formatLogEvent: cursorFormatLogEvent,
};

const OPENCODE_ENGINE: MarkerEngine = {
  id: "opencode",
  name: "OpenCode",
  binary: "opencode",
  author: "OpenCode",
  buildArgv: opencodeBuildArgv,
  extractText: opencodeExtractText,
  modelsArgv: ["models"],
  parseModels: opencodeParseModels,
  formatLogEvent: opencodeFormatLogEvent,
};

export const MARKER_ENGINES: Record<"cursor" | "opencode", MarkerEngine> = {
  cursor: CURSOR_ENGINE,
  opencode: OPENCODE_ENGINE,
};

// ---------------------------------------------------------------------------
// Stream reduction — line-buffered NDJSON reducer, shared across engines.
// ---------------------------------------------------------------------------

export interface MarkerStreamReduction {
  /** Canonical assistant/result text — the substrate for marker extraction. */
  canonicalText: string;
  /** Number of NDJSON records that parsed successfully. */
  recordCount: number;
}

/**
 * Reduce a complete NDJSON stdout buffer into canonical text by calling the
 * engine's `extractText` on every parsed record.
 *
 * Critically line-buffered: only complete lines (terminated by `\n`) are parsed.
 * A trailing partial line with no newline is treated as complete (the process
 * has exited by the time this runs on the accumulated buffer), but mid-stream
 * chunk boundaries never corrupt a record because the whole buffer is joined
 * before splitting on newlines.
 */
export function reduceMarkerStream(stdout: string, engine: MarkerEngine): MarkerStreamReduction {
  let canonicalText = "";
  let recordCount = 0;

  if (!stdout) return { canonicalText, recordCount };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: MarkerStreamEvent;
    try {
      event = JSON.parse(line) as MarkerStreamEvent;
    } catch {
      continue; // not a complete/valid NDJSON record — skip
    }
    recordCount++;

    const text = engine.extractText(event);
    if (text) canonicalText += text;
  }

  return { canonicalText, recordCount };
}

// ---------------------------------------------------------------------------
// Marker-block parsing — reduce → take the LAST complete marker block → parse →
// schema-validate. Returns null on any failure (caller fails the job).
// ---------------------------------------------------------------------------

/**
 * Extract the content of the LAST complete marker block from canonical text.
 * The open/close tags carry the job nonce, so bare `plannotator-review-json`
 * mentions in the diff or the model's prose (which lack the nonce) are ignored
 * rather than mistaken for delimiters.
 */
export function extractLastMarkerBlock(text: string, openTag: string, closeTag: string): string | null {
  let result: string | null = null;
  let searchFrom = 0;

  while (true) {
    const open = text.indexOf(openTag, searchFrom);
    if (open === -1) break;
    const contentStart = open + openTag.length;
    const close = text.indexOf(closeTag, contentStart);
    // A dangling opener (no matching close) almost always means the model's
    // final block was truncated mid-stream. Fail closed — return null — rather
    // than silently falling back to an earlier (draft, or echoed prompt-example)
    // block, which would mark a truncated review green with the wrong findings.
    if (close === -1) return null;
    result = text.slice(contentStart, close);
    searchFrom = close + closeTag.length;
  }

  return result;
}

/**
 * Parse a marker engine's NDJSON stdout into a validated review output.
 *
 * Pipeline: line-buffered NDJSON reduce → reconstruct canonical text → take the
 * LAST complete marker block → JSON.parse → schema-validate. Returns null on
 * ANY failure (missing marker, malformed JSON, schema mismatch) so the caller
 * can fail the job.
 */
export function parseMarkerStreamOutput(stdout: string, engine: MarkerEngine, nonce: string): MarkerReviewOutput | null {
  if (!stdout || !stdout.trim()) return null;
  if (!nonce) return null; // no expected nonce → cannot trust any block

  const { canonicalText } = reduceMarkerStream(stdout, engine);
  if (!canonicalText) return null;

  const block = extractLastMarkerBlock(canonicalText, markerOpen(nonce), markerClose(nonce));
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }

  return validateMarkerReviewOutput(parsed);
}

// ---------------------------------------------------------------------------
// Live log formatter — parse one NDJSON line, hand the event to the engine.
// ---------------------------------------------------------------------------

/**
 * Format one NDJSON line for the LiveLogViewer using the engine's per-event
 * formatter. Returns a human-readable string, or null if the line should be
 * skipped (unparseable or not log-worthy).
 */
export function formatMarkerLogEvent(line: string, engine: MarkerEngine): string | null {
  let event: MarkerStreamEvent;
  try {
    event = JSON.parse(line) as MarkerStreamEvent;
  } catch {
    return null;
  }
  return engine.formatLogEvent(event);
}

// ---------------------------------------------------------------------------
// Review prompt — investigation-first methodology (shared with Cursor/OpenCode
// today, byte-identical) split from the marker-block output contract so a custom
// review profile can replace the methodology while the contract — the only thing
// that makes marker output parseable — is ALWAYS appended.
// ---------------------------------------------------------------------------

export const MARKER_REVIEW_METHODOLOGY = `# Code Review

## Your role
You are a senior engineer reviewing a code change. Find the bugs a maintainer
would fix before merging — logic errors, regressions, broken edge cases,
security holes with a real exploit path, data-loss risks. You are not a linter
or style checker. Optimize for findings that get resolved, not for volume: a
few real, well-evidenced bugs beat a long list of nits.

## Method — investigate before you report
You have tools. Use them. Do not judge the diff in isolation:
  - Read the full function and module around each change, not just the hunk.
  - Trace call sites and data flow to see how the changed code is actually used.
  - Read any repo guidance and honor it if present: AGENTS.md, CLAUDE.md,
    REVIEW.md, and any rules files at the repo root and in the directories
    you're reviewing. Treat these as authoritative for this repo and respect any
    skip/ignore rules they define.
  - Before reporting, check whether the issue is already handled elsewhere (a
    guard, try/catch, fallback, type guarantee).
  - Look at sibling code and tests: is the pattern you're flagging used safely
    elsewhere? Is the failure path you fear already covered?

## What to look for
  - Correctness: logic errors, regressions, broken edge cases, off-by-one,
    wrong results, build/type breakage.
  - Robustness: unhandled errors on realistic paths, resource/process leaks,
    races with observable consequences, state left inconsistent on failure.
  - Security (only when the change introduces it): execution of
    user/client-controlled input, trusting unvalidated external or model
    output, weakened trust/read-only guarantees, newly exposed surfaces.
  - Contracts & attribution: wrong file/line/path mapping, scope confusion, or a
    change to one side of a contract (types, API shape, parallel
    implementations) without the matching change on the other side.
  - Clear, citable violations of the repo guidance files above.

## Validate every finding
Confirm each candidate is real by tracing the actual code path. If you can't
show how it triggers, drop it — prefer silence over a false positive. The
confirmation you write becomes the \`reasoning\` field: what triggers it, what
breaks, and why it isn't already handled.

## Severity — report what a maintainer would actually fix
  important — should be fixed before merge: data loss, silent wrong results,
    security with an exploit path, crashes/leaks, contract drift that breaks a
    real consumer, fail-open where it must fail-closed.

  nit — minor and non-blocking: a real but low-impact edge case, missing
    handling on an unlikely path, a robustness gap with an easy workaround.

  pre_existing — a genuine bug in surrounding code NOT introduced by this
    change. Only flag when it directly affects the changed code path.

## Do NOT report
  - Formatting, naming, or style preferences (unless a repo guideline requires).
  - "Consider adding tests" — unless the change adds non-trivial logic with no
    test coverage at all.
  - Hypothetical problems needing exotic conditions with no real code path.
  - Speculative refactors or "this could be cleaner" outside the change's scope.

## Hard constraints
- This is a read-only review. Do NOT modify files.
- Do NOT post any comments to GitHub or GitLab. Do NOT use gh pr comment, glab,
  or any commenting tool.
- Never approve or block the change. Your only output is findings.`;

export function buildMarkerOutputContract(nonce: string): string {
  return `## Output contract
Your only machine-readable output is a single marker-delimited JSON block.
Any natural-language commentary you write must come BEFORE the final marker
block. Emit the block exactly once, as the last thing in your response. The
opening and closing tags carry a session id (after the colon) — reproduce both
tags EXACTLY as shown, including that id, or your findings will be discarded:

${markerOpen(nonce)}
{
  "findings": [
    {
      "file": "packages/server/review.ts",
      "line": 123,
      "end_line": 123,
      "severity": "important",
      "description": "The issue...",
      "reasoning": "Why this is a real issue..."
    }
  ],
  "summary": {
    "correctness": "Issues Found",
    "explanation": "One important issue was found.",
    "confidence": 0.85
  }
}
${markerClose(nonce)}

Schema:
- findings: array of objects, each with
  - file: string or null — path as shown in the diff. Use null for a general,
    review-level note that isn't about any one file.
  - line: integer or null — start line, post-change numbering. Give a line for a
    line-level issue; use null for a whole-file issue or a general note.
  - end_line: integer or null — end line; equal to line for a single line, null
    when line is null.
  - severity: one of "important", "nit", "pre_existing"
  - description: string (one paragraph) — state the IMPACT (what breaks, for
    whom) and the TRIGGER (when it happens); suggest a minimal fix if obvious
  - reasoning: string (how the issue was confirmed)
- summary: object with
  - correctness: string ("Correct" or "Issues Found")
  - explanation: string (one sentence)
  - confidence: number between 0 and 1

Place each finding by how specific it is: give file AND line for a line-level
issue; give file with line null for a whole-file issue; set both file and line
null for a general, review-level note. Never invent a line you are unsure of —
drop to a file or general placement instead of guessing. Cite file/line from the
new (post-change) code. One finding per distinct bug — do not stack unrelated
issues. If no issues are found, return an empty "findings" array with a valid
summary.`;
}

/**
 * Compose a marker engine's review prompt.
 *
 * A custom review profile REPLACES the methodology (its own instructions take
 * over). But unlike Claude/Codex — which use a native schema flag — marker
 * engines have NO schema flag, so the marker output contract is the ONLY thing
 * that makes their output parseable. It is therefore ALWAYS appended, even for a
 * custom profile. (This is why we do NOT call composeReviewPrompt directly: that
 * helper REPLACES the whole system prompt for custom profiles, which would strip
 * our contract.)
 *
 * The contract embeds `nonce` in its marker tags; the caller must generate it
 * with makeMarkerNonce() and recover it with extractMarkerNonce() at parse time.
 *
 *   <methodology OR custom profile instructions>
 *   <marker output contract (nonce-tagged)>
 *   ---
 *   <user message>
 */
export function composeMarkerReviewPrompt(
  profile: ResolvedReviewProfile | undefined,
  userMessage: string,
  nonce: string,
): string {
  const head = profileHasCustomSection(profile)
    ? (profile as ResolvedReviewProfile).instructions.trim()
    : MARKER_REVIEW_METHODOLOGY;
  return head + "\n\n" + buildMarkerOutputContract(nonce) + "\n\n---\n\n" + userMessage;
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export interface MarkerCommandResult {
  command: string[];
}

/** Build the full argv for a review run with the given engine. */
export function buildMarkerCommand(
  engine: MarkerEngine,
  prompt: string,
  model?: string,
  cwd?: string,
): MarkerCommandResult {
  return { command: engine.buildArgv(prompt, model, cwd) };
}

// ---------------------------------------------------------------------------
// Finding transform — marker findings → external annotations. IDENTICAL logic
// to transformClaudeFindings (classifyFindingPlacement; nothing dropped); only
// the author differs, supplied by the engine descriptor.
// ---------------------------------------------------------------------------

export type MarkerReviewAnnotationInput = ReviewAnnotationInput;

/** Transform marker findings into the external annotation format. */
export function transformMarkerFindings(
  findings: MarkerFinding[],
  source: string,
  author: string,
  cwd?: string,
  pathTransform?: (path: string) => string,
): MarkerReviewAnnotationInput[] {
  // Routing (line / whole-file / general) is shared with Claude in
  // review-findings.ts — nothing is dropped; only the author differs per engine.
  return transformSeverityFindings(findings, source, author, cwd, pathTransform);
}
