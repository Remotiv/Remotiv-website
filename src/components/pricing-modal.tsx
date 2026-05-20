"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X, Check } from "lucide-react";
import { useFocusTrap } from "@/hooks/use-focus-trap";

const PURPLE = "#7E47FF";
const BG = "#f8f4f1";
const LIME = "#c9ff85";
const GREEN = "#49D7A7";

type Tier = "starter" | "pro";

type PricingModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onGetStarted?: (tier: Tier) => void;
};

export default function PricingModal({ isOpen, onClose, onGetStarted }: PricingModalProps) {
  const router = useRouter();
  // Phase 5 A7: focus trap + initial focus + focus restore. Hook is a no-op
  // when !isOpen, so it's safe to declare unconditionally.
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, isOpen);

  // ESC closes only the topmost modal — capture phase + stopPropagation
  // prevents a stacked ProfileModal's bubble-phase listener from also firing.
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEsc, true);
    return () => document.removeEventListener("keydown", handleEsc, true);
  }, [isOpen, onClose]);

  // Ref-counted body scroll lock so stacked modals don't clobber each other.
  useEffect(() => {
    if (!isOpen) return;
    const count = parseInt(document.body.dataset.scrollLocks ?? "0", 10);
    document.body.dataset.scrollLocks = String(count + 1);
    if (count === 0) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      const current = parseInt(document.body.dataset.scrollLocks ?? "1", 10);
      const next = current - 1;
      document.body.dataset.scrollLocks = String(next);
      if (next <= 0) {
        document.body.style.overflow = "";
        delete document.body.dataset.scrollLocks;
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleGetStarted = (tier: Tier) => {
    if (onGetStarted) {
      onGetStarted(tier);
    } else {
      router.push("/signup");
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pricing-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        fontFamily: "DM Sans, sans-serif",
      }}
    >
      <div
        ref={modalRef}
        style={{
          background: BG,
          borderRadius: 20,
          padding: "36px 32px",
          width: "100%",
          maxWidth: 720,
          maxHeight: "92vh",
          overflowY: "auto",
          position: "relative",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: "50%",
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <X size={16} color="#666" />
        </button>

        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ color: PURPLE, fontWeight: 600, fontSize: 20, letterSpacing: "-0.5px", marginBottom: 12 }}>Remotiv.</div>
          <h2 id="pricing-modal-title" style={{ fontSize: 22, fontWeight: 500, margin: "0 0 6px 0", color: "#111", letterSpacing: "-0.5px" }}>
            Unlock contact details
          </h2>
          <p style={{ fontSize: 13, color: "#666", margin: 0 }}>Choose a plan to start unlocking talent</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          {/* STARTER */}
          <div style={{ background: "#fff", border: "1px solid #e8e0db", borderRadius: 14, padding: "18px 14px", display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#111", marginBottom: 8 }}>Starter</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: "#111", letterSpacing: "-1px" }}>$49</div>
              <div style={{ fontSize: 11, color: "#666" }}>/mo</div>
            </div>
            <p style={{ fontSize: 11, color: "#666", margin: "0 0 14px 0", lineHeight: 1.4 }}>For companies exploring the talent pool</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, fontSize: 11, flex: 1 }}>
              <FeatureRow text="Browse full talent pool" />
              <FeatureRow text="View profiles with resume" />
              <FeatureRow text="30 contact unlocks/mo" />
              <FeatureRow text="Advanced filters" disabled />
            </div>
            <button
              type="button"
              onClick={() => handleGetStarted("starter")}
              style={{ background: GREEN, color: "#0a3829", border: "none", borderRadius: 10, padding: 11, fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%", fontFamily: "DM Sans, sans-serif" }}
            >
              Get Started
            </button>
          </div>

          {/* PRO */}
          <div style={{ background: PURPLE, borderRadius: 14, padding: "18px 14px", position: "relative", display: "flex", flexDirection: "column" }}>
            <div
              style={{
                position: "absolute",
                top: -8,
                left: "50%",
                transform: "translateX(-50%)",
                background: LIME,
                color: "#1a3a1a",
                fontSize: 10,
                padding: "3px 10px",
                borderRadius: 999,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              Most Popular
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", marginBottom: 8 }}>Pro</div>
            <div style={{ background: "#fff", borderRadius: 8, padding: 8, marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: PURPLE, letterSpacing: "-1px" }}>$499</div>
                <div style={{ fontSize: 11, color: "#888" }}>/mo</div>
              </div>
            </div>
            <p style={{ fontSize: 11, color: "#ddd", margin: "0 0 14px 0", lineHeight: 1.4 }}>For teams actively hiring at scale</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, fontSize: 11, flex: 1 }}>
              <FeatureRow text="Everything in Starter" dark />
              <FeatureRow text="300 unlocks/mo" dark />
              <FeatureRow text="Advanced filters" dark />
              <FeatureRow text="Save and shortlist" dark />
              <FeatureRow text="Priority support" dark />
            </div>
            <button
              type="button"
              onClick={() => handleGetStarted("pro")}
              style={{ background: "#fff", color: PURPLE, border: "none", borderRadius: 10, padding: 11, fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%", fontFamily: "DM Sans, sans-serif" }}
            >
              Get Started
            </button>
          </div>

          {/* CUSTOM */}
          <div style={{ background: "#fff", border: "1px solid #e8e0db", borderRadius: 14, padding: "18px 14px", display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#111", marginBottom: 8 }}>Custom</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#111", letterSpacing: "-0.5px", marginBottom: 4 }}>Let&apos;s talk</div>
            <p style={{ fontSize: 11, color: "#666", margin: "0 0 14px 0", lineHeight: 1.4 }}>For companies who want Remotiv to do the heavy lifting</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16, fontSize: 11, flex: 1 }}>
              <FeatureRow text="Everything in Pro" />
              <FeatureRow text="Recruiters source for you" />
              <FeatureRow text="AI-powered matching" />
              <FeatureRow text="Dedicated manager" />
              <FeatureRow text="90-day replacement" />
            </div>
            <Link
              href="/contact"
              onClick={onClose}
              style={{ background: GREEN, color: "#0a3829", border: "none", borderRadius: 10, padding: 11, fontSize: 13, fontWeight: 600, cursor: "pointer", width: "100%", fontFamily: "DM Sans, sans-serif", textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}
            >
              Get a Quote
            </Link>
          </div>
        </div>

        <p style={{ fontSize: 12, color: "#888", textAlign: "center", margin: "18px 0 0 0" }}>
          Already have an account?{" "}
          <Link href="/signin" onClick={onClose} style={{ color: PURPLE, textDecoration: "none", fontWeight: 500 }}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function FeatureRow({ text, dark = false, disabled = false }: { text: string; dark?: boolean; disabled?: boolean }) {
  if (disabled) {
    return (
      <div style={{ display: "flex", alignItems: "start", gap: 6 }}>
        <X size={14} color="#ccc" style={{ flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: "#aaa", textDecoration: "line-through", lineHeight: 1.4 }}>{text}</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "start", gap: 6 }}>
      <Check size={14} color={dark ? LIME : GREEN} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ color: dark ? "#fff" : "#333", lineHeight: 1.4 }}>{text}</span>
    </div>
  );
}
