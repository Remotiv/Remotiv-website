/**
 * The enum-constraint parser and the preflight assertion.
 *
 *   node --test "scripts/staging/*.test.mjs"
 *
 * Parsed from a fabricated dump for the shapes, and from the REAL dump for the
 * values the seed actually writes — so the exact failure the first 50-seed hit
 * (event = interview_invite / rejection, rejected by the live constraint) is
 * reproduced as a preflight violation here, offline, before any database.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { enumViolations, parseCheckEnums } from "./constraints.mjs";
import {
  CHIP_STATUSES,
  MESSAGE_EVENT_MANUAL,
  MESSAGE_EVENTS_AUTOMATIC,
  MESSAGE_STATUSES,
  PIPELINE_STAGES,
  SCORE_STATUSES,
} from "./seed-plan.mjs";

const DUMP_PATH = process.env.REMOTIV_SCHEMA_DUMP ?? "/tmp/remotiv-prod-schema.sql";
const dump = () => {
  assert.ok(
    existsSync(DUMP_PATH),
    `the production schema dump is not at ${DUMP_PATH}; see README step 1`,
  );
  return readFileSync(DUMP_PATH, "utf8");
};

const FAB = `CREATE TABLE public.communication_logs (
    id uuid NOT NULL,
    event text NOT NULL,
    channel text,
    CONSTRAINT communication_logs_event_check CHECK ((event = ANY (ARRAY['application_received'::text, 'manual'::text]))),
    CONSTRAINT communication_logs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'read'::text])))
);
CREATE TABLE public.jobs (
    id uuid NOT NULL,
    status text NOT NULL
);
ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])));
`;

test("parseCheckEnums reads inline CONSTRAINT lines and standalone ALTER ADD CONSTRAINT, scoped by table", () => {
  const c = parseCheckEnums(FAB);
  assert.deepEqual(c["communication_logs.event"], ["application_received", "manual"]);
  assert.deepEqual(c["communication_logs.status"], ["queued", "read"]);
  assert.deepEqual(c["jobs.status"], ["open", "closed"]);
  assert.equal(c["communication_logs.channel"], undefined, "channel has no CHECK: a free column");
});

test("enumViolations reports values outside a constraint and ignores free columns", () => {
  const c = parseCheckEnums(FAB);
  const v = enumViolations(c, {
    "communication_logs.event": ["application_received", "interview_invite", "rejection"],
    "communication_logs.channel": ["email", "whatsapp"],
    "jobs.status": ["open"],
  });
  assert.equal(v.length, 1);
  assert.equal(v[0].column, "communication_logs.event");
  assert.deepEqual(v[0].bad, ["interview_invite", "rejection"]);
  assert.deepEqual(v[0].allowed, ["application_received", "manual"]);
});

test("enumViolations passes when every value is permitted", () => {
  const c = parseCheckEnums(FAB);
  assert.deepEqual(
    enumViolations(c, { "jobs.status": ["open"], "communication_logs.event": ["manual"] }),
    [],
  );
});

/* ── against the REAL dump: the seed's actual enumerated values ── */

test("the dump carries the communication_logs event and status constraints", () => {
  const c = parseCheckEnums(dump());
  assert.ok(Array.isArray(c["communication_logs.event"]), "event constraint not parsed");
  assert.ok(c["communication_logs.event"].includes("manual"));
  assert.deepEqual(
    c["communication_logs.status"],
    [...MESSAGE_STATUSES],
    "all seven statuses must be allowed",
  );
});

test("every event value the seed writes is permitted by the live constraint — the first 50-seed's bug, caught offline", () => {
  const c = parseCheckEnums(dump());
  const v = enumViolations(c, {
    "communication_logs.event": [MESSAGE_EVENT_MANUAL, ...MESSAGE_EVENTS_AUTOMATIC],
  });
  assert.deepEqual(
    v,
    [],
    `the seed would write an event the constraint rejects: ${JSON.stringify(v)}`,
  );
});

test("the earlier, wrong event values WOULD be caught as a violation", () => {
  const c = parseCheckEnums(dump());
  const v = enumViolations(c, {
    "communication_logs.event": ["application_received", "interview_invite", "rejection"],
  });
  assert.equal(v.length, 1, "the old values must be rejected, proving the check discriminates");
  assert.ok(v[0].bad.includes("interview_invite") && v[0].bad.includes("rejection"));
});

test("every other enumerated value the seed writes is permitted by the real dump", () => {
  const c = parseCheckEnums(dump());
  const v = enumViolations(c, {
    "communication_logs.status": [...MESSAGE_STATUSES],
    "job_applications.pipeline_stage": [...PIPELINE_STAGES],
    "application_scores.status": [...SCORE_STATUSES],
    "interview_sessions.status": [...CHIP_STATUSES],
    "company_members.role": ["owner", "recruiter"],
    "company_members.status": ["active"],
    "job_hiring_team.team_role": ["recruiter"],
    "jobs.status": ["open"],
    "jobs.category": ["Engineering"],
    "jobs.experience_level": ["Intermediate"],
    "job_applications.status": ["new"],
    "interview_answers.transcript_status": ["skipped"],
  });
  assert.deepEqual(
    v,
    [],
    `an enumerated value the seed writes is not permitted: ${JSON.stringify(v)}`,
  );
});

test("all seven message statuses are possible on the real constraint (the standing requirement)", () => {
  const c = parseCheckEnums(dump());
  for (const s of MESSAGE_STATUSES) {
    assert.ok(
      c["communication_logs.status"].includes(s),
      `status ${s} is not permitted; the seven-status requirement is impossible`,
    );
  }
});
