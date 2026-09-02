import type { Metadata } from "next";
import Link from "next/link";
import { Navbar } from "@/components/navbar";

/**
 * Remotiv's privacy policy.
 *
 * ── Written from the code, not from a template ───────────────
 *
 * Every retention period, third party and storage claim below was read out of
 * the implementation, and the two purge jobs that enforce the periods are real
 * and run daily. That is the whole point: a policy that misdescribes an
 * enforced rule is worse than none, because it is the document someone would
 * be shown if they ever asked what we did with their CV.
 *
 * If you change a retention constant, a bucket's visibility, or add a
 * processor, this page is part of that change. The specific things it commits
 * us to:
 *
 *   CV_RETENTION_MONTHS = 24        src/app/api/apply/route.ts
 *   RETENTION_MONTHS    = 6         src/lib/interviews/tokens.ts
 *   cv-purge / interview-purge      scheduled every 24h by jobs-queue.ts
 *   `cvs` + interview buckets       private; signed URLs; signed_url_logs
 *
 * NOT white-label. A company's careers page links here, and it still says
 * Remotiv — because Remotiv is the processor holding the data, whoever the
 * candidate thinks they are applying to.
 */

export const metadata: Metadata = {
  title: "Privacy Policy — Remotiv",
  description:
    "What personal data Remotiv collects, where it is stored, how long it is kept, and who else receives it.",
  alternates: { canonical: "/privacy" },
};

/** Shown at the top. Update whenever the substance below changes. */
const LAST_UPDATED = "2 September 2026";

const CONTACT = "talent@remotiv.work";

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-14 mb-4 font-heading text-[1.45rem] font-extrabold tracking-[-0.02em] text-[#111]">
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-8 mb-3 font-heading text-[1.05rem] font-bold text-[#111]">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 text-[0.98rem] leading-[1.75] text-[#3f3f46]">{children}</p>;
}

function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mb-4 flex list-disc flex-col gap-2 pl-5 text-[0.98rem] leading-[1.7] text-[#3f3f46]">
      {children}
    </ul>
  );
}

/** A claim we want to be impossible to skim past. */
function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-6 rounded-2xl border border-remotiv-purple/20 bg-remotiv-purple/[0.04] px-5 py-4 text-[0.95rem] leading-[1.7] text-[#3f3f46]">
      {children}
    </div>
  );
}

function Mail() {
  return (
    <a
      href={`mailto:${CONTACT}`}
      className="font-medium text-remotiv-purple underline underline-offset-2"
    >
      {CONTACT}
    </a>
  );
}

