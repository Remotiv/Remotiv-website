import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";
import "./ai-video-interviews.css";

// Route-specific metadata. Kept in page.tsx rather than a sibling layout:
// the layouts on /about, /jobs and friends exist to host BreadcrumbList
// JSON-LD alongside the metadata, and this page has none to host — it is
// noindex, so structured data would have nothing to feed.
export const metadata: Metadata = {
  title: "AI Video Interviews — Remotiv",
  description: "Screen candidates with structured, AI-assisted video interviews.",
  // Canonical path is relative; Next.js resolves it against `metadataBase`
  // (set in src/app/layout.tsx).
  alternates: { canonical: "/ai-video-interviews" },
  // Deliberately noindex while this page is under construction.
  // REMOVE THIS, add navbar + footer links, and add the route to
  // sitemap.ts before launch.
  robots: { index: false, follow: false },
};

// Section 1 of 13. Sections 2-13 are still to design; per the handoff they
// should alternate cream and white rather than repeat this treatment.
export default function AIVideoInterviewsPage() {
  return (
    <>
      <Navbar />
      <main id="main">
        <section className="avi-hero" data-bg="grid">
          {/* Four background treatments ship together and are switched by the
              data-bg attribute on .avi-hero, so the choice stays reversible
              without a rebuild: grid (shipped), scale, rules, none. */}
          <div className="avi-bg" aria-hidden="true">
            <div className="avi-bg-grid" />
            <div className="avi-bg-rules" />
            <div className="avi-bg-scale">
              <div className="avi-bg-tk" />
              <div className="avi-bg-tk5" />
              <div className="avi-bg-base" />
              <div className="avi-bg-riser" />
              <div className="avi-bg-mk" />
              <div className="avi-bg-flag">86</div>
              <div className="avi-bg-num" style={{ left: "34px" }}>
                0
              </div>
              <div className="avi-bg-num" style={{ left: "50%" }}>
                50
              </div>
              <div className="avi-bg-num" style={{ right: "34px" }}>
                100
              </div>
            </div>
          </div>

          <div className="avi-inner">
            <div className="avi-grid">
              <div>
                <div className="avi-eyebrow">
                  <i />
                  AI Video Interviews
                </div>
                <h1>
                  Your team shouldn&rsquo;t spend its <span className="avi-stick">week</span> on
                  first-round screening.
                </h1>
                <p className="avi-sub">
                  Remotiv ranks applications, runs structured interviews with shortlisted
                  candidates, and turns every candidate into a recruiter-ready, evidence-backed
                  scorecard — all in one workflow. Your hiring team makes the final decision.
                </p>
                {/* The handoff points these at /early-access and /demo, but
                    neither route exists. Both anchor to the early-access form
                    planned for this same page — repoint them when it lands. */}
                <div className="avi-ctas">
                  <a className="avi-btn-primary" href="#early-access">
                    Join Early Access<em>→</em>
                  </a>
                  <a className="avi-btn-secondary" href="#early-access">
                    Book a Demo
                  </a>
                </div>
                {/* Each phrase owns its trailing middot so a separator can
                    never begin a wrapped line. Do not join these into one
                    " · " string. */}
                <p className="avi-trust">
                  <span className="avi-trust-item">
                    Transcript-only evaluation
                    <span className="avi-d">&nbsp;·</span>
                  </span>{" "}
                  <span className="avi-trust-item">
                    Evidence behind every score
                    <span className="avi-d">&nbsp;·</span>
                  </span>{" "}
                  <span className="avi-trust-item">No automated rejection</span>
                </p>
              </div>

              <div className="avi-stack">
                <div className="avi-sheet" aria-hidden="true" />
                <div className="avi-sheet avi-sheet--front" aria-hidden="true" />
                <div className="avi-rankchip">
                  Ranked 1 of 128<em>Top match</em>
                </div>
                <article className="avi-sc" aria-label="Candidate scorecard">
                  <div className="avi-sc-top">
                    <div className="avi-sc-av">AK</div>
                    <div>
                      <div className="avi-sc-name">Ayesha Karim</div>
                      <div className="avi-sc-role">Senior Backend Engineer · Remote, UTC+5</div>
                    </div>
                    <div className="avi-sc-score">
                      <b>86</b>
                      <span>Overall</span>
                    </div>
                  </div>
                  <div className="avi-sc-crit">
                    <div className="avi-crow">
                      <p>Systems design</p>
                      <div className="avi-bar">
                        <i style={{ width: "88%" }} />
                      </div>
                      <b>88</b>
                    </div>
                    <div className="avi-crow">
                      <p>Debugging under pressure</p>
                      <div className="avi-bar">
                        <i style={{ width: "84%" }} />
                      </div>
                      <b>84</b>
                    </div>
                    <div className="avi-crow">
                      <p>Async communication</p>
                      <div className="avi-bar avi-bar--amber">
                        <i style={{ width: "79%" }} />
                      </div>
                      <b>79</b>
                    </div>
                  </div>
                  <div className="avi-sc-ev">
                    <p className="avi-sc-ev-label">
                      Evidence<span className="avi-sep">·</span>Systems design
                      <span className="avi-sep">·</span>04:12
                    </p>
                    <p className="avi-sc-ev-quote">
                      &ldquo;We were paging twice a week, so I moved retries onto an idempotent
                      queue. Alerts went to zero and stayed there for two quarters.&rdquo;
                    </p>
                  </div>
                  <div className="avi-sc-foot">
                    <p>
                      <b>Recommendation only.</b> Your team can adjust or override any score.
                    </p>
                    <button className="avi-sc-override" type="button">
                      <i />
                      Adjust
                    </button>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
