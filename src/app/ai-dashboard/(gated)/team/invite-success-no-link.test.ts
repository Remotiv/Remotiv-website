/**
 * A SUCCESSFUL invitation and a successful Resend, with email delivery mocked:
 * the inviter's response carries no accept link and no token; the email does
 * (#48, QA-SAFETY-40 T-2).
 *
 *   node --test "src/app/ai-dashboard/(gated)/team/invite-success-no-link.test.ts"
 *
 * The real inviteMember and resendInvite run against the fake PostgREST client.
 * The mailer and the template are stubs that record what they were handed, so
 * the test can prove the link went to the email and only there. The token the
 * email received is checked against the token_hash the action stored, so the
 * "no token in the response" assertion is looking for the RIGHT string.
 * Synthetic data only.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__invService(); } export async function createClient() { return null; }",
  "@/app/api/_lib/rate-limit": "export function rateLimitByKey() { return { ok: true }; }",
  "@/lib/notifications/company": "export async function notifyCompany() {}",
  "@/lib/email/send": "export async function sendEmail(m) { globalThis.__invSent.push(m); return { ok: true }; }",
  "@/lib/email/templates/company-invite": "export const companyInviteSubject = 'You are invited'; export function renderCompanyInviteEmail(d) { globalThis.__invRendered.push(d); return '<a href=\\"' + d.acceptUrl + '\\">Accept</a>'; }",
  "@/lib/validators": "export function isValidEmail(e) { return /@/.test(e); }",
  "@/lib/company-identity": "export function isAlreadyRegistered() { return false; }",
  "@/app/ai-dashboard/lib/company-guards": "export async function requireCompanyRole() { return globalThis.__invCtx; } export async function getCompanyContext() { return globalThis.__invCtx; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { inviteMember, resendInvite } = await import("./actions.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const sha = (raw) => createHash("sha256").update(raw).digest("hex");

function world() {
  const inserted = [];
  const service = fakeService(async (table, calls) => {
    const op = calls[0]?.[0];
    if (table === "company_members") return { data: null, error: null }; // not already a member
    if (table === "company_invites" && op === "insert") {
      inserted.push(calls[0][1]);
      return { data: { id: `inv-${inserted.length}` }, error: null };
    }
    if (table === "company_invites" && op === "select") {
      return {
        data: {
          id: "inv-old",
          company_id: CO,
          email: "sam@acme.test",
          name: "Sam",
          role: "recruiter",
          status: "pending",
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  globalThis.__invService = () => service;
  globalThis.__invCtx = {
    companyId: CO,
    company: { id: CO, name: "Acme" },
    user: { id: "u-owner" },
    memberId: "m-owner",
    memberName: "Owner",
    role: "owner",
  };
  globalThis.__invSent = [];
  globalThis.__invRendered = [];
  return { inserted };
}

for (const [name, run] of [
  ["inviteMember", () => inviteMember({ email: "sam@acme.test", name: "Sam", role: "recruiter" })],
  ["resendInvite", () => resendInvite("inv-old")],
]) {
  test(`${name} succeeds with delivery mocked, and the inviter gets no link and no token`, async () => {
    const w = world();
    const result = await run();
    assert.deepEqual(result, { success: true, data: undefined });

    // The email got the link, built from a real token whose hash is what was stored.
    assert.equal(globalThis.__invSent.length, 1, "one email sent");
    const url = globalThis.__invRendered[0].acceptUrl;
    const token = url.split("/ai-dashboard/accept/")[1];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, "a 256-bit base64url token");
    assert.equal(w.inserted.at(-1).token_hash, sha(token), "the emailed token is the stored one");
    assert.ok(globalThis.__invSent[0].html.includes(token), "and it is in the email body");

    // ...and none of it reached the inviter.
    const response = JSON.stringify(result);
    assert.ok(!response.includes(token), "no token in the response");
    assert.ok(!response.includes("/accept/"), "no accept path in the response");
    assert.ok(!response.includes(sha(token)), "no token hash either");
  });
}
