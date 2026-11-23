/**
 * #87: a recruiter whose interview invitation fails gets no bell about their
 * own failure, because the send action shows them the error. Everyone else who
 * should be told still is, and an invitation sent with no member (an automatic
 * one) bells everyone. Same rule as the final-interview link (#87 part 2).
 *
 *   node --test src/lib/interviews/invite-actor.test.ts
 *
 * Drives the real sendInviteEmail, deliverEmail and the failure bell against a
 * fake database (fake-service-client-hook.mjs) that applies eq and in filters,
 * and a fake `fetch` standing in for Resend. Every outbound email is answered
 * by that stub: nothing leaves the machine. The harness is
 * calendar/notify-actor.test.ts's, with the company row sendInviteEmail reads.
 */
// @ts-nocheck - same reason as send-failure.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/fake-service-client-hook.mjs", import.meta.url));

const { sendInviteEmail } = await import("./invite-delivery.ts");

const CO = "c0000000-0000-4000-8000-000000000001";
const OTHER_CO = "c0000000-0000-4000-8000-000000000002";
const JOB = "j0000000-0000-4000-8000-000000000001";
const APP = "a0000000-0000-4000-8000-000000000001";

/** The sending recruiter, on this job's hiring team. */
const ACTOR = "m-actor";
const MEMBERS = [
  { id: "m-owner", company_id: CO, role: "owner" },
  { id: "m-admin", company_id: CO, role: "admin" },
  { id: ACTOR, company_id: CO, role: "recruiter" },
  { id: "m-off-team", company_id: CO, role: "recruiter" },
  { id: "x-owner", company_id: OTHER_CO, role: "owner" },
];
const TEAM = [{ job_id: JOB, member_id: ACTOR, company_id: CO }];

const applies = (row, calls) =>
  calls.every(([m, col, val]) => {
    if (m === "eq") return row[col] === undefined || row[col] === val;
    if (m === "in") return row[col] === undefined || val.includes(row[col]);
    return true;
  });

/** The database: bells are stored, the log row is written, members are filtered. */
function world() {
  const bells = [];
  const logs = [];
  const service = fakeService((table, calls) => {
    const has = (m) => calls.some((c) => c[0] === m);
    switch (table) {
      case "communication_logs": {
        if (calls.find((c) => c[0] === "select")?.[2]?.head) {
          return { data: null, count: 0, error: null }; // the daily cap
        }
        const ins = calls.find((c) => c[0] === "insert");
        if (ins) {
          const row = { id: `log-${logs.length + 1}`, ...ins[1] };
          logs.push(row);
          return { data: { id: row.id }, error: null };
        }
        const upd = calls.find((c) => c[0] === "update");
        if (upd) {
          const id = calls.find((c) => c[0] === "eq" && c[1] === "id")?.[2];
          const row = logs.find((r) => r.id === id);
          if (row) Object.assign(row, upd[1]);
          return { data: has("select") && row ? [{ id }] : null, error: null };
        }
        return { data: null, error: null };
      }
      case "companies":
        return { data: { name: "Acme", candidate_reply_email: null }, error: null };
      case "job_applications":
        return {
          data: applies({ id: APP, company_id_snapshot: CO }, calls) ? { job_id: JOB } : null,
          error: null,
        };
      case "company_members":
        return { data: MEMBERS.filter((m) => applies(m, calls)), error: null };
      case "job_hiring_team":
        return { data: TEAM.filter((t) => applies(t, calls)), error: null };
      case "notifications_company": {
        const row = calls.find((c) => c[0] === "insert")[1];
        if (bells.some((b) => b.id === row.id)) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        bells.push(row);
        return { data: row, error: null };
      }
      default:
        throw new Error(`test: unexpected table ${table}`);
    }
  });
  return { service, bells, logs };
}

