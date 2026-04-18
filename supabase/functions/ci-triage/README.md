# ci-triage Edge Function

Supabase Edge Function that ingests CI failure reports from any CI
system (today: Cloud Build via `redline/infra/ci/cloudbuild-triage-integration.yaml`)
and maintains:

- `public.ci_failures` — deduplicated failure rows keyed on
  `(project, pipeline, test_name, fixture_id)`.
- `public.tasks` — one Open Brain task per distinct regression,
  auto-created on the first failure and auto-closed on the first
  subsequent success.

The function is intentionally project-agnostic: callers identify
themselves via the `project` field of the payload (case-insensitive
match against `projects.name`). Any repo with its own Open Brain
project can send failures here without modifying this function.

## Deployed at

`https://dqjrajbxhnbstbloqxbl.supabase.co/functions/v1/ci-triage`
(project: `open-brain-mcp`)

## Deploy

This is the canonical source (redline carries a mirror under
`infra/supabase/functions/ci-triage/` for audit history; that mirror
tracks this one, not the other way around). When updating, redeploy
via the Supabase CLI:

```bash
supabase functions deploy ci-triage \
  --project-ref dqjrajbxhnbstbloqxbl \
  --no-verify-jwt
```

`--no-verify-jwt` is required — the function does its own Bearer token
check against a Postgres-stored secret. Do not flip that on.

## Bearer token storage

The function reads the expected Bearer token from
`public.webhook_secrets` where `name = 'ci_triage_webhook_key'`. Storing
the token in Postgres (RLS on, no policies — only the service role can
read it) means the token can be seeded and rotated entirely via SQL:

```sql
update public.webhook_secrets
   set value = '<new-token>', updated_at = now()
 where name = 'ci_triage_webhook_key';
```

Callers keep their copy of the same token in their own secret store
(redline stores it in GCP Secret Manager as `rl-ci-triage-webhook-key`
and sends it via Cloud Build `availableSecrets`). Both sides must match
or the webhook returns 401.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by
Supabase — no additional env vars to configure.

## Payload

```json
{
  "project":       "redline",              // required; must match projects.name case-insensitive
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

## Schema reference

- `public.ci_failures` — migration `202604170001_ci_failures.sql`.
- `public.webhook_secrets` — migration `202604170002_webhook_secrets.sql`.
