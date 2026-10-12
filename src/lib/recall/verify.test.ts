/**
 * Recall webhook signatures: the Standard Webhooks scheme Recall signs with
 * through Svix, in both header families, against the exact raw body.
 *
 *   node --test src/lib/recall/verify.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { verifyRecallWebhook } from "./verify.ts";

const KEY = randomBytes(32);
const SECRET = `whsec_${KEY.toString("base64")}`;
const NOW = 1_800_000_000_000;
const TS = String(Math.floor(NOW / 1000));
const BODY = '{"event":"bot.done","data":{"data":{"code":"done"},"bot":{"id":"x"}}}';

const sign = (key, id, ts, body) =>
  createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");

function headers(family, { id = "msg_1", ts = TS, sig, key = KEY, body = BODY } = {}) {
  return {
    [`${family}-id`]: id,
    [`${family}-timestamp`]: ts,
    [`${family}-signature`]: sig ?? `v1,${sign(key, id, ts, body)}`,
  };
}

const verify = (h, { secret = SECRET, body = BODY, now = NOW } = {}) =>
  verifyRecallWebhook({
    secret,
    header: (name) => h[name.toLowerCase()] ?? null,
    rawBody: body,
    nowMs: now,
  });

test("the workspace secret with webhook-* headers verifies", () => {
  const r = verify(headers("webhook"));
  assert.equal(r.ok, true);
  assert.equal(r.family, "webhook");
  assert.equal(r.id, "msg_1");
});

test("a legacy svix-* delivery verifies with the same algorithm", () => {
  const r = verify(headers("svix"));
  assert.equal(r.ok, true);
  assert.equal(r.family, "svix");
});

test("both families with the same values: the standard one is used", () => {
  const r = verify({ ...headers("svix"), ...headers("webhook") });
  assert.equal(r.ok, true);
  assert.equal(r.family, "webhook");
});

test("families are never blended", () => {
  const w = headers("webhook");
  const s = headers("svix");
  assert.equal(
    verify({
      "webhook-id": w["webhook-id"],
      "webhook-timestamp": w["webhook-timestamp"],
      "svix-signature": s["svix-signature"],
    }).reason,
    "mixed_headers",
  );
  assert.equal(verify({ ...w, "svix-id": "msg_other" }).reason, "mixed_headers");
  assert.equal(
    verify({ "webhook-id": "msg_1", "webhook-timestamp": TS }).reason,
    "missing_headers",
  );
  assert.equal(verify({}).reason, "missing_headers");
});

test("a signature from another secret is refused", () => {
  const r = verify(headers("webhook", { key: randomBytes(32) }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_signature");
});

test("the raw body is what is signed: any change, even whitespace or key order, fails", () => {
  const h = headers("webhook");
  assert.equal(verify(h, { body: `${BODY} ` }).reason, "bad_signature");
  assert.equal(verify(h, { body: BODY.replace("done", "fatal") }).reason, "bad_signature");
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 1);
  assert.equal(verify(h, { body: reserialised }).reason, "bad_signature");
  // The id and timestamp are inside the signed content too.
  assert.equal(verify({ ...h, "webhook-id": "msg_2" }).reason, "bad_signature");
});

test("timestamps more than five minutes away either way are refused", () => {
  const at = (deltaSeconds) => {
    const ts = String(Number(TS) + deltaSeconds);
    return verify(headers("webhook", { ts }));
  };
  assert.equal(at(-300).ok, true);
  assert.equal(at(300).ok, true);
  assert.equal(at(-301).reason, "stale_timestamp");
  assert.equal(at(301).reason, "stale_timestamp");
  assert.equal(verify(headers("webhook", { ts: "12.5" })).reason, "bad_timestamp");
  assert.equal(verify(headers("webhook", { ts: "soon" })).reason, "bad_timestamp");
});

test("several v1 signatures: any one match is enough; other versions are ignored", () => {
  const good = sign(KEY, "msg_1", TS, BODY);
  const bad = sign(randomBytes(32), "msg_1", TS, BODY);
  assert.equal(verify(headers("webhook", { sig: `v1,${bad} v1,${good}` })).ok, true);
  assert.equal(verify(headers("webhook", { sig: `v1,${good} v1,${bad}` })).ok, true);
  assert.equal(verify(headers("webhook", { sig: `v2,${good}` })).reason, "bad_signature");
  assert.equal(verify(headers("webhook", { sig: `v1,${bad}` })).reason, "bad_signature");
  assert.equal(verify(headers("webhook", { sig: "v1,short" })).reason, "bad_signature");
  assert.equal(verify(headers("webhook", { sig: "garbage" })).reason, "bad_signature");
});

test("during a rotation, old and new secrets both verify their own signature", () => {
  const oldKey = randomBytes(32);
  const sig = `v1,${sign(oldKey, "msg_1", TS, BODY)} v1,${sign(KEY, "msg_1", TS, BODY)}`;
  assert.equal(verify(headers("webhook", { sig })).ok, true);
  assert.equal(
    verify(headers("webhook", { sig }), { secret: `whsec_${oldKey.toString("base64")}` }).ok,
    true,
  );
});

test("no secret, or a malformed one, is a configuration refusal, before any comparison", () => {
  const h = headers("webhook");
  for (const secret of [undefined, null, "", "   "]) {
    const r = verifyRecallWebhook({
      secret,
      header: (name) => h[name] ?? null,
      rawBody: BODY,
      nowMs: NOW,
    });
    assert.equal(r.reason, "no_secret", String(secret));
  }
  for (const secret of [KEY.toString("base64"), "whsec_", "whsec_!!!notbase64", "whsec_c2hvcnQ="]) {
    assert.equal(verify(headers("webhook"), { secret }).reason, "bad_secret", secret);
  }
});

test("results carry no secret, key or signature", () => {
  for (const h of [headers("webhook"), headers("webhook", { key: randomBytes(32) })]) {
    const text = JSON.stringify(verify(h));
    assert.ok(!text.includes(KEY.toString("base64")));
    assert.ok(!text.includes("whsec_"));
    assert.ok(!text.includes(h["webhook-signature"].slice(3)));
  }
});
