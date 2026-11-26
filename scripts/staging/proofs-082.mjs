// Migration 082 proofs on the REAL function (staging only), #58 commit 1.
//
//   node --env-file=.env.staging scripts/staging/proofs-082.mjs
//
// Requires 082 applied on STAGING (the pre-flight stops otherwise), psql on
// PATH and STAGING_DATABASE_URL. The same guard as proofs-080.mjs: the staging
// sentinel must read "Synthetic data only". Synthetic fixtures in two
// throwaway companies, removed at the end. The function is called through the
// service role's RPC, the way the save path will call it. Prints outcomes and
// counts only: never a URL, key, id or question text from outside the fixture.
// Exits 1 if any expectation fails.
//
//   P1 a save of both lists (async 3, live 4): counts returned, rows per kind,
//      positions 1..n (input positions ignored)
//   P2 NULL leaves that list untouched
//   P3 [] clears that list, the other untouched
//   P4 an invalid live list (9 items; empty text) rolls back the async list
//   P5 the job under the wrong company_id: refused, nothing deleted
//   P6 the rows that existed before the proof (1 on staging): still 'async',
//      byte-for-byte untouched
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const { createClient } = createRequire(import.meta.url)("@supabase/supabase-js");
const DB = process.env.STAGING_DATABASE_URL;
if (!DB || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("REFUSED: staging credentials are required (.env.staging)");
  process.exit(1);
}
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  opts,
);
const sentinel = await svc.schema("staging_guard").from("sentinel").select("*");
if (sentinel.error || !JSON.stringify(sentinel.data ?? []).includes("Synthetic data only")) {
  console.log("REFUSED: the staging sentinel is not readable; this is not staging");
  process.exit(1);
}

function psql(sql) {
  return new Promise((resolve) => {
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
      }),
    );
    p.stdin.end(sql);
  });
}
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const say = (k, v) => console.log(k.padEnd(66), typeof v === "string" ? v : JSON.stringify(v));
const must = async (q, what) => {
  const r = await q;
  if (r.error) throw new Error(`${what}: ${r.error.code ?? r.error.statusCode}`);
  return r.data;
};
const one = async (sql, what) => {
  const r = await psql(sql);
  if (!r.ok) throw new Error(`${what}: ${r.err}`);
  return r.lines.at(-1) ?? "";
};

const has082 = await psql(
  "select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'replace_interview_questions' and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_company_id uuid, p_async jsonb, p_live jsonb';",
);
if (has082.lines[0] !== "1") {
  console.log("STOP: 082 is not on staging. Apply it there first (with Waleed's OK).");
  process.exit(1);
}

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const otherCompany = randomUUID();
const job = randomUUID();
const results = [];
const expect = (name, got, want) => {
  const ok = got === want;
  results.push(ok);
  say(name, `${got}${ok ? "" : `  EXPECTED ${want}`}`);
};

/** Synthetic questions. `position` is sent on purpose: the function must ignore it. */
const list = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    question: `${prefix} synthetic question ${i + 1} ${tag}`,
    competency: "Ownership",
    rubric: `${prefix} synthetic guide ${i + 1}`,
    prep_seconds: 30,
    answer_seconds: 120,
    weight: 2,
    required: true,
    position: 90 + i,
  }));
const save = (asyncList, liveList, companyId = company) =>
  svc.rpc("replace_interview_questions", {
    p_job_id: job,
    p_company_id: companyId,
    p_async: asyncList,
    p_live: liveList,
  });
/** The counts the function returned, as "async/live" ("-" for a kind left untouched). */
const counts = (r) =>
  r.error ? `error ${iq082(r)}` : `${r.data?.async ?? "-"}/${r.data?.live ?? "-"}`;
const iq082 = (r) => (r.error ? (r.error.message.match(/IQ082: .*/)?.[0] ?? "error") : "no error");
/** One kind's rows as "position:prefix" in position order, e.g. "1:A,2:A,3:A". */
const rows = (kind) =>
  one(
    `select coalesce(string_agg(position || ':' || split_part(question, ' ', 1), ',' order by position), '')
     from public.interview_questions where job_id = ${lit(job)}::uuid and interview_kind = ${lit(kind)};`,
    `rows ${kind}`,
  );
/** A fingerprint of one kind's rows, every column: unchanged means byte-for-byte. */
const print = (kind) =>
  one(
    `select coalesce(md5(string_agg(q::text, '|' order by q.position)), 'none')
     from public.interview_questions q where q.job_id = ${lit(job)}::uuid and q.interview_kind = ${lit(kind)};`,
    `print ${kind}`,
  );
/** Every row that is not this proof's: count, kinds, fingerprint. */
const others = () =>
  one(
    `select count(*) || ' ' || coalesce(string_agg(distinct interview_kind, ','), '-') || ' ' || coalesce(md5(string_agg(q::text, '|' order by q.id)), 'none')
     from public.interview_questions q where q.job_id <> ${lit(job)}::uuid;`,
    "others",
  );

