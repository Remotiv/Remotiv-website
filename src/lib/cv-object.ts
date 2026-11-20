/**
 * Is a CV's file really in storage? (#6)
 *
 * Asked of storage itself, never guessed from the row: a row can name a path
 * whose object is gone (23 such applications on production when #6 was
 * raised), and the only honest test is the storage server's answer for that
 * path.
 *
 * Storage answers a missing object with StorageApiError, HTTP 400, statusCode
 * "404", "Object not found" (read on staging, storage-js 2.105.0). Only that
 * answer means "missing". Any other error, or a throw (network, timeout), is
 * "unknown": a CV is never called lost because storage could not be asked.
 *
 * Never logs the path or the error text; callers log their own fixed lines.
 */

type StorageBucket = {
  info(path: string): PromiseLike<{
    data: { size?: number | null } | null;
    error: { status?: number; statusCode?: string } | null;
  }>;
};

export type CvObjectState =
  | { state: "present"; size: number | null }
  | { state: "missing" }
  | { state: "unknown" };

/** Storage's own "no such object" answer, and nothing else. */
export function isObjectMissing(error: { status?: number; statusCode?: string } | null): boolean {
  return Boolean(error && (error.statusCode === "404" || error.status === 404));
}

export async function cvObjectState(bucket: StorageBucket, path: string): Promise<CvObjectState> {
  try {
    const { data, error } = await bucket.info(path);
    if (error) return isObjectMissing(error) ? { state: "missing" } : { state: "unknown" };
    const size = data?.size;
    return {
      state: "present",
      size: typeof size === "number" && Number.isSafeInteger(size) && size > 0 ? size : null,
    };
  } catch {
    return { state: "unknown" };
  }
}

/** What a CV button needs to know: open it, say it is unavailable, or keep the link. */
export type CvAvailability = "available" | "unavailable" | "unknown";

export function availabilityOf(s: CvObjectState): CvAvailability {
  return s.state === "present" ? "available" : s.state === "missing" ? "unavailable" : "unknown";
}

/** The page a missing CV opens to, in the recruiter's terms. */
export const CV_UNAVAILABLE = {
  title: "CV unavailable",
  body: "The CV file for this application is missing, so it can't be opened. The applicant's details and your hiring notes are unaffected.",
} as const;
