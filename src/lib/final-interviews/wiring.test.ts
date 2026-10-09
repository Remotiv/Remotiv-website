/**
 * Final Human Interview scheduling, from the source: the rules the behaviour
 * tests cannot see from outside.
 *
 *   node --test src/lib/final-interviews/wiring.test.ts
 *
 * The supersede rule filters by purpose in both branches; the screening path
 * names its purpose and never reads a final booking; the public route checks
 * the acknowledgement before it reads availability or claims a slot, and
 * writes the version the constants module defines once; every write action
 * checks the role before it builds a client; nothing touches a stage.
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const BOOKINGS = read("src/lib/calendar/bookings.ts");
const BOOKING_ACTIONS = read("src/app/ai-dashboard/(gated)/applicants/booking-actions.ts");
const ROUTE = read("src/app/api/book/[token]/route.ts");
const NOTIFY = read("src/lib/calendar/notify.ts");
const ACTIONS = read("src/app/ai-dashboard/(gated)/applicants/final-interview-actions.ts");
const NEW_FILES = [
  "src/lib/final-interviews/constants.ts",
  "src/lib/final-interviews/types.ts",
  "src/lib/final-interviews/eligibility.ts",
  "src/app/ai-dashboard/(gated)/applicants/final-interview-actions.ts",
];

function body(text, start, end) {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = end ? text.indexOf(end, from + start.length) : -1;
  return text.slice(from, to < 0 ? undefined : to);
}
function inOrder(text, steps, label) {
  let last = -1;
  for (const step of steps) {
    const i = text.indexOf(step, last + 1);
    assert.ok(i > last, `${label}: out of order or missing: ${step}`);
    last = i;
  }
}

test("createBookingLink filters the live booking by purpose, then by application or final interview", () => {
  const fn = code(
    body(BOOKINGS, "export async function createBookingLink(", "export type ClaimOutcome"),
  );
  assert.match(fn, /\.eq\("purpose", args\.purpose\)/);
  assert.match(
    fn,
    /\.eq\("final_interview_id", finalInterviewId\)\s*:\s*live\.eq\("application_id", args\.applicationId\)/,
  );
  assert.match(fn, /\.in\("status", \["invited", "booked"\]\)/);
  assert.match(
    fn,
    /if \(current\?\.status === "booked"\) return \{ ok: false, reason: "already_booked" \};/,
  );
  // The insert carries both the purpose and the link to the final interview.
  assert.match(fn, /purpose: args\.purpose,\s*final_interview_id: finalInterviewId,/);
  // No overlap guard of its own: the database constraint covers both purposes.
  assert.doesNotMatch(fn, /overlapsExisting|tstzrange/);
});

test("the screening path names its purpose everywhere it reads or writes a booking", () => {
  const c = code(BOOKING_ACTIONS);
  assert.match(c, /createBookingLink\(\{\s*purpose: "interview",/);
  assert.equal(
    (c.match(/\.eq\("purpose", "interview"\)/g) ?? []).length,
    2,
    "fetchBookingPanel and cancel",
  );
  assert.doesNotMatch(
    c,
    /mintBookingToken|from\("interview_bookings"\)\s*\.insert\(/,
    "minting moved to bookings.ts",
  );
  assert.doesNotMatch(c, /purpose: "final"|final_interview/);
});

test("claimSlot refuses a final slot without the acknowledgement and writes it in the booking update", () => {
  const fn = code(
    body(BOOKINGS, "export async function claimSlot(", "export async function overlapsExisting("),
  );
  inOrder(
    fn,
    [
      'const isFinal = args.row.purpose === "final";',
      'return { ok: false, reason: "acknowledgement_required" };',
      "await overlapsExisting(",
      'status: "booked",',
      "recording_notice_acknowledged_at: bookedAt,",
      "recording_notice_version: args.recordingNotice.version,",
    ],
    "claimSlot",
  );
});

test("the public route checks the acknowledgement before availability and the claim, with the one version", () => {
  const post = code(body(ROUTE, "export async function POST(", "export async function PATCH("));
  inOrder(
    post,
    [
      'if (row.status === "cancelled") return fail(410, "cancelled");',
      'const isFinal = row.purpose === "final";',
      "if (isFinal && body?.recordingNoticeAcknowledged !== true) {",
      "return fail(400, ACKNOWLEDGE_RECORDING);",
      "await fetchAvailability(",
      "await claimSlot({",
      "recordingNotice: isFinal ? { version: RECORDING_NOTICE_VERSION } : null,",
      "await attachCalendarEvent({",
    ],
    "POST",
  );
  // Final rounds add the extra interviewers as guests; screening keeps host + candidate.
  assert.match(post, /\.\.\.\(ctx\.final\?\.interviewerEmails \?\? \[\]\)/);
  // GET carries the notice for the page to show.
  assert.match(
    code(ROUTE),
    /text: recordingNoticeText\(ctx\.company\?\.name \?\? ""\),\s*version: RECORDING_NOTICE_VERSION,/,
  );
});

test("RECORDING_NOTICE_VERSION is defined once and consumed by the route only", () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  const files = walk(join(ROOT, "src")).filter((p) => !p.includes(join("src", "test-support")));
  const defining = files.filter((p) =>
    /export const RECORDING_NOTICE_VERSION/.test(code(readFileSync(p, "utf8"))),
  );
  assert.deepEqual(
    defining.map((p) => relative(ROOT, p)),
    ["src/lib/final-interviews/constants.ts"],
  );
  const using = files
    .filter((p) => /\bRECORDING_NOTICE_VERSION\b/.test(code(readFileSync(p, "utf8"))))
    .map((p) => relative(ROOT, p))
    .sort();
  assert.deepEqual(using, [
    "src/app/api/book/[token]/route.ts",
    "src/lib/final-interviews/constants.ts",
  ]);
});

test("every write action checks the role before building a client; the reads do not gate on it", () => {
  const c = code(ACTIONS);
  for (const name of [
    "scheduleFinalInterview",
    "resendFinalInterviewLink",
    "cancelFinalInterview",
  ]) {
    const fn = body(c, `export async function ${name}(`, "\nexport async function");
    inOrder(
      fn,
      [
        "const ctx = await getCompanyContext();",
        "if (!canManageBookings(ctx.role)) return { success: false, error: NOT_A_BOOKING_ROLE };",
        "const service = createServiceClient();",
      ],
      name,
    );
  }
  for (const name of ["getFinalInterviewOptions", "listFinalInterviews"]) {
    const fn = body(c, `export async function ${name}(`, "\nexport async function");
    assert.doesNotMatch(fn, /canManageBookings/, `${name} is a read`);
    assert.match(
      fn,
      /gateApplication\(ctx, service,/,
      `${name} still checks the company and the job`,
    );
  }
  // The rule is the shared one; no role list of its own.
  assert.doesNotMatch(c, /\[\s*["']owner["']\s*,\s*["']admin["']/);
});

test("nothing in this step touches a pipeline stage, and the new copy has no em dash", () => {
  for (const rel of [
    ...NEW_FILES,
    "src/lib/calendar/bookings.ts",
    "src/lib/calendar/notify.ts",
    "src/app/api/book/[token]/route.ts",
    "src/app/ai-dashboard/(gated)/applicants/booking-actions.ts",
  ]) {
    assert.doesNotMatch(read(rel), /pipeline_stage|updateApplicationStage/, rel);
  }
  for (const rel of NEW_FILES) assert.doesNotMatch(read(rel), /—/, rel);
  // The final-round branches of the shared notices use a hyphen; the screening
  // branches keep their existing wording untouched.
  for (const verb of ["confirmed", "moved", "cancelled"]) {
    assert.match(
      NOTIFY,
      new RegExp(`\\$\\{args\\.interviewLabel\\} ${verb} - \\$\\{args\\.jobTitle\\}`),
    );
    assert.match(NOTIFY, new RegExp(`Interview ${verb} \\u2014 \\$\\{args\\.jobTitle\\}`));
  }
  const linkEmail = body(NOTIFY, "export async function sendFinalInterviewLinkEmail(", "\n}\n");
  assert.doesNotMatch(linkEmail, /—/);
  assert.match(linkEmail, /subject: `\$\{args\.interviewLabel\} with \$\{company\}`/);
  assert.match(linkEmail, /recordingNoticeText\(args\.companyName\)/);
  assert.match(linkEmail, /event: "booking_link"/);
  assert.match(linkEmail, /sentByName: args\.sentByName/);
  assert.doesNotMatch(linkEmail, /within 24 hours/i);
});
