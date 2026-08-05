/**
 * Shapes for the Email templates card.
 *
 * A separate module because template-actions.ts carries "use server" — every
 * export there is compiled into a server action, so a type cannot live in it.
 */

export type TemplateGroup = "automatic" | "manual";

export type TemplateRow = {
  /** Lifecycle event name, or a MANUAL_DEFAULTS id for composer templates. */
  key: string;
  group: TemplateGroup;
  name: string;
  trigger: string;
  /** False for events that exist but do not fire yet. */
  sending: boolean;
  editable: boolean;
  /**
   * True for a composer template the company wrote itself.
   *
   * It has no Remotiv default behind it, so Revert has nothing to restore —
   * the editor offers Delete instead, and `customised` is simply true.
   */
  ownAuthored?: boolean;

  defaultSubject: string;
  defaultBody: string;
  /** What is in force today — the company's override, else Remotiv's. */
  subject: string;
  body: string;

  /**
   * Derived by comparing `subject`/`body` against the defaults, never stored.
   * A boolean column drifts from the content and makes Revert a lie.
   */
  customised: boolean;
};

/** Sample values the editor's live preview renders against. */
export const PREVIEW_SAMPLE = {
  candidate_first_name: "Fatima",
  candidate_name: "Fatima Khan",
  job_title: "Senior Frontend Engineer",
} as const;
