/**
 * One read for the Applicants view (#41): the list, the top scored, the
 * counts and the flagged count that one change asks for travel in ONE server
 * action call instead of four or five.
 *
 * Why: Next.js runs server actions from a page one at a time, each starting
 * only when the previous one has answered, and every action pays its own
 * sign-in, company and job-scope reads before its query. A job switch asked
 * for five in a row (counts, flagged, list, top scored, then the panel), so it
 * cost the SUM of five. fetchApplicantsView runs the same four reads in one
 * Promise.all on the server, inside one request, where the context and the
 * scope are read once (both are cache()d per request). Each read is the
 * unchanged action function, with its own checks.
 *
 * The batcher keeps the client exactly as it was: every effect still asks for
 * its own part and gets its own promise, and its sequence guards, retries and
 * failure states are untouched. What changes is only that the parts asked for
 * in the same commit (one job switch: counts, flagged, list and top) are
 * gathered on a microtask and sent together. A part the server could not
 * produce rejects that part's promise, the same failure its caller already
 * handles; a call that fails outright rejects every part in it.
 *
 * Pure apart from queueMicrotask, so view-batch.test.ts drives it directly.
 */
import type {
  ApplicantCounts,
  CompanyApplicantPage,
  CompanyApplicantQuery,
  CompanyApplicantRow,
} from "@/app/ai-dashboard/lib/applicant-types";
import type { Read } from "@/lib/supabase/read";

/** At most the shown job's counts and the company's: the hero and the tabs. */
export const VIEW_COUNTS_MAX = 2;

export type ApplicantsViewRequest = {
  list?: CompanyApplicantQuery;
  top?: CompanyApplicantQuery;
  counts?: CompanyApplicantQuery[];
  flagged?: CompanyApplicantQuery;
};

/** One part's outcome: its own Read, or `{ threw: true }` when its read threw. */
export type ViewPart<T> = { threw: false; read: Read<T> } | { threw: true } | null;

export type ApplicantsViewResult = {
  list: ViewPart<CompanyApplicantPage>;
  top: ViewPart<CompanyApplicantRow[]>;
  counts: ViewPart<ApplicantCounts>[];
  flagged: ViewPart<number>;
};

type Waiter = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };
type Pending = {
  request: ApplicantsViewRequest;
  list?: Waiter;
  top?: Waiter;
  counts: Waiter[];
  flagged?: Waiter;
};

const settle = (part: ViewPart<unknown> | undefined, w: Waiter | undefined) => {
  if (!w) return;
  if (!part || part.threw) w.reject(new Error("view part failed"));
  else w.resolve(part.read);
};

export function createViewBatcher(
  send: (request: ApplicantsViewRequest) => Promise<ApplicantsViewResult>,
) {
  let pending: Pending | null = null;

  const flush = (batch: Pending) => {
    if (pending === batch) pending = null;
    send(batch.request).then(
      (result) => {
        settle(result.list, batch.list);
        settle(result.top, batch.top);
        batch.counts.forEach((w, i) => {
          settle(result.counts[i], w);
        });
        settle(result.flagged, batch.flagged);
      },
      (err) => {
        for (const w of [batch.list, batch.top, ...batch.counts, batch.flagged]) w?.reject(err);
      },
    );
  };

  /** The batch this part joins: the open one, unless it already holds this kind. */
  const batchFor = (kind: "list" | "top" | "counts" | "flagged"): Pending => {
    const full =
      pending &&
      (kind === "counts" ? pending.counts.length >= VIEW_COUNTS_MAX : pending[kind] !== undefined);
    if (!pending || full) {
      const batch: Pending = { request: {}, counts: [] };
      pending = batch;
      queueMicrotask(() => flush(batch));
    }
    return pending as Pending;
  };

  const ask = <T>(
    kind: "list" | "top" | "flagged",
    query: CompanyApplicantQuery,
  ): Promise<Read<T>> =>
    new Promise<Read<T>>((resolve, reject) => {
      const batch = batchFor(kind);
      batch.request[kind] = query;
      batch[kind] = { resolve: resolve as (v: unknown) => void, reject };
    });

  return {
    list: (query: CompanyApplicantQuery) => ask<CompanyApplicantPage>("list", query),
    top: (query: CompanyApplicantQuery) => ask<CompanyApplicantRow[]>("top", query),
    flagged: (query: CompanyApplicantQuery) => ask<number>("flagged", query),
    counts: (query: CompanyApplicantQuery) =>
      new Promise<Read<ApplicantCounts>>((resolve, reject) => {
        const batch = batchFor("counts");
        batch.request.counts = [...(batch.request.counts ?? []), query];
        batch.counts.push({ resolve: resolve as (v: unknown) => void, reject });
      }),
  };
}
