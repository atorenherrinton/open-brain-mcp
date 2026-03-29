-- Remove embedding from projects table
drop function if exists public.match_projects(extensions.vector(1536), float, int);

drop index if exists public.projects_embedding_hnsw_idx;

alter table public.projects drop column if exists embedding;