/** Run with Resend refusing or accepting. Every outbound request is recorded, none sent. */
async function run(send, { resend }) {
  const w = world();
  const outbound = [];
  const saved = {
    fetch: globalThis.fetch,
    key: process.env.RESEND_API_KEY,
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  globalThis.__fakeServiceClientForTests = () => w.service;
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = async (url) => {
    outbound.push(String(url));
    return resend === "refuses"
      ? new Response(
          JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `to`" }),
          { status: 422, headers: { "content-type": "application/json" } },
        )
      : new Response(JSON.stringify({ id: "re_sent_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
  };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try {
    const result = await send(w.service);
    return { ...w, result, outbound };
  } finally {
    delete globalThis.__fakeServiceClientForTests;
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.key;
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn });
  }
}

const bellsFor = (bells, memberId) => bells.filter((b) => b.member_id === memberId).length;
const WHO = [ACTOR, "m-owner", "m-admin", "m-off-team", "x-owner"];

const invite = (ctx) => (service) =>
  sendInviteEmail(service, {
    ctx,
    applicationId: APP,
    app: {
      id: APP,
      first_name: "Test",
      last_name: "Candidate",
      email: "candidate@example.test",
      job_id: JOB,
      job_title_snapshot: "Engineer",
      jobs: { title: "Engineer" },
    },
    rawToken: "token-not-real",
    expiresAt: "2026-12-01T10:00:00.000Z",
    copy: (link, deadline) => ({
      subject: "Your video interview for {{job_title}}",
      body: `Record it here: ${link}. Open until ${deadline}.`,
    }),
  });

// Negative control: drop actorMemberId from sendInviteEmail's deliverEmail call
// and the sender gets a bell here.
test("a manual invitation that Resend refuses: the sender gets no bell, the rest of the team one each, the other company none", async () => {
  const r = await run(invite({ companyId: CO, memberName: "Recruiter", memberId: ACTOR }), {
    resend: "refuses",
  });
  assert.equal(r.result.ok, false, "the send action is told, and shows the error");
  assert.ok(
    r.outbound.length > 0 && r.outbound.every((u) => u.includes("resend")),
    "Resend was called, and only the stub",
  );
  assert.ok(
    r.logs.some((l) => l.status === "failed"),
    "the delivery really failed",
  );
  assert.deepEqual(
    WHO.map((m) => bellsFor(r.bells, m)),
    [0, 1, 1, 0, 0],
  );
});

test("an invitation sent with no member (automatic): everyone who should know is belled, the recruiter included", async () => {
  for (const ctx of [
    { companyId: CO, memberName: null },
    { companyId: CO, memberName: null, memberId: null },
  ]) {
    const r = await run(invite(ctx), { resend: "refuses" });
    assert.equal(r.result.ok, false);
    assert.deepEqual(
      WHO.map((m) => bellsFor(r.bells, m)),
      [1, 1, 1, 0, 0],
    );
  }
});

test("a delivered invitation rings no bell, with or without a member", async () => {
  for (const ctx of [
    { companyId: CO, memberName: "Recruiter", memberId: ACTOR },
    { companyId: CO, memberName: null },
  ]) {
    const r = await run(invite(ctx), { resend: "accepts" });
    assert.equal(r.result.ok, true);
    assert.ok(r.logs.some((l) => l.status === "sent"));
    assert.equal(r.bells.length, 0);
  }
});

// Negative control: drop memberId from the restart's ctx and the last
// assertion fails.
test("every sender passes its member: the async and live sends pass their ctx, the restart passes ctx.memberId", () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const delivery = src("./invite-delivery.ts");
  assert.match(delivery, /sentByName: ctx\.memberName,\s*actorMemberId: ctx\.memberId \?\? null,/);
  const actions = src("../../app/ai-dashboard/(gated)/applicants/interview-actions.ts");
  const sends = actions.match(/await deliverInvite\(service, \{\s*ctx,/g) ?? [];
  assert.equal(sends.length, 2, "the async and live sends pass their CompanyContext");
  assert.match(actions, /const ctx = await getCompanyContext\(\);/);
  const roles = src("../../app/ai-dashboard/lib/company-roles.ts");
  assert.match(roles, /export type CompanyContext = \{[\s\S]*?\n\s*memberId: string;/);
  const restart = src("./live-restart-flow.ts");
  assert.match(
    restart,
    /ctx: \{ companyId: ctx\.companyId, memberName: ctx\.memberName, memberId: ctx\.memberId \},/,
  );
});
