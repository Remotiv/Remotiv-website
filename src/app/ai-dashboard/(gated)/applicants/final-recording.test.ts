/**
 * Recording step 5, server side: the recording summary listFinalInterviews
 * carries, and getFinalRecordingPlayback. Real actions, fake database, fake
 * session and fake storage (final-interview-test-hook.mjs).
 *
 *   node --test "src/app/ai-dashboard/(gated)/applicants/final-recording.test.ts"
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../../test-support/final-interview-test-hook.mjs", import.meta.url));

const { APP, CO, JOB, finalInterviewWorld, makeDb } = await import(
  "../../../../test-support/final-interview-world.mjs"
);
const { FINAL_RECORDING_BUCKET, FINAL_RECORDING_PLAYBACK_TTL_SECONDS } = await import(
  "../../../../lib/final-interviews/constants.ts"
);
const { getFinalRecordingPlayback, listFinalInterviews } = await import(
  "./final-interview-actions.ts"
);

const PATH = `${CO}/fi-1/rec-1.mp4`;
const NOT_FOUND = "Recording not found in your workspace.";

const ctxFor = (role) => ({
  companyId: CO,
  role,
  memberId: "m-rec",
  memberName: "Rae Recruiter",
  user: { id: "u-viewer", email: "viewer@acme.test" },
  company: { name: "Acme", contact_name: "Olive Owner" },
});

const interview = (over = {}) => ({
  id: "fi-1",
  company_id: CO,
  job_id: JOB,
  application_id: APP,
  interview_type: "cto",
  custom_label: null,
  host_member_id: "m-host",
  status: "active",
  created_by_name: "Rae Recruiter",
  created_at: "2026-10-01T00:00:00.000Z",
  cancelled_at: null,
  ...over,
});

const booking = (over = {}) => ({
  id: "b-now",
  company_id: CO,
  application_id: APP,
  job_id: JOB,
  host_member_id: "m-host",
  duration_minutes: 30,
  status: "booked",
  scheduled_start: "2026-11-05T10:00:00.000Z",
  scheduled_end: "2026-11-05T10:30:00.000Z",
  candidate_timezone: "UTC",
  host_timezone: "UTC",
  meeting_url: "https://meet.google.com/abc-defg-hij",
  expires_at: null,
  cancelled_by: null,
  cancel_reason: null,
  purpose: "final",
  final_interview_id: "fi-1",
  created_at: "2026-10-02T00:00:00.000Z",
  ...over,
});

const bot = (over = {}) => ({
  id: "bot-now",
  final_interview_id: "fi-1",
  company_id: CO,
  booking_id: "b-now",
  status: "scheduled",
  join_at: "2026-11-05T09:59:00.000Z",
  import_status: "none",
  last_event_code: null,
  last_event_sub_code: null,
  last_event_at: null,
  provider_recording_id: null,
  superseded_at: null,
  ...over,
});

const recording = (over = {}) => ({
  id: "rec-1",
  final_interview_id: "fi-1",
  company_id: CO,
  job_id: JOB,
  application_id: APP,
  source: "recall_bot",
  vendor_recording_id: "vendor-1",
  storage_path: PATH,
  status: "ready",
  uploaded_at: "2026-11-05T11:00:00.000Z",
  created_at: "2026-11-05T10:40:00.000Z",
  deleted_by: null,
  ...over,
});

/** One action as `role`, with storage signing recorded. */
async function run(role, act, { db = makeDb(), canAccessJob, failing, signError } = {}) {
  const service = finalInterviewWorld(db, { failing });
  const signs = [];
  service.storage = {
    from(bucket) {
      return {
        async createSignedUrl(path, ttl) {
          signs.push({ bucket, path, ttl });
          if (signError) return { data: null, error: { message: `bad ${path}` } };
          // Shaped like Supabase's: the object key is in the URL.
          return {
            data: {
              signedUrl: `https://proj.supabase.test/storage/v1/object/sign/${bucket}/${path}?token=t`,
            },
            error: null,
          };
        },
      };
    },
  };
  globalThis.__fiServiceForTests = () => service;
  globalThis.__fiCtxForTests = ctxFor(role);
  globalThis.__fiCanAccessJob = canAccessJob;
  const quiet = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    return { result: await act(), service, db, signs, logged };
  } finally {
    console.error = quiet;
  }
}

