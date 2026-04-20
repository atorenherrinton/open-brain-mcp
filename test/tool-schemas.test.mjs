/**
 * Tool schema and input validation tests.
 *
 * Validates that every registered MCP tool has correct Zod schemas,
 * required/optional fields, enum constraints, and annotations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "..", "supabase", "functions", "open-brain", "index.ts");

async function readIndex() {
  return await fs.readFile(indexPath, "utf8");
}

function sliceTool(content, toolName, length = 3000) {
  const needle = `"${toolName}"`;
  const idx = content.indexOf(`registerTool(\n    ${needle}`);
  if (idx === -1) {
    // Try alternate format
    const idx2 = content.indexOf(`registerTool(\n    "${toolName}"`);
    assert.ok(idx2 !== -1, `Expected to find tool: ${toolName}`);
    return content.slice(idx2, idx2 + length);
  }
  return content.slice(idx, idx + length);
}

// ─── Read-only annotations ─────────────────────────────────────────────

const READ_ONLY_TOOLS = [
  "version", "whoami", "server_info", "health", "db_stats",
  "search_thoughts", "list_thoughts", "thought_stats",
  "get_personal_info", "search_personal_info", "list_personal_info",
  "get_job_profile", "get_answer_bank",
  "connect_info_to_thoughts", "connect_thought_to_info",
];

for (const tool of READ_ONLY_TOOLS) {
  test(`${tool} has readOnlyHint annotation`, async () => {
    const content = await readIndex();
    const segment = sliceTool(content, tool);
    assert.match(segment, /readOnlyHint:\s*true/, `${tool} should have readOnlyHint: true`);
  });
}

const MUTATING_TOOLS = [
  "capture_thought", "delete_thought", "prune_thoughts",
  "set_personal_info", "delete_personal_info", "add_answer",
];

for (const tool of MUTATING_TOOLS) {
  test(`${tool} does NOT have readOnlyHint annotation`, async () => {
    const content = await readIndex();
    const segment = sliceTool(content, tool, 500);
    assert.ok(!segment.includes("readOnlyHint"), `${tool} should not have readOnlyHint`);
  });
}

// ─── Schema field validation ───────────────────────────────────────────

test("capture_thought requires content as string", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "capture_thought");
  assert.match(segment, /content:\s*z\.string\(\)/);
});

test("set_personal_info requires key and value, category is optional", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "set_personal_info");
  assert.match(segment, /key:\s*z\.string\(\)/);
  assert.match(segment, /value:\s*z\.string\(\)/);
  assert.match(segment, /category:\s*z\.string\(\)\.optional\(\)/);
});

test("search_thoughts has query, optional limit and threshold", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_thoughts");
  assert.match(segment, /query:\s*z\.string\(\)/);
  assert.match(segment, /limit:\s*z\.number\(\)\.optional\(\)/);
  assert.match(segment, /threshold:\s*z\.number\(\)\.optional\(\)/);
});

test("list_thoughts has all optional filter fields", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_thoughts");
  assert.match(segment, /limit:\s*z\.number\(\)\.optional\(\)/);
  assert.match(segment, /type:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /topic:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /person:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /days:\s*z\.number\(\)\.optional\(\)/);
});

test("connect_thought_to_info accepts thought_id or query", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "connect_thought_to_info");
  assert.match(segment, /thought_id:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /query:\s*z\.string\(\)\.optional\(\)/);
});

test("delete_thought requires thought_id", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_thought");
  assert.match(segment, /thought_id:\s*z\.string\(\)/);
});

test("prune_thoughts requires older_than_days, optional type/topic/dry_run", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts");
  assert.match(segment, /older_than_days:\s*z\.number\(\)\.min\(1\)/);
  assert.match(segment, /type:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /topic:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /dry_run:\s*z\.boolean\(\)\.optional\(\)/);
});
