// #55 proof on REAL staging: the company CV route keeps one company's CV files
// away from everyone who is not entitled to them, and never hands the browser
// a signed storage URL (#99).
//
//   npm run staging:app                      (in another terminal, first)
//   PROOF_055_LOG_ROWS=keep node --env-file=.env.staging scripts/staging/proofs-055.mjs
//
// #40 could only show 404s because staging held no CV files: a 404 for "not
// yours" and a 404 for "no file" looked the same. This uploads ONE synthetic
// PDF so every refusal below is compared against a request for the same file
// that succeeds.
//
// ── What it writes, and what it cannot take back ─────────────
//
// Written (service role, after openStaging's checks): one object in the
// `cvs` bucket under a random proofs-055/ folder, and three synthetic
// job_applications rows that point at it. All four are removed in `finally`,
// whatever happened, and a re-read must find none of them.
//
// NOT removable: the route writes one signed_url_logs row per successful open
// (route.ts step 6, awaited and fail-closed), and that table is append-only
// (migration 047: a row may be deleted only by purge_expired_access_logs(),
// and only once it is 24 months old; granted_at is stamped now() on insert).
// Three successful opens leave three rows naming the two staging test
// accounts and application ids that no longer exist. The script therefore
// REFUSES TO START unless PROOF_055_LOG_ROWS=keep says that has been
// accepted. It never disables a trigger or changes session_replication_role.
//
// ── The cases ────────────────────────────────────────────────
//
//   A1  owner, own company, scoped job          -> 200, the uploaded bytes
//   A2  recruiter on that job                    -> 200, the uploaded bytes
//   A3  owner, own company, a job the recruiter is NOT on -> 200 (the file is
//       there, so A4's 404 is the job gate and not a missing file)
//   A4  recruiter, that other job                -> 404 "not in your workspace"
//   A5  owner, an application whose company is ANOTHER company -> 404, body
//       byte-identical to A4's. Staging has no company-B account and creating
//       an auth user is outside the approved write, so this is the same check
//       (route.ts:99, company_id_snapshot !== ctx.companyId) seen from A's side
//   A6  signed out                               -> 403, nothing served
//   S1  #99, on every response: no Location header, no redirect, nothing in
//       any header or body that looks like a storage URL or token; 200s are
//       application/pdf, private no-store, and exactly the uploaded bytes
//   L1  signed_url_logs rows for the synthetic ids: one per 200, none for a
//       refusal
//
// Prints case names, status codes, counts and PASS/FAIL. Never an id, a path,
// an email, a URL, a token or a connection string.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { proveAppIdentity } from "./app-identity.mjs";
import { loadPin, openStaging, signInStagingAccount } from "./guard.mjs";
import { sessionCookieHeader } from "./probe-session.mjs";

if (process.env.PROOF_055_LOG_ROWS !== "keep") {
  console.log(
    "REFUSED before any write: each successful CV open leaves a signed_url_logs row that " +
      "cannot be deleted (append-only, migration 047). Set PROOF_055_LOG_ROWS=keep to accept " +
      "the 3 rows this run leaves.",
  );
  process.exit(1);
}

const { service } = await openStaging({ intent: "harness" });
const BASE = process.env.STAGING_BASE_URL;
const APP_URL = process.env.STAGING_APP_SUPABASE_URL;
if (!BASE || !APP_URL) {
  console.log("REFUSED: STAGING_BASE_URL and STAGING_APP_SUPABASE_URL are required");
  process.exit(1);
}

const owner = await signInStagingAccount({
  emailVar: "STAGING_TEST_EMAIL",
  passwordVar: "STAGING_TEST_PASSWORD",
});
const scoped = await signInStagingAccount({
  emailVar: "STAGING_SCOPED_EMAIL",
  passwordVar: "STAGING_SCOPED_PASSWORD",
});
const ownerCookie = sessionCookieHeader(owner.session, APP_URL);
const scopedCookie = sessionCookieHeader(scoped.session, APP_URL);

// The running app must be the staging app before any request carries a file.
await proveAppIdentity({ baseUrl: BASE, cookie: ownerCookie, pin: loadPin(), appUrl: APP_URL });
console.log("app identity: the running app is the pinned staging project");

// ── The fixture, read from staging (not assumed from the manifest) ──
const manifest = JSON.parse(readFileSync(new URL("./seed-manifest.json", import.meta.url), "utf8"));
const COMPANY = manifest.companyId;
const { data: member, error: memberErr } = await service
  .from("company_members")
  .select("id, role")
  .eq("company_id", COMPANY)
  .eq("user_id", scoped.userId)
  .eq("status", "active")
  .maybeSingle();
if (memberErr || !member || member.role !== "recruiter") {
  console.log("REFUSED: the scoped account is not an active recruiter of the fixture company");
  process.exit(1);
}
const { data: team, error: teamErr } = await service
  .from("job_hiring_team")
  .select("job_id")
  .eq("company_id", COMPANY)
  .eq("member_id", member.id);
const { data: jobs, error: jobsErr } = await service
  .from("jobs")
  .select("id")
  .eq("company_id", COMPANY)
  .is("deleted_at", null);
if (teamErr || jobsErr) {
  console.log("REFUSED: the hiring team or the jobs could not be read");
  process.exit(1);
}
const teamJobs = new Set((team ?? []).map((r) => r.job_id));
const onJob = (jobs ?? []).find((j) => teamJobs.has(j.id))?.id;
const offJob = (jobs ?? []).find((j) => !teamJobs.has(j.id))?.id;
if (!onJob || !offJob) {
  console.log("REFUSED: need one fixture job the recruiter is on and one they are not");
  process.exit(1);
}
console.log(
  `fixture: recruiter is on ${teamJobs.size} job(s); one on-team and one off-team job chosen`,
);

