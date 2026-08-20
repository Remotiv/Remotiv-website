import type { Metadata } from "next";
import { BookingClient } from "./_booking-client";

export const dynamic = "force-dynamic";

/**
 * Public interview booking. No login — the token is the authorisation.
 *
 * ── Why the slots are fetched by the CLIENT, not here ────────
 *
 * Availability depends on the candidate's timezone, and the server cannot know
 * it: there is no session, and a Vercel geo header is a guess about a network
 * rather than a fact about a person. Rendering times server-side would mean
 * rendering them in the SERVER's zone and hoping — which is exactly the
 * failure this whole feature is built to avoid.
 *
 * So the shell renders immediately and the client asks for slots once it has
 * read `Intl.DateTimeFormat().resolvedOptions().timeZone`, which is the
 * browser's own answer and correctable by the candidate.
 */
export const metadata: Metadata = {
  title: "Book your interview — Remotiv",
  // A booking link is a private URL. Keep it out of every index.
  robots: { index: false, follow: false },
};

export default async function BookingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <BookingClient token={token} />;
}
