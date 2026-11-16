/**
 * The drawer on a card whose CV has passed its retention date (#91 item D).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/cv-retention-note.test.ts"
 *
 * From that date, the daily retention cleanup empties every list on the
 * scorecard and keeps the score. The evidence boxes' "the model found none" lines would then state
 * findings nobody made ("Every requirement the job states was evidenced"), so
 * on such a card they are not rendered and one line says what happens. The
 * two pieces are rendered for real; how the drawer wires them is pinned on its
 * source, because the drawer itself is too large to mount here.
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/tsx-load.mjs", import.meta.url));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { CvRetentionNote, EVIDENCE_NONE_FOUND, EvidenceNoneFound } = await import(
  "./_drawer-parts.tsx"
);

const client = readFileSync(new URL("./_applicants-client.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
const render = (el) => text(renderToStaticMarkup(el));

/** The drawer's AI section, from the scored gate to the end of the evidence grid. */
function scoredSection(): string {
  const at = client.indexOf('{scoreDetail?.ai_status === "scored" && (');
  const end = client.indexOf("<MustHavesBox", at);
  const tail = client.indexOf("</EvidenceList>", client.lastIndexOf('label="Risks to verify"'));
  assert.ok(at > 0 && end > at && tail > end, "the scored section is where it was");
  return client.slice(at, tail);
}

test("#91 D: a live CV's empty boxes say exactly what they said before", () => {
  // The words, pinned: a live card must render unchanged.
  assert.deepEqual(EVIDENCE_NONE_FOUND, {
    strengths: "Nothing in the CV was evidenced strongly enough to quote.",
    missing: "Every requirement the job states was evidenced somewhere in the CV.",
    concerns: "No contradictions or gaps were raised against the CV.",
  });
  for (const kind of ["strengths", "missing", "concerns"]) {
    assert.equal(
      render(createElement(EvidenceNoneFound, { kind, retentionPassed: false })),
      EVIDENCE_NONE_FOUND[kind],
    );
  }
});

test("#91 D: once the retention date has passed, none of the three findings is rendered", () => {
  for (const kind of ["strengths", "missing", "concerns"]) {
    assert.equal(
      renderToStaticMarkup(createElement(EvidenceNoneFound, { kind, retentionPassed: true })),
      "",
    );
  }
});

test("#91 D: the line names the retention date and keeps the score, and claims no deletion", () => {
  const line = render(createElement(CvRetentionNote, { day: "05 Jan 2028" }));
  assert.equal(
    line,
    "This CV passed its retention date on 05 Jan 2028. The AI's notes on it are cleared during retention cleanup; the score is kept.",
  );
  assert.doesNotMatch(line, /delete/i, "never claims the file, or anything, was deleted");
  assert.doesNotMatch(line, /—/, "no em dash");
});

test("pin: the drawer renders the line once, in the AI section, only when the date has passed", () => {
  const section = scoredSection();
  assert.equal(
    (section.match(/<CvRetentionNote /g) ?? []).length,
    1,
    "exactly one CvRetentionNote, inside the scored section",
  );
  assert.equal((client.match(/<CvRetentionNote /g) ?? []).length, 1, "and nowhere else");
  assert.match(
    section,
    /\{retentionPassedDay && <CvRetentionNote day=\{retentionPassedDay\} \/>\}/,
  );
  assert.ok(
    section.indexOf("<CvRetentionNote") < section.indexOf('<ReviewSubhead title="Evidence"'),
    "above the evidence boxes",
  );
  assert.match(
    client,
    /const retentionPassedDay = fmtDay\(row\.cv_retention_passed_on, clock\.local\);/,
    "the date comes from the row and is formatted like every other drawer date",
  );
});

test("pin: all three empty states go through the guard, and no bare one is left", () => {
  const section = scoredSection();
  for (const kind of ["strengths", "missing", "concerns"]) {
    assert.match(
      section,
      new RegExp(
        `<EvidenceNoneFound\\s+kind="${kind}"\\s+retentionPassed=\\{retentionPassedDay !== null\\}\\s*/>`,
      ),
    );
  }
  assert.doesNotMatch(client, /<EvidenceEmpty>/, "no unguarded empty state in the drawer");
  for (const words of Object.values(EVIDENCE_NONE_FOUND)) {
    assert.ok(!client.includes(words), `"${words}" lives only in _drawer-parts.tsx`);
  }
});

test("pin: cv_retention_passed_on is the date once passed, by the same rule as the re-score guard", () => {
  assert.match(
    actions,
    /cv_retention_passed_on:\s*r\.cv_delete_after && cvExpired\(\{ cv_delete_after: r\.cv_delete_after as string \}, Date\.now\(\)\)\s*\?\s*\(r\.cv_delete_after as string\)\s*:\s*null,/,
  );
});
