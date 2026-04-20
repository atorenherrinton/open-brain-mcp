import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const indexPath = path.join(repoRoot, "supabase", "functions", "open-brain", "index.ts");

async function readIndex() {
  return await fs.readFile(indexPath, "utf8");
}

function sliceFrom(content, needle, length = 2500) {
  const idx = content.indexOf(needle);
  assert.ok(idx !== -1, `Expected to find substring: ${needle}`);
  return content.slice(idx, idx + length);
}

test("capture_thought normalizes topics to lowercase tags", async () => {
  const content = await readIndex();
  assert.match(content, /from "\.\/utils\.mjs"/);

  const captureSegment = sliceFrom(content, "async function captureThought", 2500);
  assert.match(captureSegment, /const normalizedTopics = normalizeTopicTags\(/);
  assert.match(captureSegment, /topics:\s*normalizedTopics/);
});

test("HTTP routes include expected action handlers", async () => {
  const content = await readIndex();
  for (const fragment of [
    ".well-known/oauth-protected-resource",
    ".well-known/oauth-authorization-server",
    "authorize",
    "oauth/token",
    "handleMcpRequest",
    "action === \"health\"",
    "action === \"capture\"",
    "action === \"search\"",
    "action === \"thoughts\"",
    "action === \"stats\"",
    "Not found",
  ]) {
    assert.ok(content.includes(fragment), `Expected index.ts to include route fragment: ${fragment}`);
  }
});
