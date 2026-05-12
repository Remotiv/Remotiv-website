import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Remotiv — Hire Top 1% Senior Engineering Talent";
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
        Hire Top 1% Senior Engineering Talent
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
        Pre-vetted engineers, ready in 24 hours.
      </div>
    </div>,
    {
      ...size,
    },
  );
}
