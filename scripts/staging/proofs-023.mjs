// #23 proof on a REAL Postgres (staging only): an async interview can never be
// 'abandoned', and the rule is live, not only written down.
//
//   node --env-file=.env.staging scripts/staging/proofs-023.mjs
//
// The rule (migration 020:118-121):
//   interview_sessions_abandoned_live_only CHECK (status <> 'abandoned' OR kind = 'live')
// and the door it would otherwise leave open, closed by migration 060: kind is
// immutable, so an async interview cannot first become 'live' and then be
// abandoned.
//
// ── NOTHING PERSISTS ─────────────────────────────────────────
//
// One psql session: BEGIN, the catalog reads, a synthetic fixture, the cases,
// ROLLBACK. There is no COMMIT anywhere in this file. Each case runs in a
// PL/pgSQL block with an exception handler, which is a savepoint: a case that
// unexpectedly succeeds raises to undo itself. A second session afterwards
// counts the synthetic rows and must find none.
//
// Prints case names, SQLSTATEs, constraint names, counts and ROLLED BACK.
// Never an id, a token, a connection string or an address.
//
// ── The cases ────────────────────────────────────────────────
//
//   K1  pg_constraint: the CHECK exists on interview_sessions, is validated
//       (convalidated), and its definition is the rule above
//   K2  staging holds 0 async sessions in 'abandoned' today
//   N1  invited async -> 'abandoned'  -> 23514, trigger: only a started session can be abandoned
//   P0  control: the same session -> 'started' is allowed
//   N1b started async -> 'abandoned'  -> 23514, trigger: only after a recorded restart decision
//       (a live-only action). BEFORE triggers run ahead of CHECKs, so on an
//       UPDATE the trigger answers first; the CHECK itself answers N2.
//   N2  INSERT an async session already 'abandoned' -> 23514 interview_sessions_abandoned_live_only
//   N3  UPDATE an async session's kind to 'live'    -> 23514, trigger (migration 060)
//   P1  control: the same async session CAN be cancelled (the fixture is a
//       valid row, so the refusals are for the reason named, not another)
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

const tag = `proof-023 ${randomBytes(4).toString("hex")}`;
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** A case block: run `stmt`; record the SQLSTATE and constraint it fails with. */
const refused = (ord, name, stmt) => `
do $$
declare v_state text; v_con text; v_msg text;
begin
  begin
    ${stmt}
    raise exception using errcode = 'P0099', message = 'unexpectedly succeeded';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_con = constraint_name,
                            v_msg = message_text;
  end;
  insert into proof_result values (${ord}, ${lit(name)},
    v_state || coalesce(' ' || nullif(v_con, ''), '') || ' | ' ||
    left(regexp_replace(v_msg, '[0-9a-f]{8}-[0-9a-f-]{27}', '<id>', 'g'), 110));
end $$;`;

