// Migration 069 proofs on REAL Supabase (staging only), AVI #23.
//
//   node --env-file=.env.staging scripts/staging/proofs-069.mjs
//
// Requires 066, 080 AND 069 applied on STAGING (the pre-flight stops
// otherwise), psql on PATH and STAGING_DATABASE_URL. The same guard as
// proofs-066.mjs and proofs-080.mjs: the staging sentinel must read "Synthetic
// data only". Synthetic fixtures in a throwaway company, removed at the end.
// No trigger is switched off: every end below is stamped through 069's trigger,
// as the server's backstop writes it. Prints outcomes only: never a URL,
// token, key or address. Exits 1 if any expectation fails.
//
// Times are relative to the database's now(). A 30-minute interview is due to
// end at started_at + 40 minutes (the limit plus the 10-minute grace).
//
//   E1 due 3 minutes ago, the due time written now: stored exactly as written
//   E2 a second write of the end: refused, the end unchanged
//   E3 a written end in the future: stored as now()
//   E4 a written end before started_at: stored as now()
//   E5 a written end with no started_at: stored as now()
//   E6 a terminal status with no end written: stamped now() (044, unchanged)
//   W1 due 31 minutes ago, noticed now: a piece reserved during the call is
//      refused (the window ran from the due time; under 044 it would be open)
//   W2 control: due 3 minutes ago, noticed now: the same upload is allowed
//   R1 due 61 minutes ago, noticed now, no export: a restart decision is
//      accepted (inside a transaction that is rolled back; nothing is kept)
//   R2 control: due 57 minutes ago: refused, less than an hour
//   P  proofs-080.mjs re-run as it is (C1, L6, L7, S5: 080's late turn audio
//      and 066's piece rules after deletion): its RESULT must be PASS
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { createClient } = createRequire(import.meta.url)("@supabase/supabase-js");
const DB = process.env.STAGING_DATABASE_URL;
if (!DB || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.log("REFUSED: staging credentials are required (.env.staging)");
  process.exit(1);
}
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, opts);
const browser = createClient(URL_, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
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
const functionHas = async (fn, text) =>
  (
    await psql(
      `select pg_catalog.strpos(pg_catalog.pg_get_functiondef(${lit(fn)}::regprocedure), ${lit(text)}) > 0;`,
    )
  ).lines[0] === "t";

const pre = await psql(
  "select count(*) from pg_catalog.pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'interview_upload_open_session_only';",
);
if (pre.lines[0] !== "1") {
  console.log("STOP: 066 is not on staging. Apply it there first (with Waleed's OK).");
  process.exit(1);
}
if (
  !(await functionHas(
    "public.interview_upload_open_session_only()",
    "and (ses.delete_after is null or ses.delete_after > pg_catalog.now())) then",
  ))
) {
  console.log("STOP: 080 is not on staging. Apply it there first (with Waleed's OK).");
  process.exit(1);
}
if (
  !(await functionHas(
    "public.interview_sessions_live_ended()",
    "and new.live_ended_at >= new.started_at",
  ))
) {
  console.log("STOP: 069 is not on staging. Apply it there first (with Waleed's OK).");
  process.exit(1);
}

const BUCKET = "interview-videos";
const bytes = () =>
  new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode("LIVE")])], {
    type: "video/webm",
  });
const link = async (path) => {
  const r = await svc.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
  return r.error ? { refusedAtSigning: r.error.statusCode ?? r.error.status } : r.data.token;
};
const put = async (path, token) =>
  typeof token === "object"
    ? { error: { statusCode: `${token.refusedAtSigning}, when the link was minted` } }
    : browser.storage.from(BUCKET).uploadToSignedUrl(path, token, bytes());
