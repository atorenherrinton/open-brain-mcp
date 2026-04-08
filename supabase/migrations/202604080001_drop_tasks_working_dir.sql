-- Drop working_dir from tasks. The daily dispatcher infers the right
-- repo from task content (or skips if ambiguous), so storing a path on
-- every task was just adding friction.

alter table public.tasks
  drop column if exists working_dir;
