import Link from "next/link";
import { displayHost, websiteHref } from "@/components/white-label/company";
import { WhiteLabelShell } from "@/components/white-label/shell";
import type { Job } from "@/lib/jobs";
import { canonicalUrl } from "@/lib/seo";
import ApplyButton from "./_apply-button";
import type { JobCompany } from "./_company-data";
import { fmtSalary, serializeJsonLd, splitLines, timeAgo, toPublicJob } from "./_format";
import { ShareRole } from "./_share";
import "./job-page.css";

/**
 * A COMPANY's job page — the approved white-label design.
 *
 * Reached only when the job carries a company_id and that company is active.
 * Remotiv's own jobs render the editorial page instead; see RemotivJobDetail.
 *
 * No imagery of any kind. The only raster is the company's uploaded logo, and
 * where there is none the mark falls back to a lettermark rather than a blank
 * square — the same rule in the header, the hero and the about card.
 *
 * The retired structures stay retired: no 1.85fr/1fr hero split, no .hcard
 * role-summary card. The masthead rail replaced both.
 */

/**
 * Fixed design copy, not sample data.
 *
 * The four steps are the same for every company because the process is
 * Remotiv's, not theirs — and step 2 is this product's recorded interview, so
 * the copy describes what actually happens rather than a placeholder.
 *
 * The numerals are REAL MARKUP below, never a CSS counter: `counter(s,
 * decimal-leading-zero)` in Sora with tabular-nums draws the zero and the digit
 * on top of each other.
 */
const HIRING_STEPS = [
  { lead: "Apply", rest: "— a short form and your CV, about five minutes." },
  {
    lead: "Recorded intro",
    rest: "— a few questions you answer on video, whenever suits you.",
  },
  { lead: "Two conversations", rest: "— one with the team, one on craft." },
  { lead: "Decision", rest: "— every applicant gets an answer within a week." },
];

const ARROW = "M4 12h15M13 6l6 6-6 6";
const BACK = "M20 12H5M11 18l-6-6 6-6";

