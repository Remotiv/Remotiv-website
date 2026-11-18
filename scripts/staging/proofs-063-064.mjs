// Migrations 063 and 064 proofs on a REAL Postgres (staging only), #52.
//
//   node --env-file=.env.staging scripts/staging/proofs-063-064.mjs
//
// Requires 063 and 064 applied on staging (the pre-flight stops otherwise),
// psql on PATH and STAGING_DATABASE_URL. Fixtures are synthetic, in a
// throwaway company cloned from the staging fixture's row shapes, and removed
// at the end. Prints outcome words and counts only: never a token, address or
// connection string.
//
//   Q  queue_manual_whatsapp: one call writes the row AND the job (the job
//      carries the row's id); bad input and a foreign company write nothing;
//      a call inside a transaction that is rolled back leaves neither.
//   C  claim_manual_communication_log: claimed, then 'uncertain' on a second
//      claim (row failed with the note, never claimable again); a row
//      cancelled first is 'stopped'.
//   U  063: two sessions for one applicant and kind inserted at once: exactly
//      one survives, the other gets 23505 naming the index.
//   P  privileges: service_role only.
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
  {
    auth: { persistSession: false },
  },
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
const one = async (sql) => (await psql(sql)).lines[0];

const pre = await one(
  "select (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('queue_manual_whatsapp', 'claim_manual_communication_log')) || '/' || (select count(*) from pg_catalog.pg_indexes where schemaname = 'public' and indexname = 'interview_sessions_one_open_per_kind');",
);
if (pre !== "2/1") {
  console.log(
    `STOP: 063 and 064 are not both on staging (functions/index = ${pre}). Apply them first.`,
  );
  process.exit(1);
}

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const other = randomUUID();
const app = randomUUID();
const must = async (q, what) => {
  const r = await q;
  if (r.error) throw new Error(`${what}: ${r.error.code}`);
  return r.data;
};
try {
  for (const [id, name] of [
    [company, `proof-063-064 ${tag}`],
    [other, `proof-063-064 other ${tag}`],
  ]) {
    await must(
      svc.from("companies").insert({
        id,
        name,
        contact_email: `p064-${name.length}-${tag}@example.invalid`,
        must_change_password: false,
      }),
      "company",
    );
  }
  // An application shaped like the fixture's (every required column filled), in the throwaway company.
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
    email: `p064-app-${tag}@example.invalid`,
    phone: null,
    cv_path: null,
    cv_url: null,
  };
  for (const k of ["created_at", "updated_at", "effective_score"]) delete appRow[k];
  await must(svc.from("job_applications").insert(appRow), "application");

  const q = (over = {}) => {
    const a = {
      company: company,
      app: app,
      event: "interview",
      to: "923001234567",
      body: "interview_invitation: {}",
      by: "Proof Recruiter",
      payload: '\'{"deadline": "20 Nov 2026"}\'::jsonb',
      ...over,
    };
    return `select out_outcome || ',' || coalesce(out_log_id::text, '-') || ',' || coalesce(out_job_id::text, '-') from public.queue_manual_whatsapp(${lit(a.company)}::uuid, ${lit(a.app)}::uuid, ${lit(a.event)}, ${lit(a.to)}, ${lit(a.body)}, ${lit(a.by)}, ${a.payload});`;
  };
  const counts = async () => ({
    logs: Number(
      await one(
        `select count(*) from public.communication_logs where application_id = ${lit(app)}::uuid;`,
      ),
    ),
    jobs: Number(
      await one(
        `select count(*) from public.background_jobs where payload->>'applicationId' = ${lit(app)};`,
      ),
    ),
  });

  // ── Q ──
  say("Q before", await counts());
  const [outcome, logId, jobId] = (await one(q())).split(",");
  say("Q queue: outcome", outcome);
  say(
    "Q the job carries the row's id",
    (await one(
      `select (payload->>'logId') = ${lit(logId)} from public.background_jobs where id = ${lit(jobId)}::uuid;`,
    )) === "t",
  );
  say(
    "Q the row: status / claimed?",
    await one(
      `select status || ' / ' || (attempt_started_at is not null) from public.communication_logs where id = ${lit(logId)}::uuid;`,
    ),
  );
  say("Q after one call", await counts());
  say("Q empty recipient", (await one(q({ to: " " }))).split(",")[0]);
  say("Q empty body", (await one(q({ body: "" }))).split(",")[0]);
  say("Q another company's application", (await one(q({ company: other }))).split(",")[0]);
  const rolled = await psql(`begin; ${q()} rollback;`);
  say("Q a call inside a rolled-back transaction (ok)", rolled.ok);
  say("Q after refusals and the rollback (still 1 and 1)", await counts());

  // ── C ──
  const claim = (id, co = company) =>
    one(
      `select out_outcome from public.claim_manual_communication_log(${lit(id)}::uuid, ${lit(co)}::uuid, 'Not confirmed (proof).');`,
    );
  say("C claim from another company", await claim(logId, other));
  say("C first claim", await claim(logId));
  say("C second claim (an earlier run died mid-send)", await claim(logId));
  say(
    "C the row now",
    await one(
      `select status || ' / ' || error from public.communication_logs where id = ${lit(logId)}::uuid;`,
    ),
  );
  say("C third claim", await claim(logId));
  const [, log2] = (await one(q())).split(",");
  await psql(
    `update public.communication_logs set status = 'cancelled' where id = ${lit(log2)}::uuid;`,
  );
  say("C a row Stopped before the claim", await claim(log2));

  // ── U: 063 ──
  const tplS = await must(
    svc.from("interview_sessions").select("*").limit(1).single(),
    "template session",
  );
  const sessionSql = () => {
    const id = randomUUID();
    const cols = {
      ...tplS,
      id,
      company_id: company,
      application_id: app,
      job_id: null,
      status: "invited",
      kind: "async",
      attempt: 1,
      previous_attempt_id: null,
      token_hash: randomBytes(32).toString("hex"),
      purged_at: null,
    };
    for (const k of ["created_at", "updated_at"]) delete cols[k];
    for (const k of Object.keys(cols)) if (/^(live_|provider_)/.test(k)) cols[k] = null;
    const names = Object.keys(cols);
    const vals = names.map((k) =>
      cols[k] === null
        ? "null"
        : typeof cols[k] === "object"
          ? `${lit(JSON.stringify(cols[k]))}::jsonb`
          : lit(cols[k]),
    );
    return `begin; insert into public.interview_sessions (${names.join(", ")}) values (${vals.join(", ")}); select pg_catalog.pg_sleep(2); commit;`;
  };
  const [u1, u2] = await Promise.all([psql(sessionSql()), psql(sessionSql())]);
  say("U two simultaneous open sessions: succeeded", [u1.ok, u2.ok].filter(Boolean).length);
  const loser = [u1, u2].find((r) => !r.ok);
  say(
    "U the loser's error names the index",
    !!loser &&
      /duplicate key value violates unique constraint "interview_sessions_one_open_per_kind"/.test(
        loser.err,
      ),
  );
  say(
    "U open sessions for the applicant",
    await one(
      `select count(*) from public.interview_sessions where application_id = ${lit(app)}::uuid and status in ('invited','started');`,
    ),
  );

  // ── P ──
  for (const f of [
    "public.queue_manual_whatsapp(uuid, uuid, text, text, text, text, jsonb)",
    "public.claim_manual_communication_log(uuid, uuid, text)",
  ]) {
    say(
      `P ${f.split("(")[0]}: anon / authenticated / service_role`,
      await one(
        `select pg_catalog.has_function_privilege('anon', ${lit(f)}, 'execute') || '/' || pg_catalog.has_function_privilege('authenticated', ${lit(f)}, 'execute') || '/' || pg_catalog.has_function_privilege('service_role', ${lit(f)}, 'execute');`,
      ),
    );
  }
} finally {
  await psql(`delete from public.background_jobs where payload->>'applicationId' = ${lit(app)};`);
  await psql(`delete from public.interview_sessions where application_id = ${lit(app)}::uuid;`);
  await psql(`delete from public.communication_logs where application_id = ${lit(app)}::uuid;`);
  await svc.from("job_applications").delete().eq("id", app);
  await svc.from("companies").delete().in("id", [company, other]);
  say("cleanup", "jobs, sessions, logs, application and companies removed");
}
