"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const PURPLE = "#7E47FF";
const BG = "#f8f4f1";

export default function SigninClient({
  errorParam,
  nextParam,
}: {
  errorParam?: string;
  nextParam?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(errorParam ?? null);

  const handleEmailSignin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error: signinError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (signinError) {
      if (signinError.message.toLowerCase().includes("rate")) {
        setError("Too many attempts. Please wait a moment.");
      } else {
        setError("Email or password is incorrect.");
      }
      return;
    }

    const next = nextParam ?? "/browse-talent";
    router.push(next);
    router.refresh();
  };

  const handleGoogleSignin = async () => {
    setError(null);
    const supabase = createClient();
    const next = nextParam ?? "/browse-talent";
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (oauthError) {
      setError("Could not start Google signin. Please try again.");
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "DM Sans, sans-serif" }}>
      <div style={{ background: BG, borderRadius: 16, padding: "36px 28px", maxWidth: 440, width: "100%" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ color: PURPLE, fontWeight: 600, fontSize: 22, letterSpacing: "-0.5px", marginBottom: 20 }}>Remotiv.</div>
          <h1 style={{ fontSize: 24, fontWeight: 500, margin: "0 0 6px 0", color: "#111", letterSpacing: "-0.5px" }}>Welcome back</h1>
          <p style={{ fontSize: 14, color: "#666", margin: 0 }}>Sign in to your Remotiv account</p>
        </div>

        {error && (
          <div role="alert" style={{ background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 12, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <button onClick={handleGoogleSignin} type="button" style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 12, padding: 12, fontSize: 14, fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, width: "100%", marginBottom: 16 }}>
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
            <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          Continue with Google
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0" }}>
          <div style={{ flex: 1, height: 1, background: "#ddd" }} />
          <span style={{ fontSize: 11, color: "#999" }}>OR</span>
          <div style={{ flex: 1, height: 1, background: "#ddd" }} />
        </div>

        <form onSubmit={handleEmailSignin} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 12, padding: "13px 16px", fontSize: 14, fontFamily: "DM Sans, sans-serif" }}
          />
          <div style={{ position: "relative" }}>
            <input
              type={showPassword ? "text" : "password"}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 12, padding: "13px 44px 13px 16px", fontSize: 14, fontFamily: "DM Sans, sans-serif", width: "100%", boxSizing: "border-box" }}
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "#888", display: "flex" }}>
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          <div style={{ textAlign: "right", marginTop: -2 }}>
            <Link href="/forgot-password" style={{ fontSize: 12, color: PURPLE, textDecoration: "none", fontWeight: 500 }}>
              Forgot password?
            </Link>
          </div>

          <button type="submit" disabled={loading} style={{ background: PURPLE, color: "#fff", border: "none", borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 600, marginTop: 8, cursor: loading ? "wait" : "pointer", opacity: loading ? 0.7 : 1, fontFamily: "DM Sans, sans-serif" }}>
            {loading ? "Signing in..." : "Sign in →"}
          </button>
        </form>

        <p style={{ fontSize: 13, color: "#555", textAlign: "center", margin: "20px 0 0 0" }}>
          New to Remotiv?{" "}
          <Link href="/signup" style={{ color: PURPLE, textDecoration: "none", fontWeight: 500 }}>
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
