/**
 * HTTP routing and server entrypoint tests.
 *
 * Validates route matching, auth requirements, response handling,
 * and the Deno.serve handler structure.
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

// ─── Route definitions ─────────────────────────────────────────────────

test("OPTIONS requests return ok (CORS preflight)", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "OPTIONS"/, "Should handle OPTIONS");
  assert.match(handler, /jsonResponse\(\{ ok: true \}\)/, "Should return ok for OPTIONS");
});

test("health route does not require auth", async () => {
  const content = await readIndex();
  // The health route handler should return jsonResponse directly without calling requireAuth.
  // Extract just the if-block for health (from action === "health" to the closing brace).
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  const healthIdx = handler.indexOf('action === "health"');
  const healthBlock = handler.slice(healthIdx, healthIdx + 120);
  // The health block is: action === "health") { return jsonResponse(...); }
  // It should NOT contain requireAuth within that single-line return.
  assert.ok(!healthBlock.includes("requireAuth"), "Health endpoint should be unauthenticated");
});

test("capture route requires auth", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, 'action === "capture"', 500);
  assert.match(handler, /requireAuth/, "Capture endpoint should require auth");
});

test("search route requires auth", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, 'action === "search"', 500);
  assert.match(handler, /requireAuth/, "Search endpoint should require auth");
});

test("thoughts route requires auth", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, 'action === "thoughts"', 500);
  assert.match(handler, /requireAuth/, "Thoughts endpoint should require auth");
});

test("stats route requires auth", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, 'action === "stats"', 500);
  assert.match(handler, /requireAuth/, "Stats endpoint should require auth");
});

test("MCP endpoint requires auth", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  // Find the MCP route block in the serve handler
  const mcpIdx = handler.indexOf("handleMcpRequest");
  const mcpBlock = handler.slice(Math.max(0, mcpIdx - 200), mcpIdx + 100);
  assert.match(mcpBlock, /requireAuth/, "MCP endpoint should require auth");
});

// ─── OAuth routes ──────────────────────────────────────────────────────

test("OAuth well-known endpoints do not require auth", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);

  // Find the well-known handlers and verify they return before requireAuth is called
  const oauthMetaIdx = handler.indexOf("oauthMetadata(baseUrl)");
  const protectedMetaIdx = handler.indexOf("protectedResourceMetadata(baseUrl)");
  const requireAuthIdx = handler.indexOf("requireAuth(req");

  assert.ok(oauthMetaIdx < requireAuthIdx, "OAuth metadata should be handled before auth check");
  assert.ok(protectedMetaIdx < requireAuthIdx, "Protected resource metadata should be handled before auth check");
});

test("authorize endpoint uses GET method", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "GET" && \(action === "authorize"/, "Authorize should be GET");
});

test("oauth/token endpoint uses POST method", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "POST" && action === "oauth\/token"/, "Token endpoint should be POST");
});

// ─── Route methods ─────────────────────────────────────────────────────

test("health is GET only", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "GET" && action === "health"/, "Health should be GET");
});

test("capture is POST only", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "POST" && action === "capture"/, "Capture should be POST");
});

test("search is POST only", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "POST" && action === "search"/, "Search should be POST");
});

test("thoughts is GET only", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "GET" && action === "thoughts"/, "Thoughts should be GET");
});

test("stats is GET only", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "GET" && action === "stats"/, "Stats should be GET");
});

test("MCP accepts both POST and GET", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /req\.method === "POST" \|\| req\.method === "GET"/, "MCP should accept POST and GET");
});

// ─── Error handling ────────────────────────────────────────────────────

test("unknown routes return 404", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /Not found.*404/s, "Should return 404 for unknown routes");
});

test("handler catches Response errors and returns them directly", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /error instanceof Response/, "Should catch Response errors (from requireAuth)");
});

test("handler catches Error instances and returns 500", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /error instanceof Error.*error\.message.*500/s, "Should return 500 for Error instances");
});

test("handler catches unknown errors", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, "Deno.serve(", 5000);
  assert.match(handler, /Unknown error/, "Should handle non-Error throws");
});

// ─── search endpoint validates query ───────────────────────────────────

test("search endpoint validates query parameter", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, 'action === "search"', 500);
  assert.match(handler, /Query is required/, "Should validate query is present");
  assert.match(handler, /400/, "Should return 400 for missing query");
});

// ─── health endpoint returns thought count ─────────────────────────────

test("health endpoint returns thought count", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, 'action === "health"', 300);
  assert.match(handler, /getThoughtCount/, "Should include thought count in health response");
});

// ─── CORS headers ──────────────────────────────────────────────────────

test("jsonResponse includes CORS headers", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "function jsonResponse(", 500);
  assert.match(fn, /Access-Control-Allow-Origin.*\*/, "Should allow all origins");
  assert.match(fn, /Access-Control-Allow-Methods.*GET.*POST/, "Should allow GET and POST");
});

// ─── MCP transport configuration ───────────────────────────────────────

test("MCP transport uses JSON response mode", async () => {
  const content = await readIndex();
  assert.match(content, /enableJsonResponse:\s*true/, "MCP transport should enable JSON responses");
});

test("MCP transport does not use session IDs", async () => {
  const content = await readIndex();
  assert.match(content, /sessionIdGenerator:\s*undefined/, "MCP transport should not generate session IDs");
});

test("MCP server cleans up transport and server after request", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "await server.connect(transport)", 500);
  assert.match(fn, /finally/, "Should use try/finally for cleanup");
  assert.match(fn, /transport\.close\(\)/, "Should close transport");
  assert.match(fn, /server\.close\(\)/, "Should close server");
});

// ─── Supabase client configuration ────────────────────────────────────

test("Supabase client disables session persistence", async () => {
  const content = await readIndex();
  assert.match(content, /persistSession:\s*false/, "Should disable session persistence for edge function");
});

test("Supabase client uses service role key", async () => {
  const content = await readIndex();
  assert.match(content, /requireSupabaseServiceRoleKey\(\)/, "Should use service role key");
});

// ─── thoughts route parses query params ────────────────────────────────

test("thoughts route supports query param filters", async () => {
  const content = await readIndex();
  const handler = sliceFrom(content, 'action === "thoughts"', 800);
  assert.match(handler, /searchParams\.get\("limit"\)/, "Should parse limit param");
  assert.match(handler, /searchParams\.get\("type"\)/, "Should parse type param");
  assert.match(handler, /searchParams\.get\("topic"\)/, "Should parse topic param");
  assert.match(handler, /searchParams\.get\("person"\)/, "Should parse person param");
  assert.match(handler, /searchParams\.get\("days"\)/, "Should parse days param");
});
