/**
 * The launcher (scripts/staging/app.mjs) passes the NAMES it locked to "" in
 * this process, comma-separated. The report says which of them are present
 * anyway. Names only: a value is never read into the response. Null when the
 * app was not started by the launcher, which proveAppIdentity refuses.
 *
 * Lives beside the gate rather than in the route file because a route module
 * may export only its handlers and config.
 */
export const ISOLATION_VAR = "STAGING_ISOLATION_NAMES";

export type IsolationReport = { checked: string[]; present: string[] };

export function isolationReport(env: NodeJS.ProcessEnv = process.env): IsolationReport | null {
  const raw = env[ISOLATION_VAR];
  if (!raw) return null;
  const checked = raw.split(",").filter((n) => n !== "");
  return { checked, present: checked.filter((n) => (env[n] ?? "") !== "") };
}
