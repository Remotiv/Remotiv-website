import { Navbar } from "@/components/navbar";
import { createServiceClient } from "@/lib/supabase/server";
import { hashKeepToken, RETENTION_MONTHS } from "@/lib/talent-retention";

export const dynamic = "force-dynamic";

/**
 * One click, from the retention warning email, to keep a profile.
 *
 * ── Why there is no login ────────────────────────────────────
 *
 * The warning has to make KEEPING the profile the easy action. Putting a
 * password in front of it inverts that: deletion becomes the path of least
 * resistance, and the email stops being a warning and becomes a formality. The
 * bearer token is the credential, exactly as it is for /interview/[token].
 *
 * What it can do is bounded: it sets last_active_at, clears the warning, and
 * burns itself. It cannot read the profile, change it, or show anything about
 * the person — this page names no one, so a forwarded or logged URL leaks
 * nothing.
 *
 * ── Clicking twice is harmless ───────────────────────────────
 *
 * The update matches on the token hash and clears it in the same statement, so
 * the second click matches zero rows. That is reported as "already done" rather
 * than as a failure, because from the reader's side it IS done — their profile
 * is kept either way, and an error page would send them looking for a problem
 * that does not exist.
 *
 * The failure this cannot distinguish from a second click is a genuinely
 * unknown token. Both land on the same reassuring copy, which is the safe
 * direction: the alternative tells a stranger whether a token was ever valid.
 */
export default async function KeepProfilePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const service = createServiceClient();

  /*
   * Match on the hash, clear it in the same write.
   *
   * `last_active_at = now` is literally what the email promises: another
   * RETENTION_MONTHS from today, on the same rolling clock as signing in. The
   * warning stamp is cleared too, so the purge selector stops matching this
   * profile the instant this returns.
   */
  const { data, error } = await service
    .from("talent_profiles")
    .update({
      last_active_at: new Date().toISOString(),
      retention_warned_at: null,
      retention_keep_token_hash: null,
    })
    .eq("retention_keep_token_hash", hashKeepToken(token))
    .select("id");

  if (error) {
    console.error("[talent-keep] update failed:", error.message);
  }
  const kept = !error && (data ?? []).length > 0;

  return (
    <>
      <Navbar />
      <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-6 py-24 text-center">
        <p className="font-heading text-sm font-semibold uppercase tracking-widest text-remotiv-purple">
          Remotiv talent pool
        </p>
        <h1 className="mt-4 font-heading text-3xl font-bold text-gray-900 md:text-4xl">
          {error ? "We couldn't do that just now" : "Your profile is staying"}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-gray-600">
          {error ? (
            <>
              Something went wrong on our side — your profile has not been changed or deleted. Try
              the link again in a moment, or email us at{" "}
              <a className="font-semibold text-remotiv-purple" href="mailto:talent@remotiv.work">
                talent@remotiv.work
              </a>{" "}
              and we&apos;ll sort it out.
            </>
          ) : kept ? (
            <>
              Thanks — we&apos;ll keep it for another {RETENTION_MONTHS} months. Signing in or
              updating anything on your profile starts that again from the day you do it.
            </>
          ) : (
            <>
              This link has already been used, so there&apos;s nothing more to do — your profile is
              being kept. If you meant to remove it instead, email{" "}
              <a className="font-semibold text-remotiv-purple" href="mailto:talent@remotiv.work">
                talent@remotiv.work
              </a>
              .
            </>
          )}
        </p>
      </main>
    </>
  );
}
