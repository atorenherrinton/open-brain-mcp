create table if not exists public.personal_info (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text not null,
  category text not null default 'general',
  embedding extensions.vector(1536),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists personal_info_key_idx
  on public.personal_info (key);

create index if not exists personal_info_category_idx
  on public.personal_info (category);

create index if not exists personal_info_embedding_hnsw_idx
  on public.personal_info using hnsw (embedding extensions.vector_cosine_ops);

drop trigger if exists personal_info_updated_at on public.personal_info;
create trigger personal_info_updated_at
  before update on public.personal_info
  for each row
  execute function public.update_updated_at();

-- Upsert personal info (insert or update)
create or replace function public.upsert_personal_info(
  p_key text,
  p_value text,
  p_category text default 'general',
  p_embedding extensions.vector(1536) default null
)
returns table (
  id uuid,
  key text,
  value text,
  category text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
set search_path = public, extensions
as $$
  insert into public.personal_info (key, value, category, embedding)
  values (p_key, p_value, coalesce(p_category, 'general'), p_embedding)
  on conflict (key) do update
    set value = excluded.value,
        category = coalesce(excluded.category, personal_info.category),
        embedding = coalesce(excluded.embedding, personal_info.embedding)
  returning personal_info.id, personal_info.key, personal_info.value,
            personal_info.category, personal_info.created_at, personal_info.updated_at;
$$;

-- Semantic search over personal info
create or replace function public.match_personal_info(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.7,
  match_count int default 10
)
returns table (
  id uuid,
  key text,
  value text,
  category text,
  similarity float,
  created_at timestamptz
)
language plpgsql
set search_path = public, extensions
as $$
begin
  return query
  select
    pi.id,
    pi.key,
    pi.value,
    pi.category,
    (1 - (pi.embedding <=> query_embedding))::float as similarity,
    pi.created_at
  from public.personal_info pi
  where pi.embedding is not null
    and 1 - (pi.embedding <=> query_embedding) > match_threshold
  order by pi.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
end;
$$;

-- Get a single personal info entry by key
create or replace function public.get_personal_info(
  p_key text
)
returns table (
  id uuid,
  key text,
  value text,
  category text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select pi.id, pi.key, pi.value, pi.category, pi.created_at, pi.updated_at
  from public.personal_info pi
  where pi.key = p_key;
$$;

-- List all personal info, optionally filtered by category
create or replace function public.list_personal_info(
  p_category text default null
)
returns table (
  id uuid,
  key text,
  value text,
  category text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select pi.id, pi.key, pi.value, pi.category, pi.created_at, pi.updated_at
  from public.personal_info pi
  where (p_category is null or pi.category = p_category)
  order by pi.category, pi.key;
$$;

-- Delete a personal info entry by key
create or replace function public.delete_personal_info(
  p_key text
)
returns boolean
language sql
set search_path = public
as $$
  delete from public.personal_info where key = p_key
  returning true;
$$;
