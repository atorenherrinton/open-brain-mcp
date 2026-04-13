-- Backfill existing thoughts to normalize topic tags to lowercase.
-- New thoughts are already normalized via normalizeTopicTags() in the
-- capture_thought handler, but historical data may have mixed casing
-- (e.g. "Career Development" vs "career development").
--
-- This migration lowercases all topic values and deduplicates within
-- each thought's topic array.

UPDATE thoughts
SET metadata = jsonb_set(
  metadata,
  '{topics}',
  (
    SELECT COALESCE(
      jsonb_agg(DISTINCT lower(elem #>> '{}'))
      FILTER (WHERE (elem #>> '{}') IS NOT NULL AND (elem #>> '{}') != ''),
      '[]'::jsonb
    )
    FROM jsonb_array_elements(metadata -> 'topics') AS elem
  )
)
WHERE metadata ? 'topics'
  AND jsonb_typeof(metadata -> 'topics') = 'array'
  AND jsonb_array_length(metadata -> 'topics') > 0;
