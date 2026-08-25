import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";
import type { CSSPropertiesWithVars } from "@/lib/css-types";
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

// Nothing here is default-hidden: the CSS only hides what this script is
// there to reveal, and it is gated on @media (scripting: enabled) as well.
// An earlier round hid content on opacity:0 unconditionally and the caption
// stayed invisible wherever the observer never ran.
const REVEAL_SCRIPT = `(function(){
var r=document.querySelectorAll(".avi2-rail[data-reveal]");
var s=function(e){e.classList.add("avi2-in")};
if(!("IntersectionObserver" in window)){r.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.12});
r.forEach(function(e){o.observe(e)});
setTimeout(function(){r.forEach(function(e){
if(!e.classList.contains("avi2-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Sections 1 and 2 of 13. Sections 3-13 are still to design; per the handoff
// they should keep alternating cream and white rather than repeat either
// treatment.
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

        {/* Section 2 of 13 — the product demo, "the rail". White ground
            against the hero's cream. The six stages wrap 3 + 3 rather than
            running across in one row: inside the 1100 container a six-track
            row leaves ~155px per stage, which is about nineteen characters
            of measure. The 3 + 3 wrap puts the tracks at ~300px. */}
        <section className="avi2-sec">
          <div className="avi2-wrap">
            <div className="avi2-slab">
              <div className="avi2-head">
                <div>
                  <p className="avi2-eyeb">
                    <i />
                    Inside Remotiv
                  </p>
                  <h2>
                    Two interviews happen before you spend a{" "}
                    <span className="avi2-stick">minute</span> of your week.
                  </h2>
                  <p className="avi2-lede">
                    Applications arrive, get ranked, and every shortlisted candidate sits an
                    introductory screen and a technical round on your team&apos;s own questions.
                    Remotiv scores the transcripts. Then it stops.
                  </p>
                </div>
                <div className="avi2-count">
                  <div>
                    <b>06</b>
                    <span>stages, end to end</span>
                  </div>
                  <div className="avi2-m">
                    <b>02</b>
                    <span>of them interviews</span>
                  </div>
                  <div>
                    <b>01</b>
                    <span>decision, and it&apos;s yours</span>
                  </div>
                </div>
              </div>

              <div className="avi2-rail" data-reveal>
                <section
                  className="avi2-run avi2-run--one"
                  style={{ "--i": 0 } as CSSPropertiesWithVars}
                >
                  <p className="avi2-plabel">
                    Rank, then the first interview
                    <em>No one on your team has looked yet</em>
                  </p>
                  {/* The rule is two segments: faint across 01-02, bright
                      under 03. Carries no meaning a screen reader can use. */}
                  <div className="avi2-rrow avi2-g3" aria-hidden="true">
                    <b className="avi2-s1" />
                    <b className="avi2-s2 avi2-bright" />
                  </div>
                  <ol className="avi2-stops avi2-g3">
                    <li className="avi2-st">
                      <p className="avi2-st__n">01</p>
                      <h3 className="avi2-st__t">Applications arrive</h3>
                      <p className="avi2-st__d">
                        Every applicant lands in one place, in one format.
                      </p>
                    </li>
                    <li className="avi2-st">
                      <p className="avi2-st__n">02</p>
                      <h3 className="avi2-st__t">AI CV ranking</h3>
                      <p className="avi2-st__d">
                        Ranked against the role you wrote, not against keywords.
                      </p>
                    </li>
                    <li className="avi2-st avi2-st--key">
                      <div className="avi2-box">
                        <div className="avi2-st__meta">
                          <p className="avi2-st__n">03</p>
                          <p className="avi2-badge">
                            <i />
                            Introductory
                          </p>
                        </div>
                        <h3 className="avi2-st__t">Async video screening</h3>
                        <p className="avi2-st__d">
                          Communication and fit, answered in the candidate&apos;s own hours.
                        </p>
                      </div>
                    </li>
                  </ol>
                </section>

                <section
                  className="avi2-run avi2-run--two"
                  style={{ "--i": 1 } as CSSPropertiesWithVars}
                >
                  <p className="avi2-plabel">
                    Scorecard, technical round, decision
                    <em>Ends with a person, not a score</em>
                  </p>
                  <div className="avi2-rrow avi2-g3" aria-hidden="true">
                    <b className="avi2-s1 avi2-bright" />
                    <b className="avi2-s2 avi2-mint" />
                    <s />
                  </div>
                  <ol className="avi2-stops avi2-g3">
                    <li className="avi2-st">
                      <p className="avi2-st__n">04</p>
                      {/* Non-breaking hyphen (U+2011): a plain one lets the
                          title break into three lines in a 300px track. */}
                      <h3 className="avi2-st__t">Evidence&#8209;backed scorecard</h3>
                      <p className="avi2-st__d">Every score carries the moment it came from.</p>
                    </li>
                    <li className="avi2-st avi2-st--key">
                      <div className="avi2-box">
                        <div className="avi2-st__meta">
                          <p className="avi2-st__n">05</p>
                          <p className="avi2-badge">
                            <i />
                            Technical
                          </p>
                        </div>
                        <h3 className="avi2-st__t">AI video interview</h3>
                        <p className="avi2-st__d">
                          Your team&apos;s questions, asked the same way of every candidate.
                        </p>
                      </div>
                    </li>
                    <li className="avi2-st avi2-st--dest">
                      <div className="avi2-box">
                        <div className="avi2-st__meta">
                          <p className="avi2-st__n">06</p>
                          <p className="avi2-badge">
                            <i />
                            Human
                          </p>
                        </div>
                        <h3 className="avi2-st__t">Human decision</h3>
                        <p className="avi2-st__d">
                          A person on your team decides. No candidate is ever auto-rejected.
                        </p>
                      </div>
                    </li>
                  </ol>
                </section>

                <div className="avi2-artrow">
                  <div className="avi2-fragcol">
                    <div className="avi2-frag">
                      <p className="avi2-frag__tag">
                        Ayesha Karim<s>·</s>Senior Backend Engineer
                      </p>
                      <div className="avi2-frag__row">
                        <p>Systems design</p>
                        <div className="avi2-bar">
                          <i style={{ width: "88%" }} />
                        </div>
                        <b>88</b>
                      </div>
                      <div className="avi2-frag__row">
                        <p>Async communication</p>
                        <div className="avi2-bar avi2-bar--amber">
                          <i style={{ width: "79%" }} />
                        </div>
                        <b>79</b>
                      </div>
                      <div className="avi2-frag__ev">
                        <p>
                          &ldquo;We were paging twice a week, so I moved retries onto an idempotent
                          queue. Alerts went to zero and stayed there for two quarters.&rdquo;
                        </p>
                        <em>Systems design · 04:12 · transcript</em>
                      </div>
                      {/* Load-bearing disclosure, not decoration. */}
                      <div className="avi2-frag__foot">
                        <p>
                          <b>Recommendation only.</b> Transcript is the only input — no face, voice,
                          or accent analysis.
                        </p>
                        <button className="avi2-adjust" type="button">
                          <i />
                          Adjust
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="avi2-cap">
                    <b>Stage 04, redrawn</b>
                    <p>
                      The scorecard your team opens after each interview — with the transcript
                      sitting behind every number.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      {/* Entrance observer. Raw inline script rather than next/script so the
          page stays a server component — the same pattern as the JSON-LD in
          src/app/join-as-talent/layout.tsx. The 2.2s timeout is a safety net
          for the case where the observer never fires but the rail is already
          on screen; without IntersectionObserver everything just shows. */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 2 entrance observer
        dangerouslySetInnerHTML={{ __html: REVEAL_SCRIPT }}
      />
    </>
  );
}
