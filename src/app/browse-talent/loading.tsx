export default function Loading() {
  return (
    <div style={{ minHeight: "100vh", background: "#f8f4f1", padding: "32px 16px", fontFamily: "DM Sans, sans-serif" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
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
  );
}
