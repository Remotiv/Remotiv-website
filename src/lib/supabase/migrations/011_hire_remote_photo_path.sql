-- Migration 011: photo_path column on hire_remote_profiles
-- Date: 2026-05-26
-- Purpose: Mirror cv_path (added in 004) so applicant photos can be re-signed
--   via Supabase storage. The cvs bucket is private; the previous
--   getPublicUrl() result stored in photo_url is non-functional. Going forward
--   the API writes photo_path and the admin list query signs a fresh 1-hour
--   URL at read time. No backfill: existing rows have a broken photo_url and
--   the admin dashboard already falls back to initials when photo_url 401s.
-- Safe to re-run (IF NOT EXISTS guard).

alter table public.hire_remote_profiles
  add column if not exists photo_path text;

comment on column public.hire_remote_profiles.photo_path is
  'Bucket-relative path inside the cvs bucket for the applicant photo. Mirror of cv_path (migration 004). photo_url is now a transient signed URL minted at read time and should not be relied on as a stored value.';
