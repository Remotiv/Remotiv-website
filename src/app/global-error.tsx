"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          textAlign: "center",
          background: "#f8f4f1",
          color: "#111",
          margin: 0,
        }}
      >
        <p
          style={{
            fontSize: "0.875rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "#7E47FF",
            marginBottom: "1rem",
          }}
        >
          Critical Error
        </p>
        <h1
          style={{
            fontSize: "2.5rem",
            fontWeight: 800,
            marginBottom: "1rem",
            maxWidth: "32rem",
            lineHeight: 1.2,
          }}
        >
          Something went seriously wrong.
        </h1>
        <p
          style={{
            fontSize: "1rem",
            color: "#666",
            marginBottom: "2rem",
            maxWidth: "28rem",
          }}
        >
          Please refresh the page. If the problem persists, email us at{" "}
          <a
            href="mailto:talent@remotiv.work"
            style={{ color: "#7E47FF", textDecoration: "underline" }}
          >
            talent@remotiv.work
          </a>
          .
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            background: "#7E47FF",
            color: "white",
            border: "none",
            padding: "0.875rem 1.75rem",
            borderRadius: "9999px",
            fontSize: "0.875rem",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
