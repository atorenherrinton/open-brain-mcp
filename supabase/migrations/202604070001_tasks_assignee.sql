-- Add assignee + working_dir to tasks for AI task routing

alter table public.tasks
  add column if not exists assignee text not null default 'human'
  check (assignee in ('human', 'ai'));

alter table public.tasks
  add column if not exists working_dir text;

-- Partial index to make the AI-task polling/webhook query free
create index if not exists tasks_ai_todo_idx
  on public.tasks (created_at)
  where assignee = 'ai' and status = 'todo';
