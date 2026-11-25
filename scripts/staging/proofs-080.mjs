// Migration 080 proofs on REAL Supabase Storage (staging only), #55 part 2.
//
//   node --env-file=.env.staging scripts/staging/proofs-080.mjs
//
// Requires 066 AND 080 applied on STAGING (the pre-flight stops otherwise),
// psql on PATH and STAGING_DATABASE_URL. The same guard as proofs-066.mjs: the
// staging sentinel must read "Synthetic data only". Synthetic fixtures in a
// throwaway company, removed at the end. Candidate uploads are REAL: a signed
// upload link is minted by the service role and used from an anon client, as
// the browser does. Prints outcomes only: never a URL, token, key or address.
// Exits 1 if any expectation fails.
//
//   C1 control: server turn audio on an OPEN live session: allowed
//   L6 a live piece whose link was signed while the interview ran, used after
//      the applicant's delete closed the session (071's Close updates:
//      delete_after = now(), status cancelled): refused, and no object left
//      (storage list AND storage.objects)
//   L7 a new link for that piece signed after the close: refused (at signing
//      or at upload), no object left
//   S5 the server's turn audio for that closed session (080's rule):
//      refused, no object left
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

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

const pre = await psql(
  "select count(*) from pg_catalog.pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'interview_upload_open_session_only';",
);
if (pre.lines[0] !== "1") {
  console.log("STOP: 066 is not on staging. Apply it there first (with Waleed's OK).");
  process.exit(1);
}
const has080 = await psql(
  "select pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.interview_upload_open_session_only()'::regprocedure), 'and (ses.delete_after is null or ses.delete_after > pg_catalog.now())) then') > 0;",
);
if (has080.lines[0] !== "t") {
  console.log("STOP: 080 is not on staging. Apply it there first (with Waleed's OK).");
  process.exit(1);
}

const BUCKET = "interview-videos";
// A WebM header and a marker; the size tells which bytes are stored.
const bytes = (marker) =>
  new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode(marker)])], {
    type: "video/webm",
  });
const SIZES = { 9: "FIRST", 12: "REPLACED", 13: "RECREATED", 8: "LIVE", 10: "SERVER" };
const stored = async (path) => {
  const [dir, name] = path.split("/");
  const { data } = await svc.storage.from(BUCKET).list(dir, { search: name });
  const o = (data ?? []).find((x) => x.name === name);
  return o ? (SIZES[o.metadata?.size] ?? `size ${o.metadata?.size}`) : "absent";
};
// Storage tests the insert when it SIGNS a link (066 fired there too, on the
// first run), so a refusal can come at signing: reported as such.
const link = async (path, upsert) => {
  const r = await svc.storage.from(BUCKET).createSignedUploadUrl(path, { upsert });
  return r.error ? { refusedAtSigning: r.error.statusCode ?? r.error.status } : r.data.token;
};
const put = async (path, token, marker) =>
  typeof token === "object"
    ? { error: { statusCode: `${token.refusedAtSigning}, when the link was minted` } }
    : browser.storage.from(BUCKET).uploadToSignedUrl(path, token, bytes(marker));

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
/** No object at this path: neither in a storage listing nor in storage.objects. */
const leftBehind = async (path) => {
  const listed = await stored(path);
  const rows = await psql(
    `select count(*) from storage.objects where bucket_id = ${lit(BUCKET)} and name = ${lit(path)};`,
  );
  return listed === "absent" && rows.ok && rows.lines[0] === "0"
    ? "none"
    : `listed ${listed}, rows ${rows.lines[0]}`;
};
const refused = (r) => (r.error ? "refused" : "allowed");
try {
  await must(
    svc.from("companies").insert({
      id: company,
      name: `proof-080 ${tag}`,
      contact_email: `p080-${tag}@example.invalid`,
      must_change_password: false,
    }),
    "company",
  );
  const session = async () => {
    const id = randomUUID();
    sessions.push(id);
    const r = await psql(
      `insert into public.interview_sessions (id, company_id, kind, status, token_hash, expires_at, live_settings)
       values (${lit(id)}::uuid, ${lit(company)}::uuid, 'live', 'started', ${lit(randomBytes(32).toString("hex"))}, now() + interval '2 days', '{}'::jsonb);`,
    );
    if (!r.ok) throw new Error(`session: ${r.err}`);
    return id;
  };
  const turnPath = (sid) => {
    const path = `${sid}/t1.${randomBytes(8).toString("hex")}.webm`;
    paths.push(path);
    return path;
  };
  const serverUpload = (path) =>
    svc.storage.from(BUCKET).upload(path, bytes("SERVER!"), { contentType: "video/webm" });

  // C1: the rule is not a blanket refusal.
  const open = await session();
  const tOpen = turnPath(open);
  expect(
    "C1 control: server turn audio, OPEN live session",
    refused(await serverUpload(tOpen)),
    "allowed",
  );

  // The interview runs: piece 0 is reserved and its link signed.
  const live = await session();
  const v0 = `${live}/v0.webm`;
  paths.push(v0);
  const reserved = await psql(
    `insert into public.live_video_pieces (session_id, company_id, piece_index, status, media_path, mime_type)
     values (${lit(live)}::uuid, ${lit(company)}::uuid, 0, 'pending', ${lit(v0)}, 'video/webm');`,
  );
  if (!reserved.ok) throw new Error(`piece: ${reserved.err}`);
  const oldLink = await link(v0, false);
  say(
    "fixture: link signed while the interview ran",
    typeof oldLink === "string" ? "yes" : "refused",
  );

  // The applicant's delete begins: 071's Close, as it updates this session.
  const closed = await psql(
    `update public.interview_sessions set delete_after = now(), status = 'cancelled' where id = ${lit(live)}::uuid;
     select status || ' ' || (delete_after <= now())::text from public.interview_sessions where id = ${lit(live)}::uuid;`,
  );
  if (!closed.ok) throw new Error(`close: ${closed.err}`);
  expect("fixture: closed as the Close leaves it", closed.lines.at(-1), "cancelled true");

  expect("L6 old link, used after the close", refused(await put(v0, oldLink, "LIVE")), "refused");
  expect("L6 nothing left behind", await leftBehind(v0), "none");
  expect(
    "L7 new link after the close",
    refused(await put(v0, await link(v0, false), "LIVE")),
    "refused",
  );
  expect("L7 nothing left behind", await leftBehind(v0), "none");

  const tClosed = turnPath(live);
  expect(
    "S5 server turn audio after the close (080)",
    refused(await serverUpload(tClosed)),
    "refused",
  );
  expect("S5 nothing left behind", await leftBehind(tClosed), "none");
} finally {
  await svc.storage.from(BUCKET).remove(paths);
  await psql(
    `delete from public.interview_sessions where id in (${sessions.map((s) => `${lit(s)}::uuid`).join(", ") || "null"});`,
  );
  await svc.from("companies").delete().eq("id", company);
  say("cleanup", "objects, sessions, pieces and company removed");
}
const failed = results.filter((ok) => !ok).length;
say(
  "RESULT",
  failed === 0 && results.length > 0
    ? `PASS (${results.length} checks)`
    : `FAIL (${failed} of ${results.length})`,
);
process.exit(failed === 0 && results.length > 0 ? 0 : 1);
