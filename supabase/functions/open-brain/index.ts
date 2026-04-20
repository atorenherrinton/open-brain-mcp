import { createClient } from "npm:@supabase/supabase-js@2";
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "npm:zod@3.24.1";
import {
  collectMatchedFields,
  getAction,
  jsonToolResult,
  makeSnippet,
  normalizeContent,
  normalizeTopicTags,
  normalizeToolError,
  normalizeToolResult,
  vectorLiteral,
} from "./utils.mjs";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_THOUGHT_CHARS = 12000;
const SERVER_VERSION = "2.0.0";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

function requireEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function requireSupabaseServiceRoleKey() {
  return Deno.env.get("SUPABASE_SECRET_KEY") || requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

async function getEmbedding(text: string) {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });

  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(`Embedding failed: ${res.status} ${message}`.trim());
  }

  const data = await res.json();
  return data.data[0].embedding as number[];
}

async function extractMetadata(text: string) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });

  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// ─── OAuth 2.0 Client Credentials ───────────────────────────────────

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return base64url(String.fromCharCode(...sig));
}

async function createJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = await hmacSign(secret, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
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

function getBaseUrl(_url: URL, functionName: string): string {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || _url.origin).replace(/\/$/, "");
  return `${supabaseUrl}/functions/v1/${functionName}`;
}

function oauthMetadata(baseUrl: string): Response {
  return jsonResponse({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "client_credentials"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  });
}

async function sha256Base64url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(String.fromCharCode(...new Uint8Array(hash)));
}

async function handleAuthorizeAsync(url: URL, baseUrl: string): Promise<Response> {
  const clientId = Deno.env.get("OAUTH_CLIENT_ID") ?? "";
  const reqClientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "";
  const responseType = url.searchParams.get("response_type") ?? "";

  if (responseType !== "code") {
    return jsonResponse({ error: "unsupported_response_type" }, 400);
  }
  if (!clientId || reqClientId !== clientId) {
    return jsonResponse({ error: "invalid_client" }, 401);
  }
  if (!redirectUri) {
    return jsonResponse({ error: "invalid_request", error_description: "redirect_uri required" }, 400);
  }
  if (codeChallengeMethod && codeChallengeMethod !== "S256") {
    return jsonResponse({ error: "invalid_request", error_description: "Only S256 code_challenge_method supported" }, 400);
  }

  const jwtSecret = Deno.env.get("OAUTH_JWT_SECRET") || Deno.env.get("OAUTH_CLIENT_SECRET") || "";
  const now = Math.floor(Date.now() / 1000);
  const code = await createJWT({
    type: "auth_code",
    sub: clientId,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod || "S256",
    redirect_uri: redirectUri,
    iat: now,
    exp: now + 600,
  }, jwtSecret);

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.toString(),
      "Cache-Control": "no-store",
    },
  });
}

function protectedResourceMetadata(baseUrl: string): Response {
  return jsonResponse({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  });
}

