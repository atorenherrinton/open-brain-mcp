import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const utilsPath = path.join(repoRoot, "supabase", "functions", "open-brain", "utils.mjs");
const utils = await import(pathToFileURL(utilsPath).href);

test("normalizeContent trims, normalizes whitespace, and strips indentation", () => {
  const input = "  hello\r\n\t  world  \n\n\n  next\tline\n";
  assert.equal(utils.normalizeContent(input), "hello world next line");
});

test("makeSnippet truncates with ellipsis", () => {
  const snippet = utils.makeSnippet("a".repeat(10), 5);
  assert.equal(snippet, "aaaa…");
});

test("collectMatchedFields returns matching keys and semantic_match fallback", () => {
  assert.deepEqual(
    utils.collectMatchedFields("foo bar", { title: "FOO", tags: ["x", "bar"], other: "nope" }).sort(),
    ["tags", "title"]
  );
  assert.deepEqual(utils.collectMatchedFields("zzz", { a: "b" }), ["semantic_match"]);
});

test("normalizeTopicTags lowercases, dedupes, trims, and limits to 3", () => {
  assert.deepEqual(utils.normalizeTopicTags([" Career ", "career", "AI", "", "Ops", "Extra"]), ["career", "ai", "ops"]);
  assert.deepEqual(utils.normalizeTopicTags(null), []);
});

test("inferToolErrorCode categorizes common failures", () => {
  assert.equal(utils.inferToolErrorCode("No task found"), "NOT_FOUND");
  assert.equal(utils.inferToolErrorCode("Invalid request: required field"), "VALIDATION_ERROR");
  assert.equal(utils.inferToolErrorCode("Already exists"), "CONFLICT");
  assert.equal(utils.inferToolErrorCode("429 rate limit"), "RATE_LIMITED");
  assert.equal(utils.inferToolErrorCode("Unauthorized"), "AUTH_ERROR");
  assert.equal(utils.inferToolErrorCode("Missing SUPABASE_URL"), "CONFIG_ERROR");
  assert.equal(utils.inferToolErrorCode("Something else"), "INTERNAL_ERROR");
});

test("normalizeToolResult wraps plain text tool results into ok JSON envelope", () => {
  const result = utils.normalizeToolResult({ content: [{ type: "text", text: "hello" }] });
  assert.ok(result?.content?.[0]?.text);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, { message: "hello" });
});

test("normalizeToolResult preserves already-normalized JSON envelopes", () => {
  const payload = { ok: true, data: { a: 1 }, error: null, meta: {} };
  const input = { content: [{ type: "text", text: JSON.stringify(payload) }] };
  assert.deepEqual(utils.normalizeToolResult(input), input);
});

test("normalizeToolResult turns NOT_FOUND plain text into ok=false envelope", () => {
  const result = utils.normalizeToolResult({ content: [{ type: "text", text: "No task found with ID \"x\"." }] });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "NOT_FOUND");
});

test("normalizeToolError handles Response and Error instances", () => {
  const responseErr = utils.normalizeToolError(new Response("no", { status: 401 }));
  assert.equal(responseErr.code, "INTERNAL_ERROR");
  assert.equal(responseErr.message, "HTTP 401");

  const errorErr = utils.normalizeToolError(new Error("Invalid or missing access key"));
  assert.equal(errorErr.code, "VALIDATION_ERROR");
});

test("getAction extracts action segment after open-brain and supports query param fallback", () => {
  const url1 = new URL("https://x/functions/v1/open-brain/health");
  assert.equal(utils.getAction(url1), "health");

  const url2 = new URL("https://x/functions/v1/open-brain/mcp/.well-known/oauth-protected-resource");
  assert.equal(utils.getAction(url2), "mcp/.well-known/oauth-protected-resource");

  const url3 = new URL("https://x/?action=capture");
  assert.equal(utils.getAction(url3), "capture");
});
