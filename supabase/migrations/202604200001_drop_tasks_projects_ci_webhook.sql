-- Drop tasks / task_notes / projects / ci_failures / webhook_secrets.
--
-- These tables and the MCP tools that managed them are being retired in
-- favor of GitHub Issues on the respective repos. Active tasks were
-- migrated to issues before this migration ran. The ci-triage Edge
-- Function has been rewritten to open issues on redline directly (auth
-- via CI_TRIAGE_WEBHOOK_SECRET env var instead of the webhook_secrets
-- row), so this migration also removes the secrets table.

-- Drop tables. FK order: ci_failures → tasks, task_notes → tasks, tasks → projects.
DROP TABLE IF EXISTS ci_failures;
DROP TABLE IF EXISTS task_notes;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS webhook_secrets;

-- Recreate the db_overview RPC without the dropped tables.
CREATE OR REPLACE FUNCTION db_overview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'thoughts', (SELECT count(*)::int FROM thoughts),
    'personal_info_by_category', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('category', category, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT category, count(*)::int AS cnt FROM personal_info GROUP BY category ORDER BY category) sub
    ),
    'duplicate_personal_info_keys', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('key', key, 'count', cnt)), '[]'::jsonb)
      FROM (SELECT key, count(*)::int AS cnt FROM personal_info GROUP BY key HAVING count(*) > 1) sub
    )
  ) INTO result;

  RETURN result;
END;
$$;
