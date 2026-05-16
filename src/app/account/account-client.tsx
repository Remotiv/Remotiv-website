"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Navbar } from "@/components/navbar";

const PURPLE = "#7E47FF";
const BG = "#f8f4f1";
const LIME = "#c9ff85";

type Props = {
  email: string;
  fullName: string | null;
  tier: "free" | "starter" | "pro" | "admin";
  creditsRemaining: number;
  creditsLimit: number;
  subscriptionStartDate: string | null;
};

export default function AccountClient({
  email,
  fullName,
  tier,
  creditsRemaining,
  creditsLimit,
  subscriptionStartDate,
}: Props) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const displayName = fullName || email.split("@")[0];
  const initial = (fullName?.charAt(0) || email.charAt(0)).toUpperCase();
  const creditsUsed = creditsLimit > 0 ? creditsLimit - creditsRemaining : 0;
  const progressPct = creditsLimit > 0 ? (creditsUsed / creditsLimit) * 100 : 0;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  };

  const isSubscriber = tier === "starter" || tier === "pro";
  const planName = tier === "starter" ? "Starter" : tier === "pro" ? "Pro" : tier === "admin" ? "Admin" : "Free";
  const planPrice = tier === "starter" ? "$49/month" : tier === "pro" ? "$499/month" : tier === "admin" ? "Internal" : "Free tier";

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: "DM Sans, sans-serif" }}>
      <Navbar />

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px 80px 20px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: PURPLE, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600, fontSize: 22 }}>
            {initial}
          </div>
          <div>
            <h1 style={{ fontSize: 24, fontWeight: 500, margin: 0, color: "#111", letterSpacing: "-0.5px" }}>{displayName}</h1>
            <p style={{ fontSize: 14, color: "#666", margin: "4px 0 0 0" }}>{email}</p>
          </div>
        </div>

        {/* Current plan card */}
        <div id="subscription" style={{ background: "#fff", border: "1px solid #e8e0db", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 6 }}>Current plan</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 20, fontWeight: 600, color: "#111" }}>{planName}</div>
                {(isSubscriber || tier === "admin") && (
                  <span style={{ background: LIME, color: "#1a3a1a", fontSize: 11, padding: "3px 10px", borderRadius: 999, fontWeight: 500 }}>
                    {tier === "admin" ? "Internal" : "Active"}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: "#666", marginTop: 4 }}>
                {planPrice}
                {subscriptionStartDate && isSubscriber && (
                  <span> · Started {new Date(subscriptionStartDate).toLocaleDateString()}</span>
                )}
              </div>
            </div>
            {tier === "free" && (
              <button
                type="button"
                onClick={() => showToast("🔒 Subscriptions coming soon — payment integration in progress.")}
                style={{ background: PURPLE, color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "DM Sans, sans-serif" }}
              >
                Subscribe
              </button>
            )}
            {tier === "starter" && (
              <button
                type="button"
                onClick={() => showToast("🔒 Coming soon — payment integration in progress.")}
                style={{ background: "transparent", border: "1px solid #ddd", borderRadius: 8, padding: "8px 14px", fontSize: 13, color: "#333", cursor: "pointer", fontFamily: "DM Sans, sans-serif" }}
              >
                Upgrade to Pro
              </button>
            )}
          </div>

          {isSubscriber && (
            <div style={{ borderTop: "1px solid #f0ebe6", paddingTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 13, color: "#666" }}>Credits this month</div>
                <div style={{ fontSize: 13, fontWeight: 500, color: "#111" }}>{creditsUsed} of {creditsLimit} used</div>
              </div>
              <div style={{ height: 6, background: "#f0ebe6", borderRadius: 999, overflow: "hidden" }}>
                <div style={{ width: `${progressPct}%`, height: "100%", background: PURPLE, borderRadius: 999 }} />
              </div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 8 }}>
                {creditsRemaining} credits remaining
              </div>
            </div>
          )}

          {tier === "admin" && (
            <div style={{ borderTop: "1px solid #f0ebe6", paddingTop: 16 }}>
              <p style={{ fontSize: 13, color: "#666", margin: 0 }}>Admin accounts bypass credit usage and have unlimited access.</p>
            </div>
          )}

          {tier === "free" && (
            <div style={{ borderTop: "1px solid #f0ebe6", paddingTop: 16 }}>
              <p style={{ fontSize: 13, color: "#666", margin: 0 }}>You&apos;re on the free tier. Subscribe to unlock contact details and full talent access.</p>
            </div>
          )}
        </div>

        {/* Account section */}
        <div style={{ background: "#fff", border: "1px solid #e8e0db", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>Account</div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f0ebe6" }}>
            <div>
              <div style={{ fontSize: 14, color: "#111", fontWeight: 500 }}>Email</div>
              <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>{email}</div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #f0ebe6" }}>
            <div>
              <div style={{ fontSize: 14, color: "#111", fontWeight: 500 }}>Password</div>
              <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>••••••••••</div>
            </div>
            <Link
              href="/forgot-password"
              style={{ background: "transparent", border: "none", fontSize: 13, color: PURPLE, fontWeight: 500, cursor: "pointer", textDecoration: "none" }}
            >
              Change
            </Link>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
            <div>
              <div style={{ fontSize: 14, color: "#111", fontWeight: 500 }}>Sign out</div>
              <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>End this session</div>
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              style={{ background: "transparent", border: "1px solid #ddd", borderRadius: 8, padding: "6px 12px", fontSize: 13, color: "#333", cursor: signingOut ? "wait" : "pointer", fontFamily: "DM Sans, sans-serif", opacity: signingOut ? 0.6 : 1 }}
            >
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </div>

        {/* Danger zone — only for active subscribers */}
        {isSubscriber && (
          <div style={{ background: "#fff", border: "1px solid #e8e0db", borderRadius: 12, padding: 20 }}>
            <div style={{ fontSize: 12, color: "#888", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 12 }}>Danger zone</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 14, color: "#111", fontWeight: 500 }}>Cancel subscription</div>
                <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>Lose access to subscriber features at end of billing cycle</div>
              </div>
              <button
                type="button"
                onClick={() => showToast("🔒 Coming soon — payment integration in progress.")}
                style={{ background: "transparent", border: "1px solid #f0c0c0", color: "#c14040", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "DM Sans, sans-serif" }}
              >
                Cancel plan
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Toast notification */}
      {toast && (
        <div
          role="alert"
          style={{
            position: "fixed",
            bottom: 24,
            left: 24,
            background: "#111",
            color: "#fff",
            padding: "12px 18px",
            borderRadius: 12,
            fontSize: 13,
            zIndex: 100,
            maxWidth: 360,
            boxShadow: "0 4px 16px rgba(0,0,0,0.16)",
            fontFamily: "DM Sans, sans-serif",
          }}
        >
          {toast}
        </div>
      )}

    </div>
  );
}
