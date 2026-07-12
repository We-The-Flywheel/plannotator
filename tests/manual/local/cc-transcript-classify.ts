#!/usr/bin/env bun
/**
 * Classify the outcome of the last ExitPlanMode call in a Claude Code session
 * transcript (jsonl). Used by cc-approval-drop-harness.sh.
 *
 * Usage: bun cc-transcript-classify.ts <transcript.jsonl>
 *
 * Prints one line of JSON:
 *   { "outcome": "PROCEEDED" | "REJECTED" | "PENDING" | "NONE",
 *     "toolUseTs": "...", "resultTs": "...", "resultText": "..." }
 *
 * PROCEEDED = tool_result present and not an error/rejection
 * REJECTED  = tool_result present and is_error or contains rejection text
 * PENDING   = tool_use present, no tool_result yet
 * NONE      = no ExitPlanMode tool_use found
 */

const file = process.argv[2];
if (!file) {
  console.error("usage: bun cc-transcript-classify.ts <transcript.jsonl>");
  process.exit(2);
}

const text = await Bun.file(file).text();
const lines = text.split("\n").filter((l) => l.trim().length > 0);

interface Found {
  id: string;
  ts: string;
}

let lastUse: Found | null = null;
// First pass: last ExitPlanMode tool_use
for (const line of lines) {
  if (!line.includes('"ExitPlanMode"')) continue;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const content = obj?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const c of content) {
    if (c?.type === "tool_use" && c?.name === "ExitPlanMode") {
      lastUse = { id: c.id, ts: obj.timestamp ?? "" };
    }
  }
}

if (!lastUse) {
  console.log(JSON.stringify({ outcome: "NONE" }));
  process.exit(0);
}

// Second pass: its tool_result
let resultTs = "";
let resultText = "";
let isError = false;
let found = false;
for (const line of lines) {
  if (!line.includes(lastUse.id)) continue;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const content = obj?.message?.content;
  if (!Array.isArray(content)) continue;
  for (const c of content) {
    if (c?.type === "tool_result" && c?.tool_use_id === lastUse.id) {
      found = true;
      resultTs = obj.timestamp ?? "";
      isError = c.is_error === true;
      resultText =
        typeof c.content === "string"
          ? c.content
          : JSON.stringify(c.content ?? "");
    }
  }
}

let outcome: string;
if (!found) {
  outcome = "PENDING";
} else if (isError || /doesn't want to proceed|rejected/i.test(resultText)) {
  outcome = "REJECTED";
} else {
  outcome = "PROCEEDED";
}

console.log(
  JSON.stringify({
    outcome,
    toolUseTs: lastUse.ts,
    resultTs,
    resultText: resultText.slice(0, 600),
  }),
);
