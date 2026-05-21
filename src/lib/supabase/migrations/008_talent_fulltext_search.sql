-- Migration 008: full-text search vector for AI Matching Stage 1 pre-filter
-- Date: 2026-05-21
-- Trigger-maintained tsvector column over key searchable fields + GIN index.
-- NOTE: We use a trigger (not a GENERATED column) because to_tsvector is not
-- immutable, which Postgres rejects in GENERATED ALWAYS expressions.
-- Used by AI Matching pre-filter to narrow 50K+ profiles to ~40 candidates.

-- 1. Plain tsvector column
ALTER TABLE talent_profiles
  ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- 2. Function that builds the vector from the row
CREATE OR REPLACE FUNCTION talent_profiles_build_search_vector()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.job_title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.role_category, '')), 'A') ||
    setweight(to_tsvector('english', array_to_string(coalesce(NEW.skills, ARRAY[]::text[]), ' ')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.city, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.country, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Trigger on insert/update
DROP TRIGGER IF EXISTS talent_profiles_search_vector_trigger ON talent_profiles;
CREATE TRIGGER talent_profiles_search_vector_trigger
  BEFORE INSERT OR UPDATE ON talent_profiles
  FOR EACH ROW
  EXECUTE FUNCTION talent_profiles_build_search_vector();

-- 4. Backfill existing rows
UPDATE talent_profiles SET search_vector = search_vector;

-- 5. GIN index
CREATE INDEX IF NOT EXISTS talent_profiles_search_vector_idx
  ON talent_profiles USING gin (search_vector);
