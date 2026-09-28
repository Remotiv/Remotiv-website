-- ============================================================================
-- Migration 025 — hash talent_claim_tokens.token_hash at rest
-- ----------------------------------------------------------------------------
-- talent_claim_tokens.token_hash has held the RAW token since the table was
-- created; the column name described an intention, not the data. Every other
-- token in this codebase is sha256 at rest (interview sessions, bookings,
-- company invites, retention keep-links). This migration brings the fifth into
-- line: the application now writes and compares sha256 digests (see
-- src/lib/claim-tokens.ts), and this file hashes the rows that were written
-- before it did.
--
-- Run by hand in the Supabase SQL editor, like the files before it. Nothing in
-- the repository executes it. (There is no 024; the number is for the record.)
--
-- ── ORDER OF OPERATIONS: DEPLOY THE CODE FIRST, THEN RUN THIS ───────────────
--
-- The code change and this backfill are two halves of one migration, and the
-- gap between them is a real window with a real cost:
--
--   1. Code deployed, backfill not yet run.
--      New tokens are minted hashed and work. A token minted BEFORE the deploy
--      is stored raw; the new code hashes whatever it is handed and looks the
--      digest up, so that legacy raw token DOES NOT MATCH until step 2 below
--      has hashed its row. Presented in this window, it fails as "not found".
--
--   2. Step 2 run.
--      Legacy rows now hold digests; the same token matches again.
--
-- Run step 2 as soon as the deploy is live. The live population when this was
-- written was 239 unexpired tokens, ALL of them post-apply "bridge" tokens
-- that were returned to the applicant's browser tab and never emailed. A
-- candidate who still has that tab open during the window sees the profile
-- form fall back to blank (join-as-talent handles a pre-fill failure by
-- degrading, not erroring); nobody loses an application. No admin invite link
-- was live. The reverse order — backfill first — would make EVERY lookup fail
-- until the deploy, and would leave any token minted by the old code in that
-- gap raw forever. Deploy first.
--
-- ── WHY STEP 2 IS SAFE TO RUN TWICE ──────────────────────────────────────────
--
-- A legacy raw token is 64 hexadecimal characters (two UUIDv4s, hyphens
-- stripped). sha256 in HEX is also 64 hexadecimal characters. Had the code
-- chosen hex digests, a hashed row would be indistinguishable from an unhashed
-- one, and a second run of the UPDATE would hash the digests again — silently,
-- with no error and no warning — and every token in the table would stop
-- working. That trap is why the digest is stored as base64url: 43 characters
-- drawn from [A-Za-z0-9_-], which can never match ^[0-9a-f]{64}$. Step 2 hashes
-- only rows that still look like raw legacy tokens. Rows the new code wrote,
-- and rows this step has already hashed, do not match the predicate, so a
-- second run updates zero rows. Step 3 shows you the count either way.
--
-- pgcrypto is required for digest(); Supabase ships it enabled. If step 2
-- fails with "function digest does not exist", run:
--   create extension if not exists pgcrypto;
-- and retry.
-- ============================================================================

-- 0. Look first. Expect: every token_hash is 64 hex (raw), none is 43 base64url,
--    and a few hundred pending/opened rows are past their expiry but unmarked.
select status,
       count(*)                                                        as rows,
       count(*) filter (where token_hash ~ '^[0-9a-f]{64}$')            as raw_hex64,
       count(*) filter (where token_hash ~ '^[A-Za-z0-9_-]{43}$')       as hashed_b64url,
       count(*) filter (where status in ('pending','opened')
                          and expires_at <= now())                     as stale_unmarked
  from public.talent_claim_tokens
 group by status
 order by status;

begin;

-- 1. Retire tokens that expired without ever being marked. The readers already
--    treat expires_at as authoritative, so this changes no behaviour; it makes
--    the status column tell the truth and shrinks the "live" set to what is
--    actually live.
update public.talent_claim_tokens
   set status = 'expired'
 where status in ('pending', 'opened')
   and expires_at <= now();

-- 2. Hash every stored raw token in place, as base64url(sha256(raw)) — the
--    exact encoding src/lib/claim-tokens.ts#hashClaimToken produces.
--    Postgres' encode(…, 'base64') is standard base64 with padding; the
--    translate/rtrim turn it into the unpadded url-safe alphabet Node emits.
--    Guarded by the predicate explained in the header: raw rows only.
--    Distinct inputs give distinct digests, so the UNIQUE constraint on
--    token_hash (talent_claim_tokens_token_hash_key) is preserved.
update public.talent_claim_tokens
   set token_hash = translate(
         rtrim(encode(digest(token_hash, 'sha256'), 'base64'), '='),
         '+/', '-_')
 where token_hash ~ '^[0-9a-f]{64}$';

commit;

-- 3. Confirm. Expect raw_hex64 = 0, hashed_b64url = every row, stale_unmarked = 0.
--    If raw_hex64 is not 0, step 2 did not reach some rows — re-running it is
--    safe and will pick up exactly those.
select count(*)                                                        as rows,
       count(*) filter (where token_hash ~ '^[0-9a-f]{64}$')            as raw_hex64,
       count(*) filter (where token_hash ~ '^[A-Za-z0-9_-]{43}$')       as hashed_b64url,
       count(*) filter (where status in ('pending','opened')
                          and expires_at <= now())                     as stale_unmarked
  from public.talent_claim_tokens;
