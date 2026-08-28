import Link from "next/link";
import { WhiteLabelShell } from "@/components/white-label/shell";
import "./careers.css";

/**
 * Reached for an unknown slug, and for a company that is paused or archived.
 *
 * Deliberately says nothing about which: a public page that distinguishes "no
 * such company" from "this company is paused" tells a prober which slugs exist
 * and leaks a customer's account state to anyone who guesses their name.
 *
 * Rendered inside the white-label shell so the canvas, tokens and container are
 * the page's own — a 404 that falls back to Remotiv cream would be the one
 * screen where the tenant's branding visibly breaks.
 */
export default function CareersNotFound() {
  return (
    <WhiteLabelShell>
      <main>
        <section className="roles">
          <div className="wrap">
            <div className="card empty">
              <h3>This careers page isn&apos;t available</h3>
              <p>
                The link may be out of date, or the company may have taken their page down. If
                someone sent you here, ask them for a current link.
              </p>
              <Link className="btn ghost" href="/jobs">
                Browse roles on Remotiv
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap">
          <span>Careers</span>
          <p className="pw">
            Hiring powered by <Link href="/">Remotiv</Link> · Privacy
          </p>
        </div>
      </footer>
    </WhiteLabelShell>
  );
}
