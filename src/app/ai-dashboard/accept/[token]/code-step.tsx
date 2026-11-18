"use client";

import { useState } from "react";
import { acceptInvite, sendInviteCode } from "../actions";
import { INVITE_CODE_LENGTH } from "../code-length";

const FIELD_LABEL =
  "mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[var(--ai-t3)]";

/**
 * The second step of accepting an invitation (#51): the code emailed to the
 * invited address, then the join. The password typed in the first step comes
 * along, because the final action checks everything again on its own.
 */
export function CodeStep({
  token,
  password,
  existingAccount,
  resetPassword,
  email,
  submitLabel,
  onNeedsPassword,
}: {
  token: string;
  password: string;
  existingAccount: boolean;
  /** #63: the password typed in the first step REPLACES the account's, on the code alone. */
  resetPassword: boolean;
  email: string;
  submitLabel: string;
  onNeedsPassword: (error: string) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"join" | "resend" | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy("join");
    const result = await acceptInvite({ token, password, code, resetPassword });
    if (!result.success) {
      setBusy(null);
      if (result.needsExistingPassword) {
        onNeedsPassword(result.error);
        return;
      }
      setError(result.error);
      return;
    }
    // Full-page navigation, NOT router.push: the session cookie was just set
    // server-side, and an RSC navigation would render the gated layout with
    // stale cookies. `busy` stays set: the page is being replaced.
    window.location.assign("/ai-dashboard");
  }

  async function handleResend() {
    setError(null);
    setNotice(null);
    setBusy("resend");
    const result = await sendInviteCode({ token, password, existingAccount });
    setBusy(null);
    if (!result.success) {
      if (result.needsExistingPassword) {
        onNeedsPassword(result.error);
        return;
      }
      setError(result.error);
      return;
    }
    setCode("");
    setNotice("We sent a new code.");
  }

  return (
    <>
      <p className="mt-5 text-sm text-[var(--ai-t2)]">
        We sent a {INVITE_CODE_LENGTH} digit code to{" "}
        <span className="font-semibold text-[var(--ai-t1)]">{email}</span>. Enter it to confirm this
        is your email.
      </p>

      {error && (
        <p
          role="alert"
          aria-live="assertive"
          className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-5 text-sm text-[var(--ai-t2)]">
          {notice}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <div>
          <label htmlFor="accept-code" className={FIELD_LABEL}>
            Code{" "}
            <span className="text-red-500" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="accept-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern={`\\d{${INVITE_CODE_LENGTH}}`}
            maxLength={INVITE_CODE_LENGTH}
            required
            aria-required="true"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder={"0".repeat(INVITE_CODE_LENGTH)}
            className="w-full rounded-xl border border-[var(--ai-line)] px-4 py-3 text-center text-lg tracking-[0.3em] text-[var(--ai-t1)] outline-none transition-all focus:border-remotiv-purple focus:ring-2 focus:ring-remotiv-purple/20"
          />
        </div>

        <button
          type="submit"
          disabled={busy !== null}
          aria-busy={busy === "join"}
          className="mt-2 w-full rounded-xl bg-remotiv-purple py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {busy === "join" ? "Joining…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={handleResend}
          disabled={busy !== null}
          aria-busy={busy === "resend"}
          className="text-sm font-semibold text-remotiv-purple hover:underline disabled:opacity-60"
        >
          Send a new code
        </button>
      </form>
    </>
  );
}
