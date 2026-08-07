import type { Metadata } from "next";
import { resolveSessionByToken } from "@/lib/interviews/session";
import "../interview.css";
import { InterviewFlow } from "./_flow";
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

  if (session.state !== "ready") {
    return (
      <InterviewShell
        companyName={session.companyName}
        companyInitial={session.companyInitial}
        jobTitle={session.jobTitle}
      >
        <TerminalScreen
          kind={session.state}
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
