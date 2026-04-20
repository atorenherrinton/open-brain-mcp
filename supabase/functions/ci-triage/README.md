# ci-triage Edge Function

Supabase Edge Function that ingests CI failure reports from any CI
system (today: Cloud Build via `redline/infra/ci/cloudbuild-triage-integration.yaml`)
and opens/updates/closes GitHub issues on the target repo to match reality:

- **First failure for a (pipeline, test, fixture)** → opens a new issue
  on the target repo with label `ci-failure` and a body containing the
  failing commit, build log, reproduce command, and error excerpt.
- **Subsequent failures of the same (pipeline, test, fixture)** → posts
  a comment with the latest excerpt.
- **Subsequent green build of the pipeline** → closes every open
  `ci-failure` issue for that pipeline that isn't in the current failure
  set (with a resolution comment).

## Deployed at

`https://dqjrajbxhnbstbloqxbl.supabase.co/functions/v1/ci-triage`
(project: `open-brain-mcp`)

## Deploy

```bash
supabase functions deploy ci-triage \
  --project-ref dqjrajbxhnbstbloqxbl \
  --no-verify-jwt
```

`--no-verify-jwt` is required — the function does its own Bearer token
check against `CI_TRIAGE_WEBHOOK_SECRET`. Do not flip that on.

## Required Edge Function secrets

| secret | purpose |
|---|---|
| `CI_TRIAGE_WEBHOOK_SECRET` | Shared Bearer token Cloud Build sends in `Authorization` |
| `CI_TRIAGE_GITHUB_TOKEN`   | Fine-grained GitHub PAT with `Issues: Read and write` on the target repo |
| `CI_TRIAGE_GITHUB_REPO`    | `owner/repo` for the target repo (e.g. `atorenherrinton/redline`) |

Rotate via:

```bash
supabase secrets set CI_TRIAGE_GITHUB_TOKEN=<new> --project-ref dqjrajbxhnbstbloqxbl
```

When rotating `CI_TRIAGE_WEBHOOK_SECRET`, the caller's copy must be
updated too (redline stores it in GCP Secret Manager as
`rl-ci-triage-webhook-key` and sends it via Cloud Build
`availableSecrets`).

## Payload

```json
{
  "project":       "redline",              // optional, kept for back-compat
  "pipeline":      "triage-integration",   // required
  "build_id":      "abc-123",              // optional
  "commit_sha":    "1234deadbeef",         // optional
  "build_log_url": "https://...",          // optional
  "outcome":       "success" | "failure",  // required
  "failures": [                            // required when outcome=failure
    {
      "test_name":     "TestTriageIntegration",
      "fixture_id":    "EDGE_03",          // optional; "" for whole-test pipelines
      "error_excerpt": "..."               // capped at 8 KB
    }
  ]
}
```
