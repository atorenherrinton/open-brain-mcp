-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Schedule a daily job at 6 AM UTC to clean up done tasks older than 7 days.
-- Deletes associated task_notes first, then the tasks themselves.
SELECT cron.schedule(
  'cleanup-done-tasks',
  '0 6 * * *',
  $$
    DELETE FROM task_notes
    WHERE task_id IN (
      SELECT id FROM tasks
      WHERE status = 'done'
        AND updated_at < now() - interval '7 days'
    );

    DELETE FROM tasks
    WHERE status = 'done'
      AND updated_at < now() - interval '7 days';
  $$
);
