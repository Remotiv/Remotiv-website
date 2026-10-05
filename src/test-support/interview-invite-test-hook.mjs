/**
 * Companion to node-resolve.mjs for the interview invite allowance tests ONLY.
 *
 * sendInterviewInvite resolves its own company context, builds its own
 * database client and sends through the shared email path, so fakes cannot be
 * passed in. This hook swaps exactly these specifiers and lets everything else
 * - the action, the allowance module, the Karachi helpers, the token minting -
 * load as is:
 *
 *   server-only                           -> an empty module
 *   next/cache                            -> revalidatePath that does nothing
 *   @/lib/supabase/server                 -> createServiceClient returning
 *                                            globalThis.__inviteServiceForTests()
 *   @/app/ai-dashboard/lib/company-guards -> getCompanyContext returning
 *                                            globalThis.__inviteCtxForTests
 *   @/app/ai-dashboard/lib/job-scope      -> canAccessJob returning true
 *   @/lib/email/candidate/deliver         -> deliverEmail calling
 *                                            globalThis.__inviteDeliverForTests
 *   @/lib/jobs-queue                      -> enqueue calling
 *                                            globalThis.__inviteEnqueueForTests
 *   @/lib/interviews/live-settings        -> gateLiveInterviewInvite returning
 *                                            globalThis.__inviteLiveGateForTests
 *   @/lib/interviews/reminder             -> the reminder lead only
 *
 * Each stub throws when its fake is not installed, so a real client, a real
 * email or a real queue can never be reached by accident. Register this AFTER
 * node-resolve.mjs: Node calls the most recently registered hook first, and
 * this one has to see the bare specifiers.
 *
 * Test-only. Nothing in the application imports this.
 */

const missing = (what) =>
  `throw new Error("test: no fake ${what} installed; the real one must not be reached");`;

const fromGlobal = (name, what) =>
  [`  const fake = globalThis.${name};`, `  if (!fake) ${missing(what)}`].join("\n");

const STUBS = {
  "server-only": "export {};",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": [
    "export function createServiceClient() {",
    fromGlobal("__inviteServiceForTests", "service"),
    "  return fake();",
    "}",
  ].join("\n"),
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function getCompanyContext() {",
    fromGlobal("__inviteCtxForTests", "company context"),
    "  return fake;",
    "}",
  ].join("\n"),
  "@/app/ai-dashboard/lib/job-scope": "export async function canAccessJob() { return true; }",
  "@/lib/email/candidate/deliver": [
    "export function buildCandidateHtml(body) { return body; }",
    "export async function deliverEmail(service, input) {",
    fromGlobal("__inviteDeliverForTests", "email delivery"),
    "  return fake(input);",
    "}",
  ].join("\n"),
  "@/lib/jobs-queue": [
    "export const JOB_TYPES = {",
    '  SEND_MESSAGE: "send_message",',
    '  INTERVIEW_REMINDER: "interview_reminder",',
    '  INTERVIEW_EXPIRY: "interview_expiry",',
    "};",
    "export async function enqueue(job) {",
    fromGlobal("__inviteEnqueueForTests", "queue"),
    "  return fake(job);",
    "}",
  ].join("\n"),
  "@/lib/interviews/live-settings": [
    "export async function gateLiveInterviewInvite() {",
    fromGlobal("__inviteLiveGateForTests", "live gate"),
    "  return fake;",
    "}",
  ].join("\n"),
  "@/lib/interviews/reminder": "export const REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;",
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
