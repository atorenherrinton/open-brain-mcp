// CI Triage webhook — ingests per-build failure reports from any CI
// system (today: Google Cloud Build) and keeps the ci_failures table in
// sync with reality. Creates, updates, and resolves Open Brain tasks as
// failures open and close.
//
// Security: this function runs with verify_jwt=false so Cloud Build can
// POST with a static credential. Custom auth checks a Bearer token
// against the `ci_triage_webhook_key` row of public.webhook_secrets.
// Storing the secret in Postgres (readable only by the service role)
// rather than an Edge Function env var lets us rotate it entirely via
// SQL with no dashboard UI step.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_EXCERPT_CHARS = 8 * 1024;
const WEBHOOK_SECRET_NAME = "ci_triage_webhook_key";

type FailureEntry = {
  test_name: string;
  fixture_id?: string;
  error_excerpt: string;
};

type Payload = {
  project: string;
  pipeline: string;
  build_id?: string;
  commit_sha?: string;
  build_log_url?: string;
  outcome: "success" | "failure";
  failures?: FailureEntry[];
};

type FailureRow = {
  id: string;
  project: string;
  pipeline: string;
  test_name: string;
  fixture_id: string;
  consecutive_failures: number;
  open_brain_task_id: string | null;
  resolved_at: string | null;
};

function badRequest(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n[truncated]";
}

