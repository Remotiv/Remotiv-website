/**
 * plainDashes: hyphens for AI prose on screen (commit D2).
 *
 *   node --test src/app/ai-dashboard/lib/plain-dashes.test.ts
 *
 * Dash characters are built from code points so this file holds no glyph and
 * no \u escape for a formatter to rewrite.
 */
// @ts-nocheck - same reason as stage-tabs.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { plainDashes, plainDashesOrNull } = await import("./plain-dashes.ts");

const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const NO_DASH = new RegExp(`[${EN}${EM}]`);

test("spaced em dash becomes a spaced hyphen", () => {
  assert.equal(
    plainDashes(`Partial fit ${EM} broad sales experience`),
    "Partial fit - broad sales experience",
  );
});

test("unspaced em dash becomes a spaced hyphen too", () => {
  assert.equal(plainDashes(`Weak fit${EM}CV shows little`), "Weak fit - CV shows little");
  assert.equal(plainDashes(`Weak fit ${EM}CV shows`), "Weak fit - CV shows");
});

test("spaced en dash, used as a pause, becomes a spaced hyphen", () => {
  assert.equal(plainDashes(`Strong ${EN} but junior`), "Strong - but junior");
});

test("joined en dash, a range, becomes a plain hyphen", () => {
  assert.equal(plainDashes(`Led sales 2019${EN}2021`), "Led sales 2019-2021");
  assert.equal(plainDashes(`3${EN}5 years in B2B`), "3-5 years in B2B");
});

test("several dashes in one text, and nothing else changes", () => {
  const out = plainDashes(`Fit ${EM} good; 2019${EN}2021 ${EN} gap ${EM} ask`);
  assert.equal(out, "Fit - good; 2019-2021 - gap - ask");
  assert.doesNotMatch(out, NO_DASH);
});

test("text with no dash is returned as the very same string", () => {
  const s = "Strong React lead; notice is the only gap - already hyphenated";
  assert.equal(plainDashes(s), s);
  const padded = "  keeps its own spacing  ";
  assert.equal(plainDashes(padded), padded);
  assert.equal(plainDashes(""), "");
});

test("a dash at the start or end leaves no stray space", () => {
  assert.equal(plainDashes(`${EM} leading`), "- leading");
  assert.equal(plainDashes(`trailing ${EM}`), "trailing -");
});

test("other dash-like characters are left alone: hyphen, minus, figure dash", () => {
  const s = `a-b ${String.fromCharCode(0x2212)}3 ${String.fromCharCode(0x2012)}`;
  assert.equal(plainDashes(s), s);
});

test("plainDashesOrNull keeps null as null", () => {
  assert.equal(plainDashesOrNull(null), null);
  assert.equal(plainDashesOrNull(`a ${EM} b`), "a - b");
});

// Field-by-field behaviour (prose hyphenated, quotes and the rest verbatim) is
// proven against the real read in applicants/prose-dashes.test.ts. This only
// guards that no call site passes a field that must stay verbatim.
test("no call site in actions.ts passes a quote, must-have item, feedback, screening or name", () => {
  const src = readFileSync(new URL("../(gated)/applicants/actions.ts", import.meta.url), "utf8");
  const calls = [...src.matchAll(/plainDashes(?:OrNull)?\(([^)]*)\)/g)].map((m) => m[1]);
  // Six call sites cover the seven fields: missing_requirements and concerns share proseList.
  assert.equal(calls.length, 6, `call sites: ${calls.join(" | ")}`);
  for (const arg of calls) {
    assert.doesNotMatch(
      arg,
      /quote|\bitem\b|human_feedback|screening|first_name|last_name|email/,
      arg,
    );
  }
});

test("the helper file itself holds no dash glyph", () => {
  const src = readFileSync(new URL("./plain-dashes.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, NO_DASH);
});
