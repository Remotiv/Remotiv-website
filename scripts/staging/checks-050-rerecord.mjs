// #50 final checks on REAL Supabase Storage with 066 on staging: the app's
// one-key-per-upload links (upsert:false), used as the browser does.
//
//   node --env-file=.env.staging scripts/staging/checks-050-rerecord.mjs
//
// A synthetic open async interview in a throwaway company; every object and
// row is removed at the end. Prints outcomes and sizes only: never a URL,
// token, key or connection string.
//
//   K1  a new upsert:false link used twice: the second upload is refused and
//       the first bytes stay
//   K2  re-record while the interview is open: a second key is uploaded, the
//       first key's file is removed (what confirm does), and the FIRST link is
//       used again. Reported: whether it recreates the file, and that the
//       re-recorded file (the one the answer points at) is untouched
//   K3  the same first link after the interview is submitted: refused (066)
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
const say = (k, v) => console.log(k.padEnd(64), typeof v === "string" ? v : JSON.stringify(v));
const pre = await psql(
  "select count(*) from pg_catalog.pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'interview_upload_open_session_only';",
);
if (pre.lines[0] !== "1") {
  console.log("STOP: 066 is not on staging.");
  process.exit(1);
}

const BUCKET = "interview-videos";
const bytes = (marker) =>
  new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode(marker)])], {
    type: "video/webm",
  });
const SIZES = { 9: "FIRST", 10: "SECOND", 12: "REPLACED", 13: "RECREATED" };
const stored = async (path) => {
  const [dir, name] = path.split("/");
  const { data } = await svc.storage.from(BUCKET).list(dir, { search: name });
  const o = (data ?? []).find((x) => x.name === name);
  return o ? (SIZES[o.metadata?.size] ?? `size ${o.metadata?.size}`) : "absent";
};
const out = (r) =>
  r.error ? `refused (${r.error.statusCode ?? r.error.status ?? r.error.name})` : "allowed";
// What upload-url does since #50: a fresh 32-hex key per upload, create only.
const keyedPath = (session) => `${session}/q1-${randomBytes(16).toString("hex")}.webm`;
const link = async (path) => {
  const r = await svc.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
  if (r.error) throw new Error(`sign: ${r.error.statusCode ?? r.error.status}`);
  return r.data.token;
};
const put = (path, token, marker) =>
  browser.storage.from(BUCKET).uploadToSignedUrl(path, token, bytes(marker));

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const session = randomUUID();
const paths = [];
try {
  const c = await svc.from("companies").insert({
    id: company,
    name: `check-050 ${tag}`,
    contact_email: `c050-${tag}@example.invalid`,
    must_change_password: false,
  });
  if (c.error) throw new Error(`company: ${c.error.code}`);
  const s = await psql(
    `insert into public.interview_sessions (id, company_id, kind, status, token_hash, expires_at, live_settings) values (${lit(session)}::uuid, ${lit(company)}::uuid, 'async', 'started', ${lit(randomBytes(32).toString("hex"))}, now() + interval '2 days', null);`,
  );
  if (!s.ok) throw new Error(`session: ${s.err}`);

  // ── K1 ──
  const p1 = keyedPath(session);
  paths.push(p1);
  const t1 = await link(p1);
  say("K1 keyed upsert:false link: first upload", out(await put(p1, t1, "FIRST")));
  say("K1 the same link again", out(await put(p1, t1, "REPLACED")));
  say("K1 stored", await stored(p1));

  // ── K2: re-record while open ──
  const p2 = keyedPath(session);
  paths.push(p2);
  say("K2 re-record: a second key, uploaded", out(await put(p2, await link(p2), "SECOND")));
  await svc.storage.from(BUCKET).remove([p1]);
  say("K2 after confirm removes the first file: first / second", [
    await stored(p1),
    await stored(p2),
  ]);
  say("K2 the FIRST link used again while open", out(await put(p1, t1, "RECREATED")));
  say("K2 then: first key / second key (the answer's file)", [await stored(p1), await stored(p2)]);

  // ── K3: after submit ──
  await svc.storage.from(BUCKET).remove([p1]);
  await psql(
    `update public.interview_sessions set status = 'submitted' where id = ${lit(session)}::uuid;`,
  );
  say("K3 submitted: the first link again", out(await put(p1, t1, "RECREATED")));
  say("K3 stored: first key / second key", [await stored(p1), await stored(p2)]);
} finally {
  await svc.storage.from(BUCKET).remove(paths);
  await psql(`delete from public.interview_sessions where id = ${lit(session)}::uuid;`);
  await svc.from("companies").delete().eq("id", company);
  say("cleanup", "objects, session and company removed");
}
