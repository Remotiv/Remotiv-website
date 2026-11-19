// #59 design check on a REAL Postgres (staging only): the Retry claim that
// 067 will add, run here as a TEMPORARY function (pg_temp, one copy per psql
// session) against synthetic communication_logs rows in a throwaway company.
// Nothing is added to the schema. Rows and company are removed at the end.
//
//   node --env-file=.env.staging scripts/staging/checks-059-retry-claim.mjs
//
// Prints outcomes and counts only: never a connection string or address.
//
//   R1  two Retries of one failed email at the same moment: exactly one is
//       'claimed' (only the claimer sends), the other waits on the row lock
//       and then reads 'wrong_status'
//   R2  a third Retry after the first finished and marked it sent:
//       'wrong_status', nothing to send
//   R3  a row whose outcome is unknown (left 'queued' by a send that never
//       answered): 'wrong_status', never resent
//   R4  older than 24 hours: 'too_old' (Resend's idempotency window)
//   R5  another company's row: 'missing'
//
// The first send needs no claim: cancelBooking, claimSlot and
// rescheduleBooking are each ONE conditional UPDATE (status, and for a
// reschedule the old start time), so two requests for one booking event have
// one winner by the same row-lock re-check R1 shows, and only the winner sends.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

const DB = process.env.STAGING_DATABASE_URL;
if (!DB) {
  console.log("REFUSED: STAGING_DATABASE_URL is required (.env.staging)");
  process.exit(1);
}
function psql(sql) {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn("psql", [DB, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) =>
      resolve({
        ok: code === 0,
        lines: out.trim().split("\n").filter(Boolean),
        err: err.split("\n")[0].replace(/postgres(ql)?:\/\/\S+/g, "<db>"),
        ms: Date.now() - t,
      }),
    );
    p.stdin.end(sql);
  });
}
const sentinel = await psql("select row_to_json(s)::text from staging_guard.sentinel s;");
if (!sentinel.ok || !sentinel.lines.join(" ").includes("Synthetic data only")) {
  console.log("REFUSED: the staging sentinel is not readable; this is not staging");
  process.exit(1);
}
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const say = (k, v) => console.log(k.padEnd(64), typeof v === "string" ? v : JSON.stringify(v));

// The claim 067 will create as public.claim_failed_email_log, verbatim but in pg_temp.
const CLAIM = `
create function pg_temp.claim_failed_email_log(p_id uuid, p_company_id uuid)
returns table (out_outcome text, out_attempt_started_at timestamptz)
language plpgsql
as $$
declare
  r record;
begin
  update public.communication_logs l
     set status = 'queued', attempt_started_at = pg_catalog.now(), error = null
   where l.id = p_id
     and l.company_id = p_company_id
     and l.channel = 'email'
     and l.status = 'failed'
     and l.created_at > pg_catalog.now() - interval '24 hours'
  returning l.attempt_started_at into r;
  if found then
    return query select 'claimed'::text, r.attempt_started_at;
    return;
  end if;
  select l.status into r
    from public.communication_logs l
   where l.id = p_id and l.company_id = p_company_id and l.channel = 'email';
  if not found then
    return query select 'missing'::text, null::timestamptz;
    return;
  end if;
  if r.status is distinct from 'failed' then
    return query select 'wrong_status'::text, null::timestamptz;
    return;
  end if;
  return query select 'too_old'::text, null::timestamptz;
end;
$$;`;
const claim = (id, company, after = "") =>
  `${CLAIM}\nbegin;\nselect out_outcome from pg_temp.claim_failed_email_log(${lit(id)}::uuid, ${lit(company)}::uuid);\n${after}\ncommit;`;

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const other = randomUUID();
const rows = { race: randomUUID(), unknown: randomUUID(), old: randomUUID() };
try {
  const setup = await psql(`
insert into public.companies (id, name, contact_email, must_change_password) values
  (${lit(company)}::uuid, ${lit(`check-059 ${tag}`)}, ${lit(`c059-${tag}@example.invalid`)}, false),
  (${lit(other)}::uuid, ${lit(`check-059 other ${tag}`)}, ${lit(`c059o-${tag}@example.invalid`)}, false);
insert into public.communication_logs (id, company_id, event, channel, to_address, subject, body, status, error, created_at) values
  (${lit(rows.race)}::uuid, ${lit(company)}::uuid, 'booking_cancelled', 'email', 'candidate@example.invalid', 's', 'b', 'failed', 'provider refused', now()),
  (${lit(rows.unknown)}::uuid, ${lit(company)}::uuid, 'booking_cancelled', 'email', 'candidate@example.invalid', 's', 'b', 'queued', null, now()),
  (${lit(rows.old)}::uuid, ${lit(company)}::uuid, 'booking_cancelled', 'email', 'candidate@example.invalid', 's', 'b', 'failed', 'provider refused', now() - interval '25 hours');`);
  if (!setup.ok) throw new Error(`setup: ${setup.err}`);

  // R1: the first claim holds its transaction for 8 s; the second starts 4 s later (connecting takes a few seconds through the pooler).
  const first = psql(claim(rows.race, company, "select pg_catalog.pg_sleep(8);"));
  await new Promise((r) => setTimeout(r, 4000));
  const second = await psql(claim(rows.race, company));
  const one = await first;
  say("R1 first Retry / second Retry", [one.lines[0], second.lines[0]]);
  say("R1 second Retry waited on the row (ms)", second.ms);
  say(
    "R1 Retries that may send",
    [one.lines[0], second.lines[0]].filter((x) => x === "claimed").length,
  );
  // The claimer's send succeeded: it marks the row sent.
  await psql(
    `update public.communication_logs set status = 'sent', sent_at = now() where id = ${lit(rows.race)}::uuid;`,
  );
  say("R2 a later Retry of the sent row", (await psql(claim(rows.race, company))).lines[0]);
  say("R3 unknown outcome (left queued)", (await psql(claim(rows.unknown, company))).lines[0]);
  say("R4 failed 25 hours ago", (await psql(claim(rows.old, company))).lines[0]);
  say("R5 another company's call", (await psql(claim(rows.race, other))).lines[0]);
} finally {
  await psql(
    `delete from public.communication_logs where company_id in (${lit(company)}::uuid, ${lit(other)}::uuid); delete from public.companies where id in (${lit(company)}::uuid, ${lit(other)}::uuid);`,
  );
  say("cleanup", "rows and companies removed");
}
