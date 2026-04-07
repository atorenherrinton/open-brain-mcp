-- Drop the human/ai assignee distinction and make working_dir required.
-- With this change, the AI dispatcher looks at every todo task and the agent
-- itself decides whether it can do the work.

-- Backfill working_dir for existing rows so the NOT NULL constraint can land.
-- Tasks are grouped by project; each project maps to a known github checkout.
update public.tasks
  set working_dir = '/Users/atorenherrinton/Documents/GitHub/redline'
  where working_dir is null
    and project_id = 'f40909f8-f45e-4d87-80fd-f41621effc3d';

update public.tasks
  set working_dir = '/Users/atorenherrinton/Documents/GitHub/ari-tech-site'
  where working_dir is null
    and project_id = 'b617c69b-67bc-4341-8eeb-15dcb7e5dc5d';

-- Any remaining null rows (ari-personal + project-less) fall back to this
-- repo. The dispatcher's "agent can skip" path will handle non-code tasks.
update public.tasks
  set working_dir = '/Users/atorenherrinton/Documents/GitHub/open-brain-mcp'
  where working_dir is null;

-- Drop the partial index that depended on assignee, then the column itself.
drop index if exists public.tasks_ai_todo_idx;

alter table public.tasks
  drop column if exists assignee;

alter table public.tasks
  alter column working_dir set not null;

-- Replacement index for the dispatcher's "poll pending" query.
create index if not exists tasks_todo_idx
  on public.tasks (created_at)
  where status = 'todo';
