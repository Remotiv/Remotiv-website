/**
 * WhatsApp is on for the Remotiv AI product only (Waleed, 26 Nov 2026). For
 * Remotiv's own board and /admin it is off until WHATSAPP_REMOTIV_BOARD_ENABLED
 * is "true". The code stays; this holds the switch to every place it gates.
 *
 *   node --test src/lib/whatsapp/remotiv-board.test.ts
 *
 * The real dispatcher against fake-attempt-db and a fake Meta, the real
 * /api/apply POST against fake-postgrest, and the sources of the pages that
 * decide what the browser shows. Synthetic data only.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { register } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { APP_ID, attemptDb, COMPANY_ID, DEFAULT_APP } from "../../test-support/fake-attempt-db.mjs";
import { blockNetwork } from "../../test-support/no-network.mjs";

const guard = blockNetwork();
register(new URL("../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../test-support/whatsapp-dispatch-test-hook.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "server-only": "",
  "@/lib/supabase/server": "export function createServiceClient() { return globalThis.__whatsappDispatchServiceForTests ? globalThis.__whatsappDispatchServiceForTests() : globalThis.__boardService; }",
  "@/app/api/_lib/rate-limit": "export function rateLimit() { return { ok: true }; }",
  "@/app/admin/lib/role-guards": "export async function requireAdmin() { throw new Error('not an admin'); }",
  "@/lib/ai/cv-score-request": "export async function requestCvScore() { return { ok: true }; }",
  "@/lib/claim-tokens": "export async function mintClaimToken() { return null; }",
  "@/lib/email/candidate/triggers": "export async function queueApplicationReceived() {}",
  "@/lib/pdf-text": "export async function extractPdfTextServer() { return { text: null, status: 'skipped', error: null }; } export function stripInvalidPgChars(s) { return s; }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  if (specifier === "next/server") return next("next/server.js", context);
  return next(specifier, context);
}`)}`,
);

const { REMOTIV_BOARD_OFF_REASON, whatsAppAllowedFor, whatsAppOnRemotivBoard } = await import(
  "./remotiv-board.ts"
);
const { handleWhatsAppMessage, queueManualWhatsApp } = await import("./dispatch.ts");
const { fakeService } = await import("../../test-support/fake-postgrest.mjs");
const { POST } = await import("../../app/api/apply/route.ts");

const SWITCH = "WHATSAPP_REMOTIV_BOARD_ENABLED";
/** Run `fn` with the switch at `value` (undefined = unset), then put it back. */
async function withSwitch(value, fn) {
  const saved = process.env[SWITCH];
  if (value === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = saved;
  }
}

const TICKED = { whatsapp_opt_in: true, whatsapp_opt_in_at: "2026-11-25T09:00:00.000Z" };
const COMPANY_APP = { ...DEFAULT_APP, ...TICKED };
const BOARD_APP = { ...DEFAULT_APP, ...TICKED, company_id_snapshot: null };

// ── The switch ──────────────────────────────────────────────

test('the switch: unset, empty or anything but "true" is off', async () => {
  for (const v of [undefined, "", "false", "0", "1", "yes", "TRUE", " true"]) {
    await withSwitch(v, () => {
      assert.equal(whatsAppOnRemotivBoard(), false, String(v));
      assert.equal(whatsAppAllowedFor(null), false, String(v));
      assert.equal(whatsAppAllowedFor(undefined), false, String(v));
      assert.equal(whatsAppAllowedFor(""), false, String(v));
    });
  }
  await withSwitch("true", () => {
    assert.equal(whatsAppOnRemotivBoard(), true);
    assert.equal(whatsAppAllowedFor(null), true);
  });
});

test("a company's job (the AI product, white-label careers included) is allowed whatever the switch", async () => {
  for (const v of [undefined, "true"]) {
    await withSwitch(v, () => assert.equal(whatsAppAllowedFor(COMPANY_ID), true, String(v)));
  }
});

test("the reason is the decided wording, with no dash", () => {
  assert.equal(
    REMOTIV_BOARD_OFF_REASON,
    "Not sent: WhatsApp is only used for Remotiv AI interviews.",
  );
  assert.doesNotMatch(REMOTIV_BOARD_OFF_REASON, /[‒-―]/);
});

// ── System sends ────────────────────────────────────────────

