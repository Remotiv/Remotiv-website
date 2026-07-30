"use client";

import { useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const PURPLE = "#7E47FF";
const BG = "#f8f4f1";

export default function ForgotPasswordClient({ errorParam }: { errorParam?: string }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(errorParam ?? null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset`,
    });

    setLoading(false);

    if (resetError) {
      if (resetError.message.toLowerCase().includes("rate")) {
        setError("Too many requests. Please wait a moment.");
      } else {
        setError("Could not send reset link. Please try again.");
      }
      return;
    }

    setSuccess(true);
  };

  if (success) {
    return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "DM Sans, sans-serif" }}>
        <div style={{ background: "#fff", borderRadius: 16, padding: 40, maxWidth: 480, width: "100%", textAlign: "center", border: "1px solid #e8e0db" }}>
          <div style={{ color: PURPLE, fontWeight: 600, fontSize: 22, letterSpacing: "-0.5px", marginBottom: 20 }}>Remotiv.</div>
          <h1 style={{ fontSize: 22, fontWeight: 500, color: "#111", margin: "0 0 12px 0", letterSpacing: "-0.5px" }}>Check your email</h1>
          <p style={{ fontSize: 14, color: "#666", margin: 0, lineHeight: 1.5 }}>
            We sent a reset link to <strong>{email}</strong>. Click the link to set a new password.
          </p>
          <p style={{ fontSize: 13, color: "#999", margin: "20px 0 0 0" }}>
            Didn&apos;t get it? Check spam or <Link href="/forgot-password" style={{ color: PURPLE, textDecoration: "none", fontWeight: 500 }}>try again</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "DM Sans, sans-serif" }}>
      <div style={{ background: BG, borderRadius: 16, padding: "36px 28px", maxWidth: 440, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ color: PURPLE, fontWeight: 600, fontSize: 22, letterSpacing: "-0.5px", marginBottom: 24 }}>Remotiv.</div>
          <div style={{ width: 56, height: 56, margin: "0 auto 16px auto", borderRadius: "50%", background: "#EEEDFE", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Lock size={28} color={PURPLE} />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: "0 0 6px 0", color: "#111", letterSpacing: "-0.5px" }}>Forgot password?</h1>
          <p style={{ fontSize: 14, color: "#666", margin: 0, lineHeight: 1.5 }}>
            Enter your email and we&apos;ll send you a link to reset your password.
          </p>
        </div>

        {error && (
          <div role="alert" style={{ background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 12, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 12, padding: "13px 16px", fontSize: 14, fontFamily: "DM Sans, sans-serif" }}
          />
          <button type="submit" disabled={loading} style={{ background: PURPLE, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 600, marginTop: 8, cursor: loading ? "wait" : "pointer", opacity: loading ? 0.7 : 1, fontFamily: "DM Sans, sans-serif" }}>
            {loading ? "Sending..." : "Send reset link →"}
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: 20 }}>
          <Link href="/signin" style={{ fontSize: 13, color: PURPLE, textDecoration: "none", fontWeight: 500 }}>
            ← Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
