// Migration 066 proofs on REAL Supabase Storage (staging only), #50.
//
//   node --env-file=.env.staging scripts/staging/proofs-066.mjs
//
// Requires 066 applied on STAGING (the pre-flight stops otherwise), psql on
// PATH and STAGING_DATABASE_URL. Synthetic fixtures in a throwaway company,
// removed at the end. Every candidate upload is REAL: a signed upload link is
// minted by the service role and used from an anon client, as the browser
// does. Prints outcomes and sizes only: never a URL, token, key or address.
//
//   A  async answer (q paths):
//      A1 open session, upsert:true link: first upload allowed
//      A2 the same saved link again while still open: reported (066 does not
//         stop this; the #50 app change, one key per upload and
//         upsert:false, does)
//      A3 session submitted: the saved link's overwrite is refused, the
//         stored bytes are unchanged
//      A4 submitted within the last minute: no 30-minute grace for q paths
//      A5 object and session deleted: the saved link cannot recreate it
//   L  live pieces (v paths):
//      L1 open session, pending piece: allowed
//      L2 ended 10 minutes ago, pending piece: allowed (the window)
//      L3 ended 40 minutes ago, pending piece: refused
//      L4 inside the window but no pending piece for that path: refused
//      L5 a q (async) path on the ended live session: refused, the window is
//         for v paths only
//   S  server writes: S1 live turn audio after the interview and S2 another
//      bucket still work; turn audio is refused for S3 a permanently deleted
//      session and S4 a purged one (066's t-path rule)
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
const out = (r) =>
  r.error ? `refused (${r.error.statusCode ?? r.error.status ?? r.error.name})` : "allowed";
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
const otherPath = `zz-proof-066-${tag}/logo.webm`;
try {
  await must(
    svc.from("companies").insert({
      id: company,
      name: `proof-066 ${tag}`,
      contact_email: `p066-${tag}@example.invalid`,
      must_change_password: false,
    }),
    "company",
  );
  const session = async (kind, status, extra = "") => {
    const id = randomUUID();
    sessions.push(id);
    const r = await psql(
      `insert into public.interview_sessions (id, company_id, kind, status, token_hash, expires_at, live_settings${extra ? ", live_ended_at" : ""})
       values (${lit(id)}::uuid, ${lit(company)}::uuid, ${lit(kind)}, ${lit(status)}, ${lit(randomBytes(32).toString("hex"))}, now() + interval '2 days', ${kind === "live" ? "'{}'::jsonb" : "null"}${extra ? `, ${extra}` : ""});`,
    );
    if (!r.ok) throw new Error(`session: ${r.err}`);
    return id;
  };
  const piece = async (sid, index, status) => {
    const path = `${sid}/v${index}.webm`;
    const r = await psql(
      `insert into public.live_video_pieces (session_id, company_id, piece_index, status, media_path, mime_type)
       values (${lit(sid)}::uuid, ${lit(company)}::uuid, ${index}, ${lit(status)}, ${lit(path)}, 'video/webm');`,
    );
    if (!r.ok) throw new Error(`piece: ${r.err}`);
    paths.push(path);
    return path;
  };
  const setStatus = (sid, status) =>
    psql(
      `update public.interview_sessions set status = ${lit(status)} where id = ${lit(sid)}::uuid;`,
    );

  // ── A: async ──
  const a = await session("async", "started");
  const qa = `${a}/q1.webm`;
  paths.push(qa);
  const saved = await link(qa, true);
  say("A1 open async, upsert:true link, first upload", out(await put(qa, saved, "FIRST")));
  say("A2 same saved link again while OPEN (066 allows; app change stops)", [
    out(await put(qa, saved, "REPLACED")),
    await stored(qa),
  ]);
  await setStatus(a, "submitted");
  say("A3 submitted: saved link overwrite / stored now", [
    out(await put(qa, saved, "RECREATED")),
    await stored(qa),
  ]);
  const a4 = await session("async", "started");
  const qa4 = `${a4}/q1.webm`;
  paths.push(qa4);
  const saved4 = await link(qa4, false);
  await setStatus(a4, "submitted");
  say("A4 submitted seconds ago: q path gets no grace", out(await put(qa4, saved4, "FIRST")));
  await svc.storage.from(BUCKET).remove([qa]);
  await psql(`delete from public.interview_sessions where id = ${lit(a)}::uuid;`);
  say("A5 deleted object and session: saved link recreate / stored", [
    out(await put(qa, saved, "RECREATED")),
    await stored(qa),
  ]);

  // ── L: live ──
  // Pieces are reserved while the interview runs (live_video_pieces_guard
  // refuses a reservation after it ends), then the interview is ended.
  // live_ended_at is stamped by the database (044's trigger sets now() on any
  // end), so a past end is written with this session's triggers off, for this
  // one synthetic row only. Read back to prove it took.
  const endAgo = async (sid, minutes) => {
    const r = await psql(
      `begin; set local session_replication_role = replica; update public.interview_sessions set status = 'submitted', live_ended_at = now() - interval '${minutes} minutes' where id = ${lit(sid)}::uuid; commit; select round(extract(epoch from now() - live_ended_at) / 60) from public.interview_sessions where id = ${lit(sid)}::uuid;`,
    );
    if (!r.ok) throw new Error(`end: ${r.err}`);
    return Number(r.lines[0]);
  };
  const lOpen = await session("live", "started");
  const v0 = await piece(lOpen, 0, "pending");
  say("L1 open live, pending piece", out(await put(v0, await link(v0, false), "LIVE")));
  const lEnded = await session("live", "started");
  const v1 = await piece(lEnded, 1, "pending");
  say("L2 fixture: ended minutes ago", await endAgo(lEnded, 10));
  say("L2 ended 10 min ago, pending piece", out(await put(v1, await link(v1, false), "LIVE")));
  const lLate = await session("live", "started");
  const v2 = await piece(lLate, 2, "pending");
  say("L3 fixture: ended minutes ago", await endAgo(lLate, 40));
  say("L3 ended 40 min ago, pending piece", out(await put(v2, await link(v2, false), "LIVE")));
  const v3 = `${lEnded}/v3.webm`;
  paths.push(v3);
  say(
    "L4 inside the window, no pending piece for that path",
    out(await put(v3, await link(v3, false), "LIVE")),
  );
  const q5 = `${lEnded}/q1.webm`;
  paths.push(q5);
  say(
    "L5 q path on the ended live session (window is v only)",
    out(await put(q5, await link(q5, false), "FIRST")),
  );

  // ── S: server writes ──
  const t1 = `${lLate}/t1.${randomBytes(8).toString("hex")}.webm`;
  paths.push(t1);
  say(
    "S1 server turn audio after the interview (service upload)",
    out(await svc.storage.from(BUCKET).upload(t1, bytes("SERVER!"), { contentType: "video/webm" })),
  );
  say(
    "S2 another bucket, q-shaped name (service upload)",
    out(
      await svc.storage
        .from("company-logos")
        .upload(otherPath, bytes("SERVER!"), { contentType: "video/webm" }),
    ),
  );

  // S3: the server's delayed turn audio after the session is permanently
  // deleted (live-ingest reads the row, then uploads; a delete in between).
  const gone = await session("live", "started");
  await psql(`delete from public.interview_sessions where id = ${lit(gone)}::uuid;`);
  const t3 = `${gone}/t1.${randomBytes(8).toString("hex")}.webm`;
  paths.push(t3);
  say(
    "S3 server turn audio for a DELETED session (service upload)",
    out(await svc.storage.from(BUCKET).upload(t3, bytes("SERVER!"), { contentType: "video/webm" })),
  );

  // S4: turn audio for a PURGED live interview (purged_at set by the purge).
  const purged = await session("live", "started");
  const marked = await psql(
    `begin; set local session_replication_role = replica; update public.interview_sessions set status = 'submitted', live_ended_at = now() - interval '2 days', purged_at = now() where id = ${lit(purged)}::uuid; commit; select (purged_at is not null) from public.interview_sessions where id = ${lit(purged)}::uuid;`,
  );
  say("S4 fixture: purged", marked.lines[0] === "t");
  const t4 = `${purged}/t1.${randomBytes(8).toString("hex")}.webm`;
  paths.push(t4);
  say(
    "S4 server turn audio for a PURGED session (service upload)",
    out(await svc.storage.from(BUCKET).upload(t4, bytes("SERVER!"), { contentType: "video/webm" })),
  );
} finally {
  await svc.storage.from(BUCKET).remove(paths);
  await svc.storage.from("company-logos").remove([otherPath]);
  await psql(
    `delete from public.interview_sessions where id in (${sessions.map((s) => `${lit(s)}::uuid`).join(", ") || "null"});`,
  );
  await svc.from("companies").delete().eq("id", company);
  say("cleanup", "objects, sessions, pieces and company removed");
}
