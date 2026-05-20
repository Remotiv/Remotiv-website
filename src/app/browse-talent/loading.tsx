export default function Loading() {
  return (
    <div style={{ minHeight: "100vh", background: "#f8f4f1", padding: "32px 16px", fontFamily: "DM Sans, sans-serif" }}>
      {/* Phase 5 C3: two-column layout (240px sidebar + main) to match the
          real page so SSR→hydration doesn't shift content rightward. The
          sidebar collapses to nothing under 1024px via media query below. */}
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "240px 1fr",
          gap: 24,
        }}
        className="bt-loading-grid"
      >
        <aside className="bt-loading-sidebar" style={{ display: "block" }}>
          <div className="animate-pulse" style={{ display: "grid", gap: 10 }}>
            <div style={{ width: "70%", height: 20, background: "#e8e0db", borderRadius: 6 }} />
            <div style={{ width: "100%", height: 14, background: "#f0ebe6", borderRadius: 6 }} />
            <div style={{ width: "85%", height: 14, background: "#f0ebe6", borderRadius: 6 }} />
            <div style={{ width: "95%", height: 14, background: "#f0ebe6", borderRadius: 6 }} />
            <div style={{ width: "60%", height: 14, background: "#f0ebe6", borderRadius: 6 }} />
            <div style={{ height: 8 }} />
            <div style={{ width: "70%", height: 20, background: "#e8e0db", borderRadius: 6 }} />
            <div style={{ width: "100%", height: 14, background: "#f0ebe6", borderRadius: 6 }} />
            <div style={{ width: "80%", height: 14, background: "#f0ebe6", borderRadius: 6 }} />
            <div style={{ width: "90%", height: 14, background: "#f0ebe6", borderRadius: 6 }} />
          </div>
        </aside>
        <div>
        <div className="animate-pulse" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div style={{ width: 200, height: 24, background: "#e8e0db", borderRadius: 8 }} />
          <div style={{ width: 120, height: 32, background: "#e8e0db", borderRadius: 999 }} />
        </div>

        <div className="animate-pulse" style={{ marginBottom: 16 }}>
          <div style={{ width: "100%", height: 44, background: "#fff", border: "1px solid #e8e0db", borderRadius: 12 }} />
        </div>

        <div className="animate-pulse" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ width: 180, height: 16, background: "#e8e0db", borderRadius: 6 }} />
          <div style={{ width: 140, height: 32, background: "#fff", border: "1px solid #e8e0db", borderRadius: 8 }} />
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="animate-pulse"
              style={{
                background: "#fff",
                border: "1px solid #e8e0db",
                borderRadius: 16,
                padding: 22,
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 20,
                animationDelay: `${i * 0.08}s`,
              }}
            >
              <div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
                  <div style={{ width: 140, height: 18, background: "#e8e0db", borderRadius: 6 }} />
                  <div style={{ width: 60, height: 22, background: "#f0ebe6", borderRadius: 999 }} />
                </div>
                <div style={{ width: 220, height: 14, background: "#f0ebe6", borderRadius: 6, marginBottom: 10 }} />
                <div style={{ width: "60%", height: 12, background: "#f0ebe6", borderRadius: 6, marginBottom: 10 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ width: 60, height: 22, background: "#f0ebe6", borderRadius: 999 }} />
                  <div style={{ width: 80, height: 22, background: "#f0ebe6", borderRadius: 999 }} />
                  <div style={{ width: 70, height: 22, background: "#f0ebe6", borderRadius: 999 }} />
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                <div style={{ width: 120, height: 36, background: "#e8e0db", borderRadius: 999 }} />
                <div style={{ width: 80, height: 28, background: "#f0ebe6", borderRadius: 999 }} />
              </div>
            </div>
          ))}
        </div>
        </div>
      </div>
      {/* Phase 5 C3: collapse sidebar at the same breakpoint the real page
          uses (1024px). styled-jsx isn't enabled here, so an inline <style>
          block is the lightest-touch responsive solution. */}
      <style>{`
        @media (max-width: 1024px) {
          .bt-loading-grid { grid-template-columns: 1fr !important; }
          .bt-loading-sidebar { display: none !important; }
        }
      `}</style>
    </div>
  );
}
