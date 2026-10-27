/**
 * The measurement assertions, as pure functions that throw.
 *
 * They are deliberately not Playwright matchers: a plain throw is unit-testable
 * with no browser, which is what lets negative-controls.mjs prove each one goes
 * RED when fed the thing it is supposed to catch. An assertion nobody has seen
 * fail is not an assertion, it is a comment.
 *
 * ── The rule every function here enforces ────────────────────
 *
 * A check over an empty or short collection passes. That is the whole failure
 * mode this file exists to close, and it has now appeared seven times in this
 * project. So: nothing here will compare, sum or de-duplicate anything before
 * it has first established that the collection is non-empty and the size the
 * seed wrote. Census first, content second, in that order, always.
 *
 * ── Why sets and not counts ──────────────────────────────────
 *
 * Matching row counts cannot pass a completeness test. A paged read that drops
 * one row and repeats another returns the right total and the wrong rows, and
 * the two errors cancel exactly. Every completeness check below therefore
 * compares the exact set of unique ids and reports MISSING and EXTRA
 * separately, because those two have different causes and different fixes.
 */

/**
 * The login form's fixed refusals, as KEYS, from a read of its banner.
 *
 * The copy lives in login-client.tsx (FAILURE_MESSAGES / REASON_MESSAGES).
 * The text is matched here and never returned or printed, so the transcript
 * carries a reason and not a sentence read out of a page.
 *
 * A read that found nothing is refused, not classified. The first run with a
 * classifier here reported "unrecognised" for an EMPTY string: the locator had
 * matched a role=alert node that is not the login banner at all (the Next.js
 * dev overlay keeps one, empty, in its portal, and Playwright's selectors reach
 * into shadow roots), and the classifier accepted the empty read as a category.
 * A category reported over nothing read is not a report. Text that is not one
 * of the fixed refusals is refused too, by length only: either the copy moved
 * or this was not the banner, and neither is a login outcome.
 */
export function classifyLoginRefusal(text) {
  if (typeof text !== "string") {
    throw new Error(`login banner: read was ${typeof text}, not a string. Nothing was classified.`);
  }
  const t = text.trim().toLowerCase();
  if (t.length === 0) {
    throw new Error(
      "login banner: the matched element carried NO text. A refusal was not read; the " +
        "selector matched something other than the form's banner (the dev overlay keeps an " +
        "empty role=alert in its portal). Nothing was classified.",
    );
  }
  if (t.includes("invalid email or password")) return "credentials";
  if (t.includes("too many attempts")) return "rate_limited";
  if (t.includes("company accounts only")) return "not_company";
  if (t.includes("couldn't verify") || t.includes("couldn't load")) return "unavailable";
  if (t.includes("something went wrong")) return "error";
  if (t.includes("paused") || t.includes("archived") || t.includes("isn't active")) {
    return "inactive";
  }
  throw new Error(
    `login banner: ${t.length} characters matching none of the fixed refusals in ` +
      `login-client.tsx. Either that copy changed, or this was not the banner. Not classified.`,
  );
}

/**
 * A filled field reads back as what was set, before the form is submitted.
 *
 * A fill that did not land submits an empty form, and everything after that
 * describes the empty form, not the sign-in. Names the field and the lengths
 * only; never the values, which are credentials.
 */
export function requireFilled(field, actual, expected) {
  if (typeof expected !== "string" || expected.length === 0) {
    throw new Error(`${field}: nothing to fill (the variable behind it is empty or unset)`);
  }
  if (actual !== expected) {
    throw new Error(
      `${field}: the fill did not land. The field reads back ${typeof actual === "string" ? actual.length : typeof actual} ` +
        `character(s) against ${expected.length} set. Submitting now would describe an empty form.`,
    );
  }
}

/** Fails when a locator matched nothing, before anything is read out of it. */
export function requireFound(count, what) {
  if (!Number.isInteger(count)) {
    throw new Error(`${what}: element count was ${count}, not an integer. Refusing to continue.`);
  }
  if (count === 0) {
    throw new Error(
      `${what}: matched ZERO elements. Every assertion downstream of this ` +
        `would have passed over an empty collection. This is the census guard, ` +
        `and it has fired.`,
    );
  }
}

/**
 * Fails when any element is missing the attribute the measurement reads.
 *
 * There is deliberately NO fallback to row text, row order or row count. The
 * fallback is the false green: counting rows when the id attribute is absent
 * reports a number that looks like a measurement and proves nothing about
 * which rows those were. AGENTS.md also forbids reading row text or labels off
 * a list of real people, so the fallback would be a privacy regression on top
 * of a measurement one.
 *
 * @param {(string|null)[]} values raw attribute reads, one per element
 */
export function requireAttribute(values, attr, what) {
  requireFound(values.length, `${what} (${attr})`);
  const missing = values.filter((v) => v === null || v === "").length;
  if (missing > 0) {
    throw new Error(
      `${what}: ${missing} of ${values.length} elements carry no \`${attr}\`. ` +
        `This harness reads ids and shapes only, never row text, so it cannot ` +
        `measure this surface until \`${attr}\` is present on every row. ` +
        `Add the attribute; do NOT relax this check.`,
    );
  }
  return values;
}