const seeded = () => {
  const db = makeDb();
  db.final_interviews.push(interview());
  db.interview_bookings.push(booking());
  return db;
};

/* ── the list ───────────────────────────────────────────────────── */

test("the list carries each interview's recording summary, and none when there is no bot", async () => {
  const db = seeded();
  db.final_interviews.push(interview({ id: "fi-2", created_at: "2026-09-01T00:00:00.000Z" }));
  db.interview_bookings.push(booking({ id: "b-2", final_interview_id: "fi-2" }));
  db.final_interview_bots.push(bot({ status: "waiting_room" }));
  const { result } = await run("recruiter", () => listFinalInterviews(APP), { db });
  assert.equal(result.success, true);
  const byId = Object.fromEntries(result.data.map((r) => [r.id, r.recording]));
  assert.equal(byId["fi-1"].state, "waiting");
  assert.equal(byId["fi-2"].state, "none");
});

test("a ready recording wins and is listed by id only: no path, no URL", async () => {
  const db = seeded();
  db.final_interview_bots.push(bot({ status: "done", provider_recording_id: "vendor-1" }));
  db.final_interview_recordings.push(recording());
  const { result, signs } = await run("recruiter", () => listFinalInterviews(APP), { db });
  const rec = result.data[0].recording;
  assert.equal(rec.state, "ready");
  assert.equal(rec.recordingId, "rec-1");
  assert.equal(rec.recordedAt, "2026-11-05T10:00:00.000Z");
  assert.equal(signs.length, 0, "the list signs nothing");
  const json = JSON.stringify(result);
  assert.ok(!json.includes(PATH) && !json.includes("storage_path") && !json.includes("sign/"));
});

test("after a reschedule, the earlier booking's recording is marked as earlier", async () => {
  const db = seeded();
  db.interview_bookings.push(
    booking({
      id: "b-old",
      status: "cancelled",
      scheduled_start: "2026-11-01T09:00:00.000Z",
      created_at: "2026-10-01T12:00:00.000Z",
    }),
  );
  db.final_interview_bots.push(
    bot({
      id: "bot-old",
      booking_id: "b-old",
      status: "superseded",
      superseded_at: "2026-11-02T00:00:00.000Z",
      provider_recording_id: "vendor-1",
    }),
    bot(),
  );
  db.final_interview_recordings.push(recording());
  const { result } = await run("recruiter", () => listFinalInterviews(APP), { db });
  const rec = result.data[0].recording;
  assert.equal(rec.state, "ready");
  assert.equal(rec.fromEarlierBooking, true);
  assert.equal(rec.recordedAt, "2026-11-01T09:00:00.000Z");
});

test("the recording facts are one company-filtered read per table, however many interviews", async () => {
  const db = seeded();
  for (let i = 2; i <= 6; i++) {
    db.final_interviews.push(interview({ id: `fi-${i}` }));
    db.interview_bookings.push(booking({ id: `b-${i}`, final_interview_id: `fi-${i}` }));
  }
  const { result, service } = await run("recruiter", () => listFinalInterviews(APP), { db });
  assert.equal(result.data.length, 6);
  for (const table of ["final_interview_bots", "final_interview_recordings"]) {
    const reads = service.queries.filter((q) => q.table === table);
    assert.equal(reads.length, 1, table);
    assert.ok(
      reads[0].calls.some((c) => c[0] === "eq" && c[1] === "company_id" && c[2] === CO),
      `${table} is company-filtered`,
    );
    const ids = reads[0].calls.find((c) => c[0] === "in" && c[1] === "final_interview_id")[2];
    assert.equal(ids.length, 6);
  }
  const selected = service.queries
    .filter((q) => q.table === "final_interview_recordings")
    .flatMap((q) => q.calls.filter((c) => c[0] === "select").map((c) => c[1]));
  assert.ok(
    selected.every((cols) => !cols.includes("storage_path")),
    "the list never reads the path",
  );
});

