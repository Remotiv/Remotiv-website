/**
 * isWhatsAppOptedOut: the canonical opt-out rule, every branch of it.
 *
 *   node --test src/lib/whatsapp/opt-out.test.ts
 *
 * The dispatcher's use of it is tested in dispatch-opt-out.test.ts. This file
 * holds the rule itself: which reads it makes, what each answer means, and that
 * every failed read is `lookup_failed` and never `clear`.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { call, fakeService } from "../../test-support/fake-postgrest.mjs";

register(new URL("../../test-support/node-resolve.mjs", import.meta.url));

const { isWhatsAppOptedOut, storedPhoneForms } = await import("./opt-out.ts");

/** A test number in the normalised form, and the BSUIDs in play. */
const DIGITS = "923001234567";
const OTHER_DIGITS = "923009999999";

const ok = (data) => ({ data, error: null });
const fail = { data: null, error: { message: 'relation "x" does not exist' } };

/**
 * A database with these opt-out rows and inbound pairings. Filters are honoured
 * the way PostgREST would, so the answers are what the real query would get.
 */
function world({ optOuts = [], inbound = [], failing = null } = {}) {
  return fakeService((table, calls) => {
    if (table === "whatsapp_opt_outs") {
      const byPhone = calls.find((c) => c[0] === "eq" && c[1] === "phone");
      const byBsuid = calls.find((c) => c[0] === "in" && c[1] === "bsuid");
      if (byPhone) {
        if (failing === "opt_outs_by_phone") return fail;
        return ok(optOuts.filter((r) => r.phone === byPhone[2]).slice(0, 1));
      }
      if (byBsuid) {
        if (failing === "opt_outs_by_bsuid") return fail;
        return ok(optOuts.filter((r) => r.bsuid && byBsuid[2].includes(r.bsuid)).slice(0, 1));
      }
      throw new Error("unexpected whatsapp_opt_outs query");
    }
    if (table === "whatsapp_inbound") {
      if (failing === "inbound_bsuids") return fail;
      const forms = call(calls, "in")[2];
      return ok(inbound.filter((r) => forms.includes(r.from_phone) && r.bsuid !== null));
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const quiet = async (fn) => {
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    return await fn(logged);
  } finally {
    console.error = orig;
  }
};

test("an opt-out under the phone is found by the phone", async () => {
  const r = await isWhatsAppOptedOut(world({ optOuts: [{ phone: DIGITS, bsuid: null }] }), DIGITS);
  assert.deepEqual(r, { status: "opted_out", matchedBy: "phone" });
});

test("a BSUID-only opt-out is found through a BSUID seen with that phone", async () => {
  const service = world({
    optOuts: [{ phone: null, bsuid: "BSUID-A" }],
    inbound: [{ from_phone: DIGITS, bsuid: "BSUID-A" }],
  });
  const r = await isWhatsAppOptedOut(service, DIGITS);
  assert.deepEqual(r, { status: "opted_out", matchedBy: "bsuid" });
});

test("a BSUID seen only with another number does not opt this one out", async () => {
  const service = world({
    optOuts: [{ phone: null, bsuid: "BSUID-B" }],
    inbound: [
      { from_phone: OTHER_DIGITS, bsuid: "BSUID-B" },
      { from_phone: DIGITS, bsuid: "BSUID-A" },
    ],
  });
  assert.deepEqual(await isWhatsAppOptedOut(service, DIGITS), { status: "clear" });
});

test("a row the database returns for a different number is still refused by the normaliser", async () => {
  // Filters ignored on purpose: this is the code's own check, not the query's.
  const service = fakeService((table, calls) => {
    if (table === "whatsapp_inbound") return ok([{ from_phone: OTHER_DIGITS, bsuid: "BSUID-B" }]);
    if (call(calls, "in")) return ok([{ id: "x" }]);
    return ok([]);
  });
  assert.deepEqual(await isWhatsAppOptedOut(service, DIGITS), { status: "clear" });
});

test("an inbound row stored in another spelling of the same number still links", async () => {
  const service = world({
    optOuts: [{ phone: null, bsuid: "BSUID-A" }],
    inbound: [{ from_phone: `+${DIGITS}`, bsuid: "BSUID-A" }],
  });
  assert.deepEqual(await isWhatsAppOptedOut(service, DIGITS), {
    status: "opted_out",
    matchedBy: "bsuid",
  });
});

test("no opt-out anywhere is clear, and with no BSUID the third read is not made", async () => {
  const empty = world();
  assert.deepEqual(await isWhatsAppOptedOut(empty, DIGITS), { status: "clear" });
  assert.equal(empty.queries.length, 2, "phone check and inbound read only");

  const linked = world({ inbound: [{ from_phone: DIGITS, bsuid: "BSUID-A" }] });
  assert.deepEqual(await isWhatsAppOptedOut(linked, DIGITS), { status: "clear" });
  assert.equal(linked.queries.length, 3);
});

for (const source of ["opt_outs_by_phone", "inbound_bsuids", "opt_outs_by_bsuid"]) {
  test(`a failed ${source} read fails closed, logs the cause, and returns no raw text`, async () => {
    await quiet(async (logged) => {
      const service = world({
        inbound: [{ from_phone: DIGITS, bsuid: "BSUID-A" }],
        failing: source,
      });
      const r = await isWhatsAppOptedOut(service, DIGITS);
      assert.deepEqual(r, { status: "lookup_failed", source });
      assert.ok(!JSON.stringify(r).includes("does not exist"), "raw error leaked into the result");
      assert.ok(
        logged.some((l) => l.includes(source) && l.includes("does not exist")),
        "not logged",
      );
    });
  });
}

test("the stored spellings all normalise back to the same digits", async () => {
  const { toWhatsAppDigits } = await import("../normalize.ts");
  for (const form of storedPhoneForms(DIGITS)) {
    assert.equal(toWhatsAppDigits(form), DIGITS, form);
  }
});
