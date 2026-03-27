import { createClient } from "npm:@supabase/supabase-js@2";
import { McpServer } from "npm:@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "npm:zod@3.24.1";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_THOUGHT_CHARS = 12000;

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

function vectorLiteral(values: number[]) {
  return `[${values.join(",")}]`;
}

function normalizeContent(content: unknown) {
  return String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[\t ]+/gm, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\s+/g, " ");
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

function getAction(url: URL) {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("open-brain");
  if (functionIndex === -1) {
    return url.searchParams.get("action") || "";
  }
  return parts.slice(functionIndex + 1).join("/") || url.searchParams.get("action") || "";
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

  const payload = { ...metadata, source };
  const { data, error } = await supabase.rpc("insert_thought", {
    p_content: normalizedContent,
    p_embedding: vectorLiteral(embedding),
    p_metadata: payload,
  });

  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }

  const row = Array.isArray(data) ? data[0] : data;
  let confirmation = `Captured as ${metadata.type || "thought"}`;
  if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;
  if (metadata.people?.length) confirmation += ` | People: ${metadata.people.join(", ")}`;
  if (metadata.action_items?.length) {
    confirmation += ` | Actions: ${metadata.action_items.join("; ")}`;
  }

  return {
    success: true,
    id: row?.id,
    created_at: row?.created_at,
    confirmation,
    metadata,
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
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.registerTool(
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
      const results = await searchThoughts(supabase, query, limit ?? 10, threshold ?? 0.5);
      return { content: [{ type: "text", text: formatSearchResults(results as Array<Record<string, unknown>>, query) }] };
    }
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
      const embedding = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_personal_info", {
        query_embedding: vectorLiteral(embedding),
        match_threshold: threshold ?? 0.5,
        match_count: limit ?? 10,
      });
      if (error) throw new Error(error.message);
      if (!data || !data.length) {
        return { content: [{ type: "text", text: `No personal info found matching "${query}".` }] };
      }
      const text = (data as Array<Record<string, unknown>>)
        .map((r, i) => `${i + 1}. [${String(r.category)}] ${String(r.key)}: ${String(r.value)} (${(Number(r.similarity) * 100).toFixed(1)}% match)`)
        .join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
    "create_task",
    {
      description: "Create a new task. Use this when the user wants to track something they need to do.",
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        priority: z.string().optional(),
        due_date: z.string().optional(),
      }),
    },
    async ({ title, description, priority, due_date }) => {
      const normalizedPriority = (priority || "medium").toLowerCase().trim();
      const validPriorities = ["low", "medium", "high"];
      if (!validPriorities.includes(normalizedPriority)) {
        throw new Error(`Invalid priority "${priority}". Must be: ${validPriorities.join(", ")}`);
      }
      const embeddingText = description ? `${title}: ${description}` : title;
      const embedding = await getEmbedding(embeddingText);
      const { data, error } = await supabase.from("tasks").insert({
        title: title.trim(),
        description: description?.trim() || null,
        priority: normalizedPriority,
        due_date: due_date || null,
        embedding: vectorLiteral(embedding),
      }).select("id, title, status, priority, due_date").single();
      if (error) throw new Error(error.message);
      let confirmation = `Created task: "${data.title}" [${data.priority}]`;
      if (data.due_date) confirmation += ` — due ${data.due_date}`;
      confirmation += `\nID: ${data.id}`;
      return { content: [{ type: "text", text: confirmation }] };
    }
  );

  server.registerTool(
    "get_task",
    {
      description: "Retrieve a specific task by its ID.",
      inputSchema: z.object({ task_id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const { data, error } = await supabase.from("tasks")
        .select("id, title, description, status, priority, due_date, created_at, updated_at")
        .eq("id", task_id).single();
      if (error) throw new Error(error.message);
      if (!data) return { content: [{ type: "text", text: `No task found with ID "${task_id}".` }] };
      const lines = [
        `Title: ${data.title}`,
        `Status: ${data.status}`,
        `Priority: ${data.priority}`,
      ];
      if (data.description) lines.push(`Description: ${data.description}`);
      if (data.due_date) lines.push(`Due: ${data.due_date}`);
      lines.push(`Created: ${new Date(data.created_at).toLocaleDateString()}`);
      lines.push(`Updated: ${new Date(data.updated_at).toLocaleDateString()}`);
      lines.push(`ID: ${data.id}`);

      // Fetch associated notes
      const { data: notes } = await supabase.from("task_notes")
        .select("id, content, type, created_at")
        .eq("task_id", task_id)
        .order("created_at", { ascending: false })
        .limit(10);
      if (notes && notes.length) {
        lines.push("", `--- ${notes.length} note(s) ---`);
        for (const n of notes as Array<Record<string, unknown>>) {
          lines.push(`  [${n.type}] ${new Date(String(n.created_at)).toLocaleDateString()}: ${n.content}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "update_task",
    {
      description: "Update a task's title, description, status, priority, or due date. To mark a task as done, set status to 'done'.",
      inputSchema: z.object({
        task_id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        due_date: z.string().optional(),
      }),
    },
    async ({ task_id, title, description, status, priority, due_date }) => {
      const updates: Record<string, unknown> = {};
      if (title !== undefined) updates.title = title.trim();
      if (description !== undefined) updates.description = description?.trim() || null;
      if (status !== undefined) {
        const validStatuses = ["todo", "in_progress", "done"];
        const s = status.toLowerCase().trim();
        if (!validStatuses.includes(s)) throw new Error(`Invalid status "${status}". Must be: ${validStatuses.join(", ")}`);
        updates.status = s;
      }
      if (priority !== undefined) {
        const validPriorities = ["low", "medium", "high"];
        const p = priority.toLowerCase().trim();
        if (!validPriorities.includes(p)) throw new Error(`Invalid priority "${priority}". Must be: ${validPriorities.join(", ")}`);
        updates.priority = p;
      }
      if (due_date !== undefined) updates.due_date = due_date || null;
      if (!Object.keys(updates).length) throw new Error("No fields to update.");

      // Re-embed if title or description changed
      if (title !== undefined || description !== undefined) {
        const { data: current } = await supabase.from("tasks").select("title, description").eq("id", task_id).single();
        if (current) {
          const newTitle = title !== undefined ? title.trim() : current.title;
          const newDesc = description !== undefined ? (description?.trim() || null) : current.description;
          const embeddingText = newDesc ? `${newTitle}: ${newDesc}` : newTitle;
          updates.embedding = vectorLiteral(await getEmbedding(embeddingText));
        }
      }

      const { data, error } = await supabase.from("tasks").update(updates).eq("id", task_id)
        .select("id, title, status, priority, due_date").single();
      if (error) throw new Error(error.message);
      if (!data) return { content: [{ type: "text", text: `No task found with ID "${task_id}".` }] };
      let confirmation = `Updated: "${data.title}" [${data.status}, ${data.priority}]`;
      if (data.due_date) confirmation += ` — due ${data.due_date}`;
      return { content: [{ type: "text", text: confirmation }] };
    }
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks with optional filters by status, priority, or due date.",
      inputSchema: z.object({
        status: z.string().optional(),
        priority: z.string().optional(),
        include_done: z.boolean().optional(),
        limit: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, priority, include_done, limit }) => {
      let query = supabase.from("tasks")
        .select("id, title, description, status, priority, due_date, created_at");
      if (status) {
        query = query.eq("status", status.toLowerCase().trim());
      } else if (!include_done) {
        query = query.neq("status", "done");
      }
      if (priority) query = query.eq("priority", priority.toLowerCase().trim());
      query = query.order("priority", { ascending: true })
        .order("due_date", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(limit ?? 20);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      if (!data || !data.length) return { content: [{ type: "text", text: "No tasks found." }] };
      const text = data.map((t: Record<string, unknown>, i: number) => {
        const parts = [`${i + 1}. [${t.status}] [${t.priority}] ${t.title}`];
        if (t.due_date) parts[0] += ` — due ${t.due_date}`;
        if (t.description) parts.push(`   ${t.description}`);
        parts.push(`   ID: ${t.id}`);
        return parts.join("\n");
      }).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "search_tasks",
    {
      description: "Search tasks by meaning. Use when the user asks about tasks related to a topic.",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, threshold }) => {
      const embedding = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_tasks", {
        query_embedding: vectorLiteral(embedding),
        match_threshold: threshold ?? 0.5,
        match_count: limit ?? 10,
      });
      if (error) throw new Error(error.message);
      if (!data || !data.length) return { content: [{ type: "text", text: `No tasks found matching "${query}".` }] };
      const text = (data as Array<Record<string, unknown>>).map((t, i) => {
        const parts = [`${i + 1}. [${t.status}] [${t.priority}] ${t.title} (${(Number(t.similarity) * 100).toFixed(1)}% match)`];
        if (t.due_date) parts[0] += ` — due ${t.due_date}`;
        if (t.description) parts.push(`   ${t.description}`);
        parts.push(`   ID: ${t.id}`);
        return parts.join("\n");
      }).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  // ─── Task Notes ──────────────────────────────────────────────────────

  server.registerTool(
    "add_task_note",
    {
      description: "Add a note or deliverable to a task. Use type 'note' for general notes and 'deliverable' for specific outputs/artifacts.",
      inputSchema: z.object({
        task_id: z.string(),
        content: z.string(),
        type: z.string().optional(),
      }),
    },
    async ({ task_id, content, type }) => {
      const noteType = (type || "note").toLowerCase().trim();
      const embedding = await getEmbedding(content);
      const { data, error } = await supabase.from("task_notes").insert({
        task_id,
        content: content.trim(),
        type: noteType,
        embedding: vectorLiteral(embedding),
      }).select("id, task_id, type, created_at").single();
      if (error) throw new Error(error.message);
      return { content: [{ type: "text", text: `Added ${data.type} to task ${data.task_id}\nNote ID: ${data.id}` }] };
    }
  );

  server.registerTool(
    "list_task_notes",
    {
      description: "List all notes and deliverables for a specific task.",
      inputSchema: z.object({
        task_id: z.string(),
        type: z.string().optional(),
        limit: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ task_id, type, limit }) => {
      let query = supabase.from("task_notes")
        .select("id, content, type, created_at, updated_at")
        .eq("task_id", task_id);
      if (type) query = query.eq("type", type.toLowerCase().trim());
      query = query.order("created_at", { ascending: false }).limit(limit ?? 20);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      if (!data || !data.length) return { content: [{ type: "text", text: `No notes found for task "${task_id}".` }] };
      const text = data.map((n: Record<string, unknown>, i: number) => {
        const parts = [`${i + 1}. [${n.type}] ${new Date(String(n.created_at)).toLocaleDateString()}`];
        parts.push(`   ${n.content}`);
        parts.push(`   ID: ${n.id}`);
        return parts.join("\n");
      }).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "update_task_note",
    {
      description: "Update the content or type of an existing task note.",
      inputSchema: z.object({
        note_id: z.string(),
        content: z.string().optional(),
        type: z.string().optional(),
      }),
    },
    async ({ note_id, content, type }) => {
      const updates: Record<string, unknown> = {};
      if (content !== undefined) updates.content = content.trim();
      if (type !== undefined) updates.type = type.toLowerCase().trim();
      if (!Object.keys(updates).length) throw new Error("No fields to update.");
      if (content !== undefined) {
        updates.embedding = vectorLiteral(await getEmbedding(content.trim()));
      }
      const { data, error } = await supabase.from("task_notes").update(updates).eq("id", note_id)
        .select("id, task_id, type").single();
      if (error) throw new Error(error.message);
      if (!data) return { content: [{ type: "text", text: `No note found with ID "${note_id}".` }] };
      return { content: [{ type: "text", text: `Updated ${data.type} (${data.id}) on task ${data.task_id}.` }] };
    }
  );

  server.registerTool(
    "delete_task_note",
    {
      description: "Delete a task note by its ID.",
      inputSchema: z.object({ note_id: z.string() }),
    },
    async ({ note_id }) => {
      const { data, error } = await supabase.from("task_notes").delete().eq("id", note_id)
        .select("id").single();
      if (error) throw new Error(error.message);
      if (!data) return { content: [{ type: "text", text: `No note found with ID "${note_id}".` }] };
      return { content: [{ type: "text", text: `Deleted note ${data.id}.` }] };
    }
  );

  server.registerTool(
    "search_task_notes",
    {
      description: "Search task notes by meaning. Optionally scope to a specific task.",
      inputSchema: z.object({
        query: z.string(),
        task_id: z.string().optional(),
        limit: z.number().optional(),
        threshold: z.number().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, task_id, limit, threshold }) => {
      const embedding = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_task_notes", {
        query_embedding: vectorLiteral(embedding),
        match_threshold: threshold ?? 0.5,
        match_count: limit ?? 10,
        p_task_id: task_id || null,
      });
      if (error) throw new Error(error.message);
      if (!data || !data.length) return { content: [{ type: "text", text: `No task notes found matching "${query}".` }] };
      const text = (data as Array<Record<string, unknown>>).map((n, i) => {
        const parts = [`${i + 1}. [${n.type}] (${(Number(n.similarity) * 100).toFixed(1)}% match)`];
        parts.push(`   ${n.content}`);
        parts.push(`   Task: ${n.task_id} | Note: ${n.id}`);
        return parts.join("\n");
      }).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
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
        match_threshold: threshold ?? 0.3,
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

  server.registerTool(
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
        const results = await searchThoughts(supabase, query, 1, 0.3);
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
        match_threshold: threshold ?? 0.3,
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