const refused = (r) => (r.error ? "refused" : "allowed");

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const sessions = [];
const paths = [];
const results = [];
const expect = (name, got, want) => {
  const ok = got === want;
  results.push(ok);
  say(name, `${got}${ok ? "" : `  EXPECTED ${want}`}`);
};
const leftBehind = async (path) => {
  const rows = await psql(
    `select count(*) from storage.objects where bucket_id = ${lit(BUCKET)} and name = ${lit(path)};`,
  );
  return rows.ok && rows.lines[0] === "0" ? "none" : `rows ${rows.lines[0]}`;
};
try {
  await must(
    svc.from("companies").insert({
      id: company,
      name: `proof-069 ${tag}`,
      contact_email: `p069-${tag}@example.invalid`,
      must_change_password: false,
    }),
    "company",
  );
  /** A live session started `startedAgo` minutes ago; null: invited, never started. */
  const session = async (startedAgo) => {
    const id = randomUUID();
    sessions.push(id);
    const started = startedAgo === null ? "null" : `now() - interval '${startedAgo} minutes'`;
    const status = startedAgo === null ? "invited" : "started";
    const r = await psql(
      `insert into public.interview_sessions (id, company_id, kind, status, token_hash, expires_at, live_settings, started_at)
       values (${lit(id)}::uuid, ${lit(company)}::uuid, 'live', ${lit(status)}, ${lit(randomBytes(32).toString("hex"))}, now() + interval '2 days', '{}'::jsonb, ${started});`,
    );
    if (!r.ok) throw new Error(`session: ${r.err}`);
    return id;
  };
  /**
   * Write an end as the server's backstop does (no trigger switched off), in
   * one transaction so now() is one instant; then say how it was stored:
   * "as written", "now()", or minutes from started_at.
   */
  const writeEnd = async (sid, value) => {
    const r = await psql(
      `begin;
       update public.interview_sessions set live_ended_at = ${value} where id = ${lit(sid)}::uuid;
       select case
         when live_ended_at = (${value}) then 'as written'
         when live_ended_at = now() then 'now()'
         else 'other' end
         from public.interview_sessions where id = ${lit(sid)}::uuid;
       commit;`,
    );
    if (!r.ok) throw new Error(`end: ${r.err}`);
    return r.lines.at(-1);
  };
  const due = (sid) =>
    `(select started_at + interval '40 minutes' from public.interview_sessions where id = ${lit(sid)}::uuid)`;

  // ── E: what 069 stores ──
  const e1 = await session(43);
  expect(
    "E1 due 3 min ago, due time written now: stored",
    await writeEnd(e1, due(e1)),
    "as written",
  );
  const exact = await psql(
    `select (live_ended_at = started_at + interval '40 minutes')::text from public.interview_sessions where id = ${lit(e1)}::uuid;`,
  );
  expect("E1 the stored end is started_at + 40 minutes exactly", exact.lines[0], "true");
  const again = await psql(
    `update public.interview_sessions set live_ended_at = now() where id = ${lit(e1)}::uuid;`,
  );
  expect("E2 a second write of the end", again.ok ? "allowed" : "refused", "refused");
  const still = await psql(
    `select (live_ended_at = started_at + interval '40 minutes')::text from public.interview_sessions where id = ${lit(e1)}::uuid;`,
  );
  expect("E2 the end unchanged", still.lines[0], "true");
  const e3 = await session(43);
  expect(
    "E3 written in the future: stored",
    await writeEnd(e3, "now() + interval '20 minutes'"),
    "now()",
  );
  const e4 = await session(43);
  expect(
    "E4 written before started_at: stored",
    await writeEnd(e4, `(${due(e4)} - interval '41 minutes')`),
    "now()",
  );
  const e5 = await session(null);
  expect(
    "E5 written with no started_at: stored",
    await writeEnd(e5, "now() - interval '3 minutes'"),
    "now()",
  );
  const e6 = await session(43);
  const term = await psql(
    `begin;
     update public.interview_sessions set status = 'submitted' where id = ${lit(e6)}::uuid;
     select (live_ended_at = now())::text from public.interview_sessions where id = ${lit(e6)}::uuid;
     commit;`,
  );
  expect("E6 terminal status, no end written: stamped now()", term.lines.at(-1), "true");

  // ── W: the upload window counts from the stored end ──
  const windowCase = async (startedAgo) => {
    const sid = await session(startedAgo);
    const path = `${sid}/v0.webm`;
    paths.push(path);
    const reserved = await psql(
      `insert into public.live_video_pieces (session_id, company_id, piece_index, status, media_path, mime_type)
       values (${lit(sid)}::uuid, ${lit(company)}::uuid, 0, 'pending', ${lit(path)}, 'video/webm');`,
    );
    if (!reserved.ok) throw new Error(`piece: ${reserved.err}`);
    const stored = await writeEnd(sid, due(sid));
    return { path, stored, upload: refused(await put(path, await link(path))) };
  };
  const w1 = await windowCase(71);
  expect("W1 fixture: due 31 min ago, stored", w1.stored, "as written");
  expect("W1 piece reserved during the call, uploaded now", w1.upload, "refused");
  expect("W1 nothing left behind", await leftBehind(w1.path), "none");
  const w2 = await windowCase(43);
  expect("W2 fixture: due 3 min ago, stored", w2.stored, "as written");
  expect("W2 control: the same upload inside the window", w2.upload, "allowed");

  // ── R: the restart hour counts from the stored end ──
  const restartCase = async (startedAgo) => {
    const sid = await session(startedAgo);
    const stored = await writeEnd(sid, due(sid));
    // Rolled back: an action row is append-only and would block the cleanup.
    const r = await psql(
      `begin;
       insert into public.live_interview_actions (session_id, company_id, action, decision, note, actor_user_id, actor_role)
       values (${lit(sid)}::uuid, ${lit(company)}::uuid, 'decide_restart', 'no_restart', 'proof-069', ${lit(randomUUID())}::uuid, 'owner');
       select 'accepted';
       rollback;`,
    );
    const why = r.ok
      ? "accepted"
      : r.err.includes("less than an hour")
        ? "refused: less than an hour"
        : "refused: another rule";
    return { stored, why };
  };
  const r1 = await restartCase(101);
  expect("R1 fixture: due 61 min ago, stored", r1.stored, "as written");
  expect("R1 restart decision, no export", r1.why, "accepted");
  const r2 = await restartCase(97);
  expect("R2 fixture: due 57 min ago, stored", r2.stored, "as written");
  expect("R2 control: restart decision", r2.why, "refused: less than an hour");
  const kept = await psql(
    `select count(*) from public.live_interview_actions where company_id = ${lit(company)}::uuid;`,
  );
  expect("R  no action row kept", kept.lines[0], "0");
} finally {
  if (paths.length) await svc.storage.from(BUCKET).remove(paths);
  await psql(
    `delete from public.interview_sessions where id in (${sessions.map((s) => `${lit(s)}::uuid`).join(", ") || "null"});`,
  );
  await svc.from("companies").delete().eq("id", company);
  say("cleanup", "objects, sessions, pieces and company removed");
}

// ── P: 080's proofs, unchanged, on top of 069 ──
const p080 = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./proofs-080.mjs", import.meta.url))],
    { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", () => {});
  child.on("close", (code) => resolve({ code, lines: out.trim().split("\n") }));
});
for (const line of p080.lines) console.log(`  080 | ${line}`);
const p080Result = p080.lines.find((l) => l.startsWith("RESULT")) ?? "";
expect(
  "P  proofs-080.mjs on top of 069",
  p080.code === 0 && p080Result.includes("PASS") ? "PASS" : "FAIL",
  "PASS",
);

const failed = results.filter((ok) => !ok).length;
say(
  "RESULT",
  failed === 0 && results.length > 0
    ? `PASS (${results.length} checks)`
    : `FAIL (${failed} of ${results.length})`,
);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
