-- Add repository URL to projects
alter table public.projects
  add column if not exists repo_url text;
