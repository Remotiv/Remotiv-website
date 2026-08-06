/**
 * Shapes for the company notification bell.
 *
 * A separate module because notification-actions.ts carries "use server" —
 * every export there is compiled into a server action, so a type cannot live
 * in it.
 */

export type CompanyNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  /** Null when the recipient can no longer open the target. */
  href: string | null;
  read: boolean;
  createdAt: string;
};
