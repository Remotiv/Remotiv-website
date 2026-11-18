// #51 proofs on REAL Supabase Auth and the real 062 grant (staging only): the
// emailed code every invitation acceptance now requires.
//
//   node --env-file=.env.staging scripts/staging/proofs-051.mjs
//
// Every call is the one accept/actions.ts makes, in its order: createUser with
// the marker in app_metadata, auth.admin.generateLink (type magiclink: the
// code, and NO email), our invite email rendered by the real template with the
// send FAKED (recorded here, nothing leaves), verifyOtp (type email) on a
// cookie-less anon client with the code read back OUT OF that email, the
// marker read off the verified user's app_metadata, updateUserById or the
// password check, then accept_company_invite. Synthetic fixtures in a
// throwaway company, removed at the end. Prints outcome words and counts
// only: never a code, token, address or key.
//
//   L  the code length equals INVITE_CODE_LENGTH (the page's copy): exit 1
//      at the end if not
//   N  new address: the code step creates the account unconfirmed, with the
//      marker in app_metadata, no password, no membership; a second create
//      is refused; a wrong code writes nothing; an earlier code is checked
//      after a newer one is issued (reported, not assumed); the right code
//      proves the invited address; a replay fails; the password is set, the
//      marker cleared, the grant joins
//   E  existing account: never marked, so it must prove its password; a
//      wrong password writes nothing; the right one joins
//   F  a signed-in user writing the marker into their own user_metadata does
//      not get it into app_metadata
//   O  every code went out in OUR email, to the address it was minted for
//   M  the grant refuses an account that is not the invited address
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire, register } from "node:module";

// The template imports through the "@/" alias, as the app does.
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

const MARKER = "remotiv_invite_signup"; // accept/actions.ts NEW_ACCOUNT_MARKER
const { INVITE_CODE_LENGTH } = await import("../../src/app/ai-dashboard/accept/code-length.ts");
let lengthMismatch = false;
const say = (k, v) => console.log(k.padEnd(66), typeof v === "string" ? v : JSON.stringify(v));
const code = (r) => r.error?.code ?? r.error?.status ?? "ok";
const must = async (q, what) => {
  const r = await q;
  if (r.error) throw new Error(`${what}: ${r.error.code ?? r.error.status}`);
  return r.data;
};

