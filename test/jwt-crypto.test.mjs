/**
 * JWT / crypto unit tests.
 *
 * The crypto helpers in index.ts (base64url, hmacSign, createJWT, verifyJWT)
 * use standard Web Crypto APIs. We replicate them here so they can run under
 * Node's test runner without Deno imports, then verify round-trip correctness,
 * edge cases, and security invariants.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ─── Replicate the pure crypto helpers from index.ts ───────────────────

function base64url(input) {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return base64url(String.fromCharCode(...sig));
}

async function createJWT(payload, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = await hmacSign(secret, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

async function verifyJWT(token, secret) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const expected = await hmacSign(secret, `${h}.${p}`);
  if (expected !== s) return null;
  try {
    const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function sha256Base64url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(String.fromCharCode(...new Uint8Array(hash)));
}

// ─── base64url ─────────────────────────────────────────────────────────

test("base64url encodes without padding or unsafe chars", () => {
  const result = base64url("hello world");
  assert.ok(!result.includes("+"), "should not contain +");
  assert.ok(!result.includes("/"), "should not contain /");
  assert.ok(!result.includes("="), "should not contain padding");
});

test("base64url produces consistent output", () => {
  assert.equal(base64url("test"), base64url("test"));
});

test("base64url encodes empty string", () => {
  assert.equal(base64url(""), "");
});

// ─── hmacSign ──────────────────────────────────────────────────────────

test("hmacSign produces consistent signatures for same input", async () => {
  const sig1 = await hmacSign("secret", "data");
  const sig2 = await hmacSign("secret", "data");
  assert.equal(sig1, sig2);
});

test("hmacSign produces different signatures for different secrets", async () => {
  const sig1 = await hmacSign("secret-a", "data");
  const sig2 = await hmacSign("secret-b", "data");
  assert.notEqual(sig1, sig2);
});

test("hmacSign produces different signatures for different data", async () => {
  const sig1 = await hmacSign("secret", "data-a");
  const sig2 = await hmacSign("secret", "data-b");
  assert.notEqual(sig1, sig2);
});

// ─── createJWT / verifyJWT round-trip ──────────────────────────────────

test("createJWT produces a three-part token", async () => {
  const token = await createJWT({ sub: "test" }, "secret");
  assert.equal(token.split(".").length, 3);
});

test("createJWT embeds correct header", async () => {
  const token = await createJWT({ sub: "test" }, "secret");
  const [header] = token.split(".");
  const decoded = JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/")));
  assert.equal(decoded.alg, "HS256");
  assert.equal(decoded.typ, "JWT");
});

test("round-trip: verifyJWT returns payload for valid token", async () => {
  const payload = { sub: "user-1", role: "admin" };
  const token = await createJWT(payload, "my-secret");
  const result = await verifyJWT(token, "my-secret");
  assert.equal(result.sub, "user-1");
  assert.equal(result.role, "admin");
});

test("verifyJWT rejects token signed with different secret", async () => {
  const token = await createJWT({ sub: "user-1" }, "correct-secret");
  const result = await verifyJWT(token, "wrong-secret");
  assert.equal(result, null);
});

test("verifyJWT rejects expired token", async () => {
  const pastExp = Math.floor(Date.now() / 1000) - 60;
  const token = await createJWT({ sub: "user-1", exp: pastExp }, "secret");
  const result = await verifyJWT(token, "secret");
  assert.equal(result, null);
});

test("verifyJWT accepts token without exp (no expiry check)", async () => {
  const token = await createJWT({ sub: "user-1" }, "secret");
  const result = await verifyJWT(token, "secret");
  assert.ok(result);
  assert.equal(result.sub, "user-1");
});

test("verifyJWT accepts token with future exp", async () => {
  const futureExp = Math.floor(Date.now() / 1000) + 3600;
  const token = await createJWT({ sub: "user-1", exp: futureExp }, "secret");
  const result = await verifyJWT(token, "secret");
  assert.ok(result);
});

test("verifyJWT rejects malformed tokens", async () => {
  assert.equal(await verifyJWT("", "secret"), null);
  assert.equal(await verifyJWT("a.b", "secret"), null);
  assert.equal(await verifyJWT("not-a-jwt", "secret"), null);
  assert.equal(await verifyJWT("a.b.c.d", "secret"), null);
});

test("verifyJWT rejects token with tampered payload", async () => {
  const token = await createJWT({ sub: "user-1" }, "secret");
  const [header, , sig] = token.split(".");
  const tamperedPayload = base64url(JSON.stringify({ sub: "admin" }));
  const tampered = `${header}.${tamperedPayload}.${sig}`;
  const result = await verifyJWT(tampered, "secret");
  assert.equal(result, null);
});

test("verifyJWT rejects token with tampered header", async () => {
  const token = await createJWT({ sub: "user-1" }, "secret");
  const [, payload, sig] = token.split(".");
  const tamperedHeader = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const tampered = `${tamperedHeader}.${payload}.${sig}`;
  const result = await verifyJWT(tampered, "secret");
  assert.equal(result, null);
});

// ─── sha256Base64url (PKCE) ────────────────────────────────────────────

test("sha256Base64url produces consistent hash", async () => {
  const h1 = await sha256Base64url("test-verifier");
  const h2 = await sha256Base64url("test-verifier");
  assert.equal(h1, h2);
});

test("sha256Base64url produces different hashes for different inputs", async () => {
  const h1 = await sha256Base64url("verifier-a");
  const h2 = await sha256Base64url("verifier-b");
  assert.notEqual(h1, h2);
});

test("sha256Base64url output is base64url-safe", async () => {
  const hash = await sha256Base64url("some-code-verifier-12345");
  assert.ok(!hash.includes("+"), "no + chars");
  assert.ok(!hash.includes("/"), "no / chars");
  assert.ok(!hash.includes("="), "no padding");
});

// ─── PKCE round-trip ───────────────────────────────────────────────────

test("PKCE flow: code_verifier hashes to matching code_challenge", async () => {
  const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await sha256Base64url(codeVerifier);

  // Simulate: authorize stores challenge, token endpoint verifies
  const storedChallenge = challenge;
  const computedChallenge = await sha256Base64url(codeVerifier);
  assert.equal(computedChallenge, storedChallenge);
});
