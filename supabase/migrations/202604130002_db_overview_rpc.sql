-- RPC function for db_stats tool: returns a comprehensive overview of
-- database state including counts by status/category and potential issues.

CREATE OR REPLACE FUNCTION db_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tasks_by_status', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('status', status, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT status, count(*)::int AS cnt FROM tasks GROUP BY status ORDER BY status) sub
    ),
    'thoughts', (SELECT count(*)::int FROM thoughts),
    'personal_info_by_category', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('category', category, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT category, count(*)::int AS cnt FROM personal_info GROUP BY category ORDER BY category) sub
    ),
    'projects_by_status', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('status', status, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT status, count(*)::int AS cnt FROM projects GROUP BY status ORDER BY status) sub
    ),
    'task_notes', (SELECT count(*)::int FROM task_notes),
    'stale_in_progress_tasks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'updated_at', updated_at)), '[]'::jsonb)
      FROM (
        SELECT id, title, updated_at
        FROM tasks
        WHERE status = 'in_progress' AND updated_at < now() - interval '7 days'
        ORDER BY updated_at ASC
        LIMIT 10
      ) sub
    ),
    'orphaned_task_notes', (
      SELECT count(*)::int
      FROM task_notes tn
      LEFT JOIN tasks t ON tn.task_id = t.id
      WHERE t.id IS NULL
    ),
    'duplicate_personal_info_keys', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('key', key, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT key, count(*)::int AS cnt FROM personal_info GROUP BY key HAVING count(*) > 1) sub
    )
  ) INTO result;

  RETURN result;
END;
$$;
