-- Remove embedding from task_notes table
drop function if exists public.match_task_notes(extensions.vector(1536), float, int, uuid);

drop index if exists public.task_notes_embedding_hnsw_idx;

alter table public.task_notes drop column if exists embedding;
