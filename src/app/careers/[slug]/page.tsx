import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { WhiteLabelShell } from "@/components/white-label/shell";
import { canonicalUrl } from "@/lib/seo";
import { displayHost, getCareersData, websiteHref } from "./_data";
import { CHEVRON_DOWN, EXTERNAL, Icon } from "./_icons";
import { RolesIndex } from "./_roles-index";
import "./careers.css";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const data = await getCareersData(slug);

  if (!data) {
    return { title: "Careers — not found", robots: { index: false, follow: false } };
  }

  const { company, roles } = data;
  const title = `Careers — ${company.name}`;
  const description =
    company.description ??
    `Open roles at ${company.name}. ${roles.length} ${roles.length === 1 ? "position" : "positions"} live now.`;
  const url = `/careers/${company.slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: company.name,
      locale: "en_US",
      type: "website",
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
  };
}

/**
 * The company's own careers page.
 *
 * Every value comes from the company's record and its published jobs. No
 * imagery of any kind — the only raster is the uploaded logo, and where there
 * is none the mark falls back to a lettermark rather than a blank square.
 *
 * The Remotiv navbar is deliberately absent: the design carries its own sticky
 * company header, and the site footer is suppressed for this segment in
 * FooterWrapper so the "Hiring powered by Remotiv · Privacy" line below is the
 * only one on the page.
 */
export default async function CareersPage({ params }: PageProps) {
  const { slug } = await params;
  const data = await getCareersData(slug);
  if (!data) notFound();

  const { company, roles, categories } = data;
  const host = company.website ? displayHost(company.website) : null;
  const href = company.website ? websiteHref(company.website) : null;
  const count = roles.length;

  const mark = company.logoUrl ? (
    // biome-ignore lint/performance/noImgElement: a Supabase public URL on a per-tenant bucket path — next/image would need every company's host allow-listed, and this is a 30px mark, already the page's only raster.
    <img src={company.logoUrl} alt={`${company.name} logo`} decoding="async" />
  ) : (
    company.initials
  );

  const jobPostingLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `Careers — ${company.name}`,
    url: canonicalUrl(`/careers/${company.slug}`),
    about: { "@type": "Organization", name: company.name, url: href ?? undefined },
  };

  return (
    <WhiteLabelShell>
      <header className="chead">
        <div className="wrap">
          <div className="cid">
            <div className="mark">{mark}</div>
            <span className="cname">{company.name}</span>
          </div>
          <div className="hnav">
            {host && href && (
              <a className="wsite" href={href} target="_blank" rel="noopener noreferrer">
                {host}
                <Icon d={EXTERNAL} />
              </a>
            )}
            {count > 0 && (
              <a className="tobtn" href="#roles">
                Open roles<b>{count}</b>
              </a>
            )}
          </div>
        </div>
      </header>

      <section className="mast">
        <div className="wrap">
          <div className="panel">
            <div className="top">
              <p className="eyebrow">Careers</p>
              {host && href && (
                <a className="psite" href={href} target="_blank" rel="noopener noreferrer">
                  {host}
                  <Icon d={EXTERNAL} />
                </a>
              )}
            </div>

            <h1>{company.name}</h1>

            {/* Removed entirely when there is no description — never left as an
                empty paragraph holding open a gap. */}
            {company.description && <p className="lede">{company.description}</p>}

            <div className="cta">
              {count > 0 ? (
                <>
                  <a className="btn onbrand" href="#roles">
                    See {count} open {count === 1 ? "role" : "roles"}
                    <Icon d={CHEVRON_DOWN} />
                  </a>
                  {host && href && (
                    <a
                      className="btn onbrand-g"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      About {company.short}
                      <Icon d={EXTERNAL} />
                    </a>
                  )}
                </>
              ) : (
                host &&
                href && (
                  <a className="btn onbrand" href={href} target="_blank" rel="noopener noreferrer">
                    Visit {host}
                    <Icon d={EXTERNAL} />
                  </a>
                )
              )}
            </div>

            {/*
              The design's five cells, in its order: Hiring · Teams · Team size
              · Based in · Founded. Four can be answered — the first two from the
              published jobs, the next two from Settings. FOUNDED is omitted: no
              column feeds it, and adding one nobody fills would put an empty
              field in Settings to produce a cell that is always absent.

              A cell with no value is ABSENT, never em-dashed. "Team size —"
              tells a candidate less than not raising the subject, and the
              four-column grid is content-led by design — the reference's own
              no-roles state renders three cells into it.
            */}
            <dl className="rail">
              <div>
                <dt>Hiring</dt>
                <dd>
                  {count > 0 ? (
                    <>
                      <span className="dot" />
                      {count} open {count === 1 ? "role" : "roles"}
                    </>
                  ) : (
                    "Not right now"
                  )}
                </dd>
              </div>
              {categories.length > 0 && (
                <div>
                  <dt>Teams</dt>
                  <dd>
                    {categories.length} {categories.length === 1 ? "team" : "teams"}
                  </dd>
                </div>
              )}
              {company.teamSize && (
                <div>
                  <dt>Team size</dt>
                  <dd>{company.teamSize}</dd>
                </div>
              )}
              {company.location && (
                <div>
                  <dt>Based in</dt>
                  <dd>{company.location}</dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      </section>

      <main>
        <section className="roles">
          <div className="wrap">
            {count === 0 ? (
              <div className="card empty">
                <div className="mark">{mark}</div>
                <h3>No open roles right now</h3>
                <p>
                  {company.name} isn&apos;t hiring at the moment. New roles are published here
                  first, so it&apos;s worth checking back.
                </p>
                {host && href && (
                  <a className="btn ghost" href={href} target="_blank" rel="noopener noreferrer">
                    Visit {host}
                    <Icon d={EXTERNAL} />
                  </a>
                )}
              </div>
            ) : (
              <>
                <RolesIndex roles={roles} categories={categories} />
                <div className="closer">
                  <div>
                    <h3>Nothing that fits yet?</h3>
                    <p>
                      {company.short} keeps every application on file, and new roles are posted here
                      first.
                    </p>
                  </div>
                  {host && href && (
                    <a className="btn ghost" href={href} target="_blank" rel="noopener noreferrer">
                      Visit {host}
                      <Icon d={EXTERNAL} />
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap">
          <span>
            © {new Date().getFullYear()} {company.name}
          </span>
          {/* Legally load-bearing — no state may hide this line. */}
          <p className="pw">
            {/* The line is legally load-bearing and stays whole. "Privacy" is
                TEXT, not a link, because this app has no /privacy route — a
                404 behind a legal notice is worse than the design's stub, and
                inventing the page is not this build's call. Flagged in the
                report as a gap to close. */}
            Hiring powered by <Link href="/">Remotiv</Link> · Privacy
          </p>
        </div>
      </footer>

      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires raw JSON injection
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jobPostingLd).replace(/</g, "\\u003c"),
        }}
      />
    </WhiteLabelShell>
  );
}
