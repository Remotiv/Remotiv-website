// Migration 067 proofs on a REAL Postgres (staging only), #59.
//
//   node --env-file=.env.staging scripts/staging/proofs-067.mjs
//
// Requires 067 applied on staging (the pre-flight stops otherwise), psql on
// PATH and STAGING_DATABASE_URL. Synthetic fixtures in a throwaway company,
// removed at the end. Prints outcomes and counts only: never an address, key
// or connection string.
//
//   I  the index: two booking_cancelled rows (no sender) for ONE applicant are
//      allowed, as are two booking_confirmed and two booking_rescheduled; a
//      second 'offer' row for the same applicant is still refused (23505)
//   P  claim_failed_email_log: SECURITY DEFINER, search_path '', and EXECUTE
//      for service_role only
//   C  two claims of one failed row at the same moment: one 'claimed', the
//      other waits on the row and reads 'wrong_status'; then sent, queued
//      (unknown outcome), older than 24 hours and another company's rows
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const { createClient } = createRequire(import.meta.url)("@supabase/supabase-js");
const DB = process.env.STAGING_DATABASE_URL;
if (!DB || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    "REFUSED: STAGING_DATABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env.staging)",
  );
  process.exit(1);
}
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
const sentinel = await svc.schema("staging_guard").from("sentinel").select("*");
if (sentinel.error || !JSON.stringify(sentinel.data ?? []).includes("Synthetic data only")) {
  console.log("REFUSED: the staging sentinel is not readable; this is not staging");
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
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const say = (k, v) => console.log(k.padEnd(66), typeof v === "string" ? v : JSON.stringify(v));
const must = async (q, what) => {
  const r = await q;
  if (r.error) throw new Error(`${what}: ${r.error.code}`);
  return r.data;
};

const pre = await psql(
  "select (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_failed_email_log') || '/' || (select count(*) from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'communication_logs_auto_event_uniq' and indexdef like '%booking_cancelled%');",
);
if (pre.lines[0] !== "1/1") {
  console.log(`STOP: 067 is not on staging (function/index = ${pre.lines[0]}). Apply it first.`);
  process.exit(1);
}

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const other = randomUUID();
const app = randomUUID();
try {
  for (const [id, n] of [
    [company, 1],
    [other, 2],
  ]) {
    await must(
      svc.from("companies").insert({
        id,
        name: `proof-067 ${n} ${tag}`,
        contact_email: `p067-${n}-${tag}@example.invalid`,
        must_change_password: false,
      }),
      "company",
    );
  }
  // An application shaped like the staging fixture's (every required column filled).
  const tpl = await must(
    svc.from("job_applications").select("*").limit(1).single(),
    "template application",
  );
  const appRow = {
    ...tpl,
    id: app,
    job_id: null,
    company_id_snapshot: company,
    first_name: "Proof",
    last_name: "Synthetic",
    email: `p067-app-${tag}@example.invalid`,
    phone: null,
    cv_path: null,
    cv_url: null,
  };
  for (const k of ["created_at", "updated_at", "effective_score"]) delete appRow[k];
  await must(svc.from("job_applications").insert(appRow), "application");

  const row = (event, extra = "") =>
    psql(
      `insert into public.communication_logs (id, company_id, application_id, event, channel, to_address, subject, body, status${extra ? ", created_at" : ""}) values (gen_random_uuid(), ${lit(company)}::uuid, ${lit(app)}::uuid, ${lit(event)}, 'email', 'candidate@example.invalid', 's', 'b', 'failed'${extra ? `, ${extra}` : ""}) returning id;`,
    );

  // ── I: the index ──
  for (const event of ["booking_cancelled", "booking_confirmed", "booking_rescheduled"]) {
    const a = await row(event);
    const b = await row(event);
    say(`I two ${event} rows for one applicant: both written`, a.ok && b.ok);
  }
  await row("offer");
  const dup = await row("offer");
  say(
    "I a second 'offer' row for the same applicant: refused (23505)",
    !dup.ok &&
      /duplicate key value violates unique constraint "communication_logs_auto_event_uniq"/.test(
        dup.err,
      ),
  );

  // ── P: rights ──
  say(
    "P prosecdef / search_path / anon / authenticated / service_role",
    (
      await psql(
        "select p.prosecdef || ' / ' || coalesce(array_to_string(p.proconfig, ','), '') || ' / ' || pg_catalog.has_function_privilege('anon', p.oid, 'execute') || ' / ' || pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') || ' / ' || pg_catalog.has_function_privilege('service_role', p.oid, 'execute') from pg_catalog.pg_proc p where p.oid = 'public.claim_failed_email_log(uuid, uuid)'::regprocedure;",
      )
    ).lines[0],
  );

  // ── C: concurrent claims ──
  const target = (await row("booking_cancelled")).lines[0];
  const claim = (id, co, after = "") =>
    psql(
      `begin; select out_outcome from public.claim_failed_email_log(${lit(id)}::uuid, ${lit(co)}::uuid); ${after} commit;`,
    );
  const first = claim(target, company, "select pg_catalog.pg_sleep(8);");
  await new Promise((r) => setTimeout(r, 4000));
  const second = await claim(target, company);
  const one = await first;
  say("C first claim / second claim", [one.lines[0], second.lines[0]]);
  say("C the second claim waited on the row (ms)", second.ms);
  say(
    "C claims that may send",
    [one.lines[0], second.lines[0]].filter((x) => x === "claimed").length,
  );
  await psql(
    `update public.communication_logs set status = 'sent', sent_at = now() where id = ${lit(target)}::uuid;`,
  );
  say("C a claim of the sent row", (await claim(target, company)).lines[0]);
  const queued = (await row("booking_cancelled")).lines[0];
  await psql(
    `update public.communication_logs set status = 'queued' where id = ${lit(queued)}::uuid;`,
  );
  say("C a row left queued (unknown outcome)", (await claim(queued, company)).lines[0]);
  const old = (await row("booking_cancelled", "now() - interval '25 hours'")).lines[0];
  say("C failed 25 hours ago", (await claim(old, company)).lines[0]);
  say("C another company's call", (await claim(old, other)).lines[0]);
  say(
    "C the claimed row carries the database's stamp (seconds since the claim)",
    (
      await psql(
        `select round(abs(extract(epoch from now() - attempt_started_at))) from public.communication_logs where id = ${lit(target)}::uuid;`,
      )
    ).lines[0],
  );
} finally {
  await psql(`delete from public.communication_logs where application_id = ${lit(app)}::uuid;`);
  await svc.from("job_applications").delete().eq("id", app);
  await svc.from("companies").delete().in("id", [company, other]);
  say("cleanup", "rows, application and companies removed");
}
