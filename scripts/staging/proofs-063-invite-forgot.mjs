// #63 proofs on REAL Supabase Auth and the real 062 grant (staging only):
// "Forgot your password?" on the invitation page.
//
//   node --env-file=.env.staging scripts/staging/proofs-063-invite-forgot.mjs
//
// The calls accept/actions.ts makes on that path, in its order:
// auth.admin.generateLink (type magiclink: the code, and NO email), our invite
// email rendered by the real template with the send FAKED (nothing leaves),
// verifyOtp (type email) on a cookie-less anon client with the code read back
// OUT OF that email, updateUserById with the new password, then
// accept_company_invite. The old password is never checked. Synthetic
// fixtures in a throwaway company, removed at the end. Prints outcome words
// and counts only: never a code, token, address, password or key.
//
//   R  an account with a password: a wrong code writes nothing and the old
//      password still works; the right code sets the new password, the old
//      one stops working, the new one works, the grant joins
//   P  an account with NO password (code sign-in only): the same path joins
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire, register } from "node:module";

register(new URL("../../src/test-support/node-resolve.mjs", import.meta.url));
const { inviteCodeSubject, renderInviteCodeEmail } = await import(
  "../../src/lib/email/templates/invite-code.ts"
);
const { createClient } = createRequire(import.meta.url)("@supabase/supabase-js");
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !ANON || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log(
    "REFUSED: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required (.env.staging)",
  );
  process.exit(1);
}
const noSession = { auth: { persistSession: false, autoRefreshToken: false } };
const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, noSession);
const anon = () => createClient(URL_, ANON, noSession);
const sentinel = await svc.schema("staging_guard").from("sentinel").select("*");
if (sentinel.error || !JSON.stringify(sentinel.data ?? []).includes("Synthetic data only")) {
  console.log("REFUSED: the staging sentinel is not readable; this is not staging");
  process.exit(1);
}

const say = (k, v) => console.log(k.padEnd(62), typeof v === "string" ? v : JSON.stringify(v));
const code = (r) => r.error?.code ?? r.error?.status ?? "ok";
const must = async (q, what) => {
  const r = await q;
  if (r.error) throw new Error(`${what}: ${r.error.code ?? r.error.status}`);
  return r.data;
};
const signsIn = async (email, password) =>
  code(await anon().auth.signInWithPassword({ email, password }));

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const companyName = `proof-063 ${tag}`;
const userIds = [];
const outbox = [];
try {
  const owner = await must(
    svc.auth.admin.createUser({
      email: `p063-owner-${tag}@example.invalid`,
      password: randomBytes(18).toString("base64url"),
      email_confirm: true,
    }),
    "owner",
  );
  userIds.push(owner.user.id);
  await must(
    svc.from("companies").insert({
      id: company,
      name: companyName,
      contact_email: `p063-${tag}@example.invalid`,
      must_change_password: false,
    }),
    "company",
  );
  await must(
    svc.from("company_members").insert({
      id: randomUUID(),
      company_id: company,
      user_id: owner.user.id,
      role: "owner",
      status: "active",
      name: "P owner",
      email: owner.user.email,
    }),
    "owner membership",
  );
  const mkInvite = async (email) => {
    const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
    await must(
      svc.from("company_invites").insert({
        company_id: company,
        email,
        role: "recruiter",
        token_hash: hash,
        status: "pending",
        invited_by: owner.user.id,
        expires_at: new Date(Date.now() + 864e5).toISOString(),
      }),
      "invite",
    );
    return hash;
  };
  const state = async (hash, userId) => ({
    invite: (await svc.from("company_invites").select("status").eq("token_hash", hash).single())
      .data?.status,
    memberships: (
      await svc
        .from("company_members")
        .select("id", { count: "exact", head: true })
        .eq("company_id", company)
        .eq("user_id", userId)
    ).count,
  });
  /** The send step with the email faked: the code the person would type, read from our email. */
  const issue = async (email) => {
    const minted = (await must(svc.auth.admin.generateLink({ type: "magiclink", email }), "code"))
      .properties.email_otp;
    const html = renderInviteCodeEmail({ companyName, code: minted });
    outbox.push({ to: email, subject: inviteCodeSubject(companyName) });
    return /letter-spacing: 8px;">(\d+)</.exec(html)?.[1] ?? "";
  };
  /** The final step of the forgot path: code, then the new password, then the grant. */
  const forgot = async (email, hash, typed, newPassword) => {
    const v = await anon().auth.verifyOtp({ email, token: typed, type: "email" });
    if (v.error || !v.data.user) return { step: "code", outcome: code(v) };
    if (v.data.user.email !== email) return { step: "address", outcome: "mismatch" };
    const set = await svc.auth.admin.updateUserById(v.data.user.id, { password: newPassword });
    if (set.error) return { step: "password", outcome: code(set) };
    const granted = (
      await svc.rpc("accept_company_invite", {
        p_token_hash: hash,
        p_user_id: v.data.user.id,
        p_name: "Proof",
        p_email: email,
      })
    ).data;
    return { step: "grant", outcome: granted };
  };

  // ── R: an account with a password ──
  const rEmail = `p063-pw-${tag}@example.invalid`;
  const oldPassword = randomBytes(12).toString("base64url");
  const newPassword = randomBytes(12).toString("base64url");
  const rUser = (
    await must(
      svc.auth.admin.createUser({ email: rEmail, password: oldPassword, email_confirm: true }),
      "existing",
    )
  ).user;
  userIds.push(rUser.id);
  const rHash = await mkInvite(rEmail);
  const rCode = await issue(rEmail);
  say("R code length", rCode.length);
  const wrong = await forgot(rEmail, rHash, rCode === "000000" ? "111111" : "000000", newPassword);
  say("R wrong code: stopped at / outcome", [wrong.step, wrong.outcome]);
  say("R after the wrong code: invite / memberships", await state(rHash, rUser.id));
  say("R after the wrong code: old password / new password", [
    await signsIn(rEmail, oldPassword),
    await signsIn(rEmail, newPassword),
  ]);
  const right = await forgot(rEmail, rHash, rCode, newPassword);
  say("R right code: reached / outcome", [right.step, right.outcome]);
  say("R after: invite / memberships", await state(rHash, rUser.id));
  say("R after: old password / new password", [
    await signsIn(rEmail, oldPassword),
    await signsIn(rEmail, newPassword),
  ]);

  // ── P: an account with no password ──
  const pEmail = `p063-nopw-${tag}@example.invalid`;
  const pUser = (
    await must(svc.auth.admin.createUser({ email: pEmail, email_confirm: true }), "no password")
  ).user;
  userIds.push(pUser.id);
  const pHash = await mkInvite(pEmail);
  const pPassword = randomBytes(12).toString("base64url");
  const p = await forgot(pEmail, pHash, await issue(pEmail), pPassword);
  say("P no-password account: reached / outcome", [p.step, p.outcome]);
  say("P after: invite / memberships / password signs in", [
    ...Object.values(await state(pHash, pUser.id)),
    await signsIn(pEmail, pPassword),
  ]);

  say("O emails faked / each to the address its code was minted for", [
    outbox.length,
    outbox.every((m, i) => m.to === [rEmail, pEmail][i]),
  ]);
} finally {
  await svc.from("companies").delete().eq("id", company);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  say("cleanup", `company and ${userIds.length} users removed`);
}
