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

function getBaseUrl(url: URL, functionName: string): string {
  const path = url.pathname;
  const idx = path.lastIndexOf(`/${functionName}`);
  return idx === -1 ? url.origin : url.origin + path.substring(0, idx + functionName.length + 1);
}

function oauthMetadata(baseUrl: string): Response {
  return jsonResponse({
    issuer: baseUrl,
    token_endpoint: `${baseUrl}/oauth/token`,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    grant_types_supported: ["client_credentials"],
    response_types_supported: [],
    code_challenge_methods_supported: [],
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

  let grantType = "", reqId = "", reqSecret = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await req.text());
    grantType = params.get("grant_type") ?? "";
    reqId = params.get("client_id") ?? "";
    reqSecret = params.get("client_secret") ?? "";
  } else {
    const body = await req.json();
    grantType = body.grant_type ?? "";
    reqId = body.client_id ?? "";
    reqSecret = body.client_secret ?? "";
  }

  if (grantType !== "client_credentials") {
    return jsonResponse({ error: "unsupported_grant_type" }, 400);
  }
  if (reqId !== clientId || reqSecret !== clientSecret) {
    return jsonResponse({ error: "invalid_client" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600;
  const jwtSecret = Deno.env.get("OAUTH_JWT_SECRET") || clientSecret;
  const token = await createJWT({ sub: clientId, iat: now, exp: now + expiresIn }, jwtSecret);

  return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
}

async function requireAuth(req: Request) {
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
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
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
    throw error;
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
    throw error;
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
    throw error;
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
    throw error;
  }

  return data ?? [];
}

async function thoughtStats(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase.rpc("thought_stats");
  if (error) {
    throw error;
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
    if (req.method === "POST" && action === "oauth/token") {
      return await handleOAuthToken(req);
    }

    if ((action === "" || action === "mcp") && (req.method === "POST" || req.method === "GET")) {
      await requireAuth(req);
      return await handleMcpRequest(req, supabase);
    }

    if (req.method === "GET" && action === "health") {
      return jsonResponse({ status: "ok", thoughts: await getThoughtCount(supabase) });
    }

    if (req.method === "POST" && action === "capture") {
      await requireAuth(req);
      const { content, source } = await req.json();
      return jsonResponse(await captureThought(supabase, content, source || "edge"));
    }

    if (req.method === "POST" && action === "search") {
      await requireAuth(req);
      const { query, limit = 10, threshold = 0.5, filter = {} } = await req.json();
      if (!query) {
        return jsonResponse({ error: "Query is required" }, 400);
      }

      const results = await searchThoughts(supabase, query, limit, threshold, filter);
      return jsonResponse({ count: results.length, results });
    }

    if (req.method === "GET" && action === "thoughts") {
      await requireAuth(req);
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
      await requireAuth(req);
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