/**
 * The network guard in a REAL browser, against FABRICATED hosts, offline.
 *
 *   npm run staging:guard-selftest
 *   (playwright test --config scripts/staging/playwright.selftest.config.mjs)
 *
 * Needs no .env.staging and no network. Every destination below is made up,
 * and every forbidden one is aborted by the guard before DNS, so nothing is
 * ever sent anywhere. The approved host is fulfilled by a page-level route
 * registered inside the test (page routes take precedence over context
 * routes), which is how a "successful staging response" is produced without
 * a server. What this proves that the pure tests cannot: the guard is wired
 * into the context before the page exists, Chromium honours the abort, the
 * WebSocket is closed not connected, and a blocked request still fails.
 *
 * Not matched by the harness config: a self-test that deliberately triggers
 * violations must not share the harness's afterEach.
 */

import { expect } from "@playwright/test";
import { sha256 } from "./guard-checks.mjs";
import { guardedTest } from "./guarded-test.mjs";
import { createGuard, policyFrom } from "./network-guard.mjs";

const REF = "stagingfakeref000000";
const guard = createGuard(
  policyFrom({ pin: { projectRefSha256: sha256(REF) }, customDomains: [] }),
);
const test = guardedTest(guard);

const APPROVED_ORIGIN = `https://${REF}.supabase.co`;

test.beforeEach(() => {
  guard.violations.length = 0;
  guard.observed.approvedAttempts = 0;
  guard.observed.approvedOk = 0;
  guard.observed.other = 0;
});

test("a production-looking Supabase host is aborted before the network, recorded masked, and FAILS", async ({
  page,
}) => {
  await page.goto("about:blank");
  const outcome = await page.evaluate(async () => {
    try {
      await fetch(
        "https://prodlikeref0000000000.supabase.co/rest/v1/jobs?select=id&apikey=MUSTNOTAPPEAR",
      );
      return "sent";
    } catch {
      return "failed";
    }
  });
  expect(outcome).toBe("failed");
  expect(guard.violations).toHaveLength(1);
  expect(guard.violations[0].transport).toBe("http");
  expect(JSON.stringify(guard.violations)).not.toContain("prodlikeref");
  expect(JSON.stringify(guard.violations)).not.toContain("MUSTNOTAPPEAR");
  expect(() => guard.assertClean("selftest")).toThrow(/BROWSER NETWORK VIOLATION/);
});

test("an unknown Supabase project is aborted too", async ({ page }) => {
  await page.goto("about:blank");
  const outcome = await page.evaluate(async () => {
    try {
      await fetch("https://unknownref00000000000.supabase.co/auth/v1/token");
      return "sent";
    } catch {
      return "failed";
    }
  });
  expect(outcome).toBe("failed");
  expect(guard.violations).toHaveLength(1);
});

test("a WebSocket to the wrong project is closed by the guard, never connected", async ({
  page,
}) => {
  await page.goto("about:blank");
  const outcome = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const ws = new WebSocket("wss://otherref000000000000.supabase.co/realtime/v1/websocket");
        ws.onopen = () => resolve("opened");
        ws.onclose = () => resolve("closed");
        ws.onerror = () => resolve("closed");
        setTimeout(() => resolve("timeout"), 5000);
      }),
  );
  expect(outcome).toBe("closed");
  expect(guard.violations).toHaveLength(1);
  expect(guard.violations[0].transport).toBe("websocket");
});

test("the approved project continues, a successful response is observed, and only then does assertObserved pass", async ({
  page,
}) => {
  expect(() => guard.assertObserved()).toThrow(/ZERO successful/);
  // A page route, registered after the context route, takes precedence and
  // fulfils the approved request locally: no DNS, no network.
  await page.route(`${APPROVED_ORIGIN}/**`, (route) => route.fulfill({ status: 200, body: "ok" }));
  await page.goto("about:blank");
  const outcome = await page.evaluate(async (origin) => {
    const res = await fetch(`${origin}/auth/v1/settings`);
    return res.status;
  }, APPROVED_ORIGIN);
  expect(outcome).toBe(200);
  expect(guard.violations).toHaveLength(0);
  expect(guard.observed.approvedOk).toBe(1);
  guard.assertObserved();
  guard.assertClean("selftest");
});

test("the guard is already active on a page the test opens itself", async ({ context }) => {
  const page = await context.newPage();
  await page.goto("about:blank");
  const outcome = await page.evaluate(async () => {
    try {
      await fetch("https://prodlikeref0000000000.supabase.co/rest/v1/x");
      return "sent";
    } catch {
      return "failed";
    }
  });
  expect(outcome).toBe("failed");
  expect(guard.violations).toHaveLength(1);
});

test("service workers are blocked on the guarded context", async ({ context }) => {
  expect(context.serviceWorkers()).toHaveLength(0);
});
