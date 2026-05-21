-- Migration 010: AI match results cache
-- Date: 2026-05-21
-- Caches Claude's ranked output for a normalized query for 9 hours.
-- cache_key = normalized query (anon/free share a global cache);
-- subscribers get per-user cache via user_id in the key.

CREATE TABLE IF NOT EXISTS ai_match_cache (
  cache_key   text PRIMARY KEY,             -- normalized query (+ optional :user_id suffix for subscribers)
  query       text NOT NULL,                -- original query for reference
  result      jsonb NOT NULL,               -- array of { candidate_id, match_percent, why }
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL          -- created_at + 9 hours
);

-- Index for expiry cleanup
CREATE INDEX IF NOT EXISTS ai_match_cache_expires_idx
  ON ai_match_cache (expires_at);

-- RLS: service-role only
ALTER TABLE ai_match_cache ENABLE ROW LEVEL SECURITY;
