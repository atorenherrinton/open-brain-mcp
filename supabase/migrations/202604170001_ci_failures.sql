-- ci_failures: deduplicated CI test failures across projects, upserted
-- by the ci-triage Edge Function.
--
-- Dedupe key: (project, pipeline, test_name, fixture_id). A build that
-- re-fails the same test reuses the row and increments
-- consecutive_failures; a green build flips resolved_at and closes the
-- paired Open Brain task (via the tasks table in this same DB).
--
-- The `project` column resolves to the Open Brain `projects.id` via a
-- case-insensitive name match performed by the Edge Function, so the
-- paired task lands in the right project. Defaulted to `redline` so
-- the most common caller can omit it; other callers just send their
-- own value to get isolated task creation.

create table if not exists public.ci_failures (
    id                    uuid primary key default gen_random_uuid(),

    project               text not null default 'redline',

    pipeline              text not null,
    test_name             text not null,
    fixture_id            text not null default '',

    first_seen            timestamptz not null default now(),
    last_seen             timestamptz not null default now(),
    resolved_at           timestamptz,

    consecutive_failures  integer not null default 1,

    last_build_id         text,
    last_commit_sha       text,
    last_error_excerpt    text,

    open_brain_task_id    uuid,

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create unique index if not exists ci_failures_dedupe_key
    on public.ci_failures (project, pipeline, test_name, fixture_id);

create index if not exists ci_failures_open
    on public.ci_failures (project, resolved_at)
    where resolved_at is null;

create index if not exists ci_failures_last_seen
    on public.ci_failures (last_seen desc);

-- Reuse set_updated_at() if it already exists from an earlier migration
-- (e.g. tasks, task_notes, projects). If not, create it here.
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end
$$;

create trigger ci_failures_set_updated_at
    before update on public.ci_failures
    for each row execute function public.set_updated_at();

-- Lock the table down at the RLS boundary. All reads/writes go through
-- the service role (used by the Edge Function). No anon or authenticated
-- access.
alter table public.ci_failures enable row level security;

comment on table public.ci_failures is
    'Deduplicated CI test failures, keyed on (project, pipeline, test_name, fixture_id). Upserted by the ci-triage Edge Function. A row with resolved_at IS NULL is an active regression.';