export default function PrivacyPage() {
  return (
    <>
      <Navbar />
      <main className="bg-white px-6 pb-24 pt-28 lg:px-10">
        <article className="mx-auto w-full max-w-[720px]">
          <p className="mb-3 text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-remotiv-purple">
            Privacy
          </p>
          <h1 className="font-heading text-[clamp(2.1rem,5vw,2.9rem)] font-extrabold leading-[1.1] tracking-[-0.035em] text-[#111]">
            Privacy Policy
          </h1>
          <p className="mt-4 text-[0.9rem] text-[#71717a]">Last updated {LAST_UPDATED}</p>

          <P>
            This policy describes what Remotiv actually does with personal data — what we collect,
            where it is stored, how long we keep it, and who else receives it. It was written from
            the system itself rather than from a template, and the retention periods below are
            enforced automatically by jobs that run every day.
          </P>
          <P>
            It applies wherever you meet us: remotiv.work, a job posting, and the careers pages we
            host for the companies hiring through us. Those pages carry the company&apos;s branding,
            but Remotiv holds and processes the data, so this is the policy that governs it.
          </P>

          <H2>Who we are</H2>
          <P>
            Remotiv (National Tax Number 7921044-0) is the business responsible for the data
            described here. Our registered address is Colabs Gulberg, 50-N Gurumangat Road, Block N,
            Gulberg II, Lahore, Pakistan. For anything in this policy, write to <Mail />.
          </P>

          <H2>1. What we collect, and where it comes from</H2>

          <H3>When you apply for a job</H3>
          <P>
            Through an application form on remotiv.work or a company careers page we host, we
            collect your first and last name, email address, phone number, LinkedIn profile URL
            (which is required), your CV, your answers to any screening questions the role asks, and
            the details you give about your city and country, years of experience, notice period and
            availability.
          </P>
          <Callout>
            <strong className="font-semibold text-[#111]">
              We store the full text of your CV, not just the file.
            </strong>{" "}
            When you upload a CV we extract its contents to text and store that in our database
            alongside the document, so it can be searched and read by the automated scoring
            described in section 7. Both the file and the extracted text are deleted together when
            the retention period ends.
          </Callout>

          <H3>When you record a video interview</H3>
          <P>
            We record video and audio of your answers, generate a written transcript of each one,
            and store how long you spoke and when. We also record the moment you acknowledge the
            screen shown before recording starts, so there is a record of what you were told and
            when.
          </P>

          <H3>When you contact us</H3>
          <P>
            Our contact form collects your name, email address, company and message. Our meeting
            booking form collects your name, email address, company, the service you are interested
            in, your message and your preferred time.
          </P>

          <H3>Automatically, when you browse</H3>
          <P>
            When you arrive from a tagged link — an ad or a social post — we record the campaign
            details in that link, the website you came from, and the page you landed on. If you go
            on to apply, that information is attached to your application so we know which channel
            it came from. We do not build advertising profiles and we do not sell this or any other
            data.
          </P>

          <H3>From companies hiring through us</H3>
          <P>
            Employers using our hiring product create accounts, and may connect a Google Calendar so
            interview times can be booked. The permission we request covers calendar events. To find
            free slots we deliberately use only Google&apos;s free/busy view, which returns blocks
            of busy time with no titles, attendees or descriptions attached — we do not read the
            contents of anyone&apos;s meetings, and the only events we create are the interviews
            themselves.
          </P>

          <H2>2. Where it is stored, and who can reach it</H2>
          <P>
            All of it is stored with Supabase, our database and file-storage provider, on
            infrastructure they operate. Files are separated by how sensitive they are.
          </P>
          <UL>
            <li>
              <strong className="font-semibold text-[#111]">CVs and interview recordings</strong>{" "}
              are held in private storage. They have no public web address and cannot be opened by
              anyone who has not been authorised. Each view generates a short-lived link for that
              one view only. When a company or Remotiv staff open a CV or a recording, we record
              that access — who opened which document, and when. Opening your own CV from your own
              profile is not logged.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">Profile photos</strong>, if you add one
              to a talent profile, and company logos are held in public storage, because they are
              displayed on public pages.
            </li>
          </UL>
          <P>
            Inside the product, the company that posted a role can see the applications to that
            role. Remotiv staff can also access candidate records in order to operate and support
            the service. Access of that kind to a CV or a recording is recorded.
          </P>

          <H2>3. How long we keep it</H2>
          <P>
            Two automatic deletion jobs run every day and enforce the periods below. They are not a
            statement of intent; they are code that deletes.
          </P>

          <H3>CVs sent to a company: 24 months</H3>
          <P>
            When you apply to a role posted by a company hiring through Remotiv, an expiry date is
            set on your CV at the moment you apply, 24 months out. When it passes, both the CV file
            and the extracted text of it are deleted.
          </P>
          <P>
            The application record itself is kept: your name, email, the role you applied for, the
            stage you reached and the decisions made. The company keeps its hiring record; it stops
            holding your document.
          </P>

          <H3>Interview recordings: 6 months</H3>
          <P>
            Video recordings and their transcripts are deleted six months after the interview is
            issued. As with CVs, the record of the interview survives the media: the questions you
            were asked, how long you spoke and when, but not the recording or the transcript.
          </P>

          <H3>CVs in the Remotiv talent pool: kept until you ask us to remove them</H3>
          <Callout>
            <strong className="font-semibold text-[#111]">
              These do not expire on a timer, and we want to be direct about it.
            </strong>{" "}
            If you joined our talent network, or applied to one of Remotiv&apos;s own listings
            rather than a client company&apos;s, your CV is kept indefinitely — it is how we match
            you to future roles. The 24-month deletion above deliberately does not apply to it. If
            you would rather we did not hold it, email <Mail /> and we will remove it.
          </Callout>

          <H3>Everything else</H3>
          <P>
            Contact form messages, booking requests, account records and application records are
            kept while they remain useful to the hiring or business relationship they belong to. We
            do not currently apply an automatic expiry to them.
          </P>

          <H2>4. Why we are allowed to process it</H2>
          <P>
            Data-protection law asks us to have a specific reason for each thing we do with your
            data, not a general one. Ours are:
          </P>
          <UL>
            <li>
              <strong className="font-semibold text-[#111]">
                Handling your application and passing it to the employer
              </strong>{" "}
              — because you asked us to, as a step towards a possible contract of employment.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">
                Scoring CVs and interview answers, with a human deciding
              </strong>{" "}
              — our legitimate interest in assessing candidates consistently and at scale. The human
              decision described in section 7 is part of what makes this fair rather than automated.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">Recording video interviews</strong>
              {" — "}
              our legitimate interest in assessing candidates consistently. Before any recording
              starts, we show you what is recorded, who will see it, how long it is kept, and that a
              person makes the decision — and we record your acknowledgement of that, with a
              timestamp.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">Emailing you about a role</strong> — our
              legitimate interest in progressing an application you started. Every such email
              carries an unsubscribe link.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">
                Answering contact and booking enquiries
              </strong>{" "}
              — our legitimate interest in replying to someone who wrote to us.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">
                Security, rate limiting and access logs
              </strong>{" "}
              — our legitimate interest in keeping the service and your data secure, and in some
              cases a legal obligation to keep records.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">
                Keeping your CV in the Remotiv talent pool
              </strong>{" "}
              — your consent, given by joining the network so that we can match you to future roles.
              You can withdraw it at any time by emailing <Mail />.
            </li>
          </UL>

          <H2>5. Where in the world your data goes</H2>
          <P>
            Your data does not stay in your country. We are based in Pakistan; our systems and
            providers are not, and we would rather say so directly than bury it.
          </P>
          <UL>
            <li>
              <strong className="font-semibold text-[#111]">Japan</strong> — our database and all
              file storage, including CVs and interview recordings, are hosted by Supabase in their
              Tokyo region.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">United States</strong> — interview audio
              sent to OpenAI for transcription, CV text and transcripts sent to Anthropic for
              scoring, and email sent through Resend.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">Global</strong> — Google, for interview
              calendar events, and Meta, where WhatsApp invitations are enabled. Both operate
              internationally.
            </li>
          </UL>
          <P>
            Where the law of your country requires a safeguard for transfers of this kind, we rely
            on the standard contractual protections offered by these providers. If you want to know
            more about a particular one, email <Mail />.
          </P>

          <H2>6. Who else receives it</H2>
          <P>
            We do not sell personal data and we do not share it for advertising. We use the
            following providers to run the service, and each receives only what its job requires.
          </P>
          <UL>
            <li>
              <strong className="font-semibold text-[#111]">Supabase</strong> — our database, file
              storage and login system. Holds everything described above.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">OpenAI</strong> — receives the audio of
              your video interview answers in order to transcribe them.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">Anthropic</strong> — receives the text
              of your CV and the transcripts of your interview answers, together with the
              requirements of the role, in order to produce the scores described in section 7.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">Resend</strong> — our email provider.
              Receives your email address and the contents of the messages we send you.
            </li>
            <li>
              <strong className="font-semibold text-[#111]">Google</strong> — when an employer has
              connected a calendar, we create interview events, which include the interview time and
              the participants.
            </li>
            <li>
              {/* The separator is a string literal, not a bare space + dash: with a
                  plain space here the formatter reshapes the line and JSX drops the
                  space, rendering "Meta (WhatsApp)— where". The other five items in
                  this list are unaffected; this one wraps differently. */}
              <strong className="font-semibold text-[#111]">Meta (WhatsApp)</strong>
              {" — "}
              where WhatsApp messaging is enabled for a role, we send interview invitations through
              it, which means Meta receives your first name and phone number along with the
              company&apos;s name.
            </li>
          </UL>

          <Callout>
            <strong className="font-semibold text-[#111]">
              About the audio we send to OpenAI, plainly:
            </strong>{" "}
            we send it under OpenAI&apos;s standard API terms. OpenAI{" "}
            <strong className="font-semibold text-[#111]">
              does not use API data to train its models by default
            </strong>
            , and under standard API retention data may be held for up to 30 days for abuse
            monitoring, unless different retention controls apply to our account. Our own six-month
            deletion covers our copy of your recording and transcript; it does not reach theirs.
            Their handling is governed by their policy, not this one.
          </Callout>

          <H2>7. How AI is used, exactly</H2>
          <P>
            We use AI to read and score applications. Specifically: the text of your CV is scored
            against the requirements of the role, and your interview answers are transcribed and
            scored against a written rubric. Those scores are stored on your application, and they
            are used to rank candidates and to flag some for closer attention.
          </P>
          <P>
            A person makes every hiring decision. Nothing in our system automatically rejects,
            advances or hires anyone on the strength of a score — the scores order and highlight a
            list that a human then reads. A reviewer can also override a score, and we keep a record
            of when that happens.
          </P>
          <P>
            <strong className="font-semibold text-[#111]">
              Remotiv does not make solely automated hiring decisions.
            </strong>{" "}
            No outcome that affects you is produced by a machine alone. We are describing this
            precisely because &ldquo;AI-assisted&rdquo; can mean anything from a spellcheck to an
            automatic rejection. Ours produces a number that affects the order you appear in and
            whether you are flagged. It does not decide the outcome.
          </P>

          <H2>8. Your choices, and what actually happens</H2>

          <H3>Unsubscribing from emails</H3>
          <P>
            Every email we send about a role carries an unsubscribe link that works without logging
            in. It stops that company&apos;s emails to you. Because each company hiring through
            Remotiv is separate, unsubscribing from one does not unsubscribe you from another — you
            can use the link in each company&apos;s email.
          </P>

          <H3>Access, correction and deletion</H3>
          <Callout>
            <strong className="font-semibold text-[#111]">
              There is no self-serve way to delete your data, and we are not going to pretend
              otherwise.
            </strong>{" "}
            Email <Mail /> and a person will handle it. That is the whole mechanism today. We will
            confirm what we hold, correct it, or delete it. If you are asking us to delete something
            a company still needs as a record of a hiring decision, we will tell you what we can and
            cannot remove and why, rather than quietly doing half of it.
          </Callout>
          <P>
            Depending on where you live you may have rights over your personal data under laws such
            as the GDPR — to see it, correct it, have it deleted, or object to how it is used. The
            address above is how you exercise any of them with us.
          </P>

          <H2>9. When a company is hiring through us</H2>
          <P>
            If you applied through a careers page carrying a company&apos;s branding, both that
            company and Remotiv hold your application. The company decides who to hire; we provide
            the system that stores and processes the data, under this policy. The company may keep
            its own records outside our system, which are governed by that company&apos;s own
            privacy practices, not this page. If you want to reach them, contact them directly; if
            you want to reach us, use <Mail />.
          </P>

          <H2>10. Security</H2>
          <P>
            Data is encrypted in transit. CVs and interview recordings are held in private storage
            and reachable only through short-lived, individually generated links. Access by a
            company or by Remotiv staff is recorded. Using the hiring product requires an account,
            and each company can see only its own candidates.
          </P>

          <H2>11. Children</H2>
          <P>
            Remotiv is a service for working professionals. We do not ask your age and we have no
            way to verify it, so we are not going to claim we prevent anyone under 16 from applying.
            What we can say is that we do not knowingly collect data from children, and that if you
            tell us we are holding a child&apos;s data we will delete it. Email <Mail />.
          </P>

          <H2>12. Changes to this policy</H2>
          <P>
            If we change what we collect, how long we keep it, or who receives it, we will update
            this page and the date at the top. The retention periods stated here are enforced in
            code, so a change to them is a change to the system, not only to this document.
          </P>

          <H2>13. Contact</H2>
          <P>
            For anything in this policy — access, correction, deletion, or a question about what we
            hold — email <Mail />. For anything else, our{" "}
            <Link
              href="/contact"
              className="font-medium text-remotiv-purple underline underline-offset-2"
            >
              contact page
            </Link>{" "}
            is the place to start.
          </P>
        </article>
      </main>
    </>
  );
}
