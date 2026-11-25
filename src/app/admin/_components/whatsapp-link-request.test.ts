/**
 * #67: the admin drawer never shows one applicant's WhatsApp link on another
 * applicant's drawer, or after it closed. An answer that arrives after the
 * effect's cleanup is dropped.
 *
 *   node --test src/app/admin/_components/whatsapp-link-request.test.ts
 *
 * The real requestWhatsAppLink with promises the test resolves by hand, and
 * the drawer's source for the wiring around it. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));

const { requestWhatsAppLink } = await import("./whatsapp-link-request.ts");
const { CHAT_LINK_UNAVAILABLE, CHAT_STOP_NOTE } = await import("../../../lib/whatsapp/consent.ts");

/** A load() whose answers the test settles, per application id, in any order. */
function slowServer() {
  const pending = new Map();
  const load = (id) =>
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  return { load, pending };
}
const linkFor = (id) => ({ ok: true, href: `https://wa.me/92300000000${id.at(-1)}` });
const settle = () => new Promise((r) => setImmediate(r));

test("an answer that arrives while the drawer still shows that applicant is applied", async () => {
  const server = slowServer();
  const applied = [];
  requestWhatsAppLink(server.load, "app-a", (x) => applied.push(x));
  server.pending.get("app-a").resolve(linkFor("app-a"));
  await settle();
  assert.deepEqual(applied, [linkFor("app-a")]);
});

test("the drawer moved from A to B, and A's slow answer lands last: only B's link is shown", async () => {
  const server = slowServer();
  const applied = [];
  const cancelA = requestWhatsAppLink(server.load, "app-a", (x) => applied.push(["a", x]));
  cancelA(); // the effect's cleanup when app.id changes
  requestWhatsAppLink(server.load, "app-b", (x) => applied.push(["b", x]));
  server.pending.get("app-b").resolve(linkFor("app-b"));
  await settle();
  server.pending.get("app-a").resolve(linkFor("app-a"));
  await settle();
  assert.deepEqual(applied, [["b", linkFor("app-b")]]);
});

test("A's answer landing before B's, but after the switch, is dropped too", async () => {
  const server = slowServer();
  const applied = [];
  const cancelA = requestWhatsAppLink(server.load, "app-a", (x) => applied.push(["a", x]));
  cancelA();
  requestWhatsAppLink(server.load, "app-b", (x) => applied.push(["b", x]));
  server.pending.get("app-a").resolve(linkFor("app-a"));
  await settle();
  assert.deepEqual(applied, []);
  server.pending.get("app-b").resolve({ ok: false, label: CHAT_LINK_UNAVAILABLE.no_opt_in });
  await settle();
  assert.deepEqual(applied, [["b", { ok: false, label: CHAT_LINK_UNAVAILABLE.no_opt_in }]]);
});

test("the drawer closed (unmount cleanup): a late link or a late failure is dropped", async () => {
  for (const outcome of ["resolve", "reject"]) {
    const server = slowServer();
    const applied = [];
    const cancel = requestWhatsAppLink(server.load, "app-a", (x) => applied.push(x));
    cancel();
    if (outcome === "resolve") server.pending.get("app-a").resolve(linkFor("app-a"));
    else server.pending.get("app-a").reject(new Error("network"));
    await settle();
    assert.deepEqual(applied, [], outcome);
  }
});

test("a failed request while still open is no link, never a stale one", async () => {
  const server = slowServer();
  const applied = [];
  requestWhatsAppLink(server.load, "app-a", (x) => applied.push(x));
  server.pending.get("app-a").reject(new Error("network"));
  await settle();
  assert.deepEqual(applied, [{ ok: false, label: CHAT_LINK_UNAVAILABLE.check_failed }]);
});

// ── The drawer's wiring ─────────────────────────────────────

const drawer = readFileSync(new URL("./applications-dashboard.tsx", import.meta.url), "utf8");

test("the effect clears the old answer, asks for the current applicant, and returns the cancel", () => {
  assert.match(
    drawer,
    /useEffect\(\(\) => \{\s*setWaLink\(null\);\s*return requestWhatsAppLink\(getApplicationWhatsAppLink, app\.id, setWaLink\);\s*\}, \[app\.id\]\);/,
  );
  // Nothing else asks for the link, so nothing else can apply a stale answer.
  assert.equal(drawer.match(/getApplicationWhatsAppLink\(/g)?.length ?? 0, 0);
  assert.equal(
    drawer.match(/getApplicationWhatsAppLink\b/g)?.length,
    2,
    "the import and the effect",
  );
});

test("the click opens the link it already has, at once: no re-check, no await", () => {
  assert.match(
    drawer,
    /onClick=\{\(\) => window\.open\(waLink\.href, "_blank", "noopener,noreferrer"\)\}/,
  );
  assert.equal(drawer.match(/window\.open\(/g)?.length, 1);
});

test("the STOP note sits under the button, only when the button is shown", () => {
  assert.equal(
    CHAT_STOP_NOTE,
    "If they reply STOP in this chat, don't message them again and tell the team.",
  );
  assert.doesNotMatch(CHAT_STOP_NOTE, /[‒-―]/);
  const shown = drawer.slice(
    drawer.indexOf("{waLink?.ok ? ("),
    drawer.indexOf(") : (", drawer.indexOf("{waLink?.ok ? (")),
  );
  assert.ok(shown.indexOf("Message on WhatsApp") < shown.indexOf("{CHAT_STOP_NOTE}"));
  assert.equal(drawer.match(/\{CHAT_STOP_NOTE\}/g)?.length, 1, "nowhere else");
});
