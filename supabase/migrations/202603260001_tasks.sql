create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  status text not null default 'todo',
  priority text not null default 'medium',
  due_date date,
  embedding extensions.vector(1536),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists tasks_status_idx
  on public.tasks (status);

create index if not exists tasks_priority_idx
  on public.tasks (priority);

create index if not exists tasks_due_date_idx
  on public.tasks (due_date);

create index if not exists tasks_created_at_idx
  on public.tasks (created_at desc);

create index if not exists tasks_embedding_hnsw_idx
  on public.tasks using hnsw (embedding extensions.vector_cosine_ops);

drop trigger if exists tasks_updated_at on public.tasks;
create trigger tasks_updated_at
  before update on public.tasks
  for each row
  execute function public.update_updated_at();

-- Semantic search over tasks
create or replace function public.match_tasks(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.7,
  match_count int default 10
)
returns table (
  id uuid,
  title text,
  description text,
  status text,
  priority text,
  due_date date,
  similarity float,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
set search_path = public, extensions
as $$
begin
  return query
  select
    t.id,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.due_date,
    (1 - (t.embedding <=> query_embedding))::float as similarity,
    t.created_at,
    t.updated_at
  from public.tasks t
  where t.embedding is not null
    and 1 - (t.embedding <=> query_embedding) > match_threshold
  order by t.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
end;
$$;
