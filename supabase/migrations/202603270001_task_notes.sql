-- Task notes / deliverables table
create table if not exists public.task_notes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  content text not null,
  type text not null default 'note',
  embedding extensions.vector(1536),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists task_notes_task_id_idx
  on public.task_notes (task_id);

create index if not exists task_notes_type_idx
  on public.task_notes (type);

create index if not exists task_notes_created_at_idx
  on public.task_notes (created_at desc);

create index if not exists task_notes_embedding_hnsw_idx
  on public.task_notes using hnsw (embedding extensions.vector_cosine_ops);

drop trigger if exists task_notes_updated_at on public.task_notes;
create trigger task_notes_updated_at
  before update on public.task_notes
  for each row
  execute function public.update_updated_at();

-- Semantic search over task notes
create or replace function public.match_task_notes(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  p_task_id uuid default null
)
returns table (
  id uuid,
  task_id uuid,
  content text,
  type text,
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
    tn.id,
    tn.task_id,
    tn.content,
    tn.type,
    (1 - (tn.embedding <=> query_embedding))::float as similarity,
    tn.created_at,
    tn.updated_at
  from public.task_notes tn
  where tn.embedding is not null
    and 1 - (tn.embedding <=> query_embedding) > match_threshold
    and (p_task_id is null or tn.task_id = p_task_id)
  order by tn.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
end;
$$;