/** One send_message[whatsapp] job: what reached Meta, and what was logged. */
async function send(world, event) {
  const metaCalls = [];
  const logs = [];
  const saved = {
    fetch: globalThis.fetch,
    log: console.log,
    warn: console.warn,
    error: console.error,
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
  globalThis.__whatsappDispatchServiceForTests = () => world.service;
  globalThis.fetch = async (_url, init) => {
    metaCalls.push(init?.body);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 });
  };
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = () => {};
  console.error = () => {};
  try {
    await handleWhatsAppMessage({
      id: "job-1",
      attempts: 0,
      payload: { applicationId: APP_ID, channel: "whatsapp", event },
    });
  } finally {
    delete globalThis.__whatsappDispatchServiceForTests;
    globalThis.fetch = saved.fetch;
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
    for (const [k, v] of [
      ["WHATSAPP_ACCESS_TOKEN", saved.token],
      ["WHATSAPP_PHONE_NUMBER_ID", saved.phoneId],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { metaCalls, logs };
}

for (const event of ["interview", "interview_reminder"]) {
  test(`switch off, ${event} for a Remotiv-board application that ticked the box: refused, and the log says why`, async () => {
    const world = attemptDb({ app: BOARD_APP });
    const r = await withSwitch(undefined, () => send(world, event));
    assert.equal(r.metaCalls.length, 0);
    assert.equal(world.db.logs.length, 0, "no company owns a Messages row for it");
    assert.ok(
      r.logs.some((l) => l.includes("[job-skip]") && l.includes(REMOTIV_BOARD_OFF_REASON)),
      r.logs.join("\n"),
    );
  });

  test(`switch off, ${event} for an AI-product application that ticked the box: sent as before`, async () => {
    const world = attemptDb({ app: COMPANY_APP });
    const r = await withSwitch(undefined, () => send(world, event));
    assert.equal(r.metaCalls.length, 1);
    assert.equal(world.db.logs[0].status, "sent");
  });

  test(`switch on, ${event}: today's behaviour, a board application is still never sent (no company), an AI one is`, async () => {
    const board = attemptDb({ app: BOARD_APP });
    const b = await withSwitch("true", () => send(board, event));
    assert.equal(b.metaCalls.length, 0);
    assert.ok(
      b.logs.some((l) => l.includes("has no company")),
      b.logs.join("\n"),
    );
    assert.ok(!b.logs.some((l) => l.includes(REMOTIV_BOARD_OFF_REASON)));

    const company = attemptDb({ app: COMPANY_APP });
    const c = await withSwitch("true", () => send(company, event));
    assert.equal(c.metaCalls.length, 1);
  });
}

test("a recruiter's WhatsApp is only ever for a company's own applicant, switch on or off", async () => {
  for (const v of [undefined, "true"]) {
    const world = attemptDb({ app: BOARD_APP });
    globalThis.__whatsappDispatchServiceForTests = () => world.service;
    try {
      const r = await withSwitch(v, () =>
        queueManualWhatsApp(world.service, {
          applicationId: APP_ID,
          companyId: COMPANY_ID,
          event: "interview",
          sentByName: "Rae",
          deadline: "30 Nov 2026",
        }),
      );
      assert.equal(r.kind, "not_queued", String(v));
      assert.equal(world.db.jobs.length, 0);
    } finally {
      delete globalThis.__whatsappDispatchServiceForTests;
    }
  }
});

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel) => readFileSync(join(SRC, rel), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the guard asks the switch first, before consent, the number or STOP", () => {
  const src = code(read("lib/whatsapp/dispatch.ts"));
  const body = src.slice(src.indexOf("async function sendTarget("));
  const board = body.indexOf("if (!whatsAppAllowedFor(app.company_id_snapshot)) {");
  assert.ok(board > 0, "the board check");
  assert.ok(board < body.indexOf("hasWhatsAppOptIn(app)"));
  assert.ok(board < body.indexOf("isWhatsAppOptedOut("));
  assert.match(body.slice(board, body.indexOf("}", board)), /reason: REMOTIV_BOARD_OFF_REASON/);
});

// ── The apply form ──────────────────────────────────────────

const JOB = "a0000000-0000-4000-8000-0000000000b0";

/** A database with one open job owned by `companyId`; keeps what was inserted. */
function applyWorld(companyId) {
  const inserts = [];
  const svc = fakeService((table, calls) => {
    const insert = calls.find((c) => c[0] === "insert");
    if (table === "jobs") {
      return {
        data: {
          id: JOB,
          title: "Synthetic role",
          status: "open",
          archived_at: null,
          deleted_at: null,
          company_id: companyId,
          screening_questions: [],
        },
        error: null,
      };
    }
    if (table === "job_applications" && insert) {
      inserts.push(insert[1]);
      return { data: { id: "app-b" }, error: null };
    }
    if (table === "job_applications") {
      return { data: calls.some((c) => c[0] === "maybeSingle") ? null : [], error: null };
    }
    return { data: null, error: null };
  });
  svc.storage = {
    from: () => ({ upload: async () => ({ error: null }), remove: async () => ({}) }),
  };
  globalThis.__boardService = svc;
  return inserts;
}

async function apply() {
  const fd = new FormData();
  fd.set("job_id", JOB);
  fd.set("first_name", "Syn");
  fd.set("last_name", "Thetic");
  fd.set("email", "syn@example.test");
  fd.set("phone", "0300 1234567");
  fd.set("linkedin_url", "https://www.linkedin.com/in/synthetic");
  fd.set("cv_text", "synthetic cv text");
  fd.set("cv", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], "cv.pdf"));
  // A browser that posts the tick anyway: the server decides, not the form.
  fd.set("whatsapp_opt_in", "yes");
  const saved = { error: console.error, log: console.log };
  console.error = () => {};
  console.log = () => {};
  try {
    const res = await POST(new Request("http://localhost/api/apply", { method: "POST", body: fd }));
    return res.status;
  } finally {
    Object.assign(console, saved);
  }
}

