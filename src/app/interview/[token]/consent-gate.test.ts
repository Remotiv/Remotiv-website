/**
 * The candidate page's side of async consent (_consent-gate.ts, and the
 * Consent screen in _flow.tsx rendered with react-dom/server): a failed save
 * never continues, the server asking for consent brings the screen back, and
 * a waiting answer is uploaded again once the agreement is saved.
 *
 *   node --test "src/app/interview/[token]/consent-gate.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/link": "export default function Link({ href, children, ...rest }) { return globalThis.__h('a', { href, ...rest }, children); }",
};
export async function resolve(specifier, context, next) {
  if (specifier in STUBS) return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return next(specifier, context);
}`)}`,
);

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
globalThis.__h = createElement;

const {
  saveConsent,
  isConsentRequired,
  screenAfterConsent,
  consentStep,
  CONSENT_AGAIN,
  CONSENT_SAVE_FAILED,
} = await import("./_consent-gate.ts");
const { CONSENT_REQUIRED } = await import("../../../lib/interviews/consent.ts");
const { Consent } = await import("./_flow.tsx");

const reply = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

test("saveConsent is true only when the server says the agreement is saved", async () => {
  assert.equal(await saveConsent("t", reply(200, { ok: true })), true);
  for (const [label, fetchImpl] of [
    ["a 500", reply(500, { code: "consent_not_saved" })],
    ["a 409", reply(409, { error: "closed" })],
    ["ok without ok:true", reply(200, { ok: false })],
    ["an unreadable reply", reply(200, new Error("not json"))],
    [
      "a dropped connection",
      async () => {
        throw new TypeError("network");
      },
    ],
  ]) {
    assert.equal(await saveConsent("t", fetchImpl), false, label);
  }
});

test("only a 403 with consent_required is the server asking for consent again", () => {
  assert.equal(isConsentRequired(403, { code: CONSENT_REQUIRED, error: "x" }), true);
  assert.equal(isConsentRequired(403, { error: "forbidden" }), false);
  assert.equal(isConsentRequired(409, { code: CONSENT_REQUIRED }), false);
  assert.equal(isConsentRequired(403, null), false);
});

test("a failed save does not continue; a saved one goes back to what was interrupted", async () => {
  const saves = [];
  const save = (ok) => async () => {
    saves.push(ok);
    return ok;
  };
  assert.deepEqual(
    await consentStep({ agreed: false, saving: false, resume: null, save: save(true) }),
    {
      kind: "not_agreed",
    },
  );
  assert.deepEqual(saves, [], "nothing saved until the box is ticked");
  assert.deepEqual(
    await consentStep({ agreed: true, saving: true, resume: null, save: save(true) }),
    {
      kind: "busy",
    },
  );
  for (const resume of [null, "upload", "submit"]) {
    assert.deepEqual(
      await consentStep({ agreed: true, saving: false, resume, save: save(false) }),
      {
        kind: "save_failed",
      },
    );
  }
  assert.deepEqual(
    await consentStep({ agreed: true, saving: false, resume: null, save: save(true) }),
    {
      kind: "continue",
      screen: "tech",
      retryUpload: false,
    },
  );
  // Brought back mid-answer: back to the recorder, and the waiting answer uploads again.
  assert.deepEqual(
    await consentStep({ agreed: true, saving: false, resume: "upload", save: save(true) }),
    {
      kind: "continue",
      screen: "record",
      retryUpload: true,
    },
  );
  // Brought back at submit: back to the review, nothing re-uploaded.
  assert.deepEqual(
    await consentStep({ agreed: true, saving: false, resume: "submit", save: save(true) }),
    {
      kind: "continue",
      screen: "review",
      retryUpload: false,
    },
  );
  assert.deepEqual(
    [screenAfterConsent("upload"), screenAfterConsent("submit"), screenAfterConsent(null)],
    ["record", "review", "tech"],
  );
});

const screen = (props) =>
  renderToStaticMarkup(
    createElement(Consent, {
      companyName: "Northwind",
      agreed: true,
      error: false,
      saving: false,
      saveError: false,
      again: null,
      onToggle: () => {},
      onContinue: () => {},
      ...props,
    }),
  );

test("the consent screen: the save error with Try again, and why it came back", () => {
  const first = screen();
  assert.doesNotMatch(first, /data-consent-save-error|data-consent-again/);
  assert.match(first, />Continue</);

  const failed = screen({ saveError: true });
  assert.match(failed, /data-consent-save-error/);
  assert.ok(failed.includes(CONSENT_SAVE_FAILED.replaceAll("'", "&#x27;")));
  assert.equal(CONSENT_SAVE_FAILED, "We couldn't save your agreement. Please try again.");
  assert.match(failed, />Try again</);

  const busy = screen({ saving: true });
  assert.match(busy, /<button[^>]*disabled=""[^>]*class="iv-btn iv-purple"/);

  for (const why of ["upload", "submit"]) {
    const html = screen({ again: CONSENT_AGAIN[why] });
    assert.match(html, /data-consent-again/);
    assert.ok(html.includes(CONSENT_AGAIN[why].replaceAll("'", "&#x27;")), why);
  }
  assert.match(
    CONSENT_AGAIN.upload,
    /Your answer is still on this device and will upload as soon as you continue\./,
  );
});

test("the flow is wired to the gate: consent_required is not an ordinary upload failure", () => {
  const flow = readFileSync(new URL("./_flow.tsx", import.meta.url), "utf8");
  // The consent route's reply decides, not a fire-and-forget fetch.
  assert.match(flow, /await consentStep\(/);
  assert.doesNotMatch(flow, /a failed stamp must\s+not block/);
  // Both upload steps read the code, and a consent refusal stops the automatic retries.
  assert.equal((flow.match(/consentRequired: isConsentRequired\(/g) ?? []).length, 2);
  assert.match(flow, /if \(result\.consentRequired\) return "consent";/);
  // The first attempt and the manual retry both bring the consent screen back, keeping the answer.
  assert.equal(
    (flow.match(/if \(outcome === "consent"\) askConsentAgain\("upload"\);/g) ?? []).length,
    2,
  );
  assert.match(
    flow,
    /isConsentRequired\(res\.status, body\)[\s\S]{0,200}askConsentAgain\("submit"\)/,
  );
});

test("hyphens only in the new copy", () => {
  for (const text of [CONSENT_SAVE_FAILED, ...Object.values(CONSENT_AGAIN)]) {
    assert.doesNotMatch(text, /[–—]/);
  }
  assert.doesNotMatch(readFileSync(new URL("./_consent-gate.ts", import.meta.url), "utf8"), /[–—]/);
});
