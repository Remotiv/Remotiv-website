/**
 * #64: inbound WhatsApp renders in the applicant drawer only when the number
 * maps to exactly ONE person at exactly ONE company.
 *
 *   node --test "src/app/ai-dashboard/(gated)/messages/inbound-ownership.test.ts"
 *
 * The action, the ownership predicate (lib/whatsapp/number-owners.ts) and the
 * normaliser are the shipped code. The company context is the fake of
 * messages-test-hook.mjs; the database is fake-live-db.mjs, which APPLIES every
 * filter - including the `imatch` prefilter and the ordered `range` pages -
 * so a row that comes back here is one PostgREST would have returned.
 *
 * Each test is named by what it proves, and each has a reversion in
 * scripts/staging/negative-controls.mjs that must turn it red. Synthetic data
 * throughout: the numbers are Pakistani-shaped so toWhatsAppDigits accepts
 * them, and none of them is a real candidate's.
 */
// @ts-nocheck - same reason as list-scope.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/messages-test-hook.mjs", import.meta.url));

const { fetchApplicationInbound } = await import("./actions.ts");
const { APPLICATION_INBOUND_CAP } = await import("./types.ts");
const { fakeLiveDb } = await import("../../../../test-support/fake-live-db.mjs");

const CO_A = "c0000000-0000-4000-8000-00000000000a";
const CO_B = "c0000000-0000-4000-8000-00000000000b";
const CO_C = "c0000000-0000-4000-8000-00000000000c";
const APP_A = "a0000000-0000-4000-8000-000000000001";
const APP_B = "a0000000-0000-4000-8000-000000000002";
const APP_Z = "a0000000-0000-4000-8000-000000000003";
const APP_W = "a0000000-0000-4000-8000-000000000004";
const APP_A2 = "a0000000-0000-4000-8000-000000000005";

/** The candidate's number, canonical as Meta delivers it. */
const X_CANONICAL = "923001234567";
/**
 * A DIFFERENT number sharing X's nine trailing digits ("001234567"): it passes
 * the prefilter and fails the exact match. This is the collision the nine
 * digits actually produce.
 */
const COLLIDER = "921001234567";

const at = (minutesAgo) =>
  new Date(Date.UTC(2026, 9, 30, 12, 0, 0) - minutesAgo * 60_000).toISOString();

/** One application, with the stored phone in whatever shape the form kept. */
function app(id, company, over = {}) {
  return {
    id,
    company_id_snapshot: company,
    job_id: "b0000000-0000-4000-8000-000000000001",
    phone: "0300-1234567",
    email: "x@example.test",
    first_name: "Ex",
    last_name: "Candidate",
    created_at: at(60),
    ...over,
  };
}

