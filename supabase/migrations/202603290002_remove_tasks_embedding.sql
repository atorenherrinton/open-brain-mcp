-- Remove embedding from tasks table
drop function if exists public.match_tasks(extensions.vector(1536), float, int);

drop index if exists public.tasks_embedding_hnsw_idx;

alter table public.tasks drop column if exists embedding;