// ── The writes ──
const TAG = randomUUID();
const PATH = `proofs-055/${TAG}.pdf`;
const OTHER_COMPANY = randomUUID(); // company_id_snapshot has no foreign key
const PDF = Buffer.from(
  `%PDF-1.4\n% proofs-055 synthetic ${TAG}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`,
);
const ids = { onTeam: randomUUID(), offTeam: randomUUID(), otherCompany: randomUUID() };
const row = (id, job_id, company_id_snapshot) => ({
  id,
  first_name: "Synthetic",
  last_name: "Proof055",
  email: `p055-${TAG.slice(0, 8)}@example.invalid`,
  job_id,
  company_id_snapshot,
  cv_path: PATH,
  cv_text_status: "skipped",
  source: "job_application",
});
const allIds = Object.values(ids);

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const SIGNED_URL = /\/storage\/v1\/object\/sign|[?&]token=|X-Amz-Signature/i;

async function open(cookie, id) {
  const res = await fetch(`${BASE}/api/cv/company-application/${id}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const headerText = [...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n");
  const leak =
    res.headers.has("location") ||
    SIGNED_URL.test(headerText) ||
    SIGNED_URL.test(bytes.toString("latin1"));
  return { status: res.status, headers: res.headers, bytes, leak };
}

let uploaded = false;
try {
  const { error: upErr } = await service.storage
    .from("cvs")
    .upload(PATH, PDF, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new Error(`upload refused (${upErr.statusCode ?? "error"})`);
  uploaded = true;
  const { error: insErr } = await service
    .from("job_applications")
    .insert([
      row(ids.onTeam, onJob, COMPANY),
      row(ids.offTeam, offJob, COMPANY),
      row(ids.otherCompany, onJob, OTHER_COMPANY),
    ]);
  if (insErr) throw new Error(`fixture insert refused (${insErr.code ?? "error"})`);
  console.log("wrote: 1 object, 3 synthetic applications\n");

  const served = (r) =>
    r.status === 200 &&
    r.headers.get("content-type") === "application/pdf" &&
    r.headers.get("cache-control") === "private, no-store" &&
    r.bytes.equals(PDF);

  const a1 = await open(ownerCookie, ids.onTeam);
  check("A1 owner, own job", served(a1), `status ${a1.status}`);
  const a2 = await open(scopedCookie, ids.onTeam);
  check("A2 recruiter on the job", served(a2), `status ${a2.status}`);
  const a3 = await open(ownerCookie, ids.offTeam);
  check("A3 owner, the other job (file present)", served(a3), `status ${a3.status}`);
  const a4 = await open(scopedCookie, ids.offTeam);
  check("A4 recruiter NOT on the job", a4.status === 404, `status ${a4.status}`);
  const a5 = await open(ownerCookie, ids.otherCompany);
  check("A5 another company's application", a5.status === 404, `status ${a5.status}`);
  check(
    "A5 body byte-identical to A4",
    a4.bytes.equals(a5.bytes),
    `${a4.bytes.length} and ${a5.bytes.length} bytes`,
  );
  check("A4/A5 serve no PDF bytes", !a4.bytes.includes(PDF) && !a5.bytes.includes(PDF));
  const a6 = await open(null, ids.onTeam);
  check("A6 signed out", a6.status === 403 && !a6.bytes.includes(PDF), `status ${a6.status}`);

  const all = [a1, a2, a3, a4, a5, a6];
  check(
    "S1 no Location header, redirect or storage URL/token in any response",
    all.every((r) => !r.leak && r.status !== 301 && r.status !== 302 && r.status !== 307),
    `${all.length} responses`,
  );

  const { count: logs, error: logErr } = await service
    .from("signed_url_logs")
    .select("id", { count: "exact", head: true })
    .in("candidate_id", allIds);
  check(
    "L1 one access log row per 200, none for a refusal",
    !logErr && logs === 3,
    `${logErr ? "unreadable" : logs} row(s)`,
  );
} catch (err) {
  failures += 1;
  console.log(`FAIL  run stopped: ${err.message}`);
} finally {
  // Applications first, then the object; each is re-read below.
  await service.from("job_applications").delete().in("id", allIds);
  if (uploaded) await service.storage.from("cvs").remove([PATH]);

  const { count: appsLeft, error: appsErr } = await service
    .from("job_applications")
    .select("id", { count: "exact", head: true })
    .in("id", allIds);
  const { data: objs, error: objErr } = await service.storage
    .from("cvs")
    .list("proofs-055", { search: TAG });
  const { count: logsLeft } = await service
    .from("signed_url_logs")
    .select("id", { count: "exact", head: true })
    .in("candidate_id", allIds);
  const clean = !appsErr && appsLeft === 0 && !objErr && (objs ?? []).length === 0;
  check(
    "CLEAN synthetic applications and the object are gone",
    clean,
    `${appsErr ? "unreadable" : appsLeft} application(s), ${objErr ? "unreadable" : (objs ?? []).length} object(s)`,
  );
  console.log(
    `KEPT  ${logsLeft ?? "unknown"} signed_url_logs row(s), append-only (PROOF_055_LOG_ROWS=keep)`,
  );
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
