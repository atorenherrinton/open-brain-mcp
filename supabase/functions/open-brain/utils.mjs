export function vectorLiteral(values) {
  return `[${values.join(",")}]`;
}

export function normalizeContent(content) {
  return String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[\t ]+/gm, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\s+/g, " ");
}

export function jsonToolResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function makeSnippet(value, max = 180) {
  const text = normalizeContent(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function collectMatchedFields(query, candidates) {
  const tokens = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matched = [];
  for (const [field, value] of Object.entries(candidates ?? {})) {
    const haystack = Array.isArray(value)
      ? value.map((entry) => String(entry).toLowerCase()).join(" ")
      : String(value ?? "").toLowerCase();
    if (tokens.some((token) => haystack.includes(token))) {
      matched.push(field);
    }
  }
  return matched.length ? matched : ["semantic_match"];
}

export function normalizeTopicTags(topics) {
  if (!Array.isArray(topics)) return [];
  const normalized = topics
    .map((topic) => String(topic ?? "").trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, 3);
}

export function inferToolErrorCode(message) {
  const lower = String(message ?? "").toLowerCase();
  if (lower.includes("not found") || lower.startsWith("no ")) return "NOT_FOUND";
  if (lower.includes("invalid") || lower.includes("required") || lower.includes("cannot be empty") || lower.includes("no fields to update")) return "VALIDATION_ERROR";
  if (lower.includes("already exists") || lower.includes("duplicate") || lower.includes("conflict")) return "CONFLICT";
  if (lower.includes("too many") || lower.includes("rate limit") || lower.includes("429")) return "RATE_LIMITED";
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("access key") || lower.includes("expired token")) return "AUTH_ERROR";
  if (lower.includes("missing")) return "CONFIG_ERROR";
  return "INTERNAL_ERROR";
}

export function normalizeToolResult(result) {
  if (result && typeof result === "object" && "content" in result) {
    const content = result.content;
    if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") {
      const text = String(content[0].text ?? "");
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "ok" in parsed && "data" in parsed && "error" in parsed && "meta" in parsed) {
          return result;
        }
      } catch {
        // plain text result, wrap below
      }
      const code = inferToolErrorCode(text);
      if (code === "NOT_FOUND") {
        return jsonToolResult({ ok: false, data: null, error: { code, message: text }, meta: {} });
      }
      return jsonToolResult({ ok: true, data: { message: text }, error: null, meta: {} });
    }
    return result;
  }
  return jsonToolResult({ ok: true, data: result ?? null, error: null, meta: {} });
}

export function normalizeToolError(error) {
  if (error instanceof Response) {
    const message = `HTTP ${error.status}`;
    return { code: inferToolErrorCode(message), message };
  }
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return { code: inferToolErrorCode(message), message };
}

export function getAction(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("open-brain");
  if (functionIndex === -1) {
    return url.searchParams.get("action") || "";
  }
  return parts.slice(functionIndex + 1).join("/") || url.searchParams.get("action") || "";
}

