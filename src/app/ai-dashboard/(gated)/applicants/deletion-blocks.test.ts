/**
 * #16: an applicant whose delete has started (071's deletion_started_at)
 * cannot be changed, and the refusal is the SERVER's, not the panel's.
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/deletion-blocks.test.ts"
 *
 * Runtime: the shipped stage change, score adjustment, shortlist dismissal,
 * rescore and comment actions against a fake database, for an applicant that
 * is clear, marked, or whose marker cannot be read. Every write the fake sees
 * is recorded, so "refused" means "nothing written", not only "an error came
 * back". Source: every other applicant-changing action calls the refusal
 * before its first write. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/applicants-test-hook.mjs", import.meta.url));

const { fakeService } = await import("../../../../test-support/fake-postgrest.mjs");
const A = await import("./actions.ts");
const { BEING_DELETED, DELETION_UNCHECKED } = await import("../../../../lib/applicant-deletion.ts");

const CO = "c0000000-0000-0000-0000-000000000001";
const APP = "a0000000-0000-0000-0000-0000000aaaaa";
const JOB = "j0000000-0000-0000-0000-000000000001";

/**
 * marker: "clear" | "marked" | "unreadable". Reads answer the applicant row
 * (and, for the marker read, its deletion_started_at); every other operation
 * is recorded as a write and answered with an error, so the action stops
 * there and the test sees whether it got that far.
 */
function world(marker) {
  const writes = [];
  const service = fakeService((table, calls) => {
    const op = calls[0]?.[0];
    const select = String(calls.find((c) => c[0] === "select")?.[1] ?? "");
    if (op === "select" && table === "job_applications") {
      if (select.includes("deletion_started_at")) {
        if (marker === "unreadable") return { data: null, error: { code: "57014" } };
        return {
          data: {
            id: APP,
            deletion_started_at: marker === "marked" ? "2026-11-20T10:00:00.000Z" : null,
          },
          error: null,
        };
      }
      return {
        data: {
          id: APP,
          company_id_snapshot: CO,
          job_id: JOB,
          pipeline_stage: "applied",
          first_name: "Candidatea",
          last_name: "Testperson",
          cv_delete_after: null,
          cv_path: "x.pdf",
          cv_text: "text",
        },
        error: null,
      };
    }
    if (op === "select") return { data: null, count: 0, error: null };
    writes.push(`${op} ${table}`);
    return { data: null, error: { code: "XX000", message: "stop here" } };
  });
  globalThis.__applicantsServiceForTests = () => service;
  globalThis.__applicantsCtxForTests = {
    companyId: CO,
    memberId: "m-actor",
    memberName: "Team Member",
    role: "owner",
    company: { id: CO, name: "Acme" },
  };
  return { writes, service };
}

const quiet = async (fn) => {
  const real = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = () => {};
  try {
    return await fn();
  } catch (err) {
    return { threw: err };
  } finally {
    Object.assign(console, real);
  }
};

const ACTIONS = {
  "stage change": () => A.updateApplicationStage(APP, "shortlisted"),
  "score adjustment": () => A.adjustScore(APP, 80, "a reason"),
  "score revert": () => A.clearScoreAdjustment(APP),
  "shortlist dismissal": () => A.dismissShortlistFlagAction(APP),
  rescore: () => A.rescoreApplication(APP),
  "add comment": () => A.addApplicationComment(APP, "a note", null),
};

test("B1. marked: every action refuses with the same sentence and writes NOTHING", async () => {
  for (const [name, run] of Object.entries(ACTIONS)) {
    const w = world("marked");
    const out = await quiet(run);
    // Comment actions answer { ok }, the rest { success }: refused either way.
    assert.equal(out.success ?? out.ok, false, name);
    assert.equal(out.error, BEING_DELETED, name);
    assert.deepEqual(w.writes, [], `${name}: nothing written`);
  }
});

test("B2. the marker cannot be read: refused (fail closed), nothing written", async () => {
  for (const [name, run] of Object.entries(ACTIONS)) {
    const w = world("unreadable");
    const out = await quiet(run);
    // Comment actions answer { ok }, the rest { success }: refused either way.
    assert.equal(out.success ?? out.ok, false, name);
    assert.equal(out.error, DELETION_UNCHECKED, name);
    assert.deepEqual(w.writes, [], name);
  }
});

test("B3. clear: the check lets the action through to its own work (not refused as being deleted)", async () => {
  let reachedWrite = 0;
  for (const [name, run] of Object.entries(ACTIONS)) {
    const w = world("clear");
    const out = await quiet(run);
    assert.notEqual(out?.error, BEING_DELETED, name);
    assert.notEqual(out?.error, DELETION_UNCHECKED, name);
    if (w.writes.length > 0) reachedWrite += 1;
  }
  // Not vacuous: most of them got as far as writing (the fake then stops them).
  assert.ok(reachedWrite >= 4, `${reachedWrite} of ${Object.keys(ACTIONS).length} reached a write`);
});

