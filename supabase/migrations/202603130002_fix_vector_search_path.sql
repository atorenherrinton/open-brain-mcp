-- Fix match_thoughts and insert_thought to include the extensions schema
-- in their search_path so the pgvector <=> operator can be resolved when
-- the vector extension lives in the extensions schema.

create or replace function public.match_thoughts(
  query_embedding extensions.vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
set search_path = public, extensions
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> query_embedding))::float as similarity,
    t.created_at
  from public.thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (coalesce(filter, '{}'::jsonb) = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
end;
$$;

create or replace function public.insert_thought(
  p_content text,
  p_embedding extensions.vector(1536),
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  created_at timestamptz
)
language sql
set search_path = public, extensions
as $$
  insert into public.thoughts (content, embedding, metadata)
  values (p_content, p_embedding, coalesce(p_metadata, '{}'::jsonb))
  returning thoughts.id, thoughts.created_at;
$$;
