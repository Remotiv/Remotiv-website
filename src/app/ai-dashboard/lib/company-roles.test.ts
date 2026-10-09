/**
 * Booking links and hiring decisions are reserved to owner, admin and
 * recruiter. The rule, its single source, and the places that must read it.
 *
 *   node --test src/app/ai-dashboard/lib/company-roles.test.ts
 *
 * Locked 2026-10-08: a hiring manager reviews and advances candidates between
 * the reviewing stages, but may not send or cancel a booking link, and may not
 * move a candidate into or out of Hired or Rejected. The first half runs the
 * helpers; the second pins the server actions and the UI to them, so a second
 * copy of the rule cannot appear and drift.
 */
// @ts-nocheck — same reason as company-access.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  canChangeStage,
  canMakeHiringDecision,
  canManageBookings,
  DECISION_STAGES,
  isDecisionStage,
} from "./company-roles.ts";

const ALLOWED = ["owner", "admin", "recruiter"];
const UNKNOWN = ["hiring_manager", "viewer", "Owner", "", null, undefined, 0, {}];

/* ── the helpers ────────────────────────────────────────────────── */

test("canManageBookings: owner, admin and recruiter only; anything else fails closed", () => {
  for (const role of ALLOWED) assert.equal(canManageBookings(role), true, role);
  for (const role of UNKNOWN) assert.equal(canManageBookings(role), false, String(role));
});

test("canMakeHiringDecision: owner, admin and recruiter only; anything else fails closed", () => {
  for (const role of ALLOWED) assert.equal(canMakeHiringDecision(role), true, role);
  for (const role of UNKNOWN) assert.equal(canMakeHiringDecision(role), false, String(role));
});

test("the decision stages are hired and rejected, and nothing else", () => {
  assert.deepEqual([...DECISION_STAGES], ["hired", "rejected"]);
  for (const s of ["applied", "screening", "shortlisted", "interview", "offer", null, undefined]) {
    assert.equal(isDecisionStage(s), false, String(s));
  }
});

/* ── the stage rule ─────────────────────────────────────────────── */

const DECISION_MOVES = [
  ["screening", "hired"],
  ["interview", "rejected"],
  ["hired", "interview"],
  ["rejected", "screening"],
  ["hired", "rejected"],
  ["hired", "hired"],
];
const REVIEW_MOVES = [
  ["screening", "interview"],
  ["applied", "shortlisted"],
  ["offer", "interview"],
  [null, "screening"],
];

test("a hiring manager is blocked from every move that touches a decision stage", () => {
  for (const [from, to] of DECISION_MOVES) {
    assert.equal(canChangeStage("hiring_manager", from, to), false, `${from} -> ${to}`);
  }
});

test("a hiring manager may still move candidates between the reviewing stages", () => {
  for (const [from, to] of REVIEW_MOVES) {
    assert.equal(canChangeStage("hiring_manager", from, to), true, `${from} -> ${to}`);
  }
});

test("owner, admin and recruiter may make every move; an unknown role is treated like a hiring manager", () => {
  for (const role of ALLOWED) {
    for (const [from, to] of [...DECISION_MOVES, ...REVIEW_MOVES]) {
      assert.equal(canChangeStage(role, from, to), true, `${role}: ${from} -> ${to}`);
    }
  }
  for (const role of ["viewer", null, undefined]) {
    assert.equal(canChangeStage(role, "screening", "hired"), false, String(role));
    assert.equal(canChangeStage(role, "screening", "interview"), true, String(role));
  }
});

/* ── the source: one rule, read by the server before any write ──── */

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Code only: comments may name a thing to say it is not done. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ACTIONS = src("../(gated)/applicants/actions.ts");
const BOOKING = src("../(gated)/applicants/booking-actions.ts");
const DRAWER = src("../(gated)/applicants/_applicants-client.tsx");
const PANEL = src("../(gated)/applicants/_interview-panel.tsx");
const TEAM = src("../(gated)/team/_team-client.tsx");
const REVIEW = src("../(gated)/interviews/[sessionId]/_review-client.tsx");
const REVIEW_PAGE = src("../(gated)/interviews/[sessionId]/page.tsx");

