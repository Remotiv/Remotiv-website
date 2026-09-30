/**
 * Companion to node-resolve.mjs for queue-health.test.ts ONLY.
 *
 * queue-health.ts is a server module: it imports `server-only`, the Supabase
 * server client, and `@/lib/jobs-queue`, which drags the entire handler graph
 * (Anthropic, OpenAI, the transcriber) behind it. None of that is what the test
 * is about. The test is about one thing: a failed read must surface as an
 * error category and never as a healthy zero. So this hook swaps exactly three
 * specifiers for inert stand-ins and lets everything else resolve normally.
 *
 *   server-only            -> an empty module (it throws outside RSC on import)
 *   @/lib/supabase/server  -> createServiceClient that throws if reached; the
 *                             test injects a fake through the module's seam,
 *                             so reaching the real one is itself a failure
 *   @/lib/jobs-queue       -> just the two constants queue-health reads
 *
 * Register this BEFORE node-resolve.mjs, so it sees the bare specifiers first.
 * Test-only. Nothing in the application imports this.
 */

const STUBS = {
  "server-only": "export {};",
  "@/lib/supabase/server":
    'export function createServiceClient() { throw new Error("test: real service client reached; the seam was not installed"); }',
  "@/lib/jobs-queue": [
    "export const LEASE_TIMEOUT_MS = 5 * 60_000;",
    "export const JOB_TYPES = {",
    '  AI_CV_SCORE: "ai_cv_score",',
    '  SEND_MESSAGE: "send_message",',
    '  INTERVIEW_REMINDER: "interview_reminder",',
    '  INTERVIEW_EXPIRY: "interview_expiry",',
    '  TRANSCRIBE: "transcribe",',
    '  AI_SCORECARD: "ai_scorecard",',
    '  CALENDAR_SYNC: "calendar_sync",',
    '  INTERVIEW_PURGE: "interview_purge",',
    '  CV_PURGE: "cv_purge",',
    '  QUEUE_SWEEP: "queue_sweep",',
    "};",
  ].join("\n"),
};

export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) {
    return {
      url: `data:text/javascript,${encodeURIComponent(stub)}`,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