/**
 * The completeness comparison. The only function that may decide a verdict.
 *
 * Four separate failures, in order, each with its own message:
 *   1. the read returned nothing            — an empty set has no duplicates
 *   2. the expected set is empty            — comparing against nothing passes
 *   3. the read repeated a row              — a page boundary returned it twice
 *   4. the sets differ                      — missing and extra listed apart
 *
 * @param {string[]} actual ids collected by paging the real read
 * @param {string[]} expected ids the seed independently wrote
 */
export function assertSameIdSet(actual, expected, what) {
  requireFound(actual.length, `${what}: the read`);

  if (expected.length === 0) {
    throw new Error(
      `${what}: the EXPECTED set is empty, so this comparison would pass ` +
        `against any read at all. The manifest did not load, or it was built ` +
        `for a different company. This is the self-reference guard.`,
    );
  }

  const seen = new Set();
  const repeated = new Set();
  for (const id of actual) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  if (repeated.size > 0) {
    throw new Error(
      `${what}: the read returned ${repeated.size} id(s) MORE THAN ONCE ` +
        `(${[...repeated].slice(0, 3).map(tail).join(", ")}…). A paged read ` +
        `without a unique final sort key can return the same row on two pages.`,
    );
  }

  const want = new Set(expected);
  const missing = [...want].filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !want.has(id));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${what}: the read does not match what the seed wrote.\n` +
        `    expected ${want.size} unique ids, read ${seen.size}\n` +
        `    MISSING (${missing.length}): ${missing.slice(0, 5).map(tail).join(", ") || "none"}\n` +
        `    EXTRA   (${extra.length}): ${extra.slice(0, 5).map(tail).join(", ") || "none"}\n` +
        `    A missing id is a row the recruiter cannot see. Counts alone would ` +
        `not have caught this: ${missing.length} missing and ${extra.length} extra ` +
        `differ by ${Math.abs(missing.length - extra.length)}.`,
    );
  }
}

/**
 * Fails unless a count badge matches, having first proved the badge was read.
 *
 * `Number(null)` is 0 and `Number("")` is 0, so a missing badge compared
 * numerically against a seeded total of 0 would pass. The parse is therefore
 * checked before the comparison.
 */
export function assertCount(raw, expected, what) {
  if (raw === null || raw === undefined || raw === "") {
    throw new Error(
      `${what}: no count was read (got ${JSON.stringify(raw)}). Number("") is 0, ` +
        `so comparing this numerically could pass. Refusing to compare.`,
    );
  }
  const got = Number(raw);
  if (!Number.isFinite(got)) {
    throw new Error(`${what}: count ${JSON.stringify(raw)} is not a number.`);
  }
  if (got !== expected) {
    throw new Error(`${what}: badge reads ${got}, the seed wrote ${expected}.`);
  }
  return got;
}

/**
 * Fails unless the parts sum to the whole AND every part was actually present.
 *
 * The missing-key check is the point. On the Interviews page `cancelled` and
 * `archived` are hidden at zero (_interviews-client.tsx:130), so a seed with no
 * such rows renders two fewer chips — and a sum over "the chips that are there"
 * would reconcile perfectly against a strip that is quietly incomplete.
 *
 * @param {Record<string, unknown>} parts chip key -> raw badge value
 * @param {string[]} requiredKeys every key that must be present
 */
export function assertPartsSumToWhole(parts, requiredKeys, whole, what) {
  const absent = requiredKeys.filter((k) => !(k in parts));
  if (absent.length > 0) {
    throw new Error(
      `${what}: ${absent.length} required chip(s) were not rendered at all: ` +
        `${absent.join(", ")}. Summing only the chips that appeared would have ` +
        `reconciled against an incomplete strip. The seed writes rows for every ` +
        `one of these, so a hidden-at-zero chip means the seed or the count is wrong.`,
    );
  }
  let sum = 0;
  for (const k of requiredKeys) sum += assertCount(parts[k], Number(parts[k]), `${what} [${k}]`);
  if (sum !== whole) {
    throw new Error(
      `${what}: the ${requiredKeys.length} parts sum to ${sum}, the whole reads ${whole}. ` +
        `These are exhaustive over the live rows, so a gap means one population ` +
        `is not the population its tab renders.`,
    );
  }
  return sum;
}

/** Last six characters only. AGENTS.md: refer to an applicant by id tail, never by name. */
export function tail(id) {
  return typeof id === "string" ? id.slice(-6) : String(id);
}

/**
 * A finding that did not reproduce. NOT a pass, and it never closes a P0.
 *
 * Returns a structured record rather than printing a cheerful line, so the
 * report can keep these in their own section instead of letting them sit
 * alongside things that actually passed. The required `toClose` field is the
 * discipline: if nobody can say what evidence would settle it, it is not
 * "probably fine", it is unmeasured.
 */
export function stillAtRisk({ finding, site, observed, toClose }) {
  if (!finding || !site || !observed || !toClose) {
    throw new Error(
      "stillAtRisk needs finding, site, observed and toClose. The last one is " +
        "not optional: an unresolved finding with no stated closing evidence " +
        "becomes an unresolved finding everyone forgets.",
    );
  }
  return {
    verdict: "NOT REPRODUCED - STILL AT RISK",
    isPass: false,
    closesFinding: false,
    finding,
    site,
    observed,
    toClose,
    note:
      "This run did not exhibit the defect. The ordering it depends on is " +
      "undefined, not random, so a clean run is one sample of an undefined " +
      "order and not a guarantee. Record under UNRESOLVED, never under passed.",
  };
}
