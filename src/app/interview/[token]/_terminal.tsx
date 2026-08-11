import { Check, SquareCheckBig, Clock, TriangleAlert } from "lucide-react";

/**
 * The page frame and the states that sit outside the flow.
 *
 * Terminal screens carry NO progress rail and NO step pill — they are not a
 * step of anything, and showing "Step 5 of 5" over "this link has expired"
 * implies there is something left to do.
 *
 * Every one of them gives a route forward. A candidate on this page has no
 * support channel, no account and no way to contact us; a dead end here is a
 * person who assumes they have been rejected.
 */

export function InterviewShell({
  companyName,
  companyInitial,
  jobTitle,
  children,
}: {
  companyName?: string;
  companyInitial?: string;
  jobTitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="iv">
      <div className="iv-wrap">
        <div className="iv-sheet">
          {/* The COMPANY leads. Remotiv is the trust layer in the footer —
              this is Acme's interview and Remotiv is the infrastructure. */}
          {companyName && (
            <div className="flex items-center gap-3 px-0.5 pb-[18px] pt-[22px]">
              <span className="iv-sora flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--purple-tint)] text-lg font-extrabold tracking-[-0.03em] text-[var(--purple-ink)]">
                {companyInitial ?? companyName[0]?.toUpperCase() ?? "?"}
              </span>
              <div className="min-w-0">
                <p className="m-0 text-[14.5px] font-bold leading-tight tracking-[-0.01em] text-[var(--t1)]">
                  {companyName}
                </p>
                {jobTitle && (
                  <p className="m-0 mt-0.5 text-[12.5px] leading-tight text-[var(--t3)]">
                    {jobTitle}
                  </p>
                )}
              </div>
            </div>
          )}

          {children}

          <div className="mt-auto px-0.5 pt-5 text-center">
            <p className="m-0 text-xs leading-relaxed text-[var(--t3)]">
              <span className="inline-flex items-center gap-1.5 font-bold text-[var(--t2)]">
                Powered by{" "}
                <b className="iv-sora font-extrabold tracking-[-0.02em] text-[var(--t1)]">
                  Remotiv<i className="not-italic text-[var(--purple)]">.</i>
                </b>
              </span>
            </p>
            <p className="m-0 mt-1.5 text-xs leading-relaxed text-[var(--t3)]">
              Your recordings are handled by Remotiv on behalf of{" "}
              {companyName ?? "the company"}.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

type TerminalKind =
  | "submitted"
  | "expired"
  | "cancelled"
  | "invalid"
  | "no-questions";

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // The candidate's own timezone, resolved by the browser at render — a
  // deadline stated in ours is a deadline they will miss.
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function TerminalScreen({
  kind,
  companyName,
  expiresAt,
  submittedAt,
}: {
  kind: TerminalKind;
  companyName?: string;
  expiresAt?: string;
  submittedAt?: string | null;
}) {
  const company = companyName ?? "the company";

  if (kind === "submitted") {
    return (
      <div className="iv-card">
        <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
          <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--mint-tint)] text-[var(--mint-ink)]">
            <SquareCheckBig className="size-[34px]" strokeWidth={2.2} />
          </span>
          <h1 className="iv-sora m-0 mb-2.5 text-[23px] font-extrabold leading-tight tracking-[-0.032em] text-[var(--t1)]">
            You&apos;ve already submitted
          </h1>
          <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">
            Your answers were received on{" "}
            <b className="text-[var(--t1)]">{fmtDateTime(submittedAt)}</b>. There&apos;s
            nothing more to do.
          </p>
          <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-[var(--t3)]">
            Answers can&apos;t be changed once submitted. {company}&apos;s team will be
            in touch by email.
          </p>
        </div>
      </div>
    );
  }

  if (kind === "expired") {
    return (
      <div className="iv-card">
        <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
          <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--inset)] text-[var(--t3)]">
            <Clock className="size-[34px]" strokeWidth={2.2} />
          </span>
          <h1 className="iv-sora m-0 mb-2.5 text-[23px] font-extrabold leading-tight tracking-[-0.032em] text-[var(--t1)]">
            This link has expired
          </h1>
          <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">
            The deadline for this interview was{" "}
            <b className="text-[var(--t1)]">{fmtDateTime(expiresAt)}</b>. It&apos;s no
            longer accepting answers.
          </p>
          {/* A dead end here becomes a support ticket nobody receives, so the
              recovery route is stated rather than implied. */}
          <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-[var(--t3)]">
            If you think this is a mistake, or something got in the way, reply to the
            email invitation and {company}&apos;s team can reopen it.
          </p>
        </div>
      </div>
    );
  }

  if (kind === "cancelled") {
    return (
      <div className="iv-card">
        <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
          <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--inset)] text-[var(--t3)]">
            <Clock className="size-[34px]" strokeWidth={2.2} />
          </span>
          <h1 className="iv-sora m-0 mb-2.5 text-[23px] font-extrabold leading-tight tracking-[-0.032em] text-[var(--t1)]">
            This link is no longer active
          </h1>
          <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">
            {company} replaced or withdrew this interview invitation.
          </p>
          <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-[var(--t3)]">
            Check your email for a newer invitation — if there isn&apos;t one, reply to
            the original and their team can send a fresh link.
          </p>
        </div>
      </div>
    );
  }

  if (kind === "no-questions") {
    return (
      <div className="iv-card">
        <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
          <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--amber-tint)] text-[var(--amber-ink)]">
            <TriangleAlert className="size-[34px]" strokeWidth={2.2} />
          </span>
          <h1 className="iv-sora m-0 mb-2.5 text-[23px] font-extrabold leading-tight tracking-[-0.032em] text-[var(--t1)]">
            This interview isn&apos;t ready yet
          </h1>
          <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">
            There are no questions set up for it, so there&apos;s nothing to answer.
          </p>
          <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-[var(--t3)]">
            Nothing has gone wrong on your side. Reply to the email invitation and{" "}
            {company}&apos;s team can finish setting it up.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="iv-card">
      <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
        <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--inset)] text-[var(--t3)]">
          <TriangleAlert className="size-[34px]" strokeWidth={2.2} />
        </span>
        <h1 className="iv-sora m-0 mb-2.5 text-[23px] font-extrabold leading-tight tracking-[-0.032em] text-[var(--t1)]">
          This link isn&apos;t valid
        </h1>
        <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">
          We couldn&apos;t find an interview for this link. It may have been mistyped,
          or only part of it was copied.
        </p>
        <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-[var(--t3)]">
          Open the link straight from your email invitation rather than copying it,
          and if it still doesn&apos;t work, reply to that email.
        </p>
      </div>
    </div>
  );
}