async function handleOAuthToken(req: Request): Promise<Response> {
  const clientId = Deno.env.get("OAUTH_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("OAUTH_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    return jsonResponse({ error: "oauth_not_configured" }, 500);
  }

  let grantType = "", reqId = "", reqSecret = "", code = "", codeVerifier = "", redirectUri = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await req.text());
    grantType = params.get("grant_type") ?? "";
    reqId = params.get("client_id") ?? "";
    reqSecret = params.get("client_secret") ?? "";
    code = params.get("code") ?? "";
    codeVerifier = params.get("code_verifier") ?? "";
    redirectUri = params.get("redirect_uri") ?? "";
  } else {
    const body = await req.json();
    grantType = body.grant_type ?? "";
    reqId = body.client_id ?? "";
    reqSecret = body.client_secret ?? "";
    code = body.code ?? "";
    codeVerifier = body.code_verifier ?? "";
    redirectUri = body.redirect_uri ?? "";
  }

  const jwtSecret = Deno.env.get("OAUTH_JWT_SECRET") || clientSecret;

  if (grantType === "authorization_code") {
    if (!code) {
      return jsonResponse({ error: "invalid_request", error_description: "code required" }, 400);
    }
    const codePayload = await verifyJWT(code, jwtSecret);
    if (!codePayload || codePayload.type !== "auth_code") {
      return jsonResponse({ error: "invalid_grant", error_description: "Invalid or expired authorization code" }, 400);
    }
    if (reqId && reqId !== clientId) {
      return jsonResponse({ error: "invalid_client" }, 401);
    }
    if (redirectUri && redirectUri !== codePayload.redirect_uri) {
      return jsonResponse({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }
    if (codePayload.code_challenge) {
      if (!codeVerifier) {
        return jsonResponse({ error: "invalid_request", error_description: "code_verifier required" }, 400);
      }
      const computed = await sha256Base64url(codeVerifier);
      if (computed !== codePayload.code_challenge) {
        return jsonResponse({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;
    const token = await createJWT({ sub: clientId, iat: now, exp: now + expiresIn }, jwtSecret);
    return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
  }

  if (grantType === "client_credentials") {
    if (reqId !== clientId || reqSecret !== clientSecret) {
      return jsonResponse({ error: "invalid_client" }, 401);
    }
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;
    const token = await createJWT({ sub: clientId, iat: now, exp: now + expiresIn }, jwtSecret);
    return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
  }

  return jsonResponse({ error: "unsupported_grant_type" }, 400);
}

function authChallengeHeaders(baseUrl: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
  };
}

async function requireAuth(req: Request, baseUrl?: string) {
  const challengeHeaders = baseUrl ? authChallengeHeaders(baseUrl) : { "Content-Type": "application/json" };

  // Check for OAuth Bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const jwtSecret = Deno.env.get("OAUTH_JWT_SECRET") || Deno.env.get("OAUTH_CLIENT_SECRET") || "";
    if (jwtSecret) {
      const payload = await verifyJWT(authHeader.slice(7), jwtSecret);
      if (payload) return;
    }
    throw new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: challengeHeaders,
    });
  }

  // Fall back to static key
  const expected = Deno.env.get("MCP_ACCESS_KEY") ?? "";
  if (!expected) return;

  const url = new URL(req.url);
  const key = req.headers.get("x-brain-key") || url.searchParams.get("key");
  if (key !== expected) {
    throw new Response(JSON.stringify({ error: "Invalid or missing access key" }), {
      status: 401,
      headers: challengeHeaders,
    });
  }
}

async function getThoughtCount(supabase: ReturnType<typeof createClient>) {
  const { count, error } = await supabase.from("thoughts").select("id", { count: "exact", head: true });
  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }
  return count ?? 0;
}

async function captureThought(
  supabase: ReturnType<typeof createClient>,
  content: unknown,
  source: string
) {
  const normalizedContent = normalizeContent(content);

  if (!normalizedContent) {
    throw new Error("Content is required");
  }

  if (normalizedContent.length > MAX_THOUGHT_CHARS) {
    throw new Error(
      `Content is too long (${normalizedContent.length} chars). Max allowed is ${MAX_THOUGHT_CHARS}.`
    );
  }

  const [embedding, metadata] = await Promise.all([
    getEmbedding(normalizedContent),
    extractMetadata(normalizedContent),
  ]);

  const normalizedTopics = normalizeTopicTags((metadata as Record<string, unknown> | null)?.topics);
  const effectiveMetadata = normalizedTopics.length ? { ...metadata, topics: normalizedTopics } : metadata;
  const payload = { ...effectiveMetadata, source };
  const { data, error } = await supabase.rpc("insert_thought", {
    p_content: normalizedContent,
    p_embedding: vectorLiteral(embedding),
    p_metadata: payload,
  });

  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }

  const row = Array.isArray(data) ? data[0] : data;
  let confirmation = `Captured as ${effectiveMetadata.type || "thought"}`;
  if (effectiveMetadata.topics?.length) confirmation += ` — ${effectiveMetadata.topics.join(", ")}`;
  if (effectiveMetadata.people?.length) confirmation += ` | People: ${effectiveMetadata.people.join(", ")}`;
  if (effectiveMetadata.action_items?.length) {
    confirmation += ` | Actions: ${effectiveMetadata.action_items.join("; ")}`;
  }

  return {
    success: true,
    id: row?.id,
    created_at: row?.created_at,
    confirmation,
    metadata: effectiveMetadata,
  };
}

async function searchThoughts(
  supabase: ReturnType<typeof createClient>,
  query: string,
  limit = 10,
  threshold = 0.5,
  filter: Record<string, unknown> = {}
) {
  const embedding = await getEmbedding(query);
  const { data, error } = await supabase.rpc("match_thoughts", {
    query_embedding: vectorLiteral(embedding),
    match_threshold: threshold,
    match_count: limit,
    filter,
  });

  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }

  return data ?? [];
}

async function listThoughts(
  supabase: ReturnType<typeof createClient>,
  args: {
    limit?: number;
    type?: string | null;
    topic?: string | null;
    person?: string | null;
    days?: number | null;
  }
) {
  const { data, error } = await supabase.rpc("list_thoughts", {
    p_limit: args.limit ?? 10,
    p_type: args.type ?? null,
    p_topic: args.topic ?? null,
    p_person: args.person ?? null,
    p_days: args.days ?? null,
  });

  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }

  return data ?? [];
}

