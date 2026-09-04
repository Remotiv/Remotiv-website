import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cssUrl } from "@/components/white-label/company";
import { ShareRole } from "@/components/white-label/share";
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
  const read = await getCareersData(slug);

  // "not found" is a claim about the company. A failed read is a claim about
  // us, and must not be dressed as the other. Neither gets indexed.
  if (!read.ok) {
    return { title: "Careers — couldn't load", robots: { index: false, follow: false } };
  }
  const data = read.value;
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
/**
 * Shown when the page could not be READ, never when the company is missing.
 *
 * This is a white-label surface: it names no company — we could not load one —
 * and it names Remotiv nowhere either. Whoever's careers page this is, the
 * visitor should not learn who hosts it from an error state.
 */
function CareersUnavailable() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-6 py-24 text-center">
      <h1 className="font-heading text-2xl font-bold text-gray-900">This page didn't load</h1>
      <p className="mt-3 text-sm leading-relaxed text-gray-600">
        Something went wrong on the way here — the careers page is still there. Refresh, or try
        again in a moment.
      </p>
    </main>
  );
}

export default async function CareersPage({ params }: PageProps) {
  const { slug } = await params;
  const read = await getCareersData(slug);

  // A read failure is not a missing company. notFound() served both, so a live
  // careers page told visitors it did not exist — and a 404 invites nobody to
  // refresh.
  if (!read.ok) return <CareersUnavailable />;

  const data = read.value;
  if (!data) notFound();

  const { company, roles, categories, rolesUnavailable } = data;
  const host = company.website ? displayHost(company.website) : null;
  const href = company.website ? websiteHref(company.website) : null;
  const count = roles.length;

  /*
   * The lettermark is ALWAYS rendered; the logo lays over it (see `.mark .logo`).
   *
   * Not a ternary any more. A logo that is slow or broken used to leave an
   * empty brand-coloured tile, which the handoff explicitly rules out — the
   * initials are the floor, and the logo is an improvement on it rather than a
   * replacement for it.
   *
   * The overlay is decorative and aria-hidden: the initials beneath already
   * carry the company name, and the company name itself is rendered as text
   * beside every one of these marks.
   */
  const mark = (
    <>
      {company.initials}
      {company.logoUrl && (
        <span className="logo" aria-hidden style={{ backgroundImage: cssUrl(company.logoUrl) }} />
      )}
    </>
  );

  const jobPostingLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `Careers — ${company.name}`,
    url: canonicalUrl(`/careers/${company.slug}`),
    about: { "@type": "Organization", name: company.name, url: href ?? undefined },
  };

  return (
    <WhiteLabelShell page="careers" preset={company.preset}>
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
            {rolesUnavailable ? (
              /*
               * Ahead of the empty state, which claims something about the
               * company. This claims something about us, names no company —
               * the masthead above already does — and names Remotiv nowhere.
               */
              <div className="card empty">
                <div className="mark">{mark}</div>
                <h3>We couldn&apos;t load the open roles</h3>
                <p>
                  They&apos;re still there — this is a problem on our side. Reload the page to try
                  again.
                </p>
              </div>
            ) : count === 0 ? (
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

                {/*
                  NOT IN THE HANDOFF — the design gives .share to the job page
                  only, and this page had no share control at all. Added because
                  the careers page is the link a company actually circulates:
                  one URL that stays right as roles open and close, where a job
                  link dies with the role.

                  Same component and same styles as the job page, deliberately.
                  A second, differently-built share row is how the two surfaces
                  drift, which is the failure the shared sheet exists to stop.
                */}
                <div className="cshare">
                  <p className="eyebrow">Share these roles</p>
                  <ShareRole
                    url={canonicalUrl(`/careers/${company.slug}`)}
                    subject={`Open roles at ${company.name}`}
                  />
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
            {/* Legally load-bearing and stays whole. "Privacy" now links to
                /privacy — Remotiv's policy, deliberately NOT white-labelled,
                because Remotiv is the processor holding the data whoever the
                candidate thinks they applied to. It was text while the route
                did not exist. */}
            Hiring powered by <Link href="/">Remotiv</Link> · <Link href="/privacy">Privacy</Link>
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