test("switch off: a tick posted for a Remotiv-board job stores no consent", async () => {
  const inserts = applyWorld(null);
  assert.equal(await withSwitch(undefined, apply), 200);
  assert.equal(inserts[0].company_id_snapshot, null);
  assert.equal(inserts[0].whatsapp_opt_in, false);
  assert.equal(inserts[0].whatsapp_opt_in_at, null);
});

test("switch off: a tick for an AI-product job is stored as before", async () => {
  const inserts = applyWorld(COMPANY_ID);
  assert.equal(await withSwitch(undefined, apply), 200);
  assert.equal(inserts[0].whatsapp_opt_in, true);
  assert.equal(typeof inserts[0].whatsapp_opt_in_at, "string");
});

test("switch on: a tick for a Remotiv-board job is stored again", async () => {
  const inserts = applyWorld(null);
  assert.equal(await withSwitch("true", apply), 200);
  assert.equal(inserts[0].whatsapp_opt_in, true);
  assert.equal(typeof inserts[0].whatsapp_opt_in_at, "string");
});

test("the route decides from the job row it read, the same value it stores as the snapshot", () => {
  const src = code(read("app/api/apply/route.ts"));
  assert.match(
    src,
    /const postedOptIn = whatsAppAllowedFor\(companyIdSnapshot\)\s*\? form\.get\(WHATSAPP_OPT_IN_FIELD\)\s*: null;/,
  );
  assert.match(src, /\.\.\.optInColumns\(postedOptIn, source, new Date\(\)\),/);
  assert.match(src, /company_id_snapshot: companyIdSnapshot,/);
});

test("the box: shown only when the server offers it, posted only then, off by default", () => {
  const modal = code(read("app/jobs/_apply-modal.tsx"));
  assert.match(modal, /offerWhatsApp = false,/);
  assert.match(modal, /\{offerWhatsApp && \(\s*<label htmlFor="apply-whatsapp"/);
  assert.equal(modal.match(/id="apply-whatsapp"/g)?.length, 1, "no second, ungated box");
  assert.match(
    modal,
    /if \(offerWhatsApp && whatsAppOptIn\) fd\.append\(WHATSAPP_OPT_IN_FIELD, WHATSAPP_OPT_IN_TICKED\);/,
  );

  const button = code(read("app/jobs/[slug]/_apply-button.tsx"));
  assert.match(button, /offerWhatsApp = false,/);
  assert.match(button, /<ApplyModal\b[^/]*offerWhatsApp=\{offerWhatsApp\}\s*\/>/);
});

test("both job pages ask the server helper, from the job's owner, on every Apply button", () => {
  for (const [file, buttons] of [
    ["app/jobs/[slug]/_remotiv-detail.tsx", 2],
    ["app/jobs/[slug]/_company-detail.tsx", 3],
  ]) {
    const src = code(read(file));
    assert.doesNotMatch(src, /^\s*["']use client["']/m, `${file} decides on the server`);
    assert.match(src, /const offerWhatsApp = whatsAppAllowedFor\(job\.company_id\);/, file);
    assert.equal(src.match(/<ApplyButton\b/g)?.length, buttons, file);
    assert.equal(
      src.match(/<ApplyButton\s+job=\{applyJob\}\s+offerWhatsApp=\{offerWhatsApp\}/g)?.length,
      buttons,
      file,
    );
  }
});

// ── The admin drawer ────────────────────────────────────────

test("admin: the page reads the switch on the server, and the drawer shows nothing while it is off", () => {
  const page = code(read("app/admin/applications/page.tsx"));
  assert.match(page, /whatsAppEnabled=\{whatsAppOnRemotivBoard\(\)\}/);

  const drawer = code(read("app/admin/_components/applications-dashboard.tsx"));
  assert.match(drawer, /whatsAppEnabled = false,/, "off unless the page says on");
  assert.match(drawer, /whatsAppEnabled=\{whatsAppEnabled\}/);
  assert.match(
    drawer,
    /setWaLink\(null\);\s*if \(!whatsAppEnabled\) return;\s*return requestWhatsAppLink\(/,
  );
  // The button, its STOP note and the "unavailable" line all sit inside the gate.
  const gate = drawer.indexOf("{whatsAppEnabled &&");
  assert.ok(gate > 0);
  const end = drawer.indexOf("))}", gate);
  const inside = drawer.slice(gate, end);
  for (const piece of ["Message on WhatsApp", "{CHAT_STOP_NOTE}", "Checking WhatsApp…"]) {
    assert.ok(inside.includes(piece), piece);
    assert.equal(drawer.split(piece).length, 2, `${piece}: once, inside the gate`);
  }
});

// ── One reader ──────────────────────────────────────────────

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) yield path;
  }
}

test("only remotiv-board.ts reads the switch", () => {
  const readers = [...sources(SRC)]
    .filter((p) => code(readFileSync(p, "utf8")).includes(SWITCH))
    .map((p) => relative(SRC, p));
  assert.deepEqual(readers, ["lib/whatsapp/remotiv-board.ts"]);
});

test("no network was touched", () => {
  guard.assertNoNetwork();
});
