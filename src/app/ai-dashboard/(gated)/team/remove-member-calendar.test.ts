/**
 * #69 step 6: removing a member revokes their Google Calendar grant, BEFORE
 * the membership changes. Each of their connections is revoked at Google, then
 * its row is deleted, the delete happening even when Google does not confirm.
 * If the connections cannot be read or a row cannot be deleted, the member is
 * NOT removed (a live token would outlive the membership): a calm error, no
 * bell, nothing written. When Google alone does not confirm, the member is
 * removed, the remover is told on screen and the owners and admins get a bell
 * with the one step that finishes the job. No token is ever logged.
 *
 *   node --test "src/app/ai-dashboard/(gated)/team/remove-member-calendar.test.ts"
 *
 * Two halves, both as shipped:
 *   - removeMember, with the calendar module replaced by a stand-in that says
 *     what each disconnect did, so the message and the bell can be checked;
 *   - disconnectAllForMember and disconnect (lib/calendar/connections.ts),
 *     against a fake calendar_connections table that applies its filters,
 *     with the provider's revoke replaced by a fake Google that records calls.
 * Synthetic data only; nothing leaves the machine.
 */
// @ts-nocheck - same reason as the other node:test files: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "export {};",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__rmService(); }",
  "@/app/api/_lib/rate-limit":
    "export async function rateLimitClosedByKey() { return { ok: true }; } export const TRY_AGAIN_SOON = 'Please try again in a minute.';",
  "@/lib/notifications/company": "export async function notifyCompany(input) { globalThis.__rmBells.push(input); }",
  "@/lib/email/send": "export async function sendEmail() { return { ok: true }; }",
  "@/lib/email/templates/company-invite": "export const companyInviteSubject = 'x'; export function renderCompanyInviteEmail() { return ''; }",
  "@/lib/validators": "export function isValidEmail(e) { return /@/.test(e); }",
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function requireCompanyRole() { return globalThis.__rmCtx; }",
    "export async function getCompanyContext() { return globalThis.__rmCtx; }",
  ].join("\\n"),
  "./provider": [
    "export function getProvider(id) {",
    "  if (id !== 'google') return null;",
    "  return { revoke: async (token) => { globalThis.__rmRevoked.push(token); return globalThis.__rmRevokeOk; } };",
    "}",
  ].join("\\n"),
  "./google": "export const EXPIRY_SKEW_MS = 60000;",
};
export async function resolve(specifier, context, next) {
  if (specifier === "@/lib/calendar/connections" && context.parentURL && context.parentURL.includes("/team/actions.ts")) {
    return { url: "data:text/javascript," + encodeURIComponent("export async function disconnectAllForMember(id) { globalThis.__rmDisconnectCalls.push(id); return globalThis.__rmDisconnectAll(id); }"), shortCircuit: true };
  }
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const { removeMember } = await import("./actions.ts");
const { disconnectAllForCompany, disconnectAllForMember } = await import(
  "../../../../lib/calendar/connections.ts"
);
const { sealedWrite } = await import("../../../../lib/calendar/token-columns.ts");

// #68 12e: tokens are stored only sealed, so the fixture rows are sealed with
// a key made for this run.
process.env.CALENDAR_TOKEN_KEYS = JSON.stringify({ t1: randomBytes(32).toString("base64") });
process.env.CALENDAR_TOKEN_KEY_CURRENT = "t1";

const CO = "c0000000-0000-4000-8000-0000000000f6";
const CTX = {
  companyId: CO,
  role: "owner",
  memberId: "m-owner",
  memberName: "Olive Owner",
  user: { id: "u-owner", email: "olive@acme.test" },
  company: { name: "Acme" },
};
const TARGET = {
  id: "m-leaver",
  company_id: CO,
  user_id: "u-leaver",
  role: "recruiter",
  name: "Lee Leaver",
  email: "lee@acme.test",
};
const TOKEN = "REFRESH-TOKEN-SECRET-1234";

const eqs = (calls) => calls.filter((c) => c[0] === "eq").map((c) => [c[1], c[2]]);
const matches = (row, calls) => eqs(calls).every(([k, v]) => row[k] === v);

/** The team tables removeMember reads and writes, all answering success; every write is logged in order. */
function teamWorld(events) {
  globalThis.__rmService = () =>
    fakeService((table, calls) => {
      const write = calls.find((c) => c[0] === "update" || c[0] === "insert" || c[0] === "delete");
      if (write) events.push(`${table}:${write[0]}${write[1]?.status ? `:${write[1].status}` : ""}`);
      if (table === "company_members") {
        const single = calls.some((c) => c[0] === "maybeSingle");
        return { data: single ? TARGET : [], error: null };
      }
      return { data: [], error: null };
    });
}

/** Run removeMember with the calendar outcome given; return its result, bells and logs. */
async function remove(outcome) {
  const events = [];
  teamWorld(events);
  globalThis.__rmCtx = CTX;
  globalThis.__rmBells = [];
  globalThis.__rmDisconnectCalls = [];
  globalThis.__rmDisconnectAll = async () => {
    events.push("disconnect");
    return outcome;
  };
  const logs = [];
  const saved = console.error;
  console.error = (...a) => logs.push(a.map(String).join(" "));
  try {
    const result = await removeMember(TARGET.id);
    return {
      result,
      bells: globalThis.__rmBells,
      logs,
      calls: globalThis.__rmDisconnectCalls,
      events,
    };
  } finally {
    console.error = saved;
  }
}

const calendarBells = (bells) => bells.filter((b) => b.type === "member_calendar_not_revoked");
const REMOVED = "company_members:update:removed";

// Negative controls: remove the disconnectAllForMember call from removeMember,
// or move it back after the membership write (the old order), and this fails.
test("removing a member disconnects their calendars BEFORE anything about the membership changes", async () => {
  const r = await remove({
    ok: true,
    results: [{ provider: "google", deleted: true, revokedAtProvider: true }],
  });
  assert.deepEqual(r.calls, [TARGET.id], "the removed member's calendars were disconnected");
  assert.equal(r.events[0], "disconnect", "the disconnect comes first");
  assert.ok(r.events.includes(REMOVED), "then the member is removed");
  assert.deepEqual(r.result, { success: true, data: undefined });
  assert.deepEqual(calendarBells(r.bells), []);
  assert.ok(
    r.bells.some((b) => b.type === "member_removed"),
    "the usual removal bell still goes",
  );
});

// Negative control: drop the warning (no message, no bell) when Google does
// not confirm, and this test fails.
test("Google does not confirm: removal still succeeds, the remover is told, owners and admins get the bell", async () => {
  const r = await remove({
    ok: true,
    results: [{ provider: "google", deleted: true, revokedAtProvider: false }],
  });
  assert.equal(r.result.success, true, "the member is removed either way");
  assert.ok(r.events.includes(REMOVED));
  assert.match(r.result.data.calendarWarning, /Google Account > Security > Third-party access/);
  assert.doesNotMatch(r.result.data.calendarWarning, /[\u2013\u2014]/, "no long dashes");
  const bells = calendarBells(r.bells);
  assert.equal(bells.length, 1);
  assert.equal(
    bells[0].actorMemberId,
    CTX.memberId,
    "the remover sees it on screen, not as a bell",
  );
  assert.match(bells[0].title, /Lee Leaver's Google Calendar/);
  assert.match(bells[0].body, /Google Account > Security > Third-party access; remove it there/);
  assert.deepEqual(r.logs, [
    "[team] remove member: calendar access not confirmed removed (revoke_unconfirmed)",
  ]);
});

const KEPT = {
  success: false,
  error: "Couldn't disconnect their calendar. Please try again.",
};

test("the connections cannot be read: the member STAYS, a calm error, no bell, nothing written", async () => {
  const r = await remove({ ok: false });
  assert.deepEqual(r.result, KEPT);
  assert.deepEqual(r.events, ["disconnect"], "no invitation revoked, no membership write");
  assert.deepEqual(r.bells, [], "no bell of any kind");
  assert.deepEqual(r.logs, [
    "[team] remove member: calendar not disconnected, member kept (read_failed)",
  ]);
});

test("a connection row cannot be deleted: the member STAYS, the same calm error", async () => {
  const r = await remove({
    ok: true,
    results: [
      { provider: "google", deleted: true, revokedAtProvider: true },
      { provider: "outlook", deleted: false, revokedAtProvider: true },
    ],
  });
  assert.deepEqual(r.result, KEPT);
  assert.ok(!r.events.includes(REMOVED));
  assert.deepEqual(r.bells, []);
  assert.match(r.logs.at(-1), /member kept \(delete_failed\)$/);
});

/* ── the real disconnect, against a fake table and a fake Google ── */

function calendarWorld(rows) {
  const table = rows.map((r) => ({ ...r }));
  globalThis.__rmRevoked = [];
  globalThis.__rmService = () =>
    fakeService((t, calls) => {
      if (t !== "calendar_connections") return { data: null, error: null };
      if (calls.some((c) => c[0] === "delete")) {
        for (let i = table.length - 1; i >= 0; i--)
          if (matches(table[i], calls)) table.splice(i, 1);
        return { data: null, error: null };
      }
      const hit = table.filter((r) => matches(r, calls));
      return calls.some((c) => c[0] === "maybeSingle")
        ? { data: hit[0] ?? null, error: null }
        : { data: hit, error: null };
    });
  return table;
}

const conn = (member_id, provider, refreshToken) => {
  const id = randomUUID();
  const sealed = sealedWrite(
    { id, memberId: member_id, provider },
    { accessToken: `access-${member_id}`, refreshToken },
  );
  return {
    id,
    member_id,
    provider,
    provider_account: `${member_id}@example.test`,
    status: "active",
    ...sealed.columns,
  };
};

// Negative control: drop `.eq("member_id", memberId)` from disconnect's delete
// and another member's connection is deleted with it.
test("disconnectAllForMember: each of the member's connections is revoked then deleted; other members' untouched", async () => {
  const table = calendarWorld([
    conn(TARGET.id, "google", TOKEN),
    conn("m-other", "google", "OTHER-TOKEN"),
  ]);
  globalThis.__rmRevokeOk = true;
  const out = await disconnectAllForMember(TARGET.id);
  assert.deepEqual(out, {
    ok: true,
    results: [{ provider: "google", deleted: true, revokedAtProvider: true }],
  });
  assert.deepEqual(globalThis.__rmRevoked, [TOKEN], "the refresh token was revoked at Google");
  assert.deepEqual(
    table.map((r) => r.member_id),
    ["m-other"],
    "only the removed member's row is gone",
  );
});

test("disconnectAllForMember: Google refuses: the row is STILL deleted, the outcome says unconfirmed, no token logged", async () => {
  const table = calendarWorld([conn(TARGET.id, "google", TOKEN)]);
  globalThis.__rmRevokeOk = false;
  const logs = [];
  const saved = console.error;
  console.error = (...a) =>
    logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  let out: Awaited<ReturnType<typeof disconnectAllForMember>> | undefined;
  try {
    out = await disconnectAllForMember(TARGET.id);
  } finally {
    console.error = saved;
  }
  assert.deepEqual(out.results, [{ provider: "google", deleted: true, revokedAtProvider: false }]);
  assert.deepEqual(table, [], "no live token is kept for someone who has left");
  for (const l of logs)
    assert.ok(!l.includes(TOKEN) && !l.includes("access-"), `token logged: ${l}`);
});

test("disconnectAllForMember: a failed read is reported, not read as 'no connections'", async () => {
  globalThis.__rmService = () =>
    fakeService(() => ({ data: null, error: { code: "57014", message: "timeout" } }));
  const saved = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await disconnectAllForMember(TARGET.id), { ok: false });
  } finally {
    console.error = saved;
  }
});

// #69 step 5: the company delete's last calendar pass, right before the row.
// Negative control: drop `.eq("company_id", companyId)` from its read and
// another company's connection is revoked and deleted with it.
test("disconnectAllForCompany: every connection of that company is revoked then deleted; another company's untouched", async () => {
  const table = calendarWorld([
    { ...conn("m-a1", "google", "A1-TOKEN"), company_id: "co-a" },
    { ...conn("m-a2", "google", "A2-TOKEN"), company_id: "co-a" },
    { ...conn("m-b1", "google", "B1-TOKEN"), company_id: "co-b" },
  ]);
  globalThis.__rmRevokeOk = true;
  const out = await disconnectAllForCompany("co-a");
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r) => r.deleted && r.revokedAtProvider));
  assert.deepEqual(globalThis.__rmRevoked.sort(), ["A1-TOKEN", "A2-TOKEN"]);
  assert.deepEqual(
    table.map((r) => r.company_id),
    ["co-b"],
  );
});