test("a failed recording read is shown as unavailable, never as no recording", async () => {
  for (const failing of [
    "final_interview_bots",
    "final_interview_recordings",
    "interview_bookings",
  ]) {
    const db = seeded();
    db.final_interview_bots.push(bot({ status: "waiting_room" }));
    const { result } = await run("recruiter", () => listFinalInterviews(APP), { db, failing });
    assert.equal(result.success, true, failing);
    assert.equal(result.data[0].recording.state, "unavailable", failing);
  }
});

test("saved then purged reads as deleted; saved with no recording row reads as no longer available", async () => {
  const saved = () =>
    bot({ status: "done", import_status: "ready", provider_recording_id: "vendor-1" });

  const purged = seeded();
  purged.final_interview_bots.push(saved());
  purged.final_interview_recordings.push(
    recording({ status: "deleted", storage_path: null, deleted_by: null }),
  );
  const a = await run("recruiter", () => listFinalInterviews(APP), { db: purged });
  assert.equal(a.result.data[0].recording.state, "deleted");
  assert.equal(a.result.data[0].recording.recordingId, null);

  const missing = seeded();
  missing.final_interview_bots.push(saved());
  const b = await run("recruiter", () => listFinalInterviews(APP), { db: missing });
  assert.equal(b.result.data[0].recording.state, "gone");

  // Rows of every status are read, still company-filtered and without the path.
  const read = b.service.queries.find((q) => q.table === "final_interview_recordings");
  assert.ok(!read.calls.some((c) => c[0] === "eq" && c[1] === "status"), "no status filter");
  assert.ok(read.calls.some((c) => c[0] === "eq" && c[1] === "company_id" && c[2] === CO));
  assert.ok(!read.calls.find((c) => c[0] === "select")[1].includes("storage_path"));
});

test("another company's recording rows never shape this company's card", async () => {
  const db = seeded();
  db.final_interview_bots.push(
    bot({ status: "done", import_status: "ready", provider_recording_id: "vendor-1" }),
  );
  db.final_interview_recordings.push(recording({ company_id: "other" }));
  const { result } = await run("recruiter", () => listFinalInterviews(APP), { db });
  assert.equal(result.data[0].recording.state, "gone", "the other company's ready row is not ours");
});

test("a hiring manager sees the same recording status", async () => {
  const db = seeded();
  db.final_interview_bots.push(bot({ status: "recording" }));
  const { result } = await run("hiring_manager", () => listFinalInterviews(APP), { db });
  assert.equal(result.data[0].recording.state, "recording");
});

/* ── playback ───────────────────────────────────────────────────── */

const withReady = (over = {}) => {
  const db = seeded();
  db.final_interview_recordings.push(recording(over));
  return db;
};

test("every role that can view the candidate may watch: a 3-hour URL, logged, path never returned", async () => {
  for (const role of ["owner", "admin", "recruiter", "hiring_manager"]) {
    const { result, db, signs } = await run(role, () => getFinalRecordingPlayback("rec-1"), {
      db: withReady(),
    });
    assert.equal(result.success, true, role);
    assert.deepEqual(Object.keys(result.data).sort(), ["expiresAt", "url"], role);
    assert.deepEqual(signs, [
      { bucket: FINAL_RECORDING_BUCKET, path: PATH, ttl: FINAL_RECORDING_PLAYBACK_TTL_SECONDS },
    ]);
    assert.equal(FINAL_RECORDING_PLAYBACK_TTL_SECONDS, 3 * 60 * 60);
    assert.deepEqual(
      db.signed_url_logs.map(({ id, created_at, ...r }) => r),
      [
        {
          user_id: "u-viewer",
          candidate_id: APP,
          source_table: "final_interview_recordings",
          was_admin: false,
        },
      ],
    );
    // Only the signed URL carries the key, as Supabase's always do; nothing else does.
    const { url, ...rest } = result.data;
    assert.ok(!JSON.stringify(rest).includes(PATH), role);
  }
});