const tag = randomBytes(3).toString("hex");
const company = randomUUID();
const userIds = [];
try {
  const owner = await must(
    svc.auth.admin.createUser({
      email: `p051-owner-${tag}@example.invalid`,
      password: randomBytes(18).toString("base64url"),
      email_confirm: true,
    }),
    "owner",
  );
  userIds.push(owner.user.id);
  await must(
    svc.from("companies").insert({
      id: company,
      name: `proof-051 ${tag}`,
      contact_email: `p051-${tag}@example.invalid`,
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
  const grant = async (hash, userId, email) =>
    (
      await svc.rpc("accept_company_invite", {
        p_token_hash: hash,
        p_user_id: userId,
        p_name: "Proof",
        p_email: email,
      })
    ).data;
  // The send step: mint, then "email" it. The fake send records the message;
  // the code the person would type is read back out of the rendered body.
  const outbox = [];
  const companyName = `proof-051 ${tag}`;
  const issue = async (email) => {
    const minted = (await must(svc.auth.admin.generateLink({ type: "magiclink", email }), "code"))
      .properties.email_otp;
    const html = renderInviteCodeEmail({ companyName, code: minted });
    outbox.push({ to: email, subject: inviteCodeSubject(companyName), html });
    return /letter-spacing: 8px;">(\d+)</.exec(html)?.[1] ?? "";
  };
  const verify = (email, token) => anon().auth.verifyOtp({ email, token, type: "email" });

  // ── N: a new address ──
  const nEmail = `p051-new-${tag}@example.invalid`;
  const nHash = await mkInvite(nEmail);
  const nUser = (
    await must(
      svc.auth.admin.createUser({
        email: nEmail,
        email_confirm: false,
        app_metadata: { [MARKER]: true },
      }),
      "new account",
    )
  ).user;
  userIds.push(nUser.id);
  say("N created unconfirmed, marker in app_metadata", [
    !nUser.email_confirmed_at,
    nUser.app_metadata?.[MARKER] === true,
  ]);
  const dup = await svc.auth.admin.createUser({
    email: nEmail,
    email_confirm: false,
    app_metadata: { [MARKER]: true },
  });
  say("N a second create for the address (a resend)", code(dup));
  const first = await issue(nEmail);
  lengthMismatch = first.length !== INVITE_CODE_LENGTH;
  say(`L code length on this project (page says ${INVITE_CODE_LENGTH})`, first.length);
  say("N ... and no membership", (await state(nHash, nUser.id)).memberships);
  const wrong = await verify(nEmail, "0".repeat(first.length));
  say("N wrong code", code(wrong));
  const second = await issue(nEmail);
  say(
    "N the first code, after a second was issued (still valid?)",
    code(await verify(nEmail, first)),
  );
  say("N after both refusals: invite / memberships", await state(nHash, nUser.id));
  const right = await verify(nEmail, second);
  say("N right code", code(right));
  say("N the verified address is the invited one", right.data.user?.email === nEmail);
  say(
    "N the verified user carries the marker in app_metadata (so: new)",
    right.data.user?.app_metadata?.[MARKER] === true,
  );
  say("N the same code again", code(await verify(nEmail, second)));
  const nPassword = randomBytes(12).toString("base64url");
  const set = await svc.auth.admin.updateUserById(nUser.id, {
    password: nPassword,
    app_metadata: { [MARKER]: null },
  });
  say("N password set, marker cleared", [
    code(set),
    set.data.user?.app_metadata?.[MARKER] !== true,
  ]);
  say("N grant", await grant(nHash, nUser.id, nEmail));
  say("N after: invite / memberships", await state(nHash, nUser.id));
  say(
    "N the new password signs in",
    code(await anon().auth.signInWithPassword({ email: nEmail, password: nPassword })),
  );

  // ── E: an existing account ──
  const eEmail = `p051-old-${tag}@example.invalid`;
  const ePassword = randomBytes(12).toString("base64url");
  const eUser = (
    await must(
      svc.auth.admin.createUser({ email: eEmail, password: ePassword, email_confirm: true }),
      "existing",
    )
  ).user;
  userIds.push(eUser.id);
  const eHash = await mkInvite(eEmail);
  const eCode = await issue(eEmail);
  const eRight = await verify(eEmail, eCode);
  say("E right code", code(eRight));
  say(
    "E marker on an account that existed (must be absent)",
    eRight.data.user?.app_metadata?.[MARKER] === true,
  );
  const bad = await anon().auth.signInWithPassword({ email: eEmail, password: "not the password" });
  say("E wrong password", code(bad));
  say("E after the code and a wrong password: invite / memberships", await state(eHash, eUser.id));
  const good = await anon().auth.signInWithPassword({ email: eEmail, password: ePassword });
  say("E right password, same account as the code", good.data.user?.id === eRight.data.user?.id);
  say("E grant", await grant(eHash, eUser.id, eEmail));
  say("E after: invite / memberships", await state(eHash, eUser.id));

  // ── O: what our email carried ──
  say("O emails faked / every one to the address it was minted for", [
    outbox.length,
    outbox.every((m) => m.to === nEmail || m.to === eEmail),
  ]);
  say(
    "O subject and words as agreed, no dashes",
    outbox.every(
      (m) =>
        m.subject === `Your code to join ${companyName} on Remotiv` &&
        m.html.includes("Enter this code to accept your invitation to join") &&
        m.html.includes("This code expires in 1 hour.") &&
        !/[\u2013\u2014]/.test(m.subject + m.html),
    ),
  );

  // ── F: the user writes the marker into their own metadata ──
  const self = anon();
  await self.auth.signInWithPassword({ email: eEmail, password: ePassword });
  const forged = await self.auth.updateUser({ data: { [MARKER]: true } });
  say("F updateUser by the account itself: user_metadata / app_metadata marker", [
    forged.data.user?.user_metadata?.[MARKER] === true,
    forged.data.user?.app_metadata?.[MARKER] === true,
  ]);
  const fCode = await issue(eEmail);
  const fVerified = await verify(eEmail, fCode);
  say(
    "F after a code: app_metadata marker (must be false: password still required)",
    fVerified.data.user?.app_metadata?.[MARKER] === true,
  );

  // ── M: the grant refuses any other account ──
  const mHash = await mkInvite(`p051-other-${tag}@example.invalid`);
  say(
    "M grant to the new account on another address's invite",
    await grant(mHash, nUser.id, nEmail),
  );
  say(
    "M ... with the invited address but the wrong account",
    await grant(mHash, nUser.id, `p051-other-${tag}@example.invalid`),
  );
  say("M after: invite status", (await state(mHash, nUser.id)).invite);
} finally {
  await svc.from("companies").delete().eq("id", company);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  say("cleanup", `company and ${userIds.length} users removed`);
}
if (lengthMismatch) {
  console.log(
    `FAIL: staging's code length is not INVITE_CODE_LENGTH (${INVITE_CODE_LENGTH}); set Auth > Email > OTP length`,
  );
  process.exit(1);
}
