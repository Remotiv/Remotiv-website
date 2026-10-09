/**
 * Companion to node-resolve.mjs for the Final Human Interview action tests.
 *
 * The actions resolve the session, build their own database client, send
 * email and ring the company bell, so none of those can be passed in. This
 * hook swaps exactly:
 *
 *   server-only                            -> an empty module
 *   next/cache                             -> revalidatePath that does nothing
 *   @/lib/supabase/server                  -> createServiceClient returning
 *                                             globalThis.__fiServiceForTests()
 *   @/app/ai-dashboard/lib/company-guards  -> getCompanyContext returning
 *                                             globalThis.__fiCtxForTests
 *   @/app/ai-dashboard/lib/job-scope       -> canAccessJob returning
 *                                             globalThis.__fiCanAccessJob ?? true
 *   @/lib/email/candidate/deliver          -> deliverEmail recording to
 *                                             globalThis.__fiEmails and answering
 *                                             globalThis.__fiDeliverResult
 *   @/lib/email/send                       -> sendEmail recording to __fiHostEmails
 *   @/lib/notifications/company            -> notifyCompany recording to __fiBell
 *   @/lib/calendar/google                  -> an empty module
 *
 * The actions, the booking module, the eligibility rules and the notice
 * builders load as shipped. Register AFTER node-resolve.mjs.
 *
 * Test-only. Nothing in the application imports this.
 */

const need = (name, what) =>
  `const v = globalThis.${name}; if (v === undefined) throw new Error("test: no ${what} installed");`;

const STUBS = {
  "server-only": "export {};",
  "next/cache": "export function revalidatePath() {}",
  "@/lib/supabase/server": [
    "export function createServiceClient() {",
    `  ${need("__fiServiceForTests", "fake service")}`,
    "  return v();",
    "}",
  ].join("\n"),
  "@/app/ai-dashboard/lib/company-guards": [
    "export async function getCompanyContext() {",
    `  ${need("__fiCtxForTests", "company context")}`,
    "  return v;",
    "}",
  ].join("\n"),
  "@/app/ai-dashboard/lib/job-scope": [
    "export async function canAccessJob(ctx, jobId) {",
    "  const f = globalThis.__fiCanAccessJob;",
    "  return f ? f(ctx, jobId) : true;",
    "}",
  ].join("\n"),
  "@/lib/email/candidate/deliver": [
    "export function buildCandidateHtml(body) { return body; }",
    "export async function deliverEmail(service, input) {",
    "  (globalThis.__fiEmails ??= []).push(input);",
    '  return globalThis.__fiDeliverResult ?? { ok: true, logId: "log", providerId: "re" };',
    "}",
  ].join("\n"),
  "@/lib/email/send": [
    "export async function sendEmail(input) {",
    "  (globalThis.__fiHostEmails ??= []).push(input);",
    "  return { ok: true };",
    "}",
  ].join("\n"),
  "@/lib/notifications/company": [
    "export async function notifyCompany(input) {",
    "  (globalThis.__fiBell ??= []).push(input);",
    "}",
  ].join("\n"),
  "@/lib/calendar/google": "export {};",
};

export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) {
    return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
  }
  return next(specifier, context);
}
