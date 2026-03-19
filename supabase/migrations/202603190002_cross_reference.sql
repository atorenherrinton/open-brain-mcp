-- Match thoughts using a personal_info row's embedding
create or replace function public.match_thoughts_by_personal_info(
  p_key text,
  match_threshold float default 0.3,
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
declare
  pi_embedding extensions.vector(1536);
begin
  select pi.embedding into pi_embedding
  from public.personal_info pi
  where pi.key = p_key and pi.embedding is not null;

  if pi_embedding is null then
    return;
  end if;

  return query
  select
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> pi_embedding))::float as similarity,
    t.created_at
  from public.thoughts t
  where t.embedding is not null
    and 1 - (t.embedding <=> pi_embedding) > match_threshold
    and (coalesce(filter, '{}'::jsonb) = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> pi_embedding
  limit greatest(coalesce(match_count, 10), 1);
end;
$$;

-- Match personal_info using a thought row's embedding
create or replace function public.match_personal_info_by_thought(
  p_thought_id uuid,
  match_threshold float default 0.3,
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
declare
  t_embedding extensions.vector(1536);
begin
  select t.embedding into t_embedding
  from public.thoughts t
  where t.id = p_thought_id and t.embedding is not null;

  if t_embedding is null then
    return;
  end if;

  return query
  select
    pi.id,
    pi.key,
    pi.value,
    pi.category,
    (1 - (pi.embedding <=> t_embedding))::float as similarity,
    pi.created_at
  from public.personal_info pi
  where pi.embedding is not null
    and 1 - (pi.embedding <=> t_embedding) > match_threshold
  order by pi.embedding <=> t_embedding
  limit greatest(coalesce(match_count, 10), 1);
end;
$$;