/** One inbound row, from `from` (digits as Meta sends them). */
function inbound(n, from, over = {}) {
  return {
    id: `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    wa_message_id: `wamid.${n}`,
    from_phone: from,
    body: `reply ${n}`,
    message_type: "text",
    received_at: at(1000 - n),
    company_id: null,
    application_id: null,
    ...over,
  };
}

function world({ applications, inboundRows, company = CO_A }) {
  const w = fakeLiveDb({ job_applications: applications, whatsapp_inbound: inboundRows });
  globalThis.__messagesServiceForTests = () => w.service;
  globalThis.__messagesCtxForTests = {
    companyId: company,
    role: "owner",
    memberId: "m0000000-0000-4000-8000-000000000001",
    memberName: "Owner",
    user: { id: "u-1", email: "owner@example.test" },
  };
  return w;
}

const asCompany = (company) => {
  globalThis.__messagesCtxForTests = { ...globalThis.__messagesCtxForTests, companyId: company };
};

const NOTE = { ok: true, rows: [], basis: "number-not-unique", truncated: false };

test("#64: one candidate at two companies: each company sees a note, never the other's replies", async () => {
  world({
    applications: [
      app(APP_A, CO_A, { phone: "0300-1234567", created_at: at(120) }),
      // Same person (same email), applied to company B from the same phone,
      // stored in a different shape.
      app(APP_B, CO_B, { phone: "+92 300 1234567", created_at: at(30) }),
    ],
    inboundRows: [inbound(1, X_CANONICAL), inbound(2, X_CANONICAL)],
  });

  asCompany(CO_A);
  assert.deepEqual(await fetchApplicationInbound(APP_A), NOTE, "company A sees a note");
  asCompany(CO_B);
  assert.deepEqual(await fetchApplicationInbound(APP_B), NOTE, "company B sees a note");
});

test("#64: two different people on one number: both see a note, neither sees the rows", async () => {
  world({
    applications: [
      app(APP_A, CO_A),
      app(APP_Z, CO_A, {
        phone: "0092 300 1234567",
        email: "z@example.test",
        first_name: "Zed",
        last_name: "Other",
        created_at: at(10),
      }),
    ],
    inboundRows: [inbound(1, X_CANONICAL)],
  });

  assert.deepEqual(await fetchApplicationInbound(APP_A), NOTE, "the first person sees a note");
  assert.deepEqual(await fetchApplicationInbound(APP_Z), NOTE, "the second person sees a note");
});

test("#64: an ordinary single-company candidate sees their own replies exactly as before", async () => {
  world({
    applications: [
      app(APP_A, CO_A, { created_at: at(120) }),
      // The same person applying again at the same company passes isOnePerson.
      app(APP_A2, CO_A, { phone: "92 300 1234567", created_at: at(20) }),
      // A different person whose number merely shares the nine-digit tail. Not
      // an owner of X's number: the prefilter finds them, the exact match drops them.
      app(APP_W, CO_C, {
        phone: "92 100 1234567",
        email: "w@example.test",
        first_name: "Double",
        last_name: "You",
      }),
    ],
    inboundRows: [
      inbound(1, X_CANONICAL),
      inbound(2, X_CANONICAL, { body: null, message_type: "audio" }),
      // An identifier-change event from X's number: an account fact, not a message.
      inbound(3, X_CANONICAL, { message_type: "system", body: "User changed id" }),
      // The collider's reply: prefilter hit, exact-match miss. Must not render.
      inbound(4, COLLIDER, { body: "not yours" }),
    ],
  });

  const read = await fetchApplicationInbound(APP_A);
  assert.equal(read.ok, true);
  assert.equal(read.basis, "phone");
  assert.equal(read.truncated, false);
  assert.deepEqual(
    read.rows.map((r) => [r.id.slice(-2), r.body, r.messageType]),
    [
      ["02", null, "audio"],
      ["01", "reply 1", "text"],
    ],
    "X's two messages, newest first; the system event and the collider's reply are absent",
  );
  assert.ok(
    read.rows.every((r) => r.body !== "not yours"),
    "the collider's message never renders under X's name",
  );
});

test("#64: a prefilter collision cannot consume the cap and truncate the candidate's own replies", async () => {
  // 150 newer replies from the colliding number, then X's three. The old
  // single `.limit(cap + 1)` read, taken before the exact match, returned the
  // first 201 prefilter hits - all the collider's - and X's rows vanished.
  const colliders = Array.from({ length: 150 }, (_, i) => inbound(100 + i, COLLIDER));
  world({
    applications: [app(APP_A, CO_A)],
    inboundRows: [
      inbound(1, X_CANONICAL),
      inbound(2, X_CANONICAL),
      inbound(3, X_CANONICAL),
      ...colliders,
    ],
  });
  assert.ok(
    150 < APPLICATION_INBOUND_CAP + 1,
    "the collision must fit the old cap to be the old bug",
  );

  const read = await fetchApplicationInbound(APP_A);
  assert.equal(read.ok, true);
  assert.equal(read.truncated, false, "the walk reached the end of the prefilter");
  assert.deepEqual(
    read.rows.map((r) => r.body),
    ["reply 3", "reply 2", "reply 1"],
    "all three of X's replies, in order, after 150 colliding rows",
  );
});

test("#64: an owner lookup that failed or may be incomplete shows nothing", async () => {
  // Incomplete: enough tail-sharing applications to fill the lookup page
  // EXACTLY, with X's own row on it. Twenty-four other people on colliding
  // numbers plus X is OWNER_LOOKUP_LIMIT rows: X is the only confirmed owner,
  // so only the full-page rule refuses - a page this full could be hiding a
  // twenty-sixth row at another company, and the set cannot prove uniqueness.
  const crowd = Array.from({ length: 24 }, (_, i) =>
    app(`a0000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, CO_C, {
      // Every first local digit except X's own "3": colliders, never co-owners.
      phone: `92${"012456789"[i % 9]}001234567`,
      email: `p${i}@example.test`,
      first_name: `P${i}`,
      last_name: "Crowd",
      created_at: at(i),
    }),
  );
  world({
    applications: [app(APP_A, CO_A, { created_at: at(500) }), ...crowd],
    inboundRows: [inbound(1, X_CANONICAL)],
  });
  assert.deepEqual(await fetchApplicationInbound(APP_A), NOTE, "a full lookup page fails closed");

  // Failed: the third job_applications read in the action is the owner
  // lookup (after canSeeApplication and the phone read). It errors; the
  // answer is a failure with no rows, never the rows.
  const w = world({ applications: [app(APP_A, CO_A)], inboundRows: [inbound(1, X_CANONICAL)] });
  const realFrom = w.service.from.bind(w.service);
  let applicationReads = 0;
  w.service.from = (table) => {
    if (table === "job_applications" && ++applicationReads === 3) return failingQuery();
    return realFrom(table);
  };
  const read = await fetchApplicationInbound(APP_A);
  assert.equal(applicationReads, 3, "the owner lookup is the read that failed");
  assert.deepEqual(read, { ok: false, rows: [], basis: "phone", truncated: false });
});

/** A builder that records nothing and resolves to a database error. */
function failingQuery() {
  const q = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve) =>
            Promise.resolve({ data: null, error: { code: "XX000", message: "fault" } }).then(
              resolve,
            );
        }
        return () => q;
      },
    },
  );
  return q;
}
