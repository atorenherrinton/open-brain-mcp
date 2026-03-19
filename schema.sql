CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS thoughts_embedding_hnsw_idx
  ON thoughts USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS thoughts_metadata_gin_idx
  ON thoughts USING gin (metadata);

CREATE INDEX IF NOT EXISTS thoughts_created_at_desc_idx
  ON thoughts (created_at DESC);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS thoughts_updated_at ON thoughts;
CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ─── Personal Info ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS personal_info (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS personal_info_key_idx
  ON personal_info (key);

CREATE INDEX IF NOT EXISTS personal_info_category_idx
  ON personal_info (category);

CREATE INDEX IF NOT EXISTS personal_info_embedding_hnsw_idx
  ON personal_info USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION match_personal_info(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  key TEXT,
  value TEXT,
  category TEXT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pi.id,
    pi.key,
    pi.value,
    pi.category,
    (1 - (pi.embedding <=> query_embedding))::FLOAT AS similarity,
    pi.created_at
  FROM personal_info pi
  WHERE pi.embedding IS NOT NULL
    AND 1 - (pi.embedding <=> query_embedding) > match_threshold
  ORDER BY pi.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

DROP TRIGGER IF EXISTS personal_info_updated_at ON personal_info;
CREATE TRIGGER personal_info_updated_at
  BEFORE UPDATE ON personal_info
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ─── Cross-Reference Functions ───────────────────────────

CREATE OR REPLACE FUNCTION match_thoughts_by_personal_info(
  p_key TEXT,
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  pi_embedding vector(1536);
BEGIN
  SELECT pi.embedding INTO pi_embedding
  FROM personal_info pi
  WHERE pi.key = p_key AND pi.embedding IS NOT NULL;

  IF pi_embedding IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> pi_embedding))::FLOAT AS similarity,
    t.created_at
  FROM thoughts t
  WHERE t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> pi_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> pi_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION match_personal_info_by_thought(
  p_thought_id UUID,
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  key TEXT,
  value TEXT,
  category TEXT,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  t_embedding vector(1536);
BEGIN
  SELECT t.embedding INTO t_embedding
  FROM thoughts t
  WHERE t.id = p_thought_id AND t.embedding IS NOT NULL;

  IF t_embedding IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    pi.id,
    pi.key,
    pi.value,
    pi.category,
    (1 - (pi.embedding <=> t_embedding))::FLOAT AS similarity,
    pi.created_at
  FROM personal_info pi
  WHERE pi.embedding IS NOT NULL
    AND 1 - (pi.embedding <=> t_embedding) > match_threshold
  ORDER BY pi.embedding <=> t_embedding
  LIMIT match_count;
END;
$$;