function Icon({ d }: { d: string }) {
  return (
    // Decorative: every icon sits beside its own text label.
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export function CompanyJobDetail({
  job,
  company,
  total,
}: {
  job: Job;
  company: JobCompany;
  total: number;
}) {
  const responsibilities = splitLines(job.responsibilities);
  const requirements = splitLines(job.requirements);
  const description = (job.description ?? "").trim();
  const salary = fmtSalary(job.salary_min, job.salary_max, job.salary_currency);
  const shareUrl = canonicalUrl(`/jobs/${job.slug}`);
  const applyJob = toPublicJob(job) as Job;

  // Every careers link is gated on the slug together: a company with none has
  // no careers page, and a link labelled "All roles at X" that lands on the
  // Remotiv board would be a lie about whose page it is.
  const careersHref = company.slug ? `/careers/${company.slug}` : null;
  const short = company.name.split(/\s+/)[0] || company.name;
  const host = company.website ? displayHost(company.website) : null;
  const href = company.website ? websiteHref(company.website) : null;

  const mark = company.logoUrl ? (
    // biome-ignore lint/performance/noImgElement: a Supabase public URL on a per-tenant bucket path — next/image would need every company's host allow-listed, and these are 26–34px marks, the page's only raster.
    <img src={company.logoUrl} alt={`${company.name} logo`} decoding="async" />
  ) : (
    company.initials
  );

  const jobPostingLd = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description: description || `${job.title} at ${company.name}.`,
    datePosted: job.created_at,
    employmentType: job.contract_type,
    hiringOrganization: { "@type": "Organization", name: company.name, url: href ?? undefined },
    jobLocationType: job.work_type === "Remote" ? "TELECOMMUTE" : undefined,
    applicantLocationRequirements: { "@type": "Country", name: job.location },
    url: shareUrl,
  };

  return (
    <WhiteLabelShell page="job">
      <header className="chead">
        <div className="wrap">
          <div className="cid">
            <div className="mark">{mark}</div>
            <span className="cname">{company.name}</span>
          </div>
          {careersHref && (
            <Link className="allroles" href={careersHref}>
              All roles at {short}
              <Icon d={ARROW} />
            </Link>
          )}
        </div>
      </header>

      <section className="hero">
        <div className="wrap">
          <div className="panel">
            <div className="top">
              {careersHref && (
                <p className="crumb">
                  <Link href={careersHref}>
                    <Icon d={BACK} />
                    All roles at {company.name}
                  </Link>
                </p>
              )}
              <div className="pco">
                <div className="mark">{mark}</div>
                <span>{company.name}</span>
              </div>
            </div>

            <h1>{job.title}</h1>

            <div className="hact">
              <ApplyButton job={applyJob} className="btn onbrand">
                <Icon d={ARROW} />
              </ApplyButton>
              <span className="meta">
                Posted {timeAgo(job.created_at)}
                {total > 0 && ` · ${total} applicant${total === 1 ? "" : "s"}`}
              </span>
            </div>

            {/* Salary · Team · Location · Level. fmtSalary says "Competitive"
                rather than leaving the cell blank when a job carries no figure —
                the rail is four cells by design and a gap reads as a fault. */}
            <dl className="mrail">
              <div>
                <dt>Salary</dt>
                <dd>{salary}</dd>
              </div>
              <div>
                <dt>Team</dt>
                <dd>{job.category}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>{job.location}</dd>
              </div>
              <div>
                <dt>Level</dt>
                <dd>
                  {job.experience_level} · {job.contract_type}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <main>
        <section className="body">
          <div className="wrap">
            <div className="grid">
              <div className="doc">
                {description && (
                  <div className="card">
                    <h2>About the role</h2>
                    {splitLines(description).map((para) => (
                      <p key={para}>{para}</p>
                    ))}
                  </div>
                )}

                {responsibilities.length > 0 && (
                  <div className="card">
                    <h2>What you&apos;ll do</h2>
                    <ul>
                      {responsibilities.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {requirements.length > 0 && (
                  <div className="card">
                    <h2>What we&apos;re looking for</h2>
                    <ul>
                      {requirements.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="card">
                  <h2>How we hire</h2>
                  <ol className="steps">
                    {HIRING_STEPS.map((step, i) => (
                      <li key={step.lead}>
                        {/* Real markup, single digit, no leading zero. */}
                        <span className="n">{i + 1}</span>
                        <span>
                          <b>{step.lead}</b> {step.rest}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <aside className="rail">
                <div className="card">
                  <p className="eyebrow">About the company</p>
                  <div className="rname">
                    <div className="mark">{mark}</div>
                    <p>{company.name}</p>
                  </div>

                  {/* Removed entirely with no description — never left as a gap
                      for the facts to sit under. */}
                  {company.description && <p className="about">{company.description}</p>}

                  <ul className="facts">
                    {company.location && (
                      <li>
                        <span>Based in</span>
                        <b>{company.location}</b>
                      </li>
                    )}
                    {company.teamSize && (
                      <li>
                        <span>Team size</span>
                        <b>{company.teamSize}</b>
                      </li>
                    )}
                    {host && href && (
                      <li>
                        <span>Website</span>
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {host}
                        </a>
                      </li>
                    )}
                    <li>
                      <span>Open roles</span>
                      <b>{company.otherRoles + 1}</b>
                    </li>
                  </ul>

                  {careersHref && (
                    <Link className="rlink" href={careersHref}>
                      {company.otherRoles > 0
                        ? `See all ${company.otherRoles + 1} roles`
                        : "Visit careers page"}
                      <Icon d={ARROW} />
                    </Link>
                  )}
                </div>

                <div className="card">
                  <p className="eyebrow">Share this role</p>
                  <ShareRole url={shareUrl} subject={`${job.title} at ${company.name}`} />
                </div>
              </aside>
            </div>
          </div>
        </section>

        <section className="close">
          <div className="wrap">
            <div className="card">
              <div>
                <h3>Interested in this role?</h3>
                <p>Five minutes to apply. Every applicant hears back within a week.</p>
              </div>
              <ApplyButton job={applyJob} className="btn">
                <Icon d={ARROW} />
              </ApplyButton>
            </div>
            {careersHref && (
              <p className="other">
                {company.otherRoles > 0 ? (
                  <>
                    Not quite right?{" "}
                    <Link href={careersHref}>
                      See all {company.otherRoles + 1} open roles at {company.name}
                    </Link>
                  </>
                ) : (
                  <>
                    This is the only role open right now.{" "}
                    <Link href={careersHref}>Visit the {company.name} careers page</Link>
                  </>
                )}
              </p>
            )}
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap">
          <span>
            © {new Date().getFullYear()} {company.name}
          </span>
          {/* Legally load-bearing — no state may hide this line. "Privacy" is
              text rather than a link because this app has no /privacy route; a
              404 behind a legal notice is worse than no link. */}
          <p className="pw">
            Hiring powered by <Link href="/">Remotiv</Link> · Privacy
          </p>
        </div>
      </footer>

      {/* Below 640 only. The footer gains 88px of bottom padding at the same
          breakpoint so this cannot cover the Remotiv line. */}
      <div className="stick">
        <span className="st">{job.title}</span>
        <ApplyButton job={applyJob} className="btn" label="Apply" />
      </div>

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires raw JSON injection
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jobPostingLd) }}
      />
    </WhiteLabelShell>
  );
}
