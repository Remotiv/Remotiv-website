-- Migration 009: AI search log for rate limiting
-- Date: 2026-05-21
-- Tracks each AI Matching search to enforce 3/day for anonymous (by IP)
-- and free (by user_id) tiers. Subscribers are unlimited (not checked).

CREATE TABLE IF NOT EXISTS ai_search_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,  -- null for anonymous
  ip_address  text,                                              -- null for logged-in (we use user_id)
  query       text NOT NULL,
  searched_at timestamptz NOT NULL DEFAULT now()
);

-- Index for counting today's searches by user
CREATE INDEX IF NOT EXISTS ai_search_log_user_day_idx
  ON ai_search_log (user_id, searched_at DESC)
  WHERE user_id IS NOT NULL;

-- Index for counting today's searches by IP (anonymous)
CREATE INDEX IF NOT EXISTS ai_search_log_ip_day_idx
  ON ai_search_log (ip_address, searched_at DESC)
  WHERE ip_address IS NOT NULL;

-- RLS: service-role only (the API route uses service role; no client access)
ALTER TABLE ai_search_log ENABLE ROW LEVEL SECURITY;
-- No policies = no authenticated/anon access; only service role bypasses RLS.
