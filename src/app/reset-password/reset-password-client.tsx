"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const PURPLE = "#7E47FF";
const BG = "#f8f4f1";

export default function ResetPasswordClient() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      if (updateError.message.toLowerCase().includes("session")) {
        setError("Reset link expired. Please request a new one.");
      } else {
        setError("Could not update password. Please try again.");
      }
      return;
    }

    router.push("/browse-talent?password_updated=true");
    router.refresh();
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "DM Sans, sans-serif" }}>
      <div style={{ background: BG, borderRadius: 16, padding: "36px 28px", maxWidth: 440, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ color: PURPLE, fontWeight: 600, fontSize: 22, letterSpacing: "-0.5px", marginBottom: 24 }}>Remotiv.</div>
          <div style={{ width: 56, height: 56, margin: "0 auto 16px auto", borderRadius: "50%", background: "#EEEDFE", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <ShieldCheck size={28} color={PURPLE} />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 500, margin: "0 0 6px 0", color: "#111", letterSpacing: "-0.5px" }}>Set new password</h1>
          <p style={{ fontSize: 14, color: "#666", margin: 0, lineHeight: 1.5 }}>
            Choose a strong password to secure your account.
          </p>
        </div>

        {error && (
          <div role="alert" style={{ background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 12, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ position: "relative" }}>
            <input
              type={showPassword ? "text" : "password"}
              placeholder="New password (min. 8 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 12, padding: "13px 44px 13px 16px", fontSize: 14, fontFamily: "DM Sans, sans-serif", width: "100%", boxSizing: "border-box" }}
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "#888", display: "flex" }}>
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <input
            type={showPassword ? "text" : "password"}
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 12, padding: "13px 16px", fontSize: 14, fontFamily: "DM Sans, sans-serif" }}
          />
          <button type="submit" disabled={loading} style={{ background: PURPLE, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 600, marginTop: 8, cursor: loading ? "wait" : "pointer", opacity: loading ? 0.7 : 1, fontFamily: "DM Sans, sans-serif" }}>
            {loading ? "Updating..." : "Update password →"}
          </button>
        </form>

        <p style={{ fontSize: 12, color: "#999", textAlign: "center", margin: "14px 0 0 0", lineHeight: 1.5 }}>
          After updating, you&apos;ll be signed in automatically.
        </p>
      </div>
    </div>
  );
}
