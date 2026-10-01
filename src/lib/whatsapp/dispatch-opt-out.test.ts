/**
 * The WhatsApp dispatcher honours an opt-out under either identifier, and does
 * not send when it cannot tell.
 *
 *   node --test src/lib/whatsapp/dispatch-opt-out.test.ts
 *
 * Drives the real handleWhatsAppMessage end to end: the real send module, the
 * real normaliser, a fake database (via whatsapp-dispatch-test-hook.mjs) and a
 * fake `fetch` standing in for Meta. "Sent" here means a request reached the
 * fake Meta endpoint; nothing leaves the machine.
 *
 * Imports only the dispatcher, never opt-out.ts, so this file also runs against
 * the code before the fix. There the BSUID case sends, and fails.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { call, fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/whatsapp-dispatch-test-hook.mjs", import.meta.url));

const dispatch = await import("./dispatch.ts");
const { handleWhatsAppMessage } = dispatch;

/** A made-up Pakistani mobile, in the form an applicant would type it. */
const TYPED_PHONE = "0300 1234567";
const DIGITS = "923001234567";
const RAW_DB_ERROR = "permission denied for table whatsapp_inbound";

const ok = (data) => ({ data, error: null });
const fail = { data: null, error: { message: RAW_DB_ERROR } };

/**
 * The database the dispatcher talks to. `optOuts` and `inbound` decide the
 * opt-out answer; `failing` makes one of the three opt-out reads error;
 * `staleQueued` puts an adoptable stale row in front of the send.
 */
function world({ optOuts = [], inbound = [], failing = null, staleQueued = false } = {}) {
  return fakeService((table, calls) => {
    switch (table) {
      case "communication_logs": {
        if (call(calls, "insert")) return ok({ id: "log-new" });
        if (call(calls, "update")) return { data: null, error: null };
        // The idempotency read.
        return ok(
          staleQueued
            ? {
                id: "log-stale",
                status: "queued",
                created_at: new Date(Date.now() - 3_600_000).toISOString(),
              }
            : null,
        );
      }
      case "job_applications":
        return ok({
          id: "app-1",
          first_name: "Test",
          phone: TYPED_PHONE,
          job_id: "job-1",
          job_title_snapshot: "Engineer",
          company_id_snapshot: "company-1",
        });
      case "companies":
        return ok({ name: "Acme" });
      case "jobs":
        return ok({ title: "Engineer" });
      case "whatsapp_opt_outs": {
        const byPhone = calls.find((c) => c[0] === "eq" && c[1] === "phone");
        const byBsuid = calls.find((c) => c[0] === "in" && c[1] === "bsuid");
        if (byPhone && failing === "opt_outs_by_phone") return fail;
        if (byBsuid && failing === "opt_outs_by_bsuid") return fail;
        const rows = byPhone
          ? optOuts.filter((r) => r.phone === byPhone[2])
          : byBsuid
            ? optOuts.filter((r) => r.bsuid && byBsuid[2].includes(r.bsuid))
            : [];
        // Answers both the old `.maybeSingle()` read and the new list read.
        return call(calls, "maybeSingle") ? ok(rows[0] ?? null) : ok(rows.slice(0, 1));
      }
      case "whatsapp_inbound": {
        if (failing === "inbound_bsuids") return fail;
        const forms = call(calls, "in")?.[2] ?? [];
        return ok(inbound.filter((r) => forms.includes(r.from_phone)));
      }
      default:
        throw new Error(`unexpected table ${table}`);
    }
  });
}