function buildTaskBody(
  project: string,
  pipeline: string,
  testName: string,
  fixtureId: string,
  consecutiveFailures: number,
  buildId: string | undefined,
  commitSha: string | undefined,
  buildLogUrl: string | undefined,
  errorExcerpt: string,
): string {
  const fixtureLine = fixtureId ? `Fixture: \`${fixtureId}\`` : "";
  const streakLine =
    consecutiveFailures === 1
      ? "First failure — may still be a flake; reproduce once before spending real effort."
      : `**Has failed ${consecutiveFailures} builds in a row** — treat as an active regression.`;
  const reproduceCmd = fixtureId
    ? `go test -run '${testName}/${fixtureId}' -v ./...`
    : `go test -run '${testName}' -v ./...`;

  return [
    `Project: \`${project}\``,
    `Pipeline: \`${pipeline}\``,
    `Test: \`${testName}\``,
    fixtureLine,
    "",
    streakLine,
    "",
    commitSha ? `Last failing commit: \`${commitSha}\`` : "",
    buildId ? `Last failing build: \`${buildId}\`` : "",
    buildLogUrl ? `Build log: ${buildLogUrl}` : "",
    "",
    "**Reproduce locally:**",
    "```",
    reproduceCmd,
    "```",
    "",
    "**Latest failure excerpt:**",
    "```",
    errorExcerpt,
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return badRequest("method not allowed", 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return badRequest("server misconfigured", 500);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Look up the expected Bearer token from the webhook_secrets table.
  // The service role reads it by default (RLS bypass). Anything else
  // querying this table hits RLS with no policies and sees nothing.
  const { data: secretRow, error: secretErr } = await supabase
    .from("webhook_secrets")
    .select("value")
    .eq("name", WEBHOOK_SECRET_NAME)
    .maybeSingle();
  if (secretErr) {
    return badRequest("unauthorized", 401);
  }
  if (!secretRow) {
    // Intentionally opaque — never reveal whether the secret row exists.
    return badRequest("unauthorized", 401);
  }
  const expectedHeader = `Bearer ${secretRow.value as string}`;
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== expectedHeader) {
    return badRequest("unauthorized", 401);
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return badRequest("invalid json");
  }

  if (!payload.project || !payload.pipeline || !payload.outcome) {
    return badRequest("missing required fields: project, pipeline, outcome");
  }
  if (payload.outcome !== "success" && payload.outcome !== "failure") {
    return badRequest("outcome must be 'success' or 'failure'");
  }
  if (payload.outcome === "failure" && (!payload.failures || payload.failures.length === 0)) {
    return badRequest("outcome=failure requires non-empty failures array");
  }

  const { data: projectRow, error: projErr } = await supabase
    .from("projects")
    .select("id")
    .ilike("name", payload.project)
    .maybeSingle();
  if (projErr) {
    return badRequest(`project lookup failed: ${projErr.message}`, 500);
  }
  if (!projectRow) {
    return badRequest(
      `unknown project '${payload.project}' — create it in Open Brain before sending failures`,
      422,
    );
  }
  const openBrainProjectId = projectRow.id as string;

  const results = {
    opened: [] as string[],
    updated: [] as string[],
    resolved: [] as string[],
  };

  if (payload.outcome === "success") {
    const { data: openRows, error: fetchErr } = await supabase
      .from("ci_failures")
      .select("id, project, pipeline, test_name, fixture_id, consecutive_failures, open_brain_task_id, resolved_at")
      .eq("project", payload.project)
      .eq("pipeline", payload.pipeline)
      .is("resolved_at", null)
      .returns<FailureRow[]>();
    if (fetchErr) {
      return badRequest(`fetch open failures: ${fetchErr.message}`, 500);
    }
    for (const row of openRows ?? []) {
      await supabase
        .from("ci_failures")
        .update({ resolved_at: new Date().toISOString(), consecutive_failures: 0 })
        .eq("id", row.id);
      if (row.open_brain_task_id) {
        await supabase.from("tasks").update({ status: "done" }).eq("id", row.open_brain_task_id);
      }
      results.resolved.push(row.id);
    }
    return okJson(results);
  }

  const buildId = payload.build_id;
  const commitSha = payload.commit_sha;
  const buildLogUrl = payload.build_log_url;
  const now = new Date().toISOString();

  const failingKeys = new Set<string>();
  for (const failure of payload.failures ?? []) {
    const fxId = failure.fixture_id ?? "";
    failingKeys.add(`${failure.test_name}||${fxId}`);
  }

  for (const failure of payload.failures ?? []) {
    const testName = failure.test_name;
    const fixtureId = failure.fixture_id ?? "";
    const excerpt = cap(failure.error_excerpt ?? "", MAX_EXCERPT_CHARS);

    const { data: existing } = await supabase
      .from("ci_failures")
      .select("id, project, pipeline, test_name, fixture_id, consecutive_failures, open_brain_task_id, resolved_at")
      .eq("project", payload.project)
      .eq("pipeline", payload.pipeline)
      .eq("test_name", testName)
      .eq("fixture_id", fixtureId)
      .maybeSingle<FailureRow>();

    const isReopen = existing !== null && existing.resolved_at !== null;
    const wasOpen = existing !== null && existing.resolved_at === null;
    const newStreak = wasOpen ? (existing!.consecutive_failures + 1) : 1;

    const title = `[CI] ${payload.pipeline}: ${testName}${fixtureId ? "/" + fixtureId : ""} failing`;
    const description = buildTaskBody(
      payload.project,
      payload.pipeline,
      testName,
      fixtureId,
      newStreak,
      buildId,
      commitSha,
      buildLogUrl,
      excerpt,
    );
    const priority: "low" | "medium" | "high" = newStreak >= 3 ? "high" : "medium";

    let taskId = existing?.open_brain_task_id ?? null;

    if (!existing || isReopen) {
      const { data: newTask, error: taskErr } = await supabase
        .from("tasks")
        .insert({
          title,
          description,
          status: "todo",
          priority,
          project_id: openBrainProjectId,
        })
        .select("id")
        .single();
      if (taskErr) {
        return badRequest(`task create failed: ${taskErr.message}`, 500);
      }
      taskId = newTask.id as string;

      if (existing) {
        const { error: updErr } = await supabase
          .from("ci_failures")
          .update({
            resolved_at: null,
            consecutive_failures: 1,
            first_seen: now,
            last_seen: now,
            last_build_id: buildId ?? null,
            last_commit_sha: commitSha ?? null,
            last_error_excerpt: excerpt,
            open_brain_task_id: taskId,
          })
          .eq("id", existing.id);
        if (updErr) {
          return badRequest(`ci_failures reopen failed: ${updErr.message}`, 500);
        }
        results.opened.push(existing.id);
      } else {
        const { data: newRow, error: insErr } = await supabase
          .from("ci_failures")
          .insert({
            project: payload.project,
            pipeline: payload.pipeline,
            test_name: testName,
            fixture_id: fixtureId,
            consecutive_failures: 1,
            last_build_id: buildId ?? null,
            last_commit_sha: commitSha ?? null,
            last_error_excerpt: excerpt,
            open_brain_task_id: taskId,
          })
          .select("id")
          .single();
        if (insErr) {
          return badRequest(`ci_failures insert failed: ${insErr.message}`, 500);
        }
        results.opened.push(newRow.id as string);
      }
    } else {
      const { error: updErr } = await supabase
        .from("ci_failures")
        .update({
          consecutive_failures: newStreak,
          last_seen: now,
          last_build_id: buildId ?? null,
          last_commit_sha: commitSha ?? null,
          last_error_excerpt: excerpt,
        })
        .eq("id", existing.id);
      if (updErr) {
        return badRequest(`ci_failures bump failed: ${updErr.message}`, 500);
      }
      if (taskId) {
        await supabase
          .from("tasks")
          .update({ description, priority })
          .eq("id", taskId);
      }
      results.updated.push(existing.id);
    }
  }

  const { data: stillOpen } = await supabase
    .from("ci_failures")
    .select("id, project, pipeline, test_name, fixture_id, consecutive_failures, open_brain_task_id, resolved_at")
    .eq("project", payload.project)
    .eq("pipeline", payload.pipeline)
    .is("resolved_at", null)
    .returns<FailureRow[]>();
  for (const row of stillOpen ?? []) {
    const key = `${row.test_name}||${row.fixture_id}`;
    if (failingKeys.has(key)) continue;
    await supabase
      .from("ci_failures")
      .update({ resolved_at: now, consecutive_failures: 0 })
      .eq("id", row.id);
    if (row.open_brain_task_id) {
      await supabase.from("tasks").update({ status: "done" }).eq("id", row.open_brain_task_id);
    }
    results.resolved.push(row.id);
  }

  return okJson(results);
});
