-- Projects table
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  status text not null default 'active',
  embedding extensions.vector(1536),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists projects_status_idx
  on public.projects (status);

create index if not exists projects_name_idx
  on public.projects (name);

create index if not exists projects_created_at_idx
  on public.projects (created_at desc);

create index if not exists projects_embedding_hnsw_idx
  on public.projects using hnsw (embedding extensions.vector_cosine_ops);

drop trigger if exists projects_updated_at on public.projects;
create trigger projects_updated_at
  before update on public.projects
  for each row
  execute function public.update_updated_at();

-- Add project_id to tasks
alter table public.tasks
  add column if not exists project_id uuid references public.projects(id);

create index if not exists tasks_project_id_idx
  on public.tasks (project_id);

-- Semantic search over projects
create or replace function public.match_projects(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.7,
  match_count int default 10
)
returns table (
  id uuid,
  name text,
  description text,
  status text,
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
    p.id,
    p.name,
    p.description,
    p.status,
    (1 - (p.embedding <=> query_embedding))::float as similarity,
    p.created_at,
    p.updated_at
  from public.projects p
  where p.embedding is not null
    and 1 - (p.embedding <=> query_embedding) > match_threshold
  order by p.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
end;
$$;

-- Update match_tasks to include project_id
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
  project_id uuid,
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
    t.project_id,
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