/** Run one automatic interview send against a world; report what happened. */
async function run(service) {
  const metaRequests = [];
  const saved = {
    fetch: globalThis.fetch,
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const logged = [];
  globalThis.__whatsappDispatchServiceForTests = () => service;
  globalThis.fetch = async (url, init) => {
    metaRequests.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), { status: 200 });
  };
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  console.error = (...a) => logged.push(a.join(" "));
  console.log = () => {};
  console.warn = () => {};
  try {
    await handleWhatsAppMessage({
      id: "job-1",
      payload: { applicationId: "app-1", event: "interview", channel: "whatsapp" },
    });
  } finally {
    delete globalThis.__whatsappDispatchServiceForTests;
    globalThis.fetch = saved.fetch;
    for (const [k, v] of [
      ["WHATSAPP_ACCESS_TOKEN", saved.token],
      ["WHATSAPP_PHONE_NUMBER_ID", saved.phoneId],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    console.error = saved.error;
    console.log = saved.log;
    console.warn = saved.warn;
  }
  const logWrites = service.queries
    .filter((q) => q.table === "communication_logs")
    .flatMap((q) =>
      q.calls
        .filter((c) => c[0] === "insert" || c[0] === "update")
        .map((c) => ({ kind: c[0], row: c[1] })),
    );
  return { metaRequests, logWrites, logged };
}

const skippedRows = (writes) => writes.filter((w) => w.row?.status === "skipped");

test("no opt-out anywhere: the message is sent", async () => {
  const { metaRequests, logWrites } = await run(world());
  assert.equal(metaRequests.length, 1, "one request to Meta");
  assert.ok(metaRequests[0].body.includes(DIGITS), "addressed to the normalised number");
  assert.ok(logWrites.some((w) => w.row?.status === "sent"));
});

test("an opt-out under the phone blocks the send", async () => {
  const { metaRequests, logWrites } = await run(
    world({ optOuts: [{ phone: DIGITS, bsuid: null }] }),
  );
  assert.equal(metaRequests.length, 0, "sent to an opted-out phone");
  const [row] = skippedRows(logWrites);
  assert.equal(row?.row.error, dispatch.OPTED_OUT_REASON);
});

test("a BSUID-only opt-out blocks the send when whatsapp_inbound links that BSUID to the phone", async () => {
  const { metaRequests, logWrites } = await run(
    world({
      optOuts: [{ phone: null, bsuid: "BSUID-A" }],
      inbound: [{ from_phone: DIGITS, bsuid: "BSUID-A" }],
    }),
  );
  assert.equal(metaRequests.length, 0, "sent to a candidate who opted out under their BSUID");
  const [row] = skippedRows(logWrites);
  assert.equal(row?.row.error, dispatch.OPTED_OUT_REASON);
});

for (const failing of ["opt_outs_by_phone", "inbound_bsuids", "opt_outs_by_bsuid"]) {
  test(`a failed ${failing} lookup fails closed and records a skipped row with a safe reason`, async () => {
    const { metaRequests, logWrites, logged } = await run(
      world({ inbound: [{ from_phone: DIGITS, bsuid: "BSUID-A" }], failing }),
    );
    assert.equal(metaRequests.length, 0, "sent although the opt-out check failed");
    const skipped = skippedRows(logWrites);
    assert.equal(skipped.length, 1, "exactly one skipped row");
    const { kind, row } = skipped[0];
    assert.equal(kind, "insert");
    assert.equal(row.channel, "whatsapp");
    assert.equal(row.error, dispatch.OPT_OUT_CHECK_FAILED_REASON);
    assert.ok(
      !JSON.stringify(logWrites).includes(RAW_DB_ERROR),
      "raw database text reached the log row",
    );
    assert.ok(
      logged.some((l) => l.includes(RAW_DB_ERROR)),
      "raw cause must reach the server log",
    );
  });
}

test("on an adopted stale row, a failed lookup marks THAT row skipped rather than inserting a second", async () => {
  const { metaRequests, logWrites } = await run(
    world({ failing: "opt_outs_by_phone", staleQueued: true }),
  );
  assert.equal(metaRequests.length, 0);
  assert.equal(
    logWrites.filter((w) => w.kind === "insert").length,
    0,
    "a second automatic row would collide",
  );
  const skipped = skippedRows(logWrites);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, "update");
  assert.equal(skipped[0].row.error, dispatch.OPT_OUT_CHECK_FAILED_REASON);
});
