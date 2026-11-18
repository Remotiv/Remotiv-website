// #94 proof on a REAL Postgres (staging only): deleting a restarted AI Video
// Interview works in ONE statement, and only in one.
//
//   node --env-file=.env.staging scripts/staging/proofs-094.mjs
//
// The unit test (interviews/delete-restart-chain.test.ts) runs on
// fake-live-db.mjs, which models the very rule it is meant to prove. This runs
// the same delete shape against the real schema and triggers.
//
// ── NOTHING PERSISTS ─────────────────────────────────────────
//
// One psql session: BEGIN, fixtures, the cases, ROLLBACK. There is no COMMIT
// anywhere in this file. If psql stops on an error the open transaction is
// discarded with the connection. Each case runs in a PL/pgSQL block with an
// exception handler, which is a savepoint: a case that unexpectedly succeeds
// raises to undo itself, so it cannot change what the next case sees. A second
// session afterwards counts the synthetic rows and must find none.
//
// Prints case names, SQLSTATEs, constraint names, row counts and ROLLED BACK.
// Never an id, a token, a connection string or an address.
//
// ── The cases ────────────────────────────────────────────────
//
//   N1  delete attempt 1 alone          -> 23503 interview_sessions_previous_attempt_fk
//   N2  delete one interviewer turn      -> 23503 interview_turns_responds_to_fk
//   P1  delete both attempts in ONE statement, as application-deletion.ts:221-226
//       sends it (id in (...) and company_id = ...) -> 2 rows; then 0 sessions,
//       0 turns and 0 live_interview_actions left for them. This also proves the
//       append-only trigger on live_interview_actions lets a CASCADED delete
//       through (it refuses only while the session still exists).
//
// ── How the synthetic chain satisfies the real rules ─────────
//
// A new application on an existing synthetic staging job (job_applications has
// no triggers), so no_first_attempt_after_restart allows its first live
// attempt. Attempt 1 is live, started, live_settings '{}', with a future
// delete_after (the words guard on turns). It is ended with a final
// technical_failure outcome, decided (live_interview_actions decide_restart,
// restart, owner, no turn target), then abandoned (allowed only from started,
// only after that decision). Attempt 2 copies company, application, job, kind,
// settings, snapshots and delete_after, starts invited, and its deadline is no
// earlier than attempt 1's and before delete_after (attempt_rules). Migration
// 063 allows at most one open session per application and kind: attempt 1 is
// abandoned before attempt 2 opens. Each attempt has an interviewer turn and a
// candidate turn responding to it.
//
// What this cannot prove: the exact SQL PostgREST sends (psql runs the
// equivalent single statement; PostgREST cannot hold a transaction open to roll
// back), concurrency, production parity beyond staging's schema, and storage.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openStaging } from "./guard.mjs";

await openStaging({ intent: "harness" });
const DB = process.env.STAGING_DATABASE_URL;
if (!DB) {
  console.log("REFUSED: STAGING_DATABASE_URL is required (.env.staging)");
  process.exit(1);
}

/** Run SQL in its own psql session; resolves with its stdout lines. */
function psql(sql) {
  return new Promise((resolve, reject) => {
    const p = spawn("psql", [DB, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `psql exit ${code}: ${err.split("\n")[0].replace(/postgres(ql)?:\/\/\S+/g, "<db>")}`,
          ),
        );
      } else {
        resolve(out.trim().split("\n").filter(Boolean));
      }
    });
    p.stdin.end(sql);
  });
}

const tag = `proof-094 ${randomBytes(4).toString("hex")}`;
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

