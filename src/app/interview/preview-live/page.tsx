import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LIVE_CONSENT, LIVE_INTERVIEW_CONSENT_VERSION } from "@/lib/interviews/live-consent";
import "../interview.css";
import "../live-interview.css";
import type { LiveConsentView } from "../[token]/_live/screens";
import { PreviewLive } from "./_preview-live";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Video Interview preview",
  robots: { index: false, follow: false },
};

const COMPANY = "Acme Ltd";

/**
 * The live candidate screen with MockVoxAgent and no database (AVI commit
 * 10), for the real-browser demo: camera, microphone, an interruption, the
 * video pieces, a dropped connection and every ending.
 *
 * Development only: a production build answers 404. Nothing here reads or
 * writes the database, and nothing leaves the browser: consent, the start,
 * the reports and the video pieces go to an in-memory stand-in for the
 * server (_preview-live.tsx). The company, the job and every word the mock
 * interviewer says are made up.
 *
 * The consent text is the DRAFT live text, placeholders included: it is not
 * final, which is why real live interviews stay closed.
 */
export default function PreviewLivePage() {
  if (process.env.NODE_ENV === "production") notFound();
  const fill = (s: string) => s.replaceAll("{company}", COMPANY);
  const consent: LiveConsentView = {
    heading: LIVE_CONSENT.heading,
    intro: LIVE_CONSENT.intro,
    rows: LIVE_CONSENT.rows.map((r) => ({ lead: r.lead, body: fill(r.body) })),
    smallPrint: LIVE_CONSENT.smallPrint,
    checkbox: LIVE_CONSENT.checkbox,
    version: LIVE_INTERVIEW_CONSENT_VERSION,
  };
  return <PreviewLive company={COMPANY} consent={consent} />;
}
