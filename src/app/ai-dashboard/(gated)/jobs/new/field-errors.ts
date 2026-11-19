/**
 * The wizard's step fields and their error messages, linked for assistive
 * technology (#37): each field names its error with aria-describedby and is
 * marked aria-invalid while the error shows, and a failed step moves focus to
 * the first field in error. Pure, so it can be tested without the wizard.
 */

/** Error key -> the id of the field it belongs to, in on-screen order. */
export const WIZARD_FIELD_IDS: Readonly<Record<string, string>> = {
  title: "w-title",
  location: "w-country",
  description: "w-jd",
  salary_min: "w-min",
  salary_max: "w-max",
};

export const fieldErrorId = (fieldId: string) => `${fieldId}-error`;

/** The ARIA attributes for a field: present only while it has an error. */
export function fieldErrorProps(fieldId: string, error: string | undefined) {
  return error ? { "aria-invalid": true as const, "aria-describedby": fieldErrorId(fieldId) } : {};
}

/** The id of the first field with an error, in on-screen order, or null. */
export function firstInvalidFieldId(errors: Record<string, string>): string | null {
  for (const [key, id] of Object.entries(WIZARD_FIELD_IDS)) {
    if (errors[key]) return id;
  }
  return null;
}