/** Shared by the flow for the unsupported-browser stop. */
export function UnsupportedScreen() {
  return (
    <div className="iv-card">
      <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
        <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--amber-tint)] text-[var(--amber-ink)]">
          <TriangleAlert className="size-[34px]" strokeWidth={2.2} />
        </span>
        <h1 className="iv-sora m-0 mb-2.5 text-[23px] font-extrabold leading-tight tracking-[-0.032em] text-[var(--t1)]">
          This browser can&apos;t record video
        </h1>
        <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">
          Your browser doesn&apos;t support in-page recording, so the interview
          won&apos;t work here.
        </p>
        {/* Named browsers, because "use a modern browser" is not an
            instruction anyone can act on. */}
        <p className="m-0 mt-2.5 text-[13px] leading-relaxed text-[var(--t3)]">
          Open this same link in <b className="text-[var(--t2)]">Chrome</b> on Android
          or desktop, or <b className="text-[var(--t2)]">Safari</b> on iPhone — both
          work. If you&apos;re in an app&apos;s built-in browser (Instagram, LinkedIn,
          Gmail), tap the ⋯ menu and choose &ldquo;Open in browser&rdquo;.
        </p>
      </div>
    </div>
  );
}

/** The mint tick used by inline notices. Exported so the flow shares it. */
export function NoticeCheck() {
  return <Check className="size-[17px] shrink-0" strokeWidth={2} />;
}