const SQL = `
begin;

do $$ begin
  if not exists (select 1 from staging_guard.sentinel
                  where to_jsonb(sentinel)::text like '%Synthetic data only%') then
    raise exception 'REFUSED: not staging';
  end if;
end $$;

create temp table proof_ids (name text primary key, id uuid not null) on commit drop;
create temp table proof_result (ord int, case_name text, outcome text) on commit drop;

-- ── K1, K2: the catalog and today's data ──
insert into proof_result
select 1, 'K1 constraint',
       c.contype::text || ' validated=' || c.convalidated::text || ' def=' || pg_get_constraintdef(c.oid)
  from pg_constraint c
 where c.conrelid = 'public.interview_sessions'::regclass
   and c.conname = 'interview_sessions_abandoned_live_only';
insert into proof_result
select 2, 'K2 async sessions in abandoned today', count(*)::text
  from public.interview_sessions where kind = 'async' and status = 'abandoned';

-- ── Fixture: one synthetic application with one async, invited session ──
do $$
declare v_job uuid; v_co uuid; v_app uuid; v_s uuid;
begin
  select id, company_id into v_job, v_co from public.jobs
   where company_id is not null and deleted_at is null order by id limit 1;
  if v_job is null then raise exception 'no staging job to attach to'; end if;

  insert into public.job_applications (job_id, company_id_snapshot, first_name, last_name, email)
  values (v_job, v_co, ${lit(tag)}, 'Synthetic', 'proof-023@example.invalid')
  returning id into v_app;

  insert into public.interview_sessions
    (company_id, application_id, job_id, token_hash, status, kind, attempt, expires_at, delete_after)
  values (v_co, v_app, v_job, md5(random()::text) || ${lit(tag)}, 'invited', 'async', 1,
          now() + interval '7 days', now() + interval '30 days')
  returning id into v_s;

  insert into proof_ids values ('app', v_app), ('job', v_job), ('co', v_co), ('async', v_s);
end $$;

${refused(
  3,
  "N1 update async -> abandoned",
  `update public.interview_sessions set status = 'abandoned'
     where id = (select id from proof_ids where name = 'async');`,
)}

do $$
declare v_n int;
begin
  update public.interview_sessions set status = 'started', started_at = now()
   where id = (select id from proof_ids where name = 'async');
  get diagnostics v_n = row_count;
  insert into proof_result values (4, 'P0 control: async -> started is allowed', v_n || ' row');
end $$;

${refused(
  5,
  "N1b update started async -> abandoned",
  `update public.interview_sessions set status = 'abandoned'
     where id = (select id from proof_ids where name = 'async');`,
)}

${refused(
  6,
  "N2 insert async already abandoned",
  `insert into public.interview_sessions
      (company_id, application_id, job_id, token_hash, status, kind, attempt, expires_at, delete_after)
    select (select id from proof_ids where name = 'co'), (select id from proof_ids where name = 'app'),
           (select id from proof_ids where name = 'job'), md5(random()::text) || ${lit(tag)},
           'abandoned', 'async', 1, now() + interval '7 days', now() + interval '30 days';`,
)}

${refused(
  7,
  "N3 update async kind -> live",
  `update public.interview_sessions set kind = 'live'
     where id = (select id from proof_ids where name = 'async');`,
)}

-- ── P1: control, a permitted change on the same row ──
do $$
declare v_n int;
begin
  update public.interview_sessions set status = 'cancelled'
   where id = (select id from proof_ids where name = 'async');
  get diagnostics v_n = row_count;
  insert into proof_result values (8, 'P1 control: async -> cancelled is allowed', v_n || ' row');
end $$;

select ord || '|' || case_name || '|' || outcome from proof_result order by ord;

rollback;
`;

const lines = await psql(SQL);
for (const l of lines) {
  const [, name, ...rest] = l.split("|");
  console.log(`${name.padEnd(42)} ${rest.join("|")}`);
}
console.log("ROLLED BACK");

// A second session: nothing the proof made may exist.
const [left] = await psql(
  `select count(*) from public.job_applications where first_name = ${lit(tag)};`,
);
const [sessionsLeft] = await psql(
  `select count(*) from public.interview_sessions where token_hash like ${lit(`%${tag}`)};`,
);
console.log(
  `after rollback: ${left} synthetic application(s), ${sessionsLeft} synthetic session(s)`,
);

const want = {
  "K2 async sessions in abandoned today": (o) => o === "0",
  "N1 update async -> abandoned": (o) =>
    /^23514 \| .*only a started session can be abandoned/.test(o),
  "P0 control: async -> started is allowed": (o) => o === "1 row",
  "N1b update started async -> abandoned": (o) =>
    /^23514 \| .*only after a recorded restart decision/.test(o),
  "N2 insert async already abandoned": (o) =>
    o.startsWith("23514 interview_sessions_abandoned_live_only |"),
  "N3 update async kind -> live": (o) =>
    /^23514 \| .*kind is set at invite and cannot be changed/.test(o),
  "P1 control: async -> cancelled is allowed": (o) => o === "1 row",
};
let ok = left === "0" && sessionsLeft === "0";
const k1 = lines.find((l) => l.includes("|K1 constraint|"));
ok &&= Boolean(
  k1?.includes("c validated=true") &&
    k1.includes("CHECK (((status <> 'abandoned'::text) OR (kind = 'live'::text)))"),
);
for (const [name, check] of Object.entries(want)) {
  const line = lines.find((l) => l.split("|")[1] === name);
  ok &&= Boolean(line && check(line.split("|").slice(2).join("|")));
}
console.log(ok ? "ALL PASS" : "FAILED");
process.exitCode = ok ? 0 : 1;
