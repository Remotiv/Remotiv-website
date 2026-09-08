/**
 * The one-box parser's contract, against every live JD.
 *
 *   node --test src/lib/jd/parse.test.ts
 *
 * ── The round trip ───────────────────────────────────────────
 *
 * `__fixtures__/jd-corpus.json` holds the three sections of all 20 publicly
 * visible jobs, scraped from the rendered pages on 2026-09-08. The main test
 * MERGES each job's three sections into the single box the wizard will present,
 * then asserts the parser recovers the three sections EXACTLY — same items,
 * same order, same characters.
 *
 * That is the property that matters. The migration and the wizard are the two
 * halves of the same operation, and if the round trip is not lossless then
 * turning three boxes into one loses employer-written text.
 *
 * ── The fixture had to be rebuilt twice ──────────────────────
 *
 * These pages stream. An unresolved Suspense slot writes an empty `<li>` and
 * sends its text later in the document, for the client to move into place. The
 * scraper read DOM order and filtered empty items, so it dropped one item per
 * page on 13 of the 20 pages — silently, with no error and a plausible-looking
 * result. Every list in the first two fixtures was one item short.
 *
 * This fixture is built from a scrape whose streamed slots were spliced back
 * into place first, and the extractor now REPORTS unresolved slots instead of
 * filtering them away. The corrected ceiling is 8, and was 8 before any of the
 * database repairs — see the assertion below.
 */

// @ts-nocheck — same reason as src/lib/supabase/paging.test.ts: the `./parse.ts`
// specifier Node requires is rejected by this repo's tsconfig, which does not
// set `allowImportingTsExtensions`. `node --test` still type-strips and runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyGroups,
  MAX_LIST_ITEMS,
  mergeJobText,
  needsModelSplit,
  parseJobDescription,
  telemetryFor,
} from "./parse.ts";

const HEADINGS = ["What you'll do", "What we're looking for", "About this role"];

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "__fixtures__", "jd-corpus.json"), "utf-8"));

/** Exactly what the wizard will show and the migration will write. */
function toOneBox(job) {
  const parts = [job.description.join("\n")];
  if (job.responsibilities.length > 0) {
    parts.push(`What you'll do\n${job.responsibilities.join("\n")}`);
  }
  if (job.requirements.length > 0) {
    parts.push(`What we're looking for\n${job.requirements.join("\n")}`);
  }
  return parts.filter((p) => p.trim()).join("\n\n");
}

test("corpus is the 20 live jobs", () => {
  assert.equal(corpus.length, 20);
});

test("the parser is the fast path: a JD with headings never calls the model", () => {
  for (const job of corpus) {
    assert.equal(needsModelSplit(parseJobDescription(toOneBox(job))), false, job.slug);
  }
});

test("a box the parser cannot read asks for the model", () => {
  // No headings, blank lines or not — both need meaning rather than structure.
  const unbroken = "Intro paragraph.\nDo the thing\nHave the experience";
  const blanks = "Intro paragraph.\n\nDo the thing\n\nHave the experience";
  assert.equal(needsModelSplit(parseJobDescription(unbroken)), true);
  assert.equal(needsModelSplit(parseJobDescription(blanks)), true);
});

test("applying a split writes headings the parser reads straight back", () => {
  /*
   * The round trip that carries the whole feature: the model's answer becomes
   * ordinary text in the box, and the columns are then derived from that text.
   * Nothing is written to a column the recruiter cannot see and edit.
   */
  const box = ["An intro paragraph.", "Build the thing", "Own the thing", "5+ years of it"].join(
    "\n",
  );
  const groups = [
    { kind: "description", lines: ["An intro paragraph."] },
    { kind: "responsibilities", lines: ["Build the thing", "Own the thing"] },
    { kind: "requirements", lines: ["5+ years of it"] },
  ];

  const applied = applyGroups(box, groups);
  assert.equal(
    applied,
    [
      "An intro paragraph.",
      "",
      "What you'll do",
      "Build the thing",
      "Own the thing",
      "",
      "What we're looking for",
      "5+ years of it",
    ].join("\n"),
  );

  const parsed = parseJobDescription(applied);
  assert.equal(parsed.outcome, "split");
  assert.equal(parsed.description, "An intro paragraph.");
  assert.deepEqual(parsed.responsibilities, ["Build the thing", "Own the thing"]);
  assert.deepEqual(parsed.requirements, ["5+ years of it"]);
  assert.equal(needsModelSplit(parsed), false, "and it never needs the model again");
});

test("applying a split keeps every line, in order, unedited", () => {
  const lines = ["Intro.", "Duty one", "Duty two", "Requirement one"];
  const applied = applyGroups(lines.join("\n"), [
    { kind: "description", lines: lines.slice(0, 1) },
    { kind: "responsibilities", lines: lines.slice(1, 3) },
    { kind: "requirements", lines: lines.slice(3) },
  ]);
  const kept = applied.split("\n").filter((l) => l.trim() && !HEADINGS.includes(l.trim()));
  assert.deepEqual(kept, lines, "the recruiter's words, untouched");
});