/* ── every applicant-changing server action, from source ───────── */

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Code only: comments may name the calls. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const body = (src, fn) => {
  const start = src.indexOf(`export async function ${fn}(`);
  assert.ok(start >= 0, `${fn} exported`);
  const end = src.indexOf("\nexport async function ", start + 10);
  return src.slice(start, end === -1 ? undefined : end);
};
/** The first thing in a body that changes data. */
const FIRST_WRITE =
  /\.(insert|update|upsert|delete)\(|\.rpc\(|enqueue\(|deliverEmail\(|sendLink\(|sendInviteEmail\(|deliverInvite\(|cancelBooking\(|requestCvScore\(|dismissShortlistFlag\(|queueStageChange\(|runLiveRecovery\(|createBooking\(|storage\b/;

const SURFACES = [
  [
    "./actions.ts",
    [
      ["updateApplicationStage", "refuseIfBeingDeleted("],
      ["adjustScore", "assertAdjustableScore("],
      ["clearScoreAdjustment", "assertAdjustableScore("],
      ["dismissShortlistFlagAction", "refuseIfBeingDeleted("],
      ["rescoreApplication", "refuseIfBeingDeleted("],
      ["attachApplicationCv", "refuseIfBeingDeleted("],
      ["addApplicationComment", "gateApplication("],
      ["updateApplicationComment", "gateApplication("],
      ["deleteApplicationComment", "gateApplication("],
    ],
  ],
  [
    "./booking-actions.ts",
    [
      ["sendBookingLink", "refuseIfBeingDeleted("],
      ["cancelBookingAsRecruiter", "refuseIfBeingDeleted("],
    ],
  ],
  [
    "./interview-actions.ts",
    [
      ["sendInterviewInvite", "loadInviteTarget("],
      ["sendLiveInterviewInvite", "loadInviteTarget("],
    ],
  ],
  ["./cancel-notice-actions.ts", [["retryCancellationNotice", "refuseIfBeingDeleted("]]],
  [
    "./final-interview-actions.ts",
    [
      ["scheduleFinalInterview", "refuseIfBeingDeleted("],
      ["resendFinalInterviewLink", "refuseIfBeingDeleted("],
      ["cancelFinalInterview", "refuseIfBeingDeleted("],
      ["submitFinalEvaluation", "refuseIfBeingDeleted("],
      ["setFinalInterviewOutcome", "refuseIfBeingDeleted("],
    ],
  ],
  ["../messages/actions.ts", [["sendManualMessage", "refuseIfBeingDeleted("]]],
  [
    "../interviews/actions.ts",
    [
      ["addInterviewNote", "gateSessionForChange("],
      ["updateInterviewNote", "gateSessionForChange("],
      ["deleteInterviewNote", "gateSessionForChange("],
      ["scoreInterview", "gateSessionForChange("],
      ["setInterviewArchived", "gateSessionForChange("],
      ["deleteInterview", "gateSessionForChange("],
      ["adjustAnswerScore", "gateSessionForChange("],
      ["revertAnswerScore", "gateSessionForChange("],
      ["adjustSessionScore", "gateSessionForChange("],
      ["revertSessionScore", "gateSessionForChange("],
    ],
  ],
  [
    "../interviews/live-actions.ts",
    [["runLiveReviewAction", "refuseIfSessionApplicantBeingDeleted("]],
  ],
];

test("S1. every applicant-changing server action refuses BEFORE its first write", () => {
  let checked = 0;
  for (const [rel, fns] of SURFACES) {
    const src = code(read(rel));
    for (const [fn, guard] of fns) {
      const b = body(src, fn);
      const at = b.indexOf(guard);
      const write = b.search(FIRST_WRITE);
      assert.ok(at > 0, `${rel} ${fn}: no ${guard}`);
      assert.ok(write === -1 || at < write, `${rel} ${fn}: ${guard} after its first write`);
      checked += 1;
    }
  }
  assert.equal(checked, 31);
});

test("S2. the shared gates the actions go through carry the refusal themselves", () => {
  const actions = code(read("./actions.ts"));
  const gate = actions.slice(actions.indexOf("async function gateApplication("));
  assert.match(
    gate.slice(0, gate.indexOf("\n}\n")),
    /refuseIfBeingDeleted\(service, \{ applicationId, companyId: ctx\.companyId \}\)/,
  );
  const adjust = actions.slice(actions.indexOf("async function assertAdjustableScore("));
  const adjustBody = adjust.slice(0, adjust.indexOf("\n}\n"));
  // Right after the company and job checks, before anything else is read.
  const refuse = adjustBody.indexOf("refuseIfBeingDeleted(");
  assert.ok(refuse > adjustBody.indexOf("roleAllowsJobAction("));
  assert.ok(refuse < adjustBody.indexOf('.from("application_scores")'));
  const invite = code(read("./interview-actions.ts"));
  const target = invite.slice(invite.indexOf("async function loadInviteTarget("));
  const targetBody = target.slice(0, target.indexOf("\n}\n"));
  const inviteRefuse = targetBody.indexOf("refuseIfBeingDeleted(");
  assert.ok(inviteRefuse > 0, "the invite gate refuses");
  assert.ok(inviteRefuse < targetBody.indexOf("return { ok: true, app"));
  const interviews = code(read("../interviews/actions.ts"));
  assert.match(
    interviews,
    /async function gateSessionForChange\([\s\S]*?const gate = await gateSession\(sessionId\);[\s\S]*?refuseIfBeingDeleted\(/,
  );
  // Reading is not changing: playback keeps the plain gate.
  assert.match(body(interviews, "getAnswerPlaybackUrl"), /await gateSession\(sessionId\)/);
});
