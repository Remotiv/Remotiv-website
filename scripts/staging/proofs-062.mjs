// Migration 062 proofs on a REAL Postgres (staging only): the inviter check and
// the grant are one transaction, in both concurrent orders (#49).
//
//   node --env-file=.env.staging scripts/staging/proofs-062.mjs
//
// Requires 062 applied on staging (the pre-flight stops otherwise), psql on
// PATH, and STAGING_DATABASE_URL. Synthetic fixtures in a throwaway company,
// removed at the end. Prints outcome words, durations and row counts only:
// never a token, a connection string or an address.
//
//   A  demotion wins: session 1 demotes the inviter and holds its transaction;
//      session 2 calls accept_company_invite, BLOCKS on the inviter's row, and
//      when session 1 commits gets 'inviter_invalid'. Invite still pending, no
//      membership.
//   B  acceptance wins: session 1 calls the function and holds its
//      transaction; session 2's demotion BLOCKS until it commits. The
//      membership was granted while the inviter was still an admin.
//   C  refusals: email_mismatch, user_mismatch, inviter_invalid (NULL), invalid.
//   D  privileges: anon and authenticated cannot execute it.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

/** Run SQL in its own psql session; resolves with stdout lines and the duration. */
function psql(sql) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const p = spawn("psql", [DB, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0)
        reject(
          new Error(
            `psql exit ${code}: ${err.split("\n")[0].replace(/postgres(ql)?:\/\/\S+/g, "<db>")}`,
          ),
        );
      else resolve({ lines: out.trim().split("\n").filter(Boolean), ms: Date.now() - t });
    });
    p.stdin.end(sql);
  });
}
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const say = (k, v) => console.log(k.padEnd(64), typeof v === "string" ? v : JSON.stringify(v));

const pre = await psql(
  "select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'accept_company_invite';",
);
if (pre.lines[0] !== "1") {
  console.log("STOP: public.accept_company_invite is not on staging. Apply 062 first.");
  process.exit(1);
}

