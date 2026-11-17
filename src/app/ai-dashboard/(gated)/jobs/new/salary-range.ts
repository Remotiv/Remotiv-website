/**
 * The job wizard's compensation line, for the review card and the live preview.
 *
 * A plain module so the three cases can be tested without rendering the wizard.
 */

/** A typed amount as the wizard shows it, "" when nothing usable was typed. */
export function fmtNumber(value: string): string {
  const n = Number.parseInt(String(value).replace(/[^0-9]/g, ""), 10);
  return Number.isNaN(n) ? "" : n.toLocaleString("en-US");
}

export function currencySymbol(currency: string): string {
  return currency === "USD" ? "$" : "PKR";
}

/**
 * hidden       the salary is not shown on the post
 * unspecified  it is shown, but neither bound has been entered
 * range        at least one bound; a missing one reads "-"
 */
export type SalaryRange =
  | { kind: "hidden" }
  | { kind: "unspecified" }
  | { kind: "range"; text: string };

export function salaryRange(input: {
  show: boolean;
  min: string;
  max: string;
  currency: string;
}): SalaryRange {
  if (!input.show) return { kind: "hidden" };
  const min = fmtNumber(input.min);
  const max = fmtNumber(input.max);
  if (!min && !max) return { kind: "unspecified" };
  return { kind: "range", text: `${currencySymbol(input.currency)} ${min || "-"} – ${max || "-"}` };
}