const before = await others();
try {
  for (const [id, name] of [
    [company, `proof-082 ${tag}`],
    [otherCompany, `proof-082 other ${tag}`],
  ]) {
    await must(
      svc.from("companies").insert({
        id,
        name,
        contact_email: `p082-${tag}-${id.slice(0, 4)}@example.invalid`,
        must_change_password: false,
      }),
      "company",
    );
  }
  await must(
    svc.from("jobs").insert({
      id: job,
      company_id: company,
      title: `Synthetic proof job ${tag}`,
      company: `proof-082 ${tag}`,
      location: "Remote",
      category: "Engineering",
      experience_level: "Intermediate",
      status: "on_hold",
    }),
    "job",
  );

  // P1: both lists in one call.
  const p1 = await save(list("A", 3), list("L", 4));
  expect("P1 save both lists: returned counts", counts(p1), "3/4");
  expect("P1 async rows: positions 1..3, kind async", await rows("async"), "1:A,2:A,3:A");
  expect("P1 live rows: positions 1..4, kind live", await rows("live"), "1:L,2:L,3:L,4:L");
  expect(
    "P1 input positions ignored (none at 90+)",
    await one(
      `select count(*) from public.interview_questions where job_id = ${lit(job)}::uuid and position >= 90;`,
      "p1 positions",
    ),
    "0",
  );

  // P2: NULL leaves that list untouched.
  const asyncPrint = await print("async");
  const p2 = await save(null, list("M", 2));
  expect("P2 async NULL: returned counts", counts(p2), "-/2");
  expect("P2 async rows untouched (fingerprint)", (await print("async")) === asyncPrint, true);
  expect("P2 live replaced: positions 1..2", await rows("live"), "1:M,2:M");

  // P3: [] clears that list; the other is untouched.
  const livePrint = await print("live");
  const p3 = await save([], null);
  expect("P3 async []: returned counts", counts(p3), "0/-");
  expect("P3 async cleared", await rows("async"), "");
  expect("P3 live untouched (fingerprint)", (await print("live")) === livePrint, true);

  // P4: an invalid live list rolls back the async list too.
  const reseed = await save(list("B", 3), null);
  expect("P4 fixture: async re-saved", counts(reseed), "3/-");
  const a4 = await print("async");
  const l4 = await print("live");
  const nine = await save(list("C", 2), list("N", 9));
  expect(
    "P4a live 9 items: refused",
    iq082(nine),
    "IQ082: the live list has 9 questions; at most 8",
  );
  expect("P4a async unchanged (fingerprint)", (await print("async")) === a4, true);
  expect("P4a live unchanged (fingerprint)", (await print("live")) === l4, true);
  const blank = await save(list("C", 2), [...list("N", 2), { question: "   " }]);
  expect(
    "P4b live empty text: refused",
    iq082(blank),
    "IQ082: live question 3 has no question text",
  );
  expect("P4b async unchanged (fingerprint)", (await print("async")) === a4, true);
  expect("P4b live unchanged (fingerprint)", (await print("live")) === l4, true);

  // P5: the wrong company_id is refused, nothing deleted.
  const wrong = await save([], [], otherCompany);
  expect("P5 wrong company: refused", iq082(wrong), "IQ082: job not found in this company");
  expect("P5 async unchanged (fingerprint)", (await print("async")) === a4, true);
  expect("P5 live unchanged (fingerprint)", (await print("live")) === l4, true);
} finally {
  await psql(
    `delete from public.interview_questions where job_id = ${lit(job)}::uuid;
     delete from public.jobs where id = ${lit(job)}::uuid;
     delete from public.companies where id in (${lit(company)}::uuid, ${lit(otherCompany)}::uuid);`,
  );
  const left = await one(
    `select (select count(*) from public.interview_questions where job_id = ${lit(job)}::uuid)
          + (select count(*) from public.jobs where id = ${lit(job)}::uuid)
          + (select count(*) from public.companies where id in (${lit(company)}::uuid, ${lit(otherCompany)}::uuid));`,
    "cleanup",
  ).catch(() => "unknown");
  expect("cleanup: fixture rows left", left, "0");
}

// P6: the rows from before the proof, untouched.
const after = await others();
const [count, kinds] = before.split(" ");
say("P6 rows outside the proof before (count, kinds)", `${count} ${kinds}`);
expect("P6 still 'async' only", kinds, "async");
expect("P6 untouched (count and fingerprint)", after === before, true);

const failed = results.filter((ok) => !ok).length;
say(
  "RESULT",
  failed === 0 && results.length > 0
    ? `PASS (${results.length} checks)`
    : `FAIL (${failed} of ${results.length})`,
);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