/** The body of one exported async function, up to the next export. */
function body(text, name) {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = text.indexOf("\nexport ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}
/** Every step must appear, in this order. */
function inOrder(text, steps, label) {
  let last = -1;
  for (const step of steps) {
    const i = text.indexOf(step, last + 1);
    assert.ok(i > last, `${label}: out of order or missing: ${step}`);
    last = i;
  }
}

test("updateApplicationStage reads the current stage, checks the rule, and only then writes stage and history", () => {
  const fn = code(body(ACTIONS, "updateApplicationStage"));
  inOrder(
    fn,
    [
      'requireCompanyRole("owner", "admin", "recruiter", "hiring_manager")',
      'select("id, company_id_snapshot, pipeline_stage, job_id',
      "await canAccessJob(ctx, target.job_id",
      "const fromStage = (target.pipeline_stage as PipelineStage)",
      "if (!canChangeStage(ctx.role, fromStage, toStage))",
      "Only an owner, admin or recruiter can hire, reject, or change a hiring decision.",
      ".update({ pipeline_stage: toStage })",
      'from("application_stage_history").insert(',
    ],
    "updateApplicationStage",
  );
  // The rule is the shared one, not a local list of stages or roles.
  assert.doesNotMatch(fn, /\[\s*["']hired["']\s*,\s*["']rejected["']\s*\]/);
  assert.doesNotMatch(ACTIONS, /hiring managers may/);
});

test("both booking actions resolve the session, then refuse by role before any token, row, email or calendar call", () => {
  const refusal = "Only an owner, admin or recruiter can send or cancel interview booking links.";
  assert.equal(BOOKING.split(refusal).length - 1, 1, "one copy of the sentence");
  inOrder(
    code(body(BOOKING, "sendBookingLink")),
    [
      "const ctx = await getCompanyContext();",
      "if (!canManageBookings(ctx.role)) return",
      // Minting and the insert live in createBookingLink since step 3a.
      "await createBookingLink({",
      "await deliverEmail(",
    ],
    "sendBookingLink",
  );
  inOrder(
    code(body(BOOKING, "cancelBookingAsRecruiter")),
    [
      "const ctx = await getCompanyContext();",
      "if (!canManageBookings(ctx.role)) return",
      'from("interview_bookings")',
      "await cancelBooking(",
      "await sendCancellationNotices(",
    ],
    "cancelBookingAsRecruiter",
  );
});

test("the UI reuses the helpers and defines no second rule; team_role is not consulted", () => {
  // The drawer: the decision stages are filtered out of the menu, and a
  // candidate already in one is shown as text with the note.
  assert.match(code(DRAWER), /canMakeHiringDecision\(viewerRole\) \|\| !isDecisionStage\(s\)/);
  assert.match(DRAWER, /Only an owner, admin or recruiter can change this\./);
  assert.match(DRAWER, /<InterviewPanel applicationId=\{row\.id\} viewerRole=\{viewerRole\}/);
  // The booking card: one flag from the helper hides both buttons.
  assert.match(code(PANEL), /const canManage = canManageBookings\(viewerRole\);/);
  assert.match(code(PANEL), /\{canManage && \(\s*<button/);
  assert.match(code(PANEL), /\{canManage && booking\.canCancel && !cancelling && \(/);
  // The review page: the account role comes from the server page, and the
  // stage control reads the same two helpers the drawer does.
  assert.match(code(REVIEW_PAGE), /<ReviewClient session=\{session\} viewerRole=\{ctx\.role\} \/>/);
  assert.match(code(REVIEW), /!canMakeHiringDecision\(viewerRole\) && isDecisionStage\(stage\)/);
  assert.match(code(REVIEW), /canMakeHiringDecision\(viewerRole\) \|\| !isDecisionStage\(s\)/);
  assert.match(REVIEW, /Only an owner, admin or recruiter can change this\./);
  // The Team page reads the same helpers.
  assert.match(code(TEAM), /allows: canMakeHiringDecision,/);
  assert.match(code(TEAM), /allows: canManageBookings,/);
  for (const [name, text] of [
    ["drawer", DRAWER],
    ["panel", PANEL],
    ["team", TEAM],
    ["review", REVIEW],
    ["actions", ACTIONS],
    ["booking", BOOKING],
  ]) {
    // No local re-statement of who may decide or book.
    assert.doesNotMatch(
      code(text),
      /function (canManageBookings|canMakeHiringDecision|canChangeStage|isDecisionStage)\b/,
      `${name}: redefines a helper`,
    );
    assert.doesNotMatch(code(text), /team_role\s*[=!]==?/, `${name}: branches on team_role`);
  }
  assert.doesNotMatch(src("./company-roles.ts"), /team_role\s*[=!]==?/);
});

test("the copy uses hyphens, never em dashes", () => {
  for (const line of TEAM.match(/label: "[^"]*"/g) ?? []) assert.doesNotMatch(line, /—/, line);
  for (const text of [DRAWER, REVIEW]) {
    const at = text.indexOf("Only an owner, admin or recruiter can change this");
    assert.ok(at >= 0);
    assert.doesNotMatch(text.slice(at, at + 60), /—/);
  }
  for (const s of [
    "Only an owner, admin or recruiter can hire, reject, or change a hiring decision.",
    "Only an owner, admin or recruiter can send or cancel interview booking links.",
  ]) {
    assert.doesNotMatch(s, /—/);
  }
});
