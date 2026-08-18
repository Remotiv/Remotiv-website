/* ============================================================================
 * Remotiv — per-job Open Graph card (1200 x 630, Next.js ImageResponse / Satori)
 * Visual basis: the approved remotiv_og_card.jsx design. Adapted here to fetch
 * real job data by slug, format salary currency-aware (matching the page), and
 * fail safe — a missing/closed job OR a failed font fetch still returns an image.
 *
 * SATORI RULES honored: inline styles + flexbox only (no grid), every element
 * with >1 child has display:flex, no external images/SVG, solid colors only.
 * ========================================================================== */

import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { publiclyVisible } from "@/lib/jobs";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "edge";
export const alt = "Remotiv job";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Props = { params: Promise<{ slug: string }> };

type MinimalRow = {
  title: string;
  company: string;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  work_type: string;
  status: string;
};

type FontEntry = {
  name: string;
  data: ArrayBuffer;
  weight: 600 | 700 | 800;
  style: "normal";
};

// ---- BRAND ----------------------------------------------------------------
const C = {
  purple: "#7E47FF",
  purpleLight: "#9886FE",
  purpleTint: "#E2DBFB",
  lime: "#D9F972",
  limeInk: "#2C3D05",
  mint: "#49D7A7",
  ink: "#241F38",
  white: "#FFFFFF",
};

// Title auto-sizing so a long {JOB_TITLE} still fits on max 2 lines.
function titleSize(title: string) {
  const n = title.length;
  if (n <= 16) return 96;
  if (n <= 24) return 84;
  if (n <= 34) return 70;
  return 58;
}

// Currency-aware salary, matching the page's fmtSalary (k-abbreviation).
// Returns null when both bounds are missing → the salary chip is omitted.
function fmtSalary(
  min: number | null,
  max: number | null,
  currency: string | null,
): string | null {
  const cur = (currency ?? "").trim().toUpperCase() || "USD";
  const k = (n: number) => {
    if (n >= 1000) {
      const v = n / 1000;
      return `${Number.isInteger(v) ? v : v.toFixed(1)}k`;
    }
    return n.toLocaleString("en-US");
  };
  if (min != null && max != null) {
    return min === max ? `${cur} ${k(min)}` : `${cur} ${k(min)}–${k(max)}`;
  }
  if (min != null) return `${cur} from ${k(min)}`;
  if (max != null) return `${cur} up to ${k(max)}`;
  return null;
}

/* Fetch a single Google Font weight as raw font data for Satori.
 * (Pulls the woff/ttf URL out of the CSS, then fetches the binary.) */
