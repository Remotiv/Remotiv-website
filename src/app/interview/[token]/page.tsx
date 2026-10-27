import type { Metadata } from "next";
import { liveConsentScreen } from "@/lib/interviews/live-consent";
import { liveWelcomeFacts } from "@/lib/interviews/live-screen";
import { resolveSessionByToken } from "@/lib/interviews/session";
import "../interview.css";
import "../live-interview.css";
import { InterviewFlow } from "./_flow";
import { LiveInterviewFlow } from "./_live/live-flow";
import { TerminalScreen, InterviewShell } from "./_terminal";

export const dynamic = "force-dynamic";

/**
 * The candidate's interview.
 *
 * Public, no login — the token in the URL is the only credential, so
 * everything rendered here is derived from the SESSION server-side and
 * nothing is taken from the client. `resolveSessionByToken` already withholds
 * video paths, rubrics, competencies and weights; this page never sees them
 * either.
 *
 * Terminal states are resolved HERE, before the flow renders, so an expired or
 * submitted link never mounts a recorder at all.
 */

export const metadata: Metadata = {
  title: "Video interview",
  // A link forwarded into a group chat should not put the candidate's name or
  // the company's role into a search index.
  robots: { index: false, follow: false },
};

export default async function InterviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolveSessionByToken(token);

  // An unknown token and a malformed one are indistinguishable on purpose:
  // the page must not confirm which interview links exist.
  if (!resolved) {
    return (
      <InterviewShell>
        <TerminalScreen kind="invalid" />
      </InterviewShell>
    );
  }

  const { session } = resolved;

  /*
   * An AI Video Interview, on the live screen (AVI commit 10): only behind
   * LIVE_INTERVIEW_SCREEN_ENABLED, and only while it can still start. The
   * page gets the interviewer's name and the time limit (liveWelcomeFacts:
   * those two fields only) and how many questions, never the questions. The consent text is null while it has a
   * placeholder, and then the screen stops at "This interview isn't open yet".
   */
  if (session.state === "live" && session.live) {
    const facts = await liveWelcomeFacts(resolved.row.id);
    return (
      <LiveInterviewFlow
        token={token}
        companyName={session.companyName}
        companyInitial={session.companyInitial}
        jobTitle={session.jobTitle}
        interviewer={facts.interviewerName}
        minutes={facts.minutes}
        questionCount={session.live.questionCount}
        consent={liveConsentScreen(session.companyName)}
      />
    );
  }

  if (session.state !== "ready") {
    return (
      <InterviewShell
        companyName={session.companyName}
        companyInitial={session.companyInitial}
        jobTitle={session.jobTitle}
      >
        <TerminalScreen
          kind={session.state === "live" ? "unavailable" : session.state}
          companyName={session.companyName}
          expiresAt={session.expiresAt}
          submittedAt={session.submittedAt}
        />
      </InterviewShell>
    );
  }

  // A job with no questions is a configuration mistake on the company's side,
  // not something to hand the candidate a broken recorder for.
  if (session.questions.length === 0) {
    return (
      <InterviewShell
        companyName={session.companyName}
        companyInitial={session.companyInitial}
        jobTitle={session.jobTitle}
      >
        <TerminalScreen kind="no-questions" companyName={session.companyName} />
      </InterviewShell>
    );
  }

  return <InterviewFlow token={token} session={session} />;
}