const SQL = `
begin;

-- The database must say it is staging, in THIS session, before anything is written.
do $$ begin
  if not exists (select 1 from staging_guard.sentinel
                  where to_jsonb(sentinel)::text like '%Synthetic data only%') then
    raise exception 'REFUSED: not staging';
  end if;
end $$;

create temp table proof_ids (name text primary key, id uuid not null) on commit drop;
create temp table proof_result (ord int, case_name text, outcome text) on commit drop;

-- ── Fixtures ──
do $$
declare
  v_job uuid; v_co uuid; v_app uuid; v_l1 uuid; v_l2 uuid; v_t1 uuid; v_t3 uuid;
  v_delete_after timestamptz := now() + interval '30 days';
  v_expires timestamptz := now() + interval '7 days';
begin
  select id, company_id into v_job, v_co from public.jobs
   where company_id is not null and deleted_at is null order by id limit 1;
  if v_job is null then raise exception 'no staging job to attach to'; end if;

  insert into public.job_applications (job_id, company_id_snapshot, first_name, last_name, email)
  values (v_job, v_co, ${lit(tag)}, 'Synthetic', 'proof-094@example.invalid')
  returning id into v_app;

  insert into public.interview_sessions
    (company_id, application_id, job_id, token_hash, status, kind, live_settings,
     attempt, expires_at, delete_after, started_at)
  values (v_co, v_app, v_job, md5(random()::text) || ${lit(tag)}, 'started', 'live', '{}'::jsonb,
          1, v_expires, v_delete_after, now())
  returning id into v_l1;

  insert into public.interview_turns
    (session_id, provider_turn_id, sequence, speaker, kind, question_position, text,
     media_path, media_mime_type, media_bytes, media_sha256, offset_ms, duration_ms, started_at, ended_at)
  values (v_l1, 'p1', 1, 'interviewer', 'base_question', 1, 'Synthetic proof question',
          v_l1::text || '/t1.webm', 'audio/webm', 1, repeat('a', 64), 0, 1, now(), now())
  returning id into v_t1;
  insert into public.interview_turns
    (session_id, provider_turn_id, sequence, speaker, responds_to_turn_id, transcript_status,
     media_path, media_mime_type, media_bytes, media_sha256, offset_ms, duration_ms, started_at, ended_at)
  values (v_l1, 'p2', 2, 'candidate', v_t1, 'pending',
          v_l1::text || '/t2.webm', 'audio/webm', 1, repeat('b', 64), 1, 1, now(), now());

  -- End attempt 1 with a final, restartable outcome; decide restart; abandon it.
  update public.interview_sessions
     set live_ended_at = now(),
         live_outcome = '{"final": true, "outcome": "technical_failure"}'::jsonb
   where id = v_l1;
  insert into public.live_interview_actions
    (session_id, company_id, action, decision, note, actor_user_id, actor_role)
  values (v_l1, v_co, 'decide_restart', 'restart', 'proof-094 synthetic', gen_random_uuid(), 'owner');
  update public.interview_sessions set status = 'abandoned' where id = v_l1;

  -- Attempt 2: copies what attempt_rules requires, starts invited.
  insert into public.interview_sessions
    (company_id, application_id, job_id, token_hash, status, kind, live_settings,
     questions_snapshot, scoring_snapshot, attempt, previous_attempt_id, expires_at, delete_after)
  select company_id, application_id, job_id, md5(random()::text) || ${lit(tag)} || '-2', 'invited', kind,
         live_settings, questions_snapshot, scoring_snapshot, 2, id, expires_at, delete_after
    from public.interview_sessions where id = v_l1
  returning id into v_l2;

  insert into public.interview_turns
    (session_id, provider_turn_id, sequence, speaker, kind, question_position, text,
     media_path, media_mime_type, media_bytes, media_sha256, offset_ms, duration_ms, started_at, ended_at)
  values (v_l2, 'p3', 1, 'interviewer', 'base_question', 1, 'Synthetic proof question',
          v_l2::text || '/t1.webm', 'audio/webm', 1, repeat('c', 64), 0, 1, now(), now())
  returning id into v_t3;
  insert into public.interview_turns
    (session_id, provider_turn_id, sequence, speaker, responds_to_turn_id, transcript_status,
     media_path, media_mime_type, media_bytes, media_sha256, offset_ms, duration_ms, started_at, ended_at)
  values (v_l2, 'p4', 2, 'candidate', v_t3, 'pending',
          v_l2::text || '/t2.webm', 'audio/webm', 1, repeat('d', 64), 1, 1, now(), now());

  insert into proof_ids values ('co', v_co), ('l1', v_l1), ('l2', v_l2), ('t1', v_t1);
end $$;

-- ── Before: what the chain holds ──
insert into proof_result
select 0, 'BEFORE', format('sessions=%s turns=%s actions=%s',
  (select count(*) from public.interview_sessions where id in (select id from proof_ids where name in ('l1','l2'))),
  (select count(*) from public.interview_turns where session_id in (select id from proof_ids where name in ('l1','l2'))),
  (select count(*) from public.live_interview_actions where session_id in (select id from proof_ids where name in ('l1','l2'))));

-- ── N1: attempt 1 alone must be refused ──
do $$
declare st text; cn text; v_l1 uuid := (select id from proof_ids where name = 'l1');
        v_co uuid := (select id from proof_ids where name = 'co');
begin
  begin
    delete from public.interview_sessions where id = v_l1 and company_id = v_co;
    st := 'NO ERROR'; cn := '';
    raise exception 'proof-094: undo an unexpected success';
  exception when others then
    if st is null then get stacked diagnostics st = returned_sqlstate, cn = constraint_name; end if;
  end;
  insert into proof_result values (1, 'N1 delete attempt 1 alone', st || ' ' || coalesce(cn, ''));
end $$;

-- ── N2: an interviewer turn a candidate turn responds to must be refused ──
do $$
declare st text; cn text; v_t1 uuid := (select id from proof_ids where name = 't1');
begin
  begin
    delete from public.interview_turns where id = v_t1;
    st := 'NO ERROR'; cn := '';
    raise exception 'proof-094: undo an unexpected success';
  exception when others then
    if st is null then get stacked diagnostics st = returned_sqlstate, cn = constraint_name; end if;
  end;
  insert into proof_result values (2, 'N2 delete a responded-to turn alone', st || ' ' || coalesce(cn, ''));
end $$;

-- ── P1: both attempts in ONE statement, the application-deletion.ts shape ──
do $$
declare n int; st text; cn text;
        v_co uuid := (select id from proof_ids where name = 'co');
begin
  begin
    delete from public.interview_sessions
     where id in (select id from proof_ids where name in ('l1', 'l2'))
       and company_id = v_co;
    get diagnostics n = row_count;
    insert into proof_result values (3, 'P1 delete both attempts in one statement', 'OK deleted=' || n);
  exception when others then
    get stacked diagnostics st = returned_sqlstate, cn = constraint_name;
    insert into proof_result values (3, 'P1 delete both attempts in one statement', 'ERROR ' || st || ' ' || coalesce(cn, ''));
  end;
end $$;

insert into proof_result
select 4, 'AFTER P1', format('sessions=%s turns=%s actions=%s',
  (select count(*) from public.interview_sessions where id in (select id from proof_ids where name in ('l1','l2'))),
  (select count(*) from public.interview_turns where session_id in (select id from proof_ids where name in ('l1','l2'))),
  (select count(*) from public.live_interview_actions where session_id in (select id from proof_ids where name in ('l1','l2'))));

select case_name || ': ' || outcome from proof_result order by ord;

rollback;
`;

