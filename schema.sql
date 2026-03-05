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

-- ─── Ancestry Tables ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS ancestors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  gedcom_xref TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  given_name TEXT,
  surname TEXT,
  sex CHAR(1),
  birth_date TEXT,
  birth_place TEXT,
  death_date TEXT,
  death_place TEXT,
  burial_place TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ancestor_relationships (
  parent_id UUID REFERENCES ancestors(id) ON DELETE CASCADE,
  child_id UUID REFERENCES ancestors(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS ancestors_name_trgm_idx
  ON ancestors USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ancestors_surname_idx
  ON ancestors (surname);

CREATE INDEX IF NOT EXISTS ancestors_gedcom_xref_idx
  ON ancestors (gedcom_xref);

-- Recursive function: trace lineage upward from a person
CREATE OR REPLACE FUNCTION trace_lineage(
  start_id UUID,
  max_generations INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  given_name TEXT,
  surname TEXT,
  sex CHAR(1),
  birth_date TEXT,
  birth_place TEXT,
  death_date TEXT,
  death_place TEXT,
  generation INT
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE lineage AS (
    SELECT
      a.id, a.name, a.given_name, a.surname, a.sex,
      a.birth_date, a.birth_place, a.death_date, a.death_place,
      0 AS generation
    FROM ancestors a
    WHERE a.id = start_id

    UNION ALL

    SELECT
      a.id, a.name, a.given_name, a.surname, a.sex,
      a.birth_date, a.birth_place, a.death_date, a.death_place,
      l.generation + 1
    FROM ancestors a
    JOIN ancestor_relationships r ON r.parent_id = a.id
    JOIN lineage l ON l.id = r.child_id
    WHERE l.generation < max_generations
  )
  SELECT * FROM lineage ORDER BY generation, name;
$$;