async function thoughtStats(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.rpc("thought_stats");
  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }

  return (
    data ?? {
      total: 0,
      date_range: null,
      types: [],
      top_topics: [],
      people_mentioned: [],
    }
  );
}

function formatSearchResults(results: Array<Record<string, unknown>>, query: string) {
  if (!results.length) {
    return `No thoughts found matching "${query}".`;
  }

  return results
    .map((result, index) => {
      const metadata = (result.metadata as Record<string, unknown> | null) ?? {};
      const parts = [
        `--- Result ${index + 1} (${(Number(result.similarity || 0) * 100).toFixed(1)}% match) ---`,
        `Captured: ${new Date(String(result.created_at)).toLocaleDateString()}`,
        `Type: ${String(metadata.type || "unknown")}`,
      ];
      if (Array.isArray(metadata.topics) && metadata.topics.length) {
        parts.push(`Topics: ${metadata.topics.join(", ")}`);
      }
      if (Array.isArray(metadata.people) && metadata.people.length) {
        parts.push(`People: ${metadata.people.join(", ")}`);
      }
      if (Array.isArray(metadata.action_items) && metadata.action_items.length) {
        parts.push(`Actions: ${metadata.action_items.join("; ")}`);
      }
      parts.push(`\n${String(result.content || "")}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

function formatThoughtList(results: Array<Record<string, unknown>>) {
  if (!results.length) {
    return "No thoughts found.";
  }

  return results
    .map((result, index) => {
      const metadata = (result.metadata as Record<string, unknown> | null) ?? {};
      const tags = Array.isArray(metadata.topics) && metadata.topics.length ? metadata.topics.join(", ") : "";
      return `${index + 1}. [${new Date(String(result.created_at)).toLocaleDateString()}] (${String(metadata.type || "??")}${tags ? " — " + tags : ""})\n   ${String(result.content || "")}`;
    })
    .join("\n\n");
}

function formatStats(stats: Record<string, unknown>) {
  const types = Array.isArray(stats.types) ? stats.types : [];
  const topics = Array.isArray(stats.top_topics) ? stats.top_topics : [];
  const people = Array.isArray(stats.people_mentioned) ? stats.people_mentioned : [];
  const range = stats.date_range as Record<string, unknown> | null;

  const lines = [
    `Total thoughts: ${Number(stats.total || 0)}`,
    `Date range: ${
      range?.earliest && range?.latest
        ? `${new Date(String(range.earliest)).toLocaleDateString()} → ${new Date(String(range.latest)).toLocaleDateString()}`
        : "N/A"
    }`,
    "",
    "Types:",
    ...types.map((entry) => `  ${String((entry as Record<string, unknown>).name)}: ${String((entry as Record<string, unknown>).count)}`),
  ];

  if (topics.length) {
    lines.push("", "Top topics:");
    for (const entry of topics) {
      lines.push(`  ${String((entry as Record<string, unknown>).name)}: ${String((entry as Record<string, unknown>).count)}`);
    }
  }

  if (people.length) {
    lines.push("", "People mentioned:");
    for (const entry of people) {
      lines.push(`  ${String((entry as Record<string, unknown>).name)}: ${String((entry as Record<string, unknown>).count)}`);
    }
  }

  return lines.join("\n");
}

async function handleMcpRequest(req: Request, supabase: ReturnType<typeof createClient>) {
  const server = new McpServer(
    {
      name: "open-brain",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );


  const registerTool = (name: string, config: Parameters<typeof server.registerTool>[1], handler: Parameters<typeof server.registerTool>[2]) =>
    server.registerTool(name, config, async (args) => {
      try {
        return normalizeToolResult(await handler(args));
      } catch (error) {
        return jsonToolResult({ ok: false, data: null, error: normalizeToolError(error), meta: {} });
      }
    });

  const resolveCallerIdentity = async () => {
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const jwtSecret = Deno.env.get("OAUTH_JWT_SECRET") || Deno.env.get("OAUTH_CLIENT_SECRET") || "";
      const payload = jwtSecret ? await verifyJWT(authHeader.slice(7), jwtSecret) : null;
      return {
        auth_method: "oauth_bearer",
        subject: payload?.sub ?? null,
        client_id: payload?.sub ?? null,
        token_claims: payload ?? null,
      };
    }

    const url = new URL(req.url);
    const key = req.headers.get("x-brain-key") || url.searchParams.get("key");
    if (key) {
      return {
        auth_method: "access_key",
        key_present: true,
      };
    }

    return {
      auth_method: "anonymous",
    };
  };

  registerTool(
    "version",
    {
      description: "Return the Open Brain MCP server name and version.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({
      name: "open-brain",
      version: SERVER_VERSION,
    })
  );

  registerTool(
    "whoami",
    {
      description: "Return the caller identity and auth method currently seen by the MCP server.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      return {
        auth: await resolveCallerIdentity(),
        server: { name: "open-brain", version: SERVER_VERSION },
      };
    }
  );

  registerTool(
    "server_info",
    {
      description: "Get Open Brain MCP server version.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const info = {
        name: "open-brain",
        version: SERVER_VERSION,
      };
      return jsonToolResult({ ok: true, data: info, error: null, meta: {} });
    }
  );

  registerTool(
    "health",
    {
      description: "Lightweight health check for Open Brain MCP and its backing database.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [thoughts, personalInfo] = await Promise.all([
        supabase.from("thoughts").select("id", { count: "exact", head: true }),
        supabase.from("personal_info").select("id", { count: "exact", head: true }),
      ]);

      const errors = [thoughts, personalInfo]
        .map((result) => result.error?.message)
        .filter(Boolean);
      if (errors.length) {
        throw new Error(`Health check failed: ${errors.join("; ")}`);
      }

      const payload = {
        ok: true,
        name: "open-brain",
        version: SERVER_VERSION,
        checked_at: new Date().toISOString(),
        counts: {
          thoughts: thoughts.count ?? 0,
          personal_info: personalInfo.count ?? 0,
        },
      };
      return jsonToolResult({ ok: true, data: payload, error: null, meta: {} });
    }
  );

  registerTool(
    "db_stats",
    {
      description: "Database overview with counts by category plus potential issues (duplicate personal_info keys). Use at the start of a session for a quick audit instead of running multiple list queries.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { data, error } = await supabase.rpc("db_overview");
      if (error) throw new Error(error.message);

      const stats = data as Record<string, unknown>;
      const duplicateKeys = stats.duplicate_personal_info_keys as Array<Record<string, unknown>> ?? [];

      const issues: string[] = [];
      if (duplicateKeys.length) issues.push(`${duplicateKeys.length} duplicate personal_info key(s)`);

      return jsonToolResult({
        ok: true,
        data: { ...stats, issues: issues.length ? issues : ["No issues detected"] },
        error: null,
        meta: {},
      });
    }
  );

  registerTool(
    "search_thoughts",
    {
      description: "Search captured thoughts by meaning.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, threshold }) => {
      const effectiveLimit = limit ?? 10;
      const effectiveThreshold = threshold ?? 0.5;
      const results = await searchThoughts(supabase, query, effectiveLimit, effectiveThreshold);
      const items = (results as Array<Record<string, unknown>>).map((result) => {
        const metadata = (result.metadata as Record<string, unknown> | null) ?? {};
        return {
          id: result.id,
          content: result.content,
          snippet: makeSnippet(result.content),
          created_at: result.created_at,
          type: metadata.type ?? null,
          topics: Array.isArray(metadata.topics) ? metadata.topics : [],
          people: Array.isArray(metadata.people) ? metadata.people : [],
          action_items: Array.isArray(metadata.action_items) ? metadata.action_items : [],
          score: Number(result.similarity ?? 0),
          matched_fields: collectMatchedFields(query, {
            content: result.content,
            topics: Array.isArray(metadata.topics) ? metadata.topics : [],
            people: Array.isArray(metadata.people) ? metadata.people : [],
            action_items: Array.isArray(metadata.action_items) ? metadata.action_items : [],
          }),
        };
      });
      return jsonToolResult({
        ok: true,
        data: { results: items },
        error: null,
        meta: {
          query,
          limit: effectiveLimit,
          threshold: effectiveThreshold,
          result_count: items.length,
        },
      });
    }
  );

  registerTool(
    "list_thoughts",
    {
      description: "List recently captured thoughts with optional filters.",
      inputSchema: z.object({
        limit: z.number().optional(),
        type: z.string().optional(),
        topic: z.string().optional(),
        person: z.string().optional(),
        days: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const results = await listThoughts(supabase, {
        limit: args.limit,
        type: args.type,
        topic: args.topic,
        person: args.person,
        days: args.days,
      });
      return { content: [{ type: "text", text: formatThoughtList(results as Array<Record<string, unknown>>) }] };
    }
  );

  registerTool(
    "thought_stats",
    {
      description: "Get a summary of all captured thoughts.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const stats = (await thoughtStats(supabase)) as Record<string, unknown>;
      return { content: [{ type: "text", text: formatStats(stats) }] };
    }
  );

  registerTool(
    "capture_thought",
    {
      description: "Save a new thought to the Open Brain.",
      inputSchema: z.object({ content: z.string() }),
    },
    async ({ content }) => {
      const result = await captureThought(supabase, content, "mcp-edge");
      return { content: [{ type: "text", text: String(result.confirmation) }] };
    }
  );

  registerTool(
    "delete_thought",
    {
      description: "Delete a thought by its ID.",
      inputSchema: z.object({ thought_id: z.string() }),
    },
    async ({ thought_id }) => {
      const { data, error } = await supabase.from("thoughts")
        .delete().eq("id", thought_id)
        .select("id, content").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return { content: [{ type: "text", text: `No thought found with ID "${thought_id}".` }] };
      const snippet = makeSnippet(data.content, 60);
      return { content: [{ type: "text", text: `Deleted thought: "${snippet}" (${data.id})` }] };
    }
  );

  registerTool(
    "prune_thoughts",
    {
      description: "Delete thoughts older than a given number of days. Optionally filter by type or topic. Returns count of deleted thoughts. Use with care — this is irreversible.",
      inputSchema: z.object({
        older_than_days: z.number().min(1),
        type: z.string().optional(),
        topic: z.string().optional(),
        dry_run: z.boolean().optional(),
      }),
    },
    async ({ older_than_days, type, topic, dry_run }) => {
      const cutoff = new Date(Date.now() - older_than_days * 24 * 60 * 60 * 1000).toISOString();
      let query = supabase.from("thoughts")
        .select("id, content, metadata, created_at")
        .lt("created_at", cutoff);

      if (type) {
        query = query.eq("metadata->>type", type.toLowerCase().trim());
      }
      if (topic) {
        query = query.contains("metadata", { topics: [topic.toLowerCase().trim()] });
      }

      const { data: candidates, error: selectError } = await query;
      if (selectError) throw new Error(selectError.message);
      if (!candidates || !candidates.length) {
        return { content: [{ type: "text", text: `No thoughts found older than ${older_than_days} days matching the given filters.` }] };
      }

      if (dry_run) {
        const previews = candidates.slice(0, 10).map((t) => {
          const m = (t.metadata as Record<string, unknown> | null) ?? {};
          return `- [${new Date(t.created_at).toLocaleDateString()}] (${String(m.type || "?")}) ${makeSnippet(t.content, 60)}`;
        });
        let text = `Dry run: would delete ${candidates.length} thought(s) older than ${older_than_days} days.`;
        if (candidates.length > 10) text += ` Showing first 10:`;
        text += `\n${previews.join("\n")}`;
        return { content: [{ type: "text", text }] };
      }

      const ids = candidates.map((t) => t.id);
      const { error: deleteError } = await supabase.from("thoughts")
        .delete().in("id", ids);
      if (deleteError) throw new Error(deleteError.message);

      return { content: [{ type: "text", text: `Pruned ${ids.length} thought(s) older than ${older_than_days} days.` }] };
    }
  );

  registerTool(
    "set_personal_info",
    {
      description: "Save or update a piece of personal information (name, birthday, preferences, etc.).",
      inputSchema: z.object({
        key: z.string(),
        value: z.string(),
        category: z.string().optional(),
      }),
    },
    async ({ key, value, category }) => {
      const embeddingText = `${key}: ${value}`;
      const embedding = await getEmbedding(embeddingText);
      const { data, error } = await supabase.rpc("upsert_personal_info", {
        p_key: key.toLowerCase().trim(),
        p_value: value.trim(),
        p_category: (category || "general").toLowerCase().trim(),
        p_embedding: vectorLiteral(embedding),
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      return { content: [{ type: "text", text: `Saved: ${row.key} = "${row.value}" (${row.category})` }] };
    }
  );

  registerTool(
    "get_personal_info",
    {
      description: "Retrieve a specific piece of personal information by key.",
      inputSchema: z.object({ key: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ key }) => {
      const { data, error } = await supabase.rpc("get_personal_info", {
        p_key: key.toLowerCase().trim(),
      });
      if (error) throw new Error(error.message);
      if (!data || (Array.isArray(data) && !data.length)) {
        return { content: [{ type: "text", text: `No personal info found for "${key}".` }] };
      }
      const row = Array.isArray(data) ? data[0] : data;
      return { content: [{ type: "text", text: `${row.key}: ${row.value} (${row.category}) — updated ${new Date(row.updated_at).toLocaleDateString()}` }] };
    }
  );

  registerTool(
    "search_personal_info",
    {
      description: "Search personal information by meaning. Use when the user asks about their details and you're not sure of the exact key.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, threshold }) => {
      const effectiveLimit = limit ?? 10;
      const effectiveThreshold = threshold ?? 0.5;
      const embedding = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_personal_info", {
        query_embedding: vectorLiteral(embedding),
        match_threshold: effectiveThreshold,
        match_count: effectiveLimit,
      });
      if (error) throw new Error(error.message);
      const items = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        key: row.key,
        value: row.value,
        category: row.category,
        updated_at: row.updated_at ?? null,
        snippet: makeSnippet(`${String(row.key)}: ${String(row.value)}`),
        score: Number(row.similarity ?? 0),
        matched_fields: collectMatchedFields(query, {
          key: row.key,
          value: row.value,
          category: row.category,
        }),
      }));
      return jsonToolResult({
        ok: true,
        data: { results: items },
        error: null,
        meta: {
          query,
          limit: effectiveLimit,
          threshold: effectiveThreshold,
          result_count: items.length,
        },
      });
    }
  );

  registerTool(
    "list_personal_info",
    {
      description: "List all stored personal information, optionally filtered by category.",
      inputSchema: z.object({ category: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ category }) => {
      const { data, error } = await supabase.rpc("list_personal_info", {
        p_category: category ? category.toLowerCase().trim() : null,
      });
      if (error) throw new Error(error.message);
      if (!data || !data.length) {
        return { content: [{ type: "text", text: category ? `No personal info in category "${category}".` : "No personal info stored yet." }] };
      }
      let currentCat = "";
      const lines: string[] = [];
      for (const row of data as Array<Record<string, unknown>>) {
        if (String(row.category) !== currentCat) {
          currentCat = String(row.category);
          lines.push(`\n[${currentCat}]`);
        }
        lines.push(`  ${String(row.key)}: ${String(row.value)}`);
      }
      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    }
  );

  registerTool(
    "delete_personal_info",
    {
      description: "Delete a piece of personal information by key.",
      inputSchema: z.object({ key: z.string() }),
    },
    async ({ key }) => {
      const { data, error } = await supabase.rpc("delete_personal_info", {
        p_key: key.toLowerCase().trim(),
      });
      if (error) throw new Error(error.message);
      return { content: [{ type: "text", text: data ? `Deleted "${key}".` : `No personal info found for "${key}".` }] };
    }
  );

  // ── Job search tools ──
  // Thin wrappers over personal_info for the `job_search.profile` and
  // `job_search.answer_bank` blobs. They parse the stored JSON so callers
  // don't have to, and `add_answer` provides the partial-update path for
  // the answer bank's nested arrays.

  async function readJobSearchBlob(key: string) {
    const { data, error } = await supabase.rpc("get_personal_info", { p_key: key });
    if (error) throw new Error(error.message);
    if (!data || (Array.isArray(data) && !data.length)) return null;
    const row = Array.isArray(data) ? data[0] : data;
    try {
      return { row, parsed: JSON.parse(String(row.value)) };
    } catch (err) {
      throw new Error(`Stored ${key} is not valid JSON: ${(err as Error).message}`);
    }
  }

  async function writeJobSearchBlob(key: string, value: unknown) {
    const serialized = JSON.stringify(value);
    const embedding = await getEmbedding(`${key}: ${serialized}`);
    const { error } = await supabase.rpc("upsert_personal_info", {
      p_key: key,
      p_value: serialized,
      p_category: "job_search",
      p_embedding: vectorLiteral(embedding),
    });
    if (error) throw new Error(error.message);
  }

  registerTool(
    "get_job_profile",
    {
      description: "Return the parsed job_search.profile object (identity, work preferences, compensation, application defaults, etc.). Use this instead of get_personal_info when you need to read the profile as structured data.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const blob = await readJobSearchBlob("job_search.profile");
      if (!blob) {
        return { content: [{ type: "text", text: "No job_search.profile set." }] };
      }
      return jsonToolResult({
        ok: true,
        data: { profile: blob.parsed, updated_at: blob.row.updated_at ?? null },
        error: null,
        meta: {},
      });
    }
  );

  registerTool(
    "get_answer_bank",
    {
      description: "Return the parsed job_search.answer_bank object (short_answers, availability_answers, work_auth_answers, compensation_answers, logistics_answers, resume_snippets, cover_letter_paragraphs, platform_specific). Use this instead of get_personal_info when you need structured access.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const blob = await readJobSearchBlob("job_search.answer_bank");
      if (!blob) {
        return { content: [{ type: "text", text: "No job_search.answer_bank set." }] };
      }
      return jsonToolResult({
        ok: true,
        data: { answer_bank: blob.parsed, updated_at: blob.row.updated_at ?? null },
        error: null,
        meta: {},
      });
    }
  );

  registerTool(
    "add_answer",
    {
      description: "Append a new answer to the job_search.answer_bank under the given category and question_type (e.g., category='short_answers', question_type='why_this_role'). Avoids a read-modify-write by the caller. `id` must be unique within the question_type; defaults approved=false, source='drafted_by_assistant'.",
      inputSchema: z.object({
        category: z.string(),
        question_type: z.string(),
        id: z.string(),
        text: z.string(),
        approved: z.boolean().optional(),
        source: z.string().optional(),
      }),
    },
    async ({ category, question_type, id, text, approved, source }) => {
      const cat = category.trim();
      const qtype = question_type.trim();
      const answerId = id.trim();
      const body = text.trim();
      if (!cat || !qtype || !answerId || !body) {
        throw new Error("category, question_type, id, and text are required and non-empty.");
      }

      const blob = await readJobSearchBlob("job_search.answer_bank");
      if (!blob) {
        throw new Error("No job_search.answer_bank set. Initialize it with set_personal_info first.");
      }

      const bank = blob.parsed as Record<string, unknown>;
      const section = bank[cat];
      if (!section || typeof section !== "object") {
        throw new Error(`Unknown answer_bank category "${cat}".`);
      }
      const sectionObj = section as Record<string, unknown>;
      const existing = sectionObj[qtype];
      const list = Array.isArray(existing) ? existing.slice() : [];

      if (list.some((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === answerId)) {
        throw new Error(`Answer id "${answerId}" already exists in ${cat}.${qtype}.`);
      }

      list.push({
        id: answerId,
        text: body,
        approved: approved ?? false,
        source: (source ?? "drafted_by_assistant").trim(),
        last_reviewed: new Date().toISOString().slice(0, 10),
      });
      sectionObj[qtype] = list;
      bank[cat] = sectionObj;

      const metadata = (bank.metadata && typeof bank.metadata === "object") ? bank.metadata as Record<string, unknown> : {};
      metadata.updated_at = new Date().toISOString().slice(0, 10);
      bank.metadata = metadata;

      await writeJobSearchBlob("job_search.answer_bank", bank);

      return { content: [{ type: "text", text: `Added answer "${answerId}" to ${cat}.${qtype}.` }] };
    }
  );

  // ── Project tools ──

  // ── Task tools ──

  // ─── Task Notes ──────────────────────────────────────────────────────

  registerTool(
    "connect_info_to_thoughts",
    {
      description: "Find thoughts related to a piece of personal info. Great for brainstorming — e.g. connect your resume, goals, or skills to captured thoughts.",
      inputSchema: z.object({
        key: z.string(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ key, limit, threshold }) => {
      const normalizedKey = key.toLowerCase().trim();

      // Get the personal info context
      const { data: infoData } = await supabase.rpc("get_personal_info", { p_key: normalizedKey });
      const infoRow = Array.isArray(infoData) && infoData.length ? infoData[0] : null;

      const { data, error } = await supabase.rpc("match_thoughts_by_personal_info", {
        p_key: normalizedKey,
        match_threshold: threshold ?? 0.5,
        match_count: limit ?? 10,
        filter: {},
      });
      if (error) throw new Error(error.message);
      if (!data || !data.length) {
        return { content: [{ type: "text", text: `No thoughts found related to personal info "${key}".` }] };
      }

      const lines: string[] = [];
      if (infoRow) {
        lines.push(`Connecting [${String(infoRow.category)}] ${String(infoRow.key)}: ${String(infoRow.value)}`, "");
        lines.push(`--- ${data.length} related thought(s) ---`, "");
      }

      for (const [i, t] of (data as Array<Record<string, unknown>>).entries()) {
        const m = (t.metadata as Record<string, unknown> | null) ?? {};
        const header = `${i + 1}. (${(Number(t.similarity) * 100).toFixed(1)}% match) [${new Date(String(t.created_at)).toLocaleDateString()}]${m.type ? ` (${String(m.type)})` : ""}`;
        const parts = [header];
        if (Array.isArray(m.topics) && m.topics.length) parts.push(`   Topics: ${m.topics.join(", ")}`);
        parts.push(`   ${String(t.content)}`);
        lines.push(parts.join("\n"));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  registerTool(
    "connect_thought_to_info",
    {
      description: "Find personal info related to a thought. Use a thought ID or a search query to find which personal details connect to a captured thought.",
      inputSchema: z.object({
        thought_id: z.string().optional(),
        query: z.string().optional(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ thought_id, query, limit, threshold }) => {
      let targetId = thought_id;
      let thoughtContent = "";

      if (!targetId && !query) {
        throw new Error("Either thought_id or query is required.");
      }

      // If query provided, find best matching thought first
      if (!targetId && query) {
        const results = await searchThoughts(supabase, query, 1, 0.5);
        const arr = results as Array<Record<string, unknown>>;
        if (!arr.length) {
          return { content: [{ type: "text", text: `No thought found matching "${query}".` }] };
        }
        targetId = String(arr[0].id);
        thoughtContent = String(arr[0].content);
      }

      // Get thought content if we only have the ID
      if (!thoughtContent) {
        const { data } = await supabase.from("thoughts").select("content").eq("id", targetId).single();
        if (!data) {
          return { content: [{ type: "text", text: `Thought "${targetId}" not found.` }] };
        }
        thoughtContent = String(data.content);
      }

      const { data, error } = await supabase.rpc("match_personal_info_by_thought", {
        p_thought_id: targetId,
        match_threshold: threshold ?? 0.5,
        match_count: limit ?? 10,
      });
      if (error) throw new Error(error.message);
      if (!data || !data.length) {
        return { content: [{ type: "text", text: "No personal info found related to this thought." }] };
      }

      const lines = [
        `Thought: ${thoughtContent}`,
        "",
        `--- ${data.length} related personal info ---`,
        "",
      ];

      for (const [i, r] of (data as Array<Record<string, unknown>>).entries()) {
        lines.push(`${i + 1}. [${String(r.category)}] ${String(r.key)}: ${String(r.value)} (${(Number(r.similarity) * 100).toFixed(1)}% match)`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  const CI_FAILURE_STATUSES = ["open", "resolved", "all"] as const;

  function formatCiFailureLine(
    f: Record<string, unknown>,
  ): string {
    const resolved = f.resolved_at ? ` — resolved ${new Date(String(f.resolved_at)).toLocaleDateString()}` : "";
    const fixture = f.fixture_id ? `/${f.fixture_id}` : "";
    const streak = Number(f.consecutive_failures ?? 0);
    const streakLabel = resolved ? "" : ` — ${streak} consecutive failure(s)`;
    const commit = f.last_commit_sha ? ` @${String(f.last_commit_sha).slice(0, 8)}` : "";
    return `${f.project}/${f.pipeline}: ${f.test_name}${fixture}${streakLabel}${commit}${resolved}`;
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  try {
    const supabase = createClient(requireEnv("SUPABASE_URL"), requireSupabaseServiceRoleKey(), {
      auth: { persistSession: false },
    });
    const url = new URL(req.url);
    const action = getAction(url);
    const baseUrl = getBaseUrl(url, "open-brain");

    if (action === ".well-known/oauth-protected-resource" || action === "mcp/.well-known/oauth-protected-resource") {
      return protectedResourceMetadata(baseUrl);
    }
    if (action === ".well-known/oauth-authorization-server" || action === "mcp/.well-known/oauth-authorization-server") {
      return oauthMetadata(baseUrl);
    }
    if (req.method === "GET" && (action === "authorize" || action === "mcp/authorize")) {
      return await handleAuthorizeAsync(url, baseUrl);
    }
    if (req.method === "POST" && action === "oauth/token") {
      return await handleOAuthToken(req);
    }

    if ((action === "" || action === "mcp") && (req.method === "POST" || req.method === "GET")) {
      await requireAuth(req, baseUrl);
      return await handleMcpRequest(req, supabase);
    }

    if (req.method === "GET" && action === "health") {
      return jsonResponse({ status: "ok", thoughts: await getThoughtCount(supabase) });
    }

    if (req.method === "POST" && action === "capture") {
      await requireAuth(req, baseUrl);
      const { content, source } = await req.json();
      return jsonResponse(await captureThought(supabase, content, source || "edge"));
    }

    if (req.method === "POST" && action === "search") {
      await requireAuth(req, baseUrl);
      const { query, limit = 10, threshold = 0.5, filter = {} } = await req.json();
      if (!query) {
        return jsonResponse({ error: "Query is required" }, 400);
      }

      const results = await searchThoughts(supabase, query, limit, threshold, filter);
      return jsonResponse({ count: results.length, results });
    }

    if (req.method === "GET" && action === "thoughts") {
      await requireAuth(req, baseUrl);
      const limit = Number(url.searchParams.get("limit") || "10");
      const days = url.searchParams.get("days");
      const thoughts = await listThoughts(supabase, {
        limit,
        type: url.searchParams.get("type"),
        topic: url.searchParams.get("topic"),
        person: url.searchParams.get("person"),
        days: days ? Number(days) : null,
      });
      return jsonResponse({ count: thoughts.length, thoughts });
    }

    if (req.method === "GET" && action === "stats") {
      await requireAuth(req, baseUrl);
      return jsonResponse(await thoughtStats(supabase));
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