const EXPECTED = new Map([
  ["BEFORE", "sessions=2 turns=4 actions=1"],
  ["N1 delete attempt 1 alone", "23503 interview_sessions_previous_attempt_fk"],
  ["N2 delete a responded-to turn alone", "23503 interview_turns_responds_to_fk"],
  ["P1 delete both attempts in one statement", "OK deleted=2"],
  ["AFTER P1", "sessions=0 turns=0 actions=0"],
]);

let lines;
try {
  lines = await psql(SQL);
} catch (err) {
  // ON_ERROR_STOP ended the session: the transaction never committed.
  console.log(`STOPPED: ${err.message}`);
  console.log("ROLLED BACK (the session ended before any commit; there is none in this file)");
  process.exit(1);
}
let unexpected = 0;
for (const line of lines) {
  const [name, outcome] = line.split(": ");
  const want = EXPECTED.get(name);
  const ok = want !== undefined && outcome.trim() === want;
  if (!ok) unexpected += 1;
  console.log(`${ok ? "PASS" : "UNEXPECTED"}  ${name}: ${outcome.trim()}`);
}
if (lines.length !== EXPECTED.size) {
  unexpected += 1;
  console.log(`UNEXPECTED  ${lines.length} result line(s), expected ${EXPECTED.size}`);
}
console.log("ROLLED BACK");

// A second session: the synthetic rows must not exist.
const left = await psql(
  `select (select count(*) from public.job_applications where first_name = ${lit(tag)})
        + (select count(*) from public.interview_sessions where token_hash like '%' || ${lit(tag)} || '%');`,
);
console.log(`persisted after rollback: ${left[0]} row(s)`);
if (left[0] !== "0") unexpected += 1;

process.exit(unexpected === 0 ? 0 : 1);
