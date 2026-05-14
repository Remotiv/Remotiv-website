import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Green check-badge fragment. Duplicated 2x inside larger TI_POINTS icons —
 * the parent <svg viewBox="0 0 64 64"> has unique sibling rects/lines per
 * card, so only this circle + checkmark fragment is shared.
 *
 * Caller must wrap in <svg viewBox="0 0 64 64" fill="none">...
 */
export function CheckBadge() {
  return (
    <>
      <circle cx="48" cy="46" r="10" fill="#49D7A7" />
      <path
        d="M43 46l3.5 3.5L53 42"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/**
 * Shield outline path. Duplicated 2x inside ADVANTAGES icons (Free
 * Replacement / Risk Sits With Us) — the parent <svg viewBox="0 0 36 36">
 * has unique interior accents (checkmark vs dot), so only the outer shield
 * path is shared.
 *
 * Caller must wrap in <svg viewBox="0 0 36 36" fill="none">...
 */
export function ShieldIcon() {
  return (
    <path
      d="M18 6l10 4v8c0 6-4.5 10.5-10 12C12.5 28.5 8 24 8 18v-8l10-4z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  );
}

/**
 * Two-person team icon — full standalone SVG. Duplicated 2x in ROLES
 * (Marketing / HR & People Ops).
 */
export function TeamIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
    </svg>
  );
}

/**
 * Calendar / credit-card icon — full standalone SVG. Duplicated 2x in ROLES
 * (Sales & Revenue / Sales Enablement & CRM).
 */
export function CalendarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm-7 12H5v-2h8v2zm4-4H5v-2h12v2zm3-4H4V6h16v2z" />
    </svg>
  );
}
