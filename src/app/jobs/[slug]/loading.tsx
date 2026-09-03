import { WhiteLabelShell } from "@/components/white-label/shell";
import "./job-page.css";

/**
 * Loading state for one job page.
 *
 * ── Why this file exists at all ───────────────────────────────
 *
 * Without it, /jobs/[slug] fell through to /jobs/loading.tsx — the LIST page's
 * skeleton: a hero band and a 3-column card grid, shaped like nothing on this
 * page, and rendered OUTSIDE any white-label canvas. Measured on a client-side
 * navigation from a careers page (scrolled 800px down, click a role):
 *
 *   t≈0.9s  skeleton up · body > footer: display BLOCK, top 491px, 709px tall
 *           in a 1200px viewport · scrollY 709, inherited from the list
 *   t≈4.9s  content swapped in · footer none · scrollY 0
 *
 * So for the whole loading window the dark site footer filled the bottom half
 * of the screen and the user was scrolled into it. "It opens on the footer."
 *
 * The footer is hidden by `body:has([data-wl-canvas]) > footer` — a condition
 * on the CANVAS, not the path — and the list skeleton had no canvas, so nothing
 * could hide it. This skeleton renders inside WhiteLabelShell, so the canvas
 * exists from the first frame and the same rule that hides the footer on the
 * real page hides it here. No path list to keep in sync.
 *
 * ── Deliberately NEUTRAL ──────────────────────────────────────
 *
 * The company's brand preset is data; a loading state renders before data. A
 * brand-coloured hero here would paint Plum for a second and then switch to the
 * company's real colour — worse than painting no colour at all. So: no `.panel`
 * (its background is var(--brand)), no `.mark` (same), no brand text. Surface
 * blocks only, in the real page's positions, so nothing shifts when it lands.
 *
 * ── The one trade-off ─────────────────────────────────────────
 *
 * This boundary also covers a job with no company — the Remotiv editorial page
 * (_remotiv-detail.tsx), which keeps the site footer. During ITS load the
 * canvas here hides that footer, and it appears with the content. Footer late
 * on one page beats footer-first on every white-label page, and the editorial
 * page has no skeleton of its own to be faithful to.
 */
export default function Loading() {
  return (
    <WhiteLabelShell page="job">
      <div role="status" aria-busy="true" aria-label="Loading role" className="wl-skel">
        <header className="chead">
          <div className="wrap">
            <div className="cid">
              <span className="wl-skel-block" style={{ width: 30, height: 30, borderRadius: 8 }} />
              <span className="wl-skel-block" style={{ width: 110, height: 14 }} />
            </div>
          </div>
        </header>

        <section className="hero">
          <div className="wrap">
            {/* The hero's footprint, not its colour. */}
            <div className="wl-skel-block" style={{ height: 300, borderRadius: "var(--r-3xl)" }} />
          </div>
        </section>

        <main>
          <section className="body">
            <div className="wrap">
              <div className="grid">
                <div className="doc">
                  <div className="card">
                    <span className="wl-skel-block" style={{ width: 160, height: 18 }} />
                    <span className="wl-skel-block" style={{ height: 12, marginTop: 18 }} />
                    <span className="wl-skel-block" style={{ height: 12, marginTop: 10 }} />
                    <span
                      className="wl-skel-block"
                      style={{ height: 12, marginTop: 10, width: "72%" }}
                    />
                  </div>
                  <div className="card">
                    <span className="wl-skel-block" style={{ width: 140, height: 18 }} />
                    <span className="wl-skel-block" style={{ height: 12, marginTop: 18 }} />
                    <span className="wl-skel-block" style={{ height: 12, marginTop: 10 }} />
                    <span
                      className="wl-skel-block"
                      style={{ height: 12, marginTop: 10, width: "60%" }}
                    />
                  </div>
                </div>
                <aside className="rail">
                  <div className="card">
                    <span className="wl-skel-block" style={{ width: 120, height: 10 }} />
                    <span className="wl-skel-block" style={{ height: 12, marginTop: 22 }} />
                    <span className="wl-skel-block" style={{ height: 12, marginTop: 10 }} />
                    <span
                      className="wl-skel-block"
                      style={{ height: 12, marginTop: 10, width: "80%" }}
                    />
                  </div>
                  <div className="card">
                    <span className="wl-skel-block" style={{ width: 110, height: 10 }} />
                    <span
                      className="wl-skel-block"
                      style={{ height: 34, marginTop: 18, width: "70%" }}
                    />
                  </div>
                </aside>
              </div>
            </div>
          </section>
        </main>
      </div>
    </WhiteLabelShell>
  );
}
