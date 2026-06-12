-- Migration 013: Add positions column to jobs
-- (Already applied to the live database via the Supabase SQL editor —
--  this file is the repo record so the schema history stays auditable.)
ALTER TABLE jobs ADD COLUMN positions integer NOT NULL DEFAULT 1 CHECK (positions >= 1);
