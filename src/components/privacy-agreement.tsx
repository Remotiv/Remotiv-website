import Link from "next/link";
import type { CSSProperties } from "react";

/**
 * #67 part 3: the line every public form that collects personal data shows
 * near its submit button. Each form passes its own small-print style. A new
 * tab, so reading the policy never loses a half-filled form. The scan in
 * privacy-link.test.ts holds every listed form to it.
 */
export function PrivacyAgreement({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <p className={className} style={style}>
      By submitting, you agree to our{" "}
      <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="underline">
        Privacy Policy
      </Link>
      .
    </p>
  );
}