async function loadGoogleFont(
  family: string,
  weight: number,
): Promise<ArrayBuffer> {
  const css = await (
    await fetch(
      `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
    )
  ).text();
  const url = css.match(/src: url\((.+?)\) format/)?.[1];
  if (!url) throw new Error(`Could not load font ${family} ${weight}`);
  return (await fetch(url)).arrayBuffer();
}

// Load all brand fonts. Any failure → null, so the card renders with the
// next/og built-in fallback font instead of throwing.
async function loadBrandFonts(): Promise<FontEntry[] | null> {
  try {
    const [sora700, sora800, dm600] = await Promise.all([
      loadGoogleFont("Sora", 700),
      loadGoogleFont("Sora", 800),
      loadGoogleFont("DM+Sans", 600),
    ]);
    return [
      { name: "Sora", data: sora700, weight: 700, style: "normal" },
      { name: "Sora", data: sora800, weight: 800, style: "normal" },
      { name: "DM Sans", data: dm600, weight: 600, style: "normal" },
    ];
  } catch {
    return null;
  }
}

function renderCard(opts: {
  title: string;
  meta: string[];
  salary: string | null;
  fonts: FontEntry[] | null;
}) {
  const { title, meta, salary, fonts } = opts;

  const metaNodes: ReactNode[] = [];
  meta.forEach((part, i) => {
    if (i > 0) {
      metaNodes.push(
        <span
          key={`sep-${part}`}
          style={{ display: "flex", margin: "0 14px", color: C.purpleLight }}
        >
          •
        </span>,
      );
    }
    metaNodes.push(
      <span key={`part-${part}`} style={{ display: "flex" }}>
        {part}
      </span>,
    );
  });

  return new ImageResponse(
    <div
      style={{
        position: "relative",
        width: "1200px",
        height: "630px",
        background: C.purple,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "60px",
        color: C.white,
        fontFamily: "Sora",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", top: -160, right: -120, width: 460, height: 460, borderRadius: 999, background: C.lime, opacity: 0.14, display: "flex" }} />
      <div style={{ position: "absolute", bottom: -140, left: -100, width: 360, height: 360, borderRadius: 999, background: C.mint, opacity: 0.1, display: "flex" }} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <span style={{ fontFamily: "Sora", fontWeight: 800, fontSize: 40, letterSpacing: -1 }}>remotiv</span>
          <div style={{ width: 11, height: 11, borderRadius: 999, background: C.mint, marginLeft: 5, marginBottom: 9, display: "flex" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", background: C.lime, borderRadius: 999, padding: "11px 22px" }}>
          <div style={{ width: 11, height: 11, borderRadius: 999, background: C.limeInk, marginRight: 9, display: "flex" }} />
          <span style={{ fontFamily: "Sora", fontWeight: 700, fontSize: 22, color: C.limeInk, letterSpacing: 1.5 }}>NOW HIRING</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontFamily: "Sora", fontWeight: 800, fontSize: titleSize(title), lineHeight: 1.02, letterSpacing: -3, maxWidth: 1000 }}>
          {title}
        </div>

        {meta.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", marginTop: 26, fontFamily: "DM Sans", fontWeight: 600, fontSize: 31, color: C.purpleTint }}>
            {metaNodes}
          </div>
        )}

        {salary && (
          <div style={{ display: "flex", alignItems: "center", marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", background: "rgba(255,255,255,0.14)", border: "2px solid rgba(255,255,255,0.22)", borderRadius: 14, padding: "12px 22px" }}>
              <span style={{ fontFamily: "Sora", fontWeight: 700, fontSize: 30 }}>{salary}</span>
              <span style={{ fontFamily: "DM Sans", fontWeight: 600, fontSize: 24, color: "#D6C8FF", marginLeft: 10, display: "flex" }}>/ month</span>
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", fontFamily: "Sora", fontWeight: 700, fontSize: 34, letterSpacing: -0.5 }}>
        <span style={{ display: "flex" }}>Pakistan’s talent. Hired by</span>
        <div style={{ display: "flex", alignItems: "center", background: C.lime, borderRadius: 9, padding: "4px 14px", marginLeft: 12 }}>
          <span style={{ display: "flex", color: C.limeInk, fontWeight: 800 }}>the world.</span>
        </div>
      </div>
    </div>,
    { ...size, ...(fonts ? { fonts } : {}) },
  );
}

export default async function Image({ params }: Props) {
  const { slug } = await params;

  // Load fonts up-front so both the real card and the fallback are crisp.
  const fonts = await loadBrandFonts();

  let row: MinimalRow | null = null;
  if (slug && slug.trim().length > 0) {
    try {
      const supabase = createServiceClient();
      // Without the visibility gate the card renders a real title and salary
      // for a job whose page 404s — the preview would leak an archived role
      // into any chat or social unfurl that still has the link.
      const { data } = await publiclyVisible(
        supabase
          .from("jobs")
          .select(
            "title, company, location, salary_min, salary_max, salary_currency, work_type, status",
          )
          .eq("slug", slug),
      ).maybeSingle();
      if (data) row = data as MinimalRow;
    } catch {
      row = null;
    }
  }

  // Fail-safe fallback — missing / closed job → branded card, generic copy.
  if (!row) {
    return renderCard({
      title: "Remote roles at Remotiv",
      meta: [],
      salary: null,
      fonts,
    });
  }

  const meta = [row.company, row.work_type, row.location].filter(
    (s) => s && s.trim().length > 0,
  );
  const salary = fmtSalary(row.salary_min, row.salary_max, row.salary_currency);

  return renderCard({ title: row.title.trim(), meta, salary, fonts });
}
