/**
 * Security tests for authentication and authorization.
 *
 * Validates that requireAuth, OAuth endpoints, and related security
 * functions in index.ts have correct structure and behavior.
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

// ─── requireAuth structure ─────────────────────────────────────────────

test("requireAuth checks Bearer token before falling back to static key", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function requireAuth(", 1500);

  // Bearer check comes first
  const bearerIdx = fn.indexOf('Bearer ');
  const staticKeyIdx = fn.indexOf('x-brain-key');
  assert.ok(bearerIdx < staticKeyIdx, "Bearer check should come before static key fallback");
});

test("requireAuth throws 401 Response on invalid Bearer token", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function requireAuth(", 1500);
  assert.match(fn, /throw new Response.*401/s, "Should throw 401 Response for invalid token");
  assert.match(fn, /Invalid or expired token/, "Error message should mention invalid/expired token");
});

test("requireAuth throws 401 Response on invalid static key", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function requireAuth(", 1500);
  assert.match(fn, /Invalid or missing access key/, "Error message should mention invalid/missing key");
});

test("requireAuth accepts query param key as fallback", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function requireAuth(", 1500);
  assert.match(fn, /url\.searchParams\.get\("key"\)/, "Should accept key via query parameter");
});

test("requireAuth skips static key check when MCP_ACCESS_KEY is not set", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function requireAuth(", 1500);
  assert.match(fn, /if \(!expected\) return/, "Should return early if no MCP_ACCESS_KEY configured");
});

test("requireAuth includes WWW-Authenticate header when baseUrl provided", async () => {
  const content = await readIndex();
  assert.match(content, /WWW-Authenticate.*oauth-protected-resource/,
    "Should include WWW-Authenticate header pointing to protected resource metadata");
});

// ─── verifyJWT structure ───────────────────────────────────────────────

test("verifyJWT checks expiration", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function verifyJWT(", 800);
  assert.match(fn, /payload\.exp.*Date\.now/, "Should check exp against current time");
});

test("verifyJWT returns null for invalid signature", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function verifyJWT(", 800);
  assert.match(fn, /if \(expected !== s\) return null/, "Should return null on signature mismatch");
});

test("verifyJWT returns null for malformed tokens", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function verifyJWT(", 800);
  assert.match(fn, /if \(!h \|\| !p \|\| !s\) return null/, "Should return null for missing parts");
});

// ─── OAuth endpoints structure ─────────────────────────────────────────

test("handleAuthorizeAsync validates response_type is code", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleAuthorizeAsync(", 2000);
  assert.match(fn, /responseType !== "code"/, "Should reject non-code response types");
  assert.match(fn, /unsupported_response_type/, "Should return unsupported_response_type error");
});

test("handleAuthorizeAsync validates client_id", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleAuthorizeAsync(", 2000);
  assert.match(fn, /reqClientId !== clientId/, "Should verify client_id matches");
  assert.match(fn, /invalid_client/, "Should return invalid_client error");
});

test("handleAuthorizeAsync requires redirect_uri", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleAuthorizeAsync(", 2000);
  assert.match(fn, /redirect_uri required/, "Should require redirect_uri");
});

test("handleAuthorizeAsync only supports S256 code_challenge_method", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleAuthorizeAsync(", 2000);
  assert.match(fn, /Only S256/, "Should only support S256 PKCE method");
});

test("handleAuthorizeAsync sets auth code expiry to 10 minutes", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleAuthorizeAsync(", 2000);
  assert.match(fn, /exp: now \+ 600/, "Auth code should expire in 600 seconds (10 min)");
});

test("handleAuthorizeAsync returns 302 redirect", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleAuthorizeAsync(", 2000);
  assert.match(fn, /status: 302/, "Should return 302 redirect");
  assert.match(fn, /Cache-Control.*no-store/, "Should set no-store cache control");
});

test("handleOAuthToken returns 500 when OAuth is not configured", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleOAuthToken(", 4000);
  assert.match(fn, /oauth_not_configured.*500/s, "Should return 500 when OAuth vars missing");
});

test("handleOAuthToken supports both form-urlencoded and JSON bodies", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleOAuthToken(", 4000);
  assert.match(fn, /application\/x-www-form-urlencoded/, "Should handle form-urlencoded");
  assert.match(fn, /await req\.json\(\)/, "Should handle JSON bodies");
});

test("handleOAuthToken validates PKCE code_verifier", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleOAuthToken(", 4000);
  assert.match(fn, /code_verifier required/, "Should require code_verifier when challenge present");
  assert.match(fn, /code_verifier mismatch/, "Should reject mismatched code_verifier");
});

test("handleOAuthToken validates client credentials for client_credentials grant", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleOAuthToken(", 4000);
  assert.match(fn, /reqId !== clientId \|\| reqSecret !== clientSecret/,
    "Should verify both client_id and client_secret");
});

test("handleOAuthToken rejects unsupported grant types", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleOAuthToken(", 4000);
  assert.match(fn, /unsupported_grant_type/, "Should return error for unsupported grant types");
});

test("handleOAuthToken sets access token expiry to 1 hour", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function handleOAuthToken(", 4000);
  assert.match(fn, /expiresIn = 3600/, "Access token should expire in 3600 seconds (1 hour)");
});

// ─── General security invariants ───────────────────────────────────────

test("no hardcoded secrets in index.ts", async () => {
  const content = await readIndex();
  // Should always read secrets from env vars, never hardcoded
  assert.ok(!content.match(/OPENROUTER_API_KEY\s*=\s*["'][^"']+["']/),
    "API key should not be hardcoded");
  assert.ok(!content.match(/OAUTH_CLIENT_SECRET\s*=\s*["'][^"']+["']/),
    "OAuth secret should not be hardcoded");
});

test("all env var access uses requireEnv or Deno.env.get", async () => {
  const content = await readIndex();
  // Should not use process.env (Deno uses Deno.env)
  assert.ok(!content.includes("process.env"), "Should use Deno.env, not process.env");
});

test("CORS headers include required headers for MCP", async () => {
  const content = await readIndex();
  assert.match(content, /Access-Control-Allow-Headers.*authorization/,
    "CORS should allow authorization header");
  assert.match(content, /Access-Control-Allow-Headers.*x-brain-key/,
    "CORS should allow x-brain-key header");
});
