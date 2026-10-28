/**
 * Is the app-identity proof WIRED IN before any browser exists?
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * app-identity.test.mjs proves proveAppIdentity refuses a 404. That is not
 * the same as the harness calling it before a page opens: a function that is
 * correct and not called protects nothing. Playwright cannot be run offline
 * here, so this reads harness.spec.mjs and pins the ORDER in its text:
 *
 *   - the beforeAll hook takes NO fixture, so no browser, context or page
 *     exists when it runs;
 *   - inside it, openStaging runs, then proveAppIdentity, and nothing in it
 *     touches a page;
 *   - the hook comes before the first test in the file.
 *
 * negative-controls.mjs deletes the proveAppIdentity call and requires this
 * to go red.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./harness.spec.mjs", import.meta.url)), "utf8");

function hookBody() {
  const m = src.match(/\ntest\.beforeAll\(async \(\) => \{\n([\s\S]*?)\n\}\);\n/);
  assert.ok(m, "test.beforeAll(async () => { ... }) with NO fixture argument was not found");
  return m[1];
}

test("beforeAll takes no fixture, so no browser exists when it runs", () => {
  hookBody();
  assert.doesNotMatch(src, /test\.beforeAll\(async \(\{/, "beforeAll must not request a fixture");
});

test("beforeAll runs the guard, then proves the app's identity, before any test", () => {
  const body = hookBody();
  const guard = body.indexOf('openStaging({ intent: "harness" })');
  const identity = body.indexOf("proveAppIdentity(");
  assert.ok(guard >= 0, "openStaging is not called in beforeAll");
  assert.ok(
    identity >= 0,
    "proveAppIdentity is not called in beforeAll: the app's identity is unproven before the browser opens",
  );
  assert.ok(guard < identity, "the guard must run before the app is asked anything");
  assert.match(body, /await proveAppIdentity\(/, "the proof must be awaited");
  const hookAt = src.indexOf("\ntest.beforeAll(");
  const firstTest = src.indexOf("\ntest(");
  assert.ok(hookAt < firstTest, "beforeAll must come before the first test");
});

test("nothing in beforeAll touches a page, context or browser", () => {
  // Code only: comment lines are dropped, and the patterns are member accesses
  // and calls, so a comment or a log line SAYING "no browser" does not match.
  const code = hookBody()
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /\bpage\.|\bcontext\.|\bbrowser\.|newPage\(|chromium|\.goto\(/);
});

test("the identity proof is the SDK sign-in, not the login form", () => {
  const body = hookBody();
  assert.match(body, /signInStagingAccount\(/, "the hook must sign in through the SDK");
  assert.doesNotMatch(body, /#co-email|#co-password/, "the form sign-in needs a page; not here");
});

/* ───────────────────── the browser network guard ───────────────────── */

const guarded = readFileSync(fileURLToPath(new URL("./guarded-test.mjs", import.meta.url)), "utf8");

test("the harness uses the guarded test, never Playwright's bare test", () => {
  assert.doesNotMatch(
    src,
    /import \{[^}]*\btest\b[^}]*\} from "@playwright\/test"/,
    "bare test imported",
  );
  assert.match(src, /const test = guardedTest\(guard\);/, "test must be the guarded one");
  assert.match(
    src,
    /const guard = createGuard\(\s*policyFrom\(/,
    "the guard is built from the pin's policy",
  );
  assert.match(src, /parseCustomDomains\(process\.env\.STAGING_SUPABASE_CUSTOM_DOMAINS\)/);
});

