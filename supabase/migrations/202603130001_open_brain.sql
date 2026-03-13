create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists thoughts_embedding_hnsw_idx
  on public.thoughts using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists thoughts_metadata_gin_idx
  on public.thoughts using gin (metadata);

create index if not exists thoughts_created_at_desc_idx
  on public.thoughts (created_at desc);

create or replace function public.update_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists thoughts_updated_at on public.thoughts;
create trigger thoughts_updated_at
  before update on public.thoughts
  for each row
  execute function public.update_updated_at();

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
set search_path = public
as $$
  insert into public.thoughts (content, embedding, metadata)
  values (p_content, p_embedding, coalesce(p_metadata, '{}'::jsonb))
  returning thoughts.id, thoughts.created_at;
$$;

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
set search_path = public
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

create or replace function public.list_thoughts(
  p_limit int default 10,
  p_type text default null,
  p_topic text default null,
  p_person text default null,
  p_days int default null
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  created_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select t.id, t.content, t.metadata, t.created_at
  from public.thoughts t
  where (p_type is null or t.metadata->>'type' = p_type)
    and (p_topic is null or coalesce(t.metadata->'topics', '[]'::jsonb) ? p_topic)
    and (p_person is null or coalesce(t.metadata->'people', '[]'::jsonb) ? p_person)
    and (p_days is null or t.created_at >= timezone('utc', now()) - make_interval(days => p_days))
  order by t.created_at desc
  limit greatest(coalesce(p_limit, 10), 1);
$$;

create or replace function public.thought_stats()
returns jsonb
language sql
stable
set search_path = public
as $$
  with summary as (
    select
      count(*)::int as total,
      min(created_at) as earliest,
      max(created_at) as latest
    from public.thoughts
  ),
  type_counts as (
    select coalesce(
      jsonb_agg(jsonb_build_object('name', name, 'count', total) order by total desc, name),
      '[]'::jsonb
    ) as data
    from (
      select metadata->>'type' as name, count(*)::int as total
      from public.thoughts
      where metadata ? 'type' and nullif(metadata->>'type', '') is not null
      group by 1
      order by total desc, name
      limit 10
    ) ranked
  ),
  topic_counts as (
    select coalesce(
      jsonb_agg(jsonb_build_object('name', name, 'count', total) order by total desc, name),
      '[]'::jsonb
    ) as data
    from (
      select topic.name, count(*)::int as total
      from public.thoughts,
      lateral jsonb_array_elements_text(coalesce(metadata->'topics', '[]'::jsonb)) as topic(name)
      group by topic.name
      order by total desc, topic.name
      limit 10
    ) ranked
  ),
  people_counts as (
    select coalesce(
      jsonb_agg(jsonb_build_object('name', name, 'count', total) order by total desc, name),
      '[]'::jsonb
    ) as data
    from (
      select person.name, count(*)::int as total
      from public.thoughts,
      lateral jsonb_array_elements_text(coalesce(metadata->'people', '[]'::jsonb)) as person(name)
      group by person.name
      order by total desc, person.name
      limit 10
    ) ranked
  )
  select jsonb_build_object(
    'total', summary.total,
    'date_range', case
      when summary.total = 0 then null
      else jsonb_build_object('earliest', summary.earliest, 'latest', summary.latest)
    end,
    'types', type_counts.data,
    'top_topics', topic_counts.data,
    'people_mentioned', people_counts.data
  )
  from summary, type_counts, topic_counts, people_counts;
$$;