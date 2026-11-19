// #50 design checks on REAL Supabase Storage (staging only). Read and write
// only throwaway objects under a random folder in the interview bucket; every
// object is removed at the end. No migration is applied: question 2 is shown
// on a TEMPORARY table inside a transaction that is rolled back.
//
//   node --env-file=.env.staging scripts/staging/checks-050-uploads.mjs
//
// Prints outcomes only: never a URL, token, key or connection string.
//
//   Q1  an upsert:true signed upload link, used once, can be used AGAIN to
//       overwrite the object (and how long the link lives)
//   Q1b the same with upsert:false: the second upload is refused
//   Q2  Postgres fires a BEFORE INSERT row trigger on INSERT ... ON CONFLICT
//       DO UPDATE even when the row conflicts (the statement Storage uses, read
//       from pg_stat_statements), so such a trigger blocks overwrites too
//   Q4  after the object is deleted, an old link (upsert false and true)
//       recreates it
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const { createClient } = createRequire(import.meta.url)("@supabase/supabase-js");
const DB = process.env.STAGING_DATABASE_URL;
if (!DB || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  console.log("REFUSED: staging credentials are required (.env.staging)");
  process.exit(1);
}
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  opts,
);
// The candidate's side: the anon key, as the browser holds it.
const browser = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  opts,
);
const sentinel = await svc.schema("staging_guard").from("sentinel").select("*");
if (sentinel.error || !JSON.stringify(sentinel.data ?? []).includes("Synthetic data only")) {
  console.log("REFUSED: the staging sentinel is not readable; this is not staging");
  process.exit(1);
}

const BUCKET = "interview-videos";
const say = (k, v) => console.log(k.padEnd(64), typeof v === "string" ? v : JSON.stringify(v));
const out = (r) =>
  r.error ? `refused (${r.error.statusCode ?? r.error.status ?? r.error.name})` : "ok";
// A minimal WebM header followed by a marker, so the stored bytes can be told apart.
const bytes = (marker) =>
  new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode(marker)])], {
    type: "video/webm",
  });
// Read from the object LISTING, not a download: downloads can be served from
// the CDN cache and show bytes that are no longer stored. The marker lengths
// differ, so the size tells which bytes are there (FIRST 9, REPLACED 12,
// RECREATED 13).
const SIZES = { 9: "FIRST", 12: "REPLACED", 13: "RECREATED" };
const read = async (path) => {
  const [dir, name] = path.split("/");
  const { data, error } = await svc.storage.from(BUCKET).list(dir, { search: name });
  if (error) return `unreadable (${error.statusCode ?? error.name})`;
  const o = (data ?? []).find((x) => x.name === name);
  return o ? (SIZES[o.metadata?.size] ?? `size ${o.metadata?.size}`) : "absent";
};
const lifeMinutes = (signedUrl) => {
  const t = new URL(signedUrl).searchParams.get("token") ?? "";
  const claims = JSON.parse(Buffer.from(t.split(".")[1] ?? "", "base64url").toString() || "{}");
  return claims.exp && claims.iat ? Math.round((claims.exp - claims.iat) / 60) : "unknown";
};

const folder = `zz-check-050-${randomUUID()}`;
const paths = [];
try {
  // ── Q1: upsert true ──
  const p1 = `${folder}/q1.webm`;
  paths.push(p1);
  const s1 = await svc.storage.from(BUCKET).createSignedUploadUrl(p1, { upsert: true });
  say("Q1 upsert:true link: minted / lifetime (minutes)", [
    out(s1),
    lifeMinutes(s1.data.signedUrl),
  ]);
  say(
    "Q1 first upload",
    out(await browser.storage.from(BUCKET).uploadToSignedUrl(p1, s1.data.token, bytes("FIRST"))),
  );
  say("Q1 stored", await read(p1));
  say(
    "Q1 SAME link again with other bytes",
    out(await browser.storage.from(BUCKET).uploadToSignedUrl(p1, s1.data.token, bytes("REPLACED"))),
  );
  say("Q1 stored now", await read(p1));

  // ── Q1b: upsert false ──
  const p2 = `${folder}/q2.webm`;
  paths.push(p2);
  const s2 = await svc.storage.from(BUCKET).createSignedUploadUrl(p2, { upsert: false });
  say(
    "Q1b upsert:false link: first upload",
    out(await browser.storage.from(BUCKET).uploadToSignedUrl(p2, s2.data.token, bytes("FIRST"))),
  );
  say(
    "Q1b SAME link again with other bytes",
    out(await browser.storage.from(BUCKET).uploadToSignedUrl(p2, s2.data.token, bytes("REPLACED"))),
  );
  say("Q1b stored", await read(p2));

  // ── Q4: delete, then the old links ──
  say("Q4 delete", out(await svc.storage.from(BUCKET).remove([p1, p2])));
  say("Q4 after delete: stored q1 / q2", [await read(p1), await read(p2)]);
  say(
    "Q4 old upsert:true link after delete",
    out(
      await browser.storage.from(BUCKET).uploadToSignedUrl(p1, s1.data.token, bytes("RECREATED")),
    ),
  );
  say(
    "Q4 old upsert:false link after delete",
    out(
      await browser.storage.from(BUCKET).uploadToSignedUrl(p2, s2.data.token, bytes("RECREATED")),
    ),
  );
  say("Q4 stored q1 / q2", [await read(p1), await read(p2)]);
} finally {
  await svc.storage.from(BUCKET).remove(paths);
  const left = await svc.storage.from(BUCKET).list(folder);
  say("cleanup: objects left in the throwaway folder", (left.data ?? []).length);
}

// ── Q2: the trigger semantics, on a temporary table, rolled back ──
const q2 = await new Promise((resolve) => {
  const p = spawn("psql", [DB, "-X", "-q", "-A", "-t"], { stdio: ["pipe", "pipe", "pipe"] });
  let o = "";
  p.stdout.on("data", (d) => (o += d));
  p.stderr.on("data", (d) => (o += d));
  p.on("close", () => resolve(o.replace(/postgres(ql)?:\/\/\S+/g, "<db>")));
  p.stdin.end(`
begin;
create temporary table t050 (k text primary key, v text) on commit drop;
insert into t050 values ('q1', 'FIRST');
create function pg_temp.refuse() returns trigger language plpgsql as $$ begin raise exception 'refused by BEFORE INSERT'; end $$;
create trigger t050_refuse before insert on t050 for each row execute function pg_temp.refuse();
savepoint a;
insert into t050 values ('q1', 'REPLACED') on conflict (k) do update set v = excluded.v;
rollback to savepoint a;
select 'Q2 row after the refused upsert: ' || v from t050 where k = 'q1';
savepoint b;
insert into t050 values ('q9', 'NEW');
rollback to savepoint b;
select 'Q2 new rows after the refused insert: ' || count(*) from t050 where k = 'q9';
rollback;
select 'Q2 Storage writes objects with: ' || case when exists (
  select 1 from pg_stat_statements
   where query ilike 'INSERT INTO storage.objects%ON CONFLICT%DO UPDATE%') then 'INSERT ... ON CONFLICT DO UPDATE' else 'not seen' end;
`);
});
for (const line of q2.split("\n").filter(Boolean)) {
  console.log(line.startsWith("ERROR") ? `Q2 psql: ${line.slice(0, 80)}` : line);
}
