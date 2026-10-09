/**
 * The Final Human Interview vocabulary: labels, durations, and the recording
 * notice word for word.
 *
 *   node --test src/lib/final-interviews/constants.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ACKNOWLEDGE_RECORDING,
  DEFAULT_FINAL_DURATION,
  FINAL_DURATIONS,
  HOST_NEEDS_CALENDAR,
  INTERVIEW_TYPE_LABELS,
  INTERVIEW_TYPES,
  interviewTypeLabel,
  isFinalDuration,
  isInterviewType,
  MAX_EXTRA_INTERVIEWERS,
  RECORDING_NOTICE_VERSION,
  recordingNoticeText,
} from "./constants.ts";

test("the six types and their labels; custom uses its own label", () => {
  assert.deepEqual(
    [...INTERVIEW_TYPES],
    ["final", "cto", "ceo", "hiring_manager", "technical", "custom"],
  );
  assert.deepEqual(INTERVIEW_TYPE_LABELS, {
    final: "Final interview",
    cto: "CTO interview",
    ceo: "CEO interview",
    hiring_manager: "Hiring manager interview",
    technical: "Technical interview",
  });
  assert.equal(interviewTypeLabel("cto", null), "CTO interview");
  assert.equal(interviewTypeLabel("custom", "  Founder chat "), "Founder chat");
  assert.equal(interviewTypeLabel("custom", null), "Final interview", "never an empty label");
  assert.equal(interviewTypeLabel("nonsense", null), "Final interview");
  for (const t of INTERVIEW_TYPES) assert.equal(isInterviewType(t), true, t);
  for (const t of ["Final", "", null, undefined, "panel"])
    assert.equal(isInterviewType(t), false, String(t));
});

test("durations: 30, 45 or 60, defaulting to 60", () => {
  assert.deepEqual([...FINAL_DURATIONS], [30, 45, 60]);
  assert.equal(DEFAULT_FINAL_DURATION, 60);
  for (const d of [30, 45, 60]) assert.equal(isFinalDuration(d), true, String(d));
  for (const d of [20, 90, 0, -30, 45.5, "45", null, undefined]) {
    assert.equal(isFinalDuration(d), false, String(d));
  }
  assert.equal(MAX_EXTRA_INTERVIEWERS, 5);
});

test("the recording notice, version v1, word for word, with the company's name", () => {
  assert.equal(RECORDING_NOTICE_VERSION, "v1");
  assert.equal(
    recordingNoticeText("Acme"),
    "This interview will be recorded. The recording will be available only to authorized members of Acme's hiring team and will be deleted after 6 months.",
  );
  assert.equal(
    recordingNoticeText("  "),
    "This interview will be recorded. The recording will be available only to authorized members of the company's hiring team and will be deleted after 6 months.",
  );
  assert.equal(
    ACKNOWLEDGE_RECORDING,
    "Please confirm you understand the interview will be recorded.",
  );
  assert.equal(
    HOST_NEEDS_CALENDAR,
    "The host needs Google Calendar connected before they can host a final interview.",
  );
});

test("hyphens, never em dashes, and the module stays client-safe", () => {
  const src = readFileSync(new URL("./constants.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /—/);
  assert.doesNotMatch(src, /server-only|@\/lib\/supabase|createServiceClient/);
  for (const text of [recordingNoticeText("Acme"), ACKNOWLEDGE_RECORDING, HOST_NEEDS_CALENDAR]) {
    assert.doesNotMatch(text, /—/);
  }
});