test("another company's recording is not found, and nothing is signed or logged", async () => {
  const db = seeded();
  db.final_interview_recordings.push(
    recording({
      company_id: "other",
      final_interview_id: "fi-o",
      job_id: "job-o",
      application_id: "app-o",
    }),
  );
  const {
    result,
    signs,
    db: after,
  } = await run("owner", () => getFinalRecordingPlayback("rec-1"), {
    db,
  });
  assert.deepEqual(result, { success: false, error: NOT_FOUND });
  assert.equal(signs.length, 0);
  assert.equal(after.signed_url_logs.length, 0);
});

test("a recording row of another company is refused even when it points at this company's interview", async () => {
  // Only the recording's own company filter stops this one.
  const { result, signs } = await run("owner", () => getFinalRecordingPlayback("rec-1"), {
    db: withReady({ company_id: "other" }),
  });
  assert.deepEqual(result, { success: false, error: NOT_FOUND });
  assert.equal(signs.length, 0);
});

test("a recording that is not ready cannot be watched", async () => {
  for (const status of ["pending", "failed", "deleted"]) {
    const { result, signs, db } = await run("owner", () => getFinalRecordingPlayback("rec-1"), {
      db: withReady({ status }),
    });
    assert.deepEqual(
      result,
      { success: false, error: "This recording isn't ready to watch." },
      status,
    );
    assert.equal(signs.length, 0, status);
    assert.equal(db.signed_url_logs.length, 0, status);
  }
});

test("a viewer without access to the recording's job is refused before anything is signed", async () => {
  const asked = [];
  const { result, signs } = await run("recruiter", () => getFinalRecordingPlayback("rec-1"), {
    db: withReady(),
    canAccessJob: async (_ctx, jobId) => {
      asked.push(jobId);
      return false;
    },
  });
  assert.deepEqual(result, { success: false, error: NOT_FOUND });
  assert.deepEqual(asked, [JOB], "job access is checked on the recording's job");
  assert.equal(signs.length, 0);
});

test("the recording, interview, application and job must agree", async () => {
  const cases = [
    ["recording on another job", (db) => (db.final_interview_recordings[0].job_id = "job-2")],
    ["interview missing", (db) => db.final_interviews.splice(0)],
    [
      "interview for another application",
      (db) => (db.final_interviews[0].application_id = "app-2"),
    ],
    [
      "application in another company",
      (db) => (db.job_applications[0].company_id_snapshot = "other"),
    ],
    ["application on another job", (db) => (db.job_applications[0].job_id = "job-2")],
  ];
  for (const [name, breakIt] of cases) {
    const db = withReady();
    breakIt(db);
    const { result, signs } = await run("owner", () => getFinalRecordingPlayback("rec-1"), { db });
    assert.deepEqual(result, { success: false, error: NOT_FOUND }, name);
    assert.equal(signs.length, 0, name);
  }
});

test("errors are safe sentences: never the path, the bucket or the storage error", async () => {
  const signed = await run("owner", () => getFinalRecordingPlayback("rec-1"), {
    db: withReady(),
    signError: true,
  });
  assert.deepEqual(signed.result, {
    success: false,
    error: "Couldn't load that recording. Try again.",
  });
  assert.ok(!signed.logged.join("\n").includes(PATH), "the path is not logged");
  for (const bad of ["", "x".repeat(101), null, 42]) {
    const r = await run("owner", () => getFinalRecordingPlayback(bad), { db: withReady() });
    assert.deepEqual(r.result, { success: false, error: NOT_FOUND });
  }
  const failed = await run("owner", () => getFinalRecordingPlayback("rec-1"), {
    db: withReady(),
    failing: "final_interview_recordings",
  });
  assert.deepEqual(failed.result, {
    success: false,
    error: "Couldn't load that recording. Try again.",
  });
});