// ── Fixtures: a throwaway company, an owner, an admin inviter, and joiners ──
const tag = randomBytes(3).toString("hex");
const mkUser = async (who) => {
  const email = `p062-${who}-${tag}@example.invalid`;
  const r = await svc.auth.admin.createUser({
    email,
    password: randomBytes(18).toString("base64url"),
    email_confirm: true,
  });
  if (r.error) throw new Error(`createUser ${who}: ${r.error.code ?? r.error.status}`);
  return { id: r.data.user.id, email };
};
const company = randomUUID();
const users = {};
const xMember = randomUUID();
try {
  Object.assign(users, {
    owner: await mkUser("owner"),
    x: await mkUser("x"),
    j1: await mkUser("j1"),
    j2: await mkUser("j2"),
    other: await mkUser("other"),
  });
  const must = async (q, what) => {
    const r = await q;
    if (r.error) throw new Error(`${what}: ${r.error.code}`);
    return r.data;
  };
  await must(
    svc.from("companies").insert({
      id: company,
      name: `proof-062 ${tag}`,
      contact_email: `p062-${tag}@example.invalid`,
      must_change_password: false,
    }),
    "company",
  );
  await must(
    svc.from("company_members").insert([
      {
        id: randomUUID(),
        company_id: company,
        user_id: users.owner.id,
        role: "owner",
        status: "active",
        name: "P owner",
        email: users.owner.email,
      },
      {
        id: xMember,
        company_id: company,
        user_id: users.x.id,
        role: "admin",
        status: "active",
        name: "P admin X",
        email: users.x.email,
      },
    ]),
    "members",
  );
  const mkInvite = async (email, invitedBy = users.x.id) => {
    const raw = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(raw).digest("hex");
    await must(
      svc.from("company_invites").insert({
        company_id: company,
        email,
        role: "recruiter",
        token_hash: hash,
        status: "pending",
        invited_by: invitedBy,
        expires_at: new Date(Date.now() + 864e5).toISOString(),
      }),
      "invite",
    );
    return hash;
  };
  const call = (hash, u, emailOverride) =>
    `select public.accept_company_invite(${lit(hash)}, ${lit(u.id)}::uuid, 'Proof', ${lit(emailOverride ?? u.email)});`;
  const counts = async (hash, joiner) => ({
    invite: (
      await psql(`select status from public.company_invites where token_hash = ${lit(hash)};`)
    ).lines[0],
    joinerMemberships: Number(
      (
        await psql(
          `select count(*) from public.company_members where company_id = ${lit(company)}::uuid and user_id = ${lit(joiner.id)}::uuid and status = 'active';`,
        )
      ).lines[0],
    ),
    inviterRole: (
      await psql(`select role from public.company_members where id = ${lit(xMember)}::uuid;`)
    ).lines[0],
  });
  const setInviter = (role) =>
    psql(`update public.company_members set role = ${lit(role)} where id = ${lit(xMember)}::uuid;`);

  // ── A: demotion wins ──
  const hA = await mkInvite(users.j1.email);
  say("A before", await counts(hA, users.j1));
  const s1 = psql(
    `begin; update public.company_members set role = 'recruiter' where id = ${lit(xMember)}::uuid; select pg_catalog.pg_sleep(3); commit;`,
  );
  await new Promise((r) => setTimeout(r, 1000));
  const s2 = await psql(call(hA, users.j1));
  await s1;
  say("A session 2 (accept) outcome / waited ms", [s2.lines[0], s2.ms]);
  say("A after", await counts(hA, users.j1));
  await setInviter("admin");

  // ── B: acceptance wins ──
  const hB = await mkInvite(users.j2.email);
  say("B before", await counts(hB, users.j2));
  const b1 = psql(`begin; ${call(hB, users.j2)} select pg_catalog.pg_sleep(3); commit;`);
  await new Promise((r) => setTimeout(r, 1000));
  const b2 = await psql(
    `update public.company_members set role = 'recruiter' where id = ${lit(xMember)}::uuid;`,
  );
  const b1r = await b1;
  say("B session 1 (accept) outcome", b1r.lines[0]);
  say("B session 2 (demotion) waited ms", b2.ms);
  say("B after", await counts(hB, users.j2));
  await setInviter("admin");

  // ── C: refusals ──
  const hC = await mkInvite(users.other.email);
  say(
    "C email_mismatch",
    (await psql(call(hC, users.other, `someone-else-${tag}@example.invalid`))).lines[0],
  );
  say(
    "C user_mismatch (another user's id)",
    (await psql(call(hC, users.j1, users.other.email))).lines[0],
  );
  const hN = await mkInvite(users.other.email, null);
  say("C inviter NULL", (await psql(call(hN, users.other))).lines[0]);
  say("C unknown token", (await psql(call("0".repeat(64), users.other))).lines[0]);
  say(
    "C invites still pending (3: A's refused + C's two)",
    (
      await psql(
        `select count(*) from public.company_invites where company_id = ${lit(company)}::uuid and status = 'pending';`,
      )
    ).lines[0],
  );

  // ── D: privileges ──
  say(
    "D execute: anon / authenticated / service_role",
    (
      await psql(
        "select pg_catalog.has_function_privilege('anon', 'public.accept_company_invite(text, uuid, text, text)', 'execute') || '/' || pg_catalog.has_function_privilege('authenticated', 'public.accept_company_invite(text, uuid, text, text)', 'execute') || '/' || pg_catalog.has_function_privilege('service_role', 'public.accept_company_invite(text, uuid, text, text)', 'execute');",
      )
    ).lines[0],
  );
} finally {
  // Clean up: the company cascades its members and invites; then the users.
  await svc.from("companies").delete().eq("id", company);
  for (const u of Object.values(users)) await svc.auth.admin.deleteUser(u.id);
  say("cleanup", "company and users removed");
}