test("guarded-test registers interception on the context BEFORE handing it to any page", () => {
  const fixture = guarded.match(/context: async \(\{ context \}, use\) => \{([\s\S]*?)\n {4}\},/);
  assert.ok(fixture, "the context fixture override was not found");
  const body = fixture[1];
  const route = body.indexOf('context.route("**/*", guard.handleRoute)');
  const ws = body.indexOf("context.routeWebSocket(() => true, guard.handleWebSocket)");
  const resp = body.indexOf('context.on("response", guard.onResponse)');
  const used = body.indexOf("await use(context)");
  for (const [name, at] of [
    ["route", route],
    ["routeWebSocket", ws],
    ["response", resp],
  ]) {
    assert.ok(at >= 0, `${name} is not registered`);
    assert.ok(
      at < used,
      `${name} must be registered before use(context), which is before any page`,
    );
  }
  // The CODE, not the docblock, which describes the option in the same words.
  assert.match(
    guarded,
    /await use\(\{ \.\.\.contextOptions, serviceWorkers: "block" \}\);/,
    "service workers must be blocked on the context",
  );
  assert.doesNotMatch(guarded, /bypassCSP/, "the harness must see the CSP a real browser sees");
});

test("every test is checked for forbidden destinations, and the run requires observed traffic", () => {
  const afterEach = src.match(/\ntest\.afterEach\(async \(\{\}, testInfo\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(afterEach, "test.afterEach not found");
  assert.match(afterEach[1], /guard\.assertClean\(testInfo\.title\)/);
  const afterAll = src.match(/\ntest\.afterAll\(\(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(afterAll, "test.afterAll not found");
  assert.match(afterAll[1], /guard\.assertObserved\(\)/, "zero observed must fail the run");
  const first = src.indexOf("\ntest(");
  const probe = src.indexOf("the app's OWN browser client reaches the approved staging project");
  assert.ok(probe >= 0 && probe - first < 1500, "the browser probe must be the first browser test");
});

test("the browser probe is driven by the APP, not by a test-supplied request", () => {
  const body = src.match(
    /test\("the app's OWN browser client reaches the approved staging project"[\s\S]*?\n\}\);/,
  );
  assert.ok(body, "the app-driven probe was not found");
  // The proof must come from the app's own traffic: no fetch/evaluate the test
  // constructs, only a navigation and a read of the guard's observed count.
  assert.doesNotMatch(
    body[0],
    /page\.evaluate\(|\bfetch\(|page\.request\./,
    "the test must issue no request of its own",
  );
  assert.match(body[0], /await page\.goto\(`\$\{BASE\}\/`/, "it must navigate to a real app page");
  assert.match(
    body[0],
    /guard\.observed\.approvedOk/,
    "it must read the guard's observed count, not a URL it supplied",
  );
});

test("beforeAll proves both accounts USABLE the dashboard's way, before any page", () => {
  const body = hookBody();
  assert.match(
    body,
    /await assertAccountUsable\(service, \{/,
    "assertAccountUsable is not called in beforeAll",
  );
  assert.match(
    body,
    /for \(const a of STAGING_ACCOUNTS\)/,
    "both accounts, from accounts.mjs, not one",
  );
});

/**
 * The login form the browser drives is the COMPANY one. /login is the admin
 * form (#al-*) and pushes to /admin; a harness driving it would fail deep in
 * the login flow with a timeout on the dashboard URL. Both ids are pinned to
 * the shipped client component, so a renamed input goes red here first.
 */
test("pin: signIn drives /ai-dashboard/login and the ids the company form actually renders", () => {
  const root = new URL("../../", import.meta.url);
  const client = readFileSync(
    fileURLToPath(new URL("src/app/ai-dashboard/login/login-client.tsx", root)),
    "utf8",
  );
  const admin = readFileSync(
    fileURLToPath(new URL("src/app/login/login-client.tsx", root)),
    "utf8",
  );
  assert.match(client, /id="co-email"/, "the company form no longer renders #co-email");
  assert.match(client, /id="co-password"/, "the company form no longer renders #co-password");
  assert.match(
    client,
    /window\.location\.assign\("\/ai-dashboard"\)/,
    "success no longer lands on /ai-dashboard",
  );
  assert.match(
    admin,
    /id="al-email"/,
    "the admin form is the one with #al-*; if that changed, re-check this pin",
  );
  const fn = src.match(/async function signInOnce\(page[\s\S]*?\n\}/);
  assert.ok(fn, "signInOnce not found");
  assert.match(src, /const LOGIN_PATH = "\/ai-dashboard\/login";/);
  assert.match(fn[0], /LOGIN_PATH/, "signIn must use the company login path");
  assert.match(fn[0], /#co-email/);
  assert.match(fn[0], /#co-password/);
  assert.doesNotMatch(fn[0], /#al-email|`\$\{BASE\}\/login`/, "signIn drives the ADMIN form");
  assert.match(
    fn[0],
    /pathname === "\/ai-dashboard"/,
    "must wait for the dashboard itself, not its login page",
  );
});

/**
 * #23 and #25 are ESTABLISHED from two halves, and the order half is read
 * from the shipped query at run time, not assumed. A test that pushed an
 * established verdict without provenTotalOrder would be the vacuous kind.
 */
test("#23 and #25 report ESTABLISHED from the sweep plus a run-time total-order read", () => {
  const m23 = src.match(/test\("#23: Messages pagination[\s\S]*?\n\}\);/);
  const m25 = src.match(/test\("#25: the real scoped allow-list[\s\S]*?\n\}\);/);
  assert.ok(m23 && m25, "the #23 and #25 tests were not found");
  assert.match(
    m23[0],
    /order: provenTotalOrder\("messages"\),/,
    "#23's order half must be read at run time",
  );
  assert.match(
    m25[0],
    /order: provenTotalOrder\("scoped"\),/,
    "#25's order half must be read at run time",
  );
  assert.match(
    m23[0],
    /established\.push\(\s*establishedBy\(/,
    "#23 must push an established verdict",
  );
  assert.match(
    m25[0],
    /established\.push\(\s*establishedBy\(/,
    "#25 must push an established verdict",
  );
  assert.doesNotMatch(m23[0] + m25[0], /stillAtRisk\(/, "neither may still be filed as unresolved");
  assert.match(
    src,
    /return assertTotalOrder\(readFileSync\(`\$\{SRC\}\$\{site\.file\}`, "utf8"\), site\);/,
  );
  const afterAll = src.match(/\ntest\.afterAll\(\(\) => \{([\s\S]*?)\n\}\);/);
  assert.match(
    afterAll[1],
    /ESTABLISHED, in two halves/,
    "the verdicts must be printed with both halves",
  );
});

/**
 * One counted login retry, in the open. The wrapper calls the one-shot,
 * retries ONCE for a retryable key, records it under FLAKES OBSERVED, and
 * never retries the forced-password redirect.
 */
test("signIn retries a retryable refusal exactly once, counted and printed", () => {
  assert.match(src, /const MAX_LOGIN_ATTEMPTS = 2;/, "exactly one retry");
  const fn = src.match(/async function signIn\(page, account = ACCOUNTS\.owner\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "the signIn wrapper not found");
  assert.match(fn[0], /await signInOnce\(page, account\)/, "the wrapper must drive the one-shot");
  assert.match(fn[0], /attempt < MAX_LOGIN_ATTEMPTS && retryable/, "the retry is bounded");
  assert.match(fn[0], /flakes\.push\(note\)/, "a retry must be recorded, not absorbed");
  const once = src.match(/async function signInOnce\(page[\s\S]*?\n\}/);
  assert.match(
    once[0],
    /outcome === "forced"[\s\S]*?throw new Error/,
    "forced is thrown, never retried",
  );
  const afterAll = src.match(/\ntest\.afterAll\(\(\) => \{([\s\S]*?)\n\}\);/);
  assert.match(afterAll[1], /FLAKES OBSERVED/, "absorbed flakes must be printed at the end");
});

/**
 * A sweep that stops says where. The context names the page reached and the
 * ids collected, and says a stop is not a gap. Resume is by URL, capped,
 * counted, and only where the list carries its page in the URL.
 */
test("a stopped sweep reports the page reached; resume is capped, counted and URL-only", () => {
  const loop = src.match(/async function collectIdsAcrossPages\([\s\S]*?\n\}/);
  assert.ok(loop, "collectIdsAcrossPages not found");
  assert.match(loop[0], /FAILED AT PAGE \$\{pageNo\} with \$\{seen\.length\} id\(s\) collected/);
  assert.match(loop[0], /not a gap/, "a stop must be told apart from a gap");
  assert.match(src, /const MAX_RESUMES = 3;/, "resume is capped");
  assert.match(loop[0], /if \(!pageUrl \|\| resumes >= MAX_RESUMES\) throw e;/);
  assert.match(
    loop[0],
    /returned the rows of page \$\{pageNo\} again; not resumable/,
    "a resume is checked",
  );
  const newest = src.match(/label: "applicants\/newest",[\s\S]*?\}\);/);
  const best = src.match(/label: "applicants\/best-match",[\s\S]*?\}\);/);
  const job = src.match(/label: "applicants\/one-job",[\s\S]*?\}\);/);
  for (const [name, m] of [
    ["newest", newest],
    ["best-match", best],
    ["one-job", job],
  ]) {
    assert.ok(m, `${name} call site not found`);
    assert.match(m[0], /pageUrl: \(n\) =>/, `${name} must carry a resume URL`);
  }
  const messages = src.match(/attr: "data-message-id",[\s\S]*?\}\);/);
  assert.ok(messages, "messages call site not found");
  assert.doesNotMatch(
    messages[0],
    /pageUrl/,
    "Messages pages in client state and cannot resume by URL",
  );
});

/**
 * The two 500-page sweeps have two hours; the polls that pace every page tick
 * every 100 ms rather than backing off to a second.
 */
test("the 500-page sweeps have a 120-minute budget and 100 ms polls", () => {
  for (const title of [
    "REGRESSION: Applicants/newest shows exactly the seeded id set",
    "REGRESSION: Best Match returns the same set through its ties",
  ]) {
    const body = src.match(
      new RegExp(`test\\("${title.replace(/[/]/g, "\\/")}"[\\s\\S]*?\\n\\}\\);`),
    );
    assert.ok(body, `${title} not found`);
    assert.match(body[0], /test\.setTimeout\(120 \* 60_000\);/, `${title}: 120 minutes`);
  }
  const wait = src.match(/async function waitForRowsToMove\([\s\S]*?\n\}/);
  assert.match(wait[0], /intervals: \[100\]/, "the rows-moved poll must tick every 100 ms");
});

/**
 * After Next, the loop waits for the ROWS to move, not for the network to go
 * quiet: Messages pages with no request, and Applicants commits a second or
 * two after its response. Reading in that window re-reads the previous page
 * and reports it as a duplicate, which the first 50-row run did four times.
 */
test("the paging loop waits for the rows to change after Next, never for networkidle", () => {
  const loop = src.match(/async function collectIdsAcrossPages\([\s\S]*?\n\}/);
  assert.ok(loop, "collectIdsAcrossPages not found");
  assert.match(
    loop[0],
    /await next\.click\(\);\n\s+try \{\n\s+await waitForRowsToMove\(page, \{ scope, attr, before: raw, label \}\);/,
  );
  assert.doesNotMatch(loop[0], /networkidle/, "networkidle resolves before the next page renders");
  // And the click is held until the button is hydrated: a click on the
  // server-rendered button reaches no handler, and the rows never move.
  const hydrate = loop[0].indexOf("next.evaluate(isHydrated)");
  const click = loop[0].indexOf("await next.click();");
  assert.ok(hydrate > 0, "the loop must poll next.evaluate(isHydrated) before clicking");
  assert.ok(click > hydrate, "the hydration poll must precede the click");
  const wait = src.match(/async function waitForRowsToMove\([\s\S]*?\n\}/);
  assert.ok(wait, "waitForRowsToMove not found");
  assert.match(
    wait[0],
    /now\.length !== before\.length \|\| now\.some\(\(id, i\) => id !== before\[i\]\)/,
  );
  assert.match(
    wait[0],
    /NOT a duplicate-row finding/,
    "an unmoved list must be named, not reported as #23",
  );
});

/**
 * The network proof is asserted in the worker that took it. Playwright
 * restarts the worker after a failure, and afterAll runs again there with an
 * empty count; the first 50-row run failed a passing test that way.
 */
test("afterAll asserts the network proof only in the worker that ran the probe", () => {
  const afterAll = src.match(/\ntest\.afterAll\(\(\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(afterAll, "afterAll not found");
  assert.match(afterAll[1], /if \(probeRanInThisWorker\) guard\.assertObserved\(\);/);
  const probe = src.match(
    /test\("the app's OWN browser client reaches the approved staging project"[\s\S]*?\n\}\);/,
  );
  assert.match(probe[0], /probeRanInThisWorker = true;/, "the probe test must mark its worker");
});

/**
 * The job test opens the page WITH ?job= and reads the select back. Driving
 * the select left it on "all" in every probe; the URL is the read path.
 */
test("the job test filters through the URL and reads the select back", () => {
  const body = src.match(
    /test\("REGRESSION: the largest job's applicants all appear[\s\S]*?\n\}\);/,
  );
  assert.ok(body, "the job test was not found");
  assert.match(
    body[0],
    /applicants\?sort=newest&job=\$\{bigJobId\}/,
    "the filter must travel in the URL",
  );
  assert.doesNotMatch(body[0], /selectOption\(/, "the select is read back, not driven");
  assert.match(body[0], /getByLabel\("Filter by job"\)\.evaluate\(\(s\) => s\.value\)/);
  assert.match(
    body[0],
    /\.toBe\(bigJobId\)/,
    "the select must show the job the page was opened with",
  );
});

/**
 * The refusal banner signIn reads is the login form's OWN, and the fill is
 * read back before the click. A bare [role=alert] matched the Next.js dev
 * overlay's empty alert node (Playwright pierces shadow roots), "refused" won
 * the race at once, and the classifier was handed an empty string.
 */
test("signIn reads the login form's OWN banner, scoped, and reads the fill back", () => {
  const root = new URL("../../", import.meta.url);
  const client = readFileSync(
    fileURLToPath(new URL("src/app/ai-dashboard/login/login-client.tsx", root)),
    "utf8",
  );
  assert.match(
    src,
    /const LOGIN_BANNER = "main p\[role=alert\]";/,
    "LOGIN_BANNER is the scoped selector",
  );
  // The component really renders that shape: a <p role="alert"> under <main>.
  assert.match(client, /<main[\s>]/, "the company login no longer has a <main>");
  assert.match(client, /<p\n\s+role="alert"/, 'the refusal banner is no longer a <p role="alert">');
  const fn = src.match(/async function signInOnce\(page[\s\S]*?\n\}/);
  assert.ok(fn, "signInOnce not found");
  assert.match(
    fn[0],
    /page\.locator\(LOGIN_BANNER\)\.waitFor\(/,
    "the race must arm the scoped banner",
  );
  assert.match(fn[0], /classifyLoginRefusal\(await page\.locator\(LOGIN_BANNER\)\.innerText\(\)\)/);
  assert.doesNotMatch(
    fn[0],
    /"\[role=alert\]"/,
    "a bare [role=alert] reaches the dev overlay's node",
  );
  assert.doesNotMatch(
    src,
    /function classifyLoginRefusal/,
    "the classifier lives in assertions.mjs, tested offline",
  );
  assert.match(
    fn[0],
    /requireFilled\("#co-email", await page\.locator\("#co-email"\)\.inputValue\(\), account\.email\)/,
  );
  assert.match(
    fn[0],
    /requireFilled\("#co-password", await page\.locator\("#co-password"\)\.inputValue\(\), account\.password\)/,
  );
  const fills = fn[0].indexOf("requireFilled(");
  const click = fn[0].indexOf('getByRole("button", { name: "Sign In" }).click()');
  assert.ok(fills > 0 && click > fills, "the readback must precede the click");
});
