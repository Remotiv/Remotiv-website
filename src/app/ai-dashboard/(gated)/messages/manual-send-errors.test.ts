/**
 * #19: a manual email the provider refuses tells the sender what happened and
 * what to do, and never shows the provider's own text. That text goes to the
 * server log. Our own refusals (daily cap, not configured, already sent, not
 * recorded) are written for the sender and still reach them unchanged.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/manual-send-errors.test.ts"
 *
 * sendManualMessage runs as shipped through messages-test-hook.mjs; deliver.ts
 * is replaced by a stub returning the outcome each test chooses, and records
 * that it was called. Synthetic data only.
 */
// @ts-nocheck - same reason as the other Messages tests: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUB = [
  "export function buildCandidateHtml(body) { return body; }",
  "export async function deliverEmail(service, input) { globalThis.__deliverCalls.push(input.event); return globalThis.__deliverOutcome; }",
].join("\\n");
export async function resolve(specifier, context, next) {
  if (specifier === "@/lib/email/candidate/deliver") {
    return { url: "data:text/javascript," + encodeURIComponent(STUB), shortCircuit: true };
  }
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { sendManualMessage } = await import("./actions.ts");

const CO = "c0000000-0000-4000-8000-0000000000d9";
const APP = "a0000000-0000-4000-8000-0000000000d9";
const RAW =
  "RAW-PROVIDER-TEXT: Invalid `to` field. The email address needs to follow the `email@example.com` format. (validation_error 422)";
const PROVIDER_REFUSED =
  "The email service couldn't send this message, so nothing was sent. Please try again in a moment. If it keeps failing, contact support.";

function install(outcome) {
  globalThis.__deliverOutcome = outcome;
  globalThis.__deliverCalls = [];
  globalThis.__messagesServiceForTests = () =>
    fakeService((table, calls) => {
      if (table === "job_applications") {
        return {
          data: {
            id: APP,
            company_id_snapshot: CO,
            job_id: null,
            first_name: "Syn",
            last_name: "Thetic",
            email: "s@example.test",
            job_title_snapshot: "Role",
            jobs: { title: "Role" },
          },
          error: null,
        };
      }
      if (table === "companies") {
        return { data: { name: "Acme", candidate_reply_email: null }, error: null };
      }
      const single = calls.some((c) => c[0] === "maybeSingle");
      return { data: single ? null : [], error: null };
    });
  globalThis.__messagesCtxForTests = {
    companyId: CO,
    memberId: "m-1",
    role: "owner",
    memberName: "Member",
    company: { id: CO, name: "Acme" },
  };
}

const send = async () => {
  const lines = [];
  const saved = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const result = await sendManualMessage({
      applicationId: APP,
      subject: "Next steps",
      body: "Hello there.",
    });
    return { result, lines };
  } finally {
    console.error = saved;
  }
};

// Negative control: put back `return { success: false, error: outcome.message }`
// for every kind and the provider's text is shown to the sender.
test("a provider refusal: the plain sentence on screen, the provider's text only in the log", async () => {
  install({ ok: false, kind: "provider", message: RAW, logId: "log-1" });
  const { result, lines } = await send();
  assert.deepEqual(globalThis.__deliverCalls, ["manual"], "the send was really attempted");
  assert.deepEqual(result, { success: false, error: PROVIDER_REFUSED });
  assert.ok(!JSON.stringify(result).includes("RAW-PROVIDER-TEXT"));
  assert.ok(!/422|validation_error|Invalid `to`/.test(result.error));
  assert.ok(
    lines.some((l) => l.includes(`application ${APP} refused by the provider`) && l.includes(RAW)),
    "the detail is in the server log",
  );
  assert.doesNotMatch(result.error, /[–—]/);
});

test("our own refusals still reach the sender word for word", async () => {
  for (const [kind, message] of [
    ["cap", "Remotiv's daily email limit has been reached. This message hasn't been sent."],
    ["not_configured", "Email isn't configured on this environment."],
    ["duplicate", "This candidate has already been sent this message."],
    ["log", "The message couldn't be recorded, so it wasn't sent."],
  ]) {
    install({ ok: false, kind, message, logId: null });
    const { result } = await send();
    assert.deepEqual(result, { success: false, error: message }, kind);
  }
});
