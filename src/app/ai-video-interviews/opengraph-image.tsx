import { ImageResponse } from "next/og";

// The homepage card's layout, gradient and type (src/app/opengraph-image.tsx),
// so the two read as the same site; only the copy differs. The card names the
// Async Video Interview, which ships, and nothing that is still in development.
export const runtime = "edge";
export const alt =
  "Remotiv — AI Video Interviews: Async Video Interviews, with evidence behind every score.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        background: "linear-gradient(135deg, #7E47FF 0%, #9886FE 100%)",
        padding: "80px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: 80,
          fontWeight: 800,
          color: "white",
          letterSpacing: "-0.04em",
          marginBottom: 24,
          display: "flex",
        }}
      >
        Remotiv.
      </div>
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          color: "white",
          letterSpacing: "-0.03em",
          lineHeight: 1.1,
          marginBottom: 32,
          maxWidth: 1000,
          display: "flex",
        }}
      >
        AI Video Interviews
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 500,
          color: "rgba(255, 255, 255, 0.85)",
          letterSpacing: "-0.01em",
          maxWidth: 900,
          display: "flex",
        }}
      >
        Async Video Interviews, with evidence behind every score.
      </div>
    </div>,
    {
      ...size,
    },
  );
}
