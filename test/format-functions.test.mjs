/**
 * Format function structural tests.
 *
 * Validates formatSearchResults, formatThoughtList, formatStats,
 * and confirmation message patterns across tool handlers.
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

function sliceFrom(content, needle, length = 3000) {
  const idx = content.indexOf(needle);
  assert.ok(idx !== -1, `Expected to find: ${needle}`);
  return content.slice(idx, idx + length);
}

// ─── formatSearchResults ───────────────────────────────────────────────

test("formatSearchResults returns empty message for no results", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatSearchResults(");
  assert.match(fn, /No thoughts found matching/, "Should return no-match message");
});

test("formatSearchResults includes similarity percentage", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatSearchResults(");
  assert.match(fn, /% match/, "Should show similarity as percentage");
});

test("formatSearchResults includes date, type, topics, people, actions", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatSearchResults(");
  assert.match(fn, /toLocaleDateString/, "Should format date");
  assert.match(fn, /Type:/, "Should show type");
  assert.match(fn, /Topics:/, "Should show topics");
  assert.match(fn, /People:/, "Should show people");
  assert.match(fn, /Actions:/, "Should show actions");
});

// ─── formatThoughtList ─────────────────────────────────────────────────

test("formatThoughtList returns empty message for no results", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatThoughtList(");
  assert.match(fn, /No thoughts found\./, "Should return empty message");
});

test("formatThoughtList numbers results", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatThoughtList(");
  assert.match(fn, /\$\{index \+ 1\}/, "Should number results starting at 1");
});

test("formatThoughtList includes type and tags", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatThoughtList(");
  assert.match(fn, /metadata\.type/, "Should include thought type");
  assert.match(fn, /metadata\.topics/, "Should include topics");
});

// ─── formatStats ───────────────────────────────────────────────────────

test("formatStats shows total count", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatStats(");
  assert.match(fn, /Total thoughts:/, "Should show total count");
});

test("formatStats shows date range", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatStats(");
  assert.match(fn, /Date range:/, "Should show date range");
  assert.match(fn, /N\/A/, "Should show N/A when no date range");
});

test("formatStats shows types breakdown", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatStats(");
  assert.match(fn, /Types:/, "Should show types section");
});

test("formatStats shows top topics when present", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatStats(");
  assert.match(fn, /Top topics:/, "Should show top topics");
});

test("formatStats shows people mentioned when present", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatStats(");
  assert.match(fn, /People mentioned:/, "Should show people mentioned");
});

test("formatStats handles missing/empty arrays gracefully", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function formatStats(");
  assert.match(fn, /Array\.isArray\(stats\.types\) \? stats\.types : \[\]/, "Should default types to []");
  assert.match(fn, /Array\.isArray\(stats\.top_topics\) \? stats\.top_topics : \[\]/, "Should default topics to []");
  assert.match(fn, /Array\.isArray\(stats\.people_mentioned\) \? stats\.people_mentioned : \[\]/, "Should default people to []");
});

// ─── captureThought confirmation messages ──────────────────────────────

test("captureThought builds confirmation with type", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /Captured as/, "Should start confirmation with 'Captured as'");
});

test("captureThought includes topics in confirmation", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /effectiveMetadata\.topics\.join/, "Should include topics");
});

test("captureThought includes people in confirmation", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /People:/, "Should include people");
});

test("captureThought includes action items in confirmation", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /Actions:/, "Should include action items");
});

// ─── Tool confirmation message patterns ────────────────────────────────

test("create_task confirmation includes title and priority", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"create_task"', 2000);
  assert.match(fn, /Created task:/, "Should confirm creation");
  assert.match(fn, /data\.title/, "Should include title");
  assert.match(fn, /data\.priority/, "Should include priority");
});

test("create_task confirmation includes due date when present", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"create_task"', 2000);
  assert.match(fn, /if \(data\.due_date\)/, "Should conditionally show due date");
});

test("create_task confirmation includes project ID when present", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"create_task"', 2000);
  assert.match(fn, /if \(data\.project_id\)/, "Should conditionally show project ID");
});

test("create_project confirmation includes name and status", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"create_project"', 1500);
  assert.match(fn, /Created project:/, "Should confirm creation");
  assert.match(fn, /data\.name/, "Should include name");
  assert.match(fn, /data\.status/, "Should include status");
});

test("update_task confirmation includes title, status, priority", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"update_task"', 2000);
  assert.match(fn, /Updated:/, "Should confirm update");
  assert.match(fn, /data\.status/, "Should include status");
  assert.match(fn, /data\.priority/, "Should include priority");
});

test("delete_task confirmation includes title", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"delete_task"', 1000);
  assert.match(fn, /Deleted task/, "Should confirm deletion");
  assert.match(fn, /data\.title/, "Should include title");
});

test("bulk_delete_tasks confirmation lists deleted tasks", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"bulk_delete_tasks"', 1500);
  assert.match(fn, /Deleted \$\{data\.length\} task\(s\)/, "Should count deleted tasks");
});

test("bulk_update_tasks confirmation lists updated tasks", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"bulk_update_tasks"', 1500);
  assert.match(fn, /Updated \$\{data\.length\} task\(s\)/, "Should count updated tasks");
});

// ─── Constants ─────────────────────────────────────────────────────────

test("SERVER_VERSION is defined", async () => {
  const content = await readIndex();
  assert.match(content, /const SERVER_VERSION = "[\d.]+"/);
});

test("MAX_THOUGHT_CHARS limits content length", async () => {
  const content = await readIndex();
  assert.match(content, /const MAX_THOUGHT_CHARS = 12000/);
});

test("TASK_NOTE_TYPES includes note and deliverable", async () => {
  const content = await readIndex();
  assert.match(content, /TASK_NOTE_TYPES.*"note".*"deliverable"/s);
});

test("PROJECT_STATUSES includes active and archived", async () => {
  const content = await readIndex();
  assert.match(content, /PROJECT_STATUSES.*"active".*"archived"/s);
});
