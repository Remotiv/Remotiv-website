/**
 * #67 part 3: every public or candidate-facing form that collects personal
 * data links to /privacy near its submit button.
 *
 *   node --test src/app/privacy-link.test.ts
 *
 * Source scan, comments stripped so a mention in a comment proves nothing.
 * The census at the bottom fails when a new form with an email or phone field
 * appears without being listed here, either as a form or as an exemption.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const SRC = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, SRC), "utf8");
/** Source without comments, block or line (but not the `//` inside a URL). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Each form, and the label on its submit button. */
const FORMS = [
  ["app/jobs/_apply-modal.tsx", "Submit application"], // also every white-label careers role
  ["app/join-as-talent/page.tsx", "Submit Profile"], // audit 23 Nov: no link
  ["app/join-as-freelancer/page.tsx", "Submit Profile"], // audit 23 Nov: no link
  ["app/talent/login/login-client.tsx", "Send me a 6-digit code"], // talent login and claim
  ["app/signup/signup-client.tsx", "Create account →"],
  ["app/contact/page.tsx", "Send Inquiry →"],
  ["components/home/cta-inquiry.tsx", "Send Inquiry →"],
  ["app/book-a-meeting/_booking-form.tsx", "Book My Call →"],
  ["app/find-freelancers/_hire-request-wizard.tsx", "Send request →"],
  ["app/services/dedicated-team/page.tsx", "Send Inquiry →"],
  ["app/services/recruitment/page.tsx", "Send Inquiry →"],
  ["app/services/staff-augmentation/page.tsx", "Send Inquiry →"],
  ["app/ai-video-interviews/page.tsx", "Send Inquiry →"],
];

/** Email or phone fields that are not a collection point, and why. */
const EXEMPT = {
  "app/login/login-client.tsx": "admin sign-in, existing staff account",
  "app/signin/signin-client.tsx": "employer sign-in, agreed at signup",
  "app/client/login/login-client.tsx": "client portal sign-in, existing account",
  "app/forgot-password/forgot-password-client.tsx": "reset for an existing account",
  "app/talent/(authed)/dashboard/edit/_edit-client.tsx":
    "signed-in talent editing their own profile",
};

const AGREEMENT = /<PrivacyAgreement\b|href="\/privacy"/;
const NEAR = 1500;

test("every listed form links to /privacy, right after its submit button", () => {
  for (const [file, submit] of FORMS) {
    const src = code(read(file));
    let at = src.indexOf(submit);
    assert.ok(at >= 0, `${file}: submit label "${submit}" not found`);
    let near = false;
    while (at >= 0 && !near) {
      near = AGREEMENT.test(src.slice(at, at + NEAR));
      at = src.indexOf(submit, at + 1);
    }
    assert.ok(near, `${file}: no privacy link within ${NEAR} chars after "${submit}"`);
    if (/<PrivacyAgreement\b/.test(src)) {
      assert.match(
        src,
        /import \{ PrivacyAgreement \} from "@\/components\/privacy-agreement";/,
        `${file}: the shared line, not a look-alike`,
      );
    }
  }
});

test("the line: the decided words, /privacy in a new tab, no dash", () => {
  const src = code(read("components/privacy-agreement.tsx"));
  assert.match(
    src,
    /By submitting, you agree to our\{" "\}\s*<Link href="\/privacy" target="_blank" rel="noopener noreferrer"[^>]*>\s*Privacy Policy\s*<\/Link>\s*\.\s*<\/p>/,
  );
  assert.doesNotMatch(src, /[‒-―]/);
});

test("white-label careers apply through the same modal, whose link opens /privacy in a new tab", () => {
  assert.match(code(read("app/careers/[slug]/_data.ts")), /href: `\/jobs\/\$\{j\.slug\}`/);
  assert.match(
    code(read("app/jobs/_apply-modal.tsx")),
    /<Link\s+href="\/privacy"\s+target="_blank"\s+rel="noopener noreferrer"/,
  );
});

test("the hire wizard shows the line on its submit step only", () => {
  assert.match(
    code(read("app/find-freelancers/_hire-request-wizard.tsx")),
    /\{step === 3 && \(\s*<PrivacyAgreement\b/,
  );
});

// ── Census ──────────────────────────────────────────────────

const OUT_OF_SCOPE = /^(app\/(admin|ai-dashboard|interview|api)\/|test-support\/)/;
const FIELD = /type="(email|tel)"|name="(email|phone)"/;

function* tsx(dir, rel = "") {
  for (const name of readdirSync(new URL(dir, SRC))) {
    const path = `${rel}${name}`;
    if (statSync(new URL(`${dir}${name}`, SRC)).isDirectory())
      yield* tsx(`${dir}${name}/`, `${path}/`);
    else if (name.endsWith(".tsx")) yield path;
  }
}

test("census: every public form with an email or phone field is listed or exempt", () => {
  const listed = new Set(FORMS.map(([f]) => f));
  const found = [
    ...[...tsx("app/", "")].map((f) => `app/${f}`),
    ...[...tsx("components/", "")].map((f) => `components/${f}`),
  ].filter((f) => !OUT_OF_SCOPE.test(f) && FIELD.test(code(read(f))));
  const unlisted = found.filter((f) => !listed.has(f) && !(f in EXEMPT));
  assert.deepEqual(
    unlisted,
    [],
    "a new form: add it to FORMS (with the line) or to EXEMPT (with a reason)",
  );
  for (const f of Object.keys(EXEMPT)) assert.ok(found.includes(f), `${f}: stale exemption`);
  assert.ok(found.length >= 15, `census found ${found.length} files`);
});