test("a leading description gets no heading; a later one does", () => {
  // Leading text already parses as the description, so a heading there is
  // noise — but a description group in the middle would inherit the section
  // above it.
  const leading = applyGroups("a\nb", [
    { kind: "description", lines: ["a"] },
    { kind: "requirements", lines: ["b"] },
  ]);
  assert.ok(!leading.includes("About this role"));

  const middle = applyGroups("a\nb\nc", [
    { kind: "responsibilities", lines: ["a"] },
    { kind: "description", lines: ["b"] },
    { kind: "requirements", lines: ["c"] },
  ]);
  assert.ok(middle.includes("About this role"));
  assert.deepEqual(parseJobDescription(middle).responsibilities, ["a"], "the note did not join it");
});

test("no groups leaves the box exactly as written", () => {
  const box = "Whatever they typed.\nOn two lines.";
  assert.equal(applyGroups(box, []), box);
});

test("a split the wizard already applied stops the server splitting again", () => {
  /*
   * THE property that makes the client call and the server call one mechanism
   * rather than two opinions.
   *
   * splitIfNeeded rebuilds a box from the incoming columns and asks whether it
   * still needs the model. If the wizard's call landed first, the columns hold
   * the split, the rebuilt box parses as "split", and the server does not call
   * — so there is never a second answer that could disagree with the first.
   */
  const raw = ["An intro paragraph.", "Build the thing", "5+ years of it"].join("\n");

  // As the wizard leaves it when its call lands first.
  const split = parseJobDescription(
    applyGroups(raw, [
      { kind: "description", lines: ["An intro paragraph."] },
      { kind: "responsibilities", lines: ["Build the thing"] },
      { kind: "requirements", lines: ["5+ years of it"] },
    ]),
  );
  const columnsFromWizard = {
    description: split.description,
    responsibilities: split.responsibilities.join("\n"),
    requirements: split.requirements.join("\n"),
  };

  assert.equal(
    needsModelSplit(parseJobDescription(mergeJobText(columnsFromWizard))),
    false,
    "the server must not call the model a second time",
  );

  // And when the wizard's call did NOT land, the payload is the raw box in
  // `description` — which the server does still split.
  assert.equal(
    needsModelSplit(
      parseJobDescription(
        mergeJobText({ description: raw, responsibilities: "", requirements: "" }),
      ),
    ),
    true,
  );
});

test("every live job is already split, so editing one never calls the model", () => {
  // Saving an existing job must not spend a model call, or every edit of a
  // salary would pay for a split that is already correct.
  for (const job of corpus) {
    const columns = {
      description: job.description.join("\n"),
      responsibilities: job.responsibilities.join("\n"),
      requirements: job.requirements.join("\n"),
    };
    assert.equal(needsModelSplit(parseJobDescription(mergeJobText(columns))), false, job.slug);
  }
});

test("opening a job for editing and saving it unchanged rewrites nothing", () => {
  /*
   * The round trip the wizard performs on every edit: three columns → one box
   * (mergeJobText) → three columns (parseJobDescription). If these two ever
   * disagree, opening a job and pressing Save reshapes text nobody touched —
   * silently, on every existing job, the first time someone edits a salary.
   */
  for (const job of corpus) {
    const columns = {
      description: job.description.join("\n"),
      responsibilities: job.responsibilities.join("\n"),
      requirements: job.requirements.join("\n"),
    };
    const parsed = parseJobDescription(mergeJobText(columns));

    assert.equal(parsed.outcome, "split", `${job.slug}: outcome`);
    assert.equal(parsed.description, columns.description, `${job.slug}: description`);
    assert.equal(
      parsed.responsibilities.join("\n"),
      columns.responsibilities,
      `${job.slug}: responsibilities`,
    );
    assert.equal(parsed.requirements.join("\n"), columns.requirements, `${job.slug}: requirements`);
  }
});

test("merge omits a heading for an empty column rather than writing an empty one", () => {
  // An empty heading would be queued as a question on the next open — the
  // wizard would interrogate the recruiter about a section it wrote itself.
  const box = mergeJobText({ description: "Just an overview.", requirements: "   " });
  assert.equal(box, "Just an overview.");
  assert.deepEqual(parseJobDescription(box).headings, []);
});

test("round trip is lossless for every live JD", () => {
  for (const job of corpus) {
    const got = parseJobDescription(toOneBox(job));
    assert.equal(got.outcome, "split", `${job.slug}: outcome`);
    assert.deepEqual(got.description.split("\n"), job.description, `${job.slug}: description`);
    assert.deepEqual(got.responsibilities, job.responsibilities, `${job.slug}: responsibilities`);
    assert.deepEqual(got.requirements, job.requirements, `${job.slug}: requirements`);
  }
});

