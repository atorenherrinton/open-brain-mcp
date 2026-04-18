-- webhook_secrets: simple key-value store for webhook Bearer tokens
-- that Edge Functions read on each invocation. Using a table instead of
-- Supabase Edge Function env-var secrets lets tokens be seeded and
-- rotated entirely via SQL (no dashboard UI step required), which means
-- the Supabase MCP can fully manage rotation on its own.
--
-- The token never flows through Postgres query results to any client:
-- RLS is enabled with no policies, so nothing except the service role
-- (which bypasses RLS by design) can read rows. The Edge Function uses
-- the service role; clients using the anon or authenticated roles see
-- nothing.
--
-- To seed after this migration applies, run:
--
--   update public.webhook_secrets
--      set value = '<real-token>', updated_at = now()
--    where name = 'ci_triage_webhook_key';
--
-- and keep the same value in GCP Secret Manager at
-- rl-ci-triage-webhook-key so the Cloud Build caller's header matches.

create table if not exists public.webhook_secrets (
    name        text primary key,
    value       text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

alter table public.webhook_secrets enable row level security;

-- Seed the ci-triage bearer token with a placeholder. The real token is
-- set out-of-band via SQL to avoid committing secrets to this repo.
insert into public.webhook_secrets (name, value)
values ('ci_triage_webhook_key', '<seed-via-sql-after-migration>')
on conflict (name) do nothing;

comment on table public.webhook_secrets is
    'Bearer tokens for webhook Edge Functions. Readable only by service role (RLS enabled with no policies). Insert/update via SQL; never expose to client SDKs.';
