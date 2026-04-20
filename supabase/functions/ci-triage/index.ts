// CI Triage webhook — ingests per-build failure reports from any CI
// system (today: Google Cloud Build) and opens/updates/closes GitHub
// issues on the target repo to match reality.
//
// Security: this function runs with verify_jwt=false so Cloud Build can
// POST with a static credential. Auth checks a Bearer token against the
// `CI_TRIAGE_WEBHOOK_SECRET` Edge Function env var. The GitHub REST API
// call uses `CI_TRIAGE_GITHUB_TOKEN`. Target repo comes from
// `CI_TRIAGE_GITHUB_REPO` (e.g. `atorenherrinton/redline`).

const MAX_EXCERPT_CHARS = 8 * 1024;
const CI_LABEL = "ci-failure";
const GITHUB_API = "https://api.github.com";

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

type GithubIssue = {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
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

function issueTitle(pipeline: string, testName: string, fixtureId: string): string {
  return `[CI] ${pipeline}: ${testName}${fixtureId ? "/" + fixtureId : ""} failing`;
}

function issueBody(
  pipeline: string,
  testName: string,
  fixtureId: string,
  buildId: string | undefined,
  commitSha: string | undefined,
  buildLogUrl: string | undefined,
  errorExcerpt: string,
): string {
  const fixtureLine = fixtureId ? `Fixture: \`${fixtureId}\`` : "";
  const reproduceCmd = fixtureId
    ? `go test -run '${testName}/${fixtureId}' -v ./...`
    : `go test -run '${testName}' -v ./...`;

  return [
    `Pipeline: \`${pipeline}\``,
    `Test: \`${testName}\``,
    fixtureLine,
    "",
    commitSha ? `First failing commit: \`${commitSha}\`` : "",
    buildId ? `First failing build: \`${buildId}\`` : "",
    buildLogUrl ? `Build log: ${buildLogUrl}` : "",
    "",
    "**Reproduce locally:**",
    "```",
    reproduceCmd,
    "```",
    "",
    "**Failure excerpt:**",
    "```",
    errorExcerpt,
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function commentBody(
  buildId: string | undefined,
  commitSha: string | undefined,
  buildLogUrl: string | undefined,
  errorExcerpt: string,
): string {
  return [
    "Still failing.",
    "",
    commitSha ? `Commit: \`${commitSha}\`` : "",
    buildId ? `Build: \`${buildId}\`` : "",
    buildLogUrl ? `Build log: ${buildLogUrl}` : "",
    "",
    "**Latest excerpt:**",
    "```",
    errorExcerpt,
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function github(path: string, token: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function findOpenIssue(
  repo: string,
  token: string,
  title: string,
): Promise<GithubIssue | null> {
  // GitHub's issue search doesn't match title exactly, so list and filter.
  // All CI-opened issues carry the ci-failure label; listing them is cheap.
  const res = await github(
    `/repos/${repo}/issues?state=open&labels=${CI_LABEL}&per_page=100`,
    token,
  );
  if (!res.ok) {
    throw new Error(`github list issues: ${res.status} ${await res.text()}`);
  }
  const issues = (await res.json()) as GithubIssue[];
  return issues.find((i) => i.title === title) ?? null;
}

async function listOpenCiIssues(repo: string, token: string): Promise<GithubIssue[]> {
  const res = await github(
    `/repos/${repo}/issues?state=open&labels=${CI_LABEL}&per_page=100`,
    token,
  );
  if (!res.ok) {
    throw new Error(`github list issues: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as GithubIssue[];
}

async function createIssue(
  repo: string,
  token: string,
  title: string,
  body: string,
): Promise<number> {
  const res = await github(`/repos/${repo}/issues`, token, {
    method: "POST",
    body: JSON.stringify({ title, body, labels: [CI_LABEL] }),
  });
  if (!res.ok) {
    throw new Error(`github create issue: ${res.status} ${await res.text()}`);
  }
  const issue = (await res.json()) as { number: number };
  return issue.number;
}

async function commentIssue(
  repo: string,
  token: string,
  number: number,
  body: string,
): Promise<void> {
  const res = await github(`/repos/${repo}/issues/${number}/comments`, token, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`github comment: ${res.status} ${await res.text()}`);
  }
}

async function closeIssue(
  repo: string,
  token: string,
  number: number,
  comment: string,
): Promise<void> {
  await commentIssue(repo, token, number, comment);
  const res = await github(`/repos/${repo}/issues/${number}`, token, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
  if (!res.ok) {
    throw new Error(`github close: ${res.status} ${await res.text()}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    return await handle(req);
  } catch (err) {
    console.error("ci-triage handler error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return badRequest("method not allowed", 405);
  }

  const webhookSecret = Deno.env.get("CI_TRIAGE_WEBHOOK_SECRET");
  const githubToken = Deno.env.get("CI_TRIAGE_GITHUB_TOKEN");
  const githubRepo = Deno.env.get("CI_TRIAGE_GITHUB_REPO");
  if (!webhookSecret || !githubToken || !githubRepo) {
    return badRequest("server misconfigured", 500);
  }

  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${webhookSecret}`) {
    return badRequest("unauthorized", 401);
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return badRequest("invalid json");
  }

  if (!payload.pipeline || !payload.outcome) {
    return badRequest("missing required fields: pipeline, outcome");
  }
  if (payload.outcome !== "success" && payload.outcome !== "failure") {
    return badRequest("outcome must be 'success' or 'failure'");
  }
  if (payload.outcome === "failure" && (!payload.failures || payload.failures.length === 0)) {
    return badRequest("outcome=failure requires non-empty failures array");
  }

  const buildId = payload.build_id;
  const commitSha = payload.commit_sha;
  const buildLogUrl = payload.build_log_url;

  const results = {
    opened: [] as number[],
    updated: [] as number[],
    closed: [] as number[],
  };

  const expectedTitles = new Set<string>();
  for (const failure of payload.failures ?? []) {
    const fxId = failure.fixture_id ?? "";
    expectedTitles.add(issueTitle(payload.pipeline, failure.test_name, fxId));
  }

  for (const failure of payload.failures ?? []) {
    const testName = failure.test_name;
    const fixtureId = failure.fixture_id ?? "";
    const excerpt = cap(failure.error_excerpt ?? "", MAX_EXCERPT_CHARS);
    const title = issueTitle(payload.pipeline, testName, fixtureId);

    const existing = await findOpenIssue(githubRepo, githubToken, title);
    if (existing) {
      await commentIssue(
        githubRepo,
        githubToken,
        existing.number,
        commentBody(buildId, commitSha, buildLogUrl, excerpt),
      );
      results.updated.push(existing.number);
    } else {
      const number = await createIssue(
        githubRepo,
        githubToken,
        title,
        issueBody(payload.pipeline, testName, fixtureId, buildId, commitSha, buildLogUrl, excerpt),
      );
      results.opened.push(number);
    }
  }

  // Close any previously-open issues for this pipeline that aren't in the
  // current failure set. On outcome=success that's everything; on
  // outcome=failure that's whatever stopped failing.
  const openIssues = await listOpenCiIssues(githubRepo, githubToken);
  const pipelinePrefix = `[CI] ${payload.pipeline}:`;
  for (const issue of openIssues) {
    if (!issue.title.startsWith(pipelinePrefix)) continue;
    if (expectedTitles.has(issue.title)) continue;
    await closeIssue(
      githubRepo,
      githubToken,
      issue.number,
      `Resolved — pipeline \`${payload.pipeline}\` went green${commitSha ? ` at \`${commitSha}\`` : ""}.`,
    );
    results.closed.push(issue.number);
  }

  return okJson(results);
}