test("every live JD still splits, and the ceiling is where we think it is", () => {
  const longest = Math.max(
    ...corpus.map((j) => Math.max(j.responsibilities.length, j.requirements.length)),
  );

  /*
   * Pinned, so the derivation behind MAX_LIST_ITEMS cannot drift silently. If
   * this fails, the corpus has changed shape and the threshold needs
   * re-deriving — not raising on the spot to make the test pass.
   *
   * 8, held by digital-marketing-strategist's responsibilities, and held by it
   * before the misfiled-criteria repair too. The repair briefly put
   * business-development-intern at 8 as well, by appending a paraphrase of a
   * degree requirement the list already carried; that duplicate has since been
   * deleted and it is back to 7. Neither event moved the ceiling.
   */
  assert.equal(longest, 8, "observed ceiling moved — re-derive MAX_LIST_ITEMS");

  // The property that actually matters, and it is strict: the threshold must
  // sit PAST the ceiling, not on it. `<` rather than `<=` is the whole point —
  // at 8 this assertion would have failed, which is what it is for.
  assert.ok(longest < MAX_LIST_ITEMS, "MAX_LIST_ITEMS must sit past the observed ceiling");
});

test("a box with no headings is not split on a guess", () => {
  const prose = [
    "We are hiring a research executive to join a small team.",
    "You will work across desk research and client reporting.",
    "Experience with Excel is important, as is written English.",
  ].join("\n");

  const got = parseJobDescription(prose);
  assert.equal(got.outcome, "no_headings");
  assert.equal(got.responsibilities.length, 0);
  assert.equal(got.requirements.length, 0);
  assert.equal(got.description.split("\n").length, 3);
});

test("a heading-shaped SENTENCE stays in the body", () => {
  // The anchors are the whole defence here. Without them this opens a section
  // mid-paragraph and shreds the rest of the prose into "items".
  const got = parseJobDescription(
    "We will discuss requirements at interview.\nThe role reports to the MD.",
  );
  assert.equal(got.outcome, "no_headings");
  assert.equal(got.requirements.length, 0);
});

test("an 'About this role' heading alone does not count as a split", () => {
  const got = parseJobDescription("About this role\nA short paragraph about the job.");
  assert.equal(got.outcome, "no_headings");
});

test("the escape hatch opens above MAX_LIST_ITEMS", () => {
  const items = Array.from({ length: MAX_LIST_ITEMS + 1 }, (_, i) => `Requirement ${i + 1}`);
  const got = parseJobDescription(`Intro line.\n\nRequirements\n${items.join("\n")}`);

  assert.equal(got.outcome, "over_threshold");
  assert.equal(got.longestList, MAX_LIST_ITEMS + 1);
  // Still populated: the wizard shows what the split WOULD have been, and the
  // outcome is what says not to write it.
  assert.equal(got.requirements.length, MAX_LIST_ITEMS + 1);
});

test("exactly MAX_LIST_ITEMS still splits", () => {
  const items = Array.from({ length: MAX_LIST_ITEMS }, (_, i) => `Requirement ${i + 1}`);
  const got = parseJobDescription(`Intro line.\n\nRequirements\n${items.join("\n")}`);
  assert.equal(got.outcome, "split");
});

test("bullets and ordinals are stripped, content is not", () => {
  const got = parseJobDescription(
    ["Intro.", "", "Requirements", "- Excel", "2. Written English", "• 1-2 years' experience"].join(
      "\n",
    ),
  );
  assert.deepEqual(got.requirements, ["Excel", "Written English", "1-2 years' experience"]);
});

test("CRLF parses identically to LF", () => {
  const lf = "Intro.\n\nRequirements\n- Excel\n- English";
  assert.deepEqual(parseJobDescription(lf.replace(/\n/g, "\r\n")), parseJobDescription(lf));
});

test("empty and null are safe", () => {
  for (const input of [null, undefined, "", "   \n\n  "]) {
    const got = parseJobDescription(input);
    assert.equal(got.outcome, "no_headings");
    assert.equal(got.description, "");
  }
});

test("telemetry carries the decision and the shape, never the text", () => {
  const box = "Intro.\n\nRequirements\n- Excel\n- Written English";
  const t = telemetryFor(parseJobDescription(box), box);

  assert.equal(t.outcome, "split");
  assert.equal(t.requirements, 2);
  assert.equal(t.boxChars, box.length);
  assert.equal(t.accepted, null, "unanswered must differ from declined");

  const serialised = JSON.stringify(t);
  assert.ok(!serialised.includes("Excel"), "telemetry must not carry JD text");
  assert.ok(!serialised.includes("Written English"), "telemetry must not carry JD text");
});
