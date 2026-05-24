// Shared source of truth for plan data shown on /pricing and inside the
// PricingModal (src/components/pricing-modal.tsx). Both surfaces import
// from here so name, price, suffix, and feature lists can never drift.
//
// Both surfaces now render the same verbose `label` wording — the modal's
// narrow columns simply wrap or scroll if needed (modal has overflowY:auto).
//
// PAGE-ONLY content (not in this file):
//   - tier descriptions ("For companies exploring the talent pool" etc.)
//   - CTA labels + hrefs (those have routing semantics)
//   - the page's COMPARISON matrix (8 rows × 3 plans of finer-grain comparison)
// These live in src/app/pricing/page.tsx because they don't belong in a
// shared data module or aren't consumed by the modal.

export type PlanFeature = {
  /** Feature wording — rendered identically on the page and inside the modal. */
  label: string;
  /** false = struck-through / "not included". Omit (or set true) for included. */
  included?: boolean;
};

export type Plan = {
  id: "starter" | "pro" | "enterprise";
  name: string;
  price: string;
  /** Empty string = no suffix rendered (e.g. Enterprise "Let's talk"). */
  priceSuffix: string;
  features: readonly PlanFeature[];
};

export const PLANS: Record<"starter" | "pro" | "enterprise", Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    price: "$49",
    priceSuffix: "USD / month",
    features: [
      { label: "Browse the full Remotiv talent pool" },
      { label: "View candidate profiles with resumes" },
      { label: "Unlock up to 30 contact details per month" },
      { label: "Advanced filters", included: false },
      { label: "Dedicated account manager", included: false },
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: "$499",
    priceSuffix: "USD / month",
    features: [
      { label: "Everything in Starter" },
      { label: "300 Profiles/mo" },
      { label: "Advanced filters — role, stack, seniority, availability, salary" },
      { label: "Save and shortlist candidates" },
      { label: "Priority support" },
    ],
  },
  enterprise: {
    id: "enterprise",
    name: "Custom Enterprise",
    price: "Let's talk",
    priceSuffix: "",
    features: [
      { label: "Everything in Pro" },
      { label: "Our recruiters source and vet candidates for you" },
      { label: "AI-powered matching to your exact role requirements" },
      { label: "Unlimited talent access" },
      { label: "90-day free replacement guarantee" },
      { label: "Dedicated success manager" },
    ],
  },
};
