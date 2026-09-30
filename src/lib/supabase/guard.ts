/**
 * Whether this process may build a service-role Supabase client.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * The Phase 8 audit found `.env.local` was produced by `vercel env pull` and
 * pointed a developer's laptop at the PRODUCTION project with the service-role
 * key. Nothing in the code cared: `createServiceClient()` built an RLS-bypassing
 * client from whatever the environment said. `next dev` was one keystroke from
 * writing to live customer data.
 *
 * ── The rule, and why it fails CLOSED ────────────────────────
 *
 * In development, a service-role client requires an explicit statement that
 * the configured project is a development one: `SUPABASE_PROJECT_ENV` must be
 * exactly "development". Anything else refuses:
 *
 *   development + "development"              allowed
 *   development + "production"               blocked
 *   development + missing                    blocked
 *   development + any other value            blocked
 *   development + ALLOW_PRODUCTION_DB_FROM_DEV=1   allowed, with a loud warning
 *   production, test, or unset NODE_ENV      normal behaviour, no check
 *
 * "Missing" blocks on purpose. A guard that only blocked on the word
 * "production" would make an unconfigured laptop the permissive case, which is
 * exactly the state the audit found. The variable is set in Vercel per
 * environment scope, so production is never asked for it under NODE_ENV=
 * "development" and a missing value there is always a laptop.
 *
 * The override is for deliberate verification sessions against production,
 * such as the read-only audits. It is loud because the point of the override is
 * that someone chose it on purpose and will see it.
 *
 * ── Pure by design ───────────────────────────────────────────
 *
 * `decideServiceClientAccess` takes the environment as an argument and touches
 * nothing, so it is testable under bare node:test with every combination
 * enumerated. `assertServiceClientAllowed` is the thin impure wrapper the
 * clients call. Neither imports anything from Next or Supabase, so the test
 * needs no resolve hook.
 */

export type GuardEnv = {
  NODE_ENV?: string;
  SUPABASE_PROJECT_ENV?: string;
  ALLOW_PRODUCTION_DB_FROM_DEV?: string;
};

export type GuardDecision =
  | { allowed: true; warning: string | null }
  | { allowed: false; reason: string };

export const OVERRIDE_NAME = "ALLOW_PRODUCTION_DB_FROM_DEV";
export const PROJECT_ENV_NAME = "SUPABASE_PROJECT_ENV";

export function decideServiceClientAccess(env: GuardEnv): GuardDecision {
  // Only a development runtime is guarded. Production runs with
  // NODE_ENV=production and never reaches the checks below, so a missing
  // variable there is harmless by construction.
  if (env.NODE_ENV !== "development") return { allowed: true, warning: null };

  if (env.ALLOW_PRODUCTION_DB_FROM_DEV === "1") {
    return {
      allowed: true,
      warning:
        `[supabase] ${OVERRIDE_NAME}=1 - a service-role client is being built in ` +
        `development WITHOUT the ${PROJECT_ENV_NAME}=development guarantee. Every ` +
        `write this process makes may be against production. Unset the override ` +
        `when the deliberate session is over.`,
    };
  }

  const projectEnv = env.SUPABASE_PROJECT_ENV;
  if (projectEnv === "development") return { allowed: true, warning: null };

  // The reason names the CATEGORY of what was found, never the value: a
  // misconfigured variable could hold anything, and this message reaches logs.
  const found =
    projectEnv === undefined || projectEnv === ""
      ? "is not set"
      : projectEnv === "production"
        ? 'is "production"'
        : "holds an unrecognised value";

  return {
    allowed: false,
    reason:
      `[supabase] Refusing to build a service-role client: NODE_ENV is "development" ` +
      `and ${PROJECT_ENV_NAME} ${found}. Point local development at a development ` +
      `project and set ${PROJECT_ENV_NAME}=development, or set ${OVERRIDE_NAME}=1 ` +
      `for a deliberate session against production.`,
  };
}

/** Warn once per process, not once per client; the client is built constantly. */
let warned = false;

/**
 * Throws when a service-role client must not be built here. Call it before
 * constructing one. Reads `process.env` unless a fake is supplied.
 */
export function assertServiceClientAllowed(
  env: GuardEnv = process.env as GuardEnv,
  log: (message: string) => void = console.warn,
): void {
  const decision = decideServiceClientAccess(env);
  if (!decision.allowed) throw new Error(decision.reason);
  if (decision.warning && !warned) {
    warned = true;
    log(decision.warning);
  }
}

/** Test seam: forget that the warning was already emitted. */
export function resetGuardWarningForTests(): void {
  warned = false;
}
