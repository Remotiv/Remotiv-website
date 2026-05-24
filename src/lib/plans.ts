// Shared source of truth for the 3 user-visible pricing fields (plan name,
// price, price suffix). Both /pricing (page.tsx TIERS) and the shared
// PricingModal (src/components/pricing-modal.tsx) import from here so the
// two surfaces can never drift on these fields.
//
// SCOPE: this file owns ONLY name + price + priceSuffix. Plan descriptions,
// feature lists, CTA labels, and href targets continue to live in their
// respective consumers — they're either copy-tuned per-surface (modal uses
// shorter feature wording due to column width) or have routing semantics that
// don't belong in a data file. Future consolidation passes may widen this.

export type PlanPricing = {
  id: "starter" | "pro" | "enterprise";
  name: string;
  price: string;
  /** Empty string = no suffix rendered (e.g. Enterprise "Let's talk"). */
  priceSuffix: string;
};

export const PLAN_PRICING: Record<"starter" | "pro" | "enterprise", PlanPricing> = {
  starter: {
    id: "starter",
    name: "Starter",
    price: "$49",
    priceSuffix: "USD / month",
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: "$499",
    priceSuffix: "USD / month",
  },
  enterprise: {
    id: "enterprise",
    name: "Custom Enterprise",
    price: "Let's talk",
    priceSuffix: "",
  },
};
