"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/app/admin/lib/role-guards";
import { isValidEmail } from "@/lib/validators";
import { slugify, uniqueSlug } from "@/lib/slug";
import {
  findAuthUserIdByEmail,
  isAlreadyRegistered,
  syncJobsCompanyName,
} from "@/lib/company-identity";
import type { CompanyStatus } from "@/app/ai-dashboard/lib/company-roles";
import type { QueueHealth } from "@/lib/queue-health-types";
import { QUEUE_TYPES, readQueueHealth } from "@/lib/queue-health";

// ── Types ────────────────────────────────────────────────────
// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. CompanyStatus is therefore NOT re-exported
// here; consumers import it from @/app/ai-dashboard/lib/company-roles.

export type Company = {
  id: string;
  user_id: string | null;
  name: string;
  slug: string | null;
  contact_name: string | null;
  contact_email: string;
  website: string | null;
  status: CompanyStatus;
  created_at: string;
  member_count: number;
};

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

// ── Helpers ──────────────────────────────────────────────────

function isValidPassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8;
}

// ── Reads ────────────────────────────────────────────────────

export async function fetchCompanies(): Promise<Company[]> {
  await requireSuperAdmin();

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("companies")
    .select(`
      id, user_id, name, slug, contact_name, contact_email, website, status, created_at,
      members:company_members(id, status)
    `)
    .order("created_at", { ascending: false });

  type MemberRow = { id: string; status: string | null };
  type CompanyQueryRow = {
    id: string;
    user_id: string | null;
    name: string | null;
    slug: string | null;
    contact_name: string | null;
    contact_email: string | null;
    website: string | null;
    status: string | null;
    created_at: string | null;
    members: MemberRow[] | null;
  };

  return ((data ?? []) as CompanyQueryRow[]).map((r) => {
    const members = Array.isArray(r.members) ? r.members : [];
    return {
      id: r.id,
      user_id: r.user_id,
      name: r.name ?? "",
      slug: r.slug,
      contact_name: r.contact_name,
      contact_email: r.contact_email ?? "",
      website: r.website,
      status: ((r.status as CompanyStatus) ?? "active"),
      created_at: r.created_at ?? "",
      member_count: members.filter((m) => m.status === "active").length,
    };
  });
}

// ── Mutations ────────────────────────────────────────────────

/**
 * The owner's auth account: created here, or an existing one linked.
 *
 * `createdUserId` is non-null ONLY when this request created the account, and
 * it gates every rollback below. Same two-variable shape invite acceptance uses,
 * and for the same reason: a provisioning failure must never delete a Remotiv
 * admin's or a talent's login just because their address was typed into this
 * form.
 */
type OwnerAccount = {
  userId: string;
  createdUserId: string | null;
  /** True when an existing account was adopted rather than created. */
  linked: boolean;
};

/**
 * Create the owner's account, or adopt the one that already exists.
 *
 * ── Why this does not ask for a password ─────────────────────
 *
 * Invite acceptance resolves the same collision by calling signInWithPassword:
 * the invitee is the person at the keyboard, so making them prove the account
 * is theirs both authenticates them and yields the user id without ever
 * enumerating auth.users.
 *
 * Here the person at the keyboard is a Remotiv super-admin, not the owner-to-be.
 * They do not have that person's password and must not be asked for it, so the
 * id is resolved by directory lookup instead. That is not a new capability for
 * this caller: createCompany already runs behind requireSuperAdmin, and
 * updateCompany already uses the same helper on the email-edit path.
 *
 * The typed password is DISCARDED on the link path. An existing account keeps
 * its own — provisioning a second workspace for someone is not a reason to
 * change how they sign in to the first.
 */
async function resolveOrCreateOwner(
  supabase: ReturnType<typeof createServiceClient>,
  email: string,
  password: string,
): Promise<MutationResult<OwnerAccount>> {
  if (password) {
    const { data: created, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (created?.user) {
      return {
        success: true,
        data: { userId: created.user.id, createdUserId: created.user.id, linked: false },
      };
    }

    const msg = authError?.message ?? "Failed to create auth user.";
    // Anything that is NOT a collision is a real failure and stops here.
    if (!isAlreadyRegistered(msg)) return { success: false, error: msg };
  }

  const existingId = await findAuthUserIdByEmail(email);
  if (existingId) {
    return { success: true, data: { userId: existingId, createdUserId: null, linked: true } };
  }

  return {
    success: false,
    error: password
      ? // GoTrue said the address is taken but the directory cannot find it —
        // a soft-deleted account, or a lookup that failed. Neither is something
        // to guess past, because guessing means creating a company with no owner.
        "That email is already registered, but the account couldn't be read. Try again, or check it in Supabase."
      : "No Remotiv account uses that email yet. Set a password to create one.",
  };
}

export async function createCompany(input: {
  name: string;
  contact_name: string;
  contact_email: string;
  /** Blank is legitimate: it means "link the account that already exists". */
  password?: string;
}): Promise<MutationResult<{ id: string; linked: boolean }>> {
  await requireSuperAdmin();

  const name = input.name?.trim() ?? "";
  const contact_name = input.contact_name?.trim() ?? "";
  const contact_email = input.contact_email?.trim().toLowerCase() ?? "";
  const password = input.password ?? "";

  if (!name) return { success: false, error: "Company name is required." };
  if (!isValidEmail(contact_email)) {
    return { success: false, error: "Please enter a valid email address." };
  }
  // Conditional, not optional: a password that IS supplied must still be a
  // usable one. A blank password is the link path, which needs none.
  if (password && !isValidPassword(password)) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  const supabase = createServiceClient();

  // 1. The owner's auth account — created, or adopted if it already exists.
  const account = await resolveOrCreateOwner(supabase, contact_email, password);
  if (!account.success) return account;
  const { userId, createdUserId, linked } = account.data;

  // 2. Insert the companies row. If this fails, clean up the auth user — but
  //    only if we created it; see the rollback below.
  // The careers link (/jobs?company=<slug>) is the company's own filtered job
  // list, so provisioning without a slug hands every new customer a link that
  // silently falls back to the FULL board — every competitor's roles included.
  // Generated here, once, from the name.
  //
  // Same probe-and-suffix helper the job slugs use, so "Acme" then "Acme"
  // again yields acme / acme-2 rather than a constraint violation. The loop is
  // a backstop only — see the 23505 branch below.
  const slug = await uniqueSlug(supabase, {
    table: "companies",
    base: slugify(name),
    // A name that slugifies to nothing ("!!!", or a purely non-Latin name)
    // would otherwise produce an empty slug and a careers link matching
    // nothing at all.
    fallback: "company",
  });

  const { data: row, error: insertError } = await supabase
    .from("companies")
    .insert({
      user_id: userId,
      name,
      slug,
      contact_name: contact_name || null,
      contact_email,
      status: "active",
      /*
       * Only for an account we just created. must_change_password forces the
       * owner through /ai-dashboard/change-password on first login, which is
       * right for a password a Remotiv admin typed and is wrong for one the
       * person already chose and has been using — it would demand they change
       * a password this action never touched.
       */
      must_change_password: !linked,
    })
    .select("id")
    .single();

  if (insertError || !row) {
    // Only ever an account THIS request created.
    if (createdUserId) await supabase.auth.admin.deleteUser(createdUserId);
    if (insertError?.code === "23505") {
      // Two unique constraints can raise this, and they need different copy —
      // telling someone their email is taken when the SLUG collided sends them
      // hunting for a duplicate account that does not exist.
      //
      // The slug case is the probe-then-insert race: uniqueSlug saw the name
      // free a moment before a concurrent provisioning claimed it. Retrying
      // resolves it, because the second probe now sees the winner.
      const detail = `${insertError.message} ${insertError.details ?? ""}`;
      if (/slug/i.test(detail)) {
        return {
          success: false,
          error: "That company name was just taken. Try again.",
        };
      }
      /*
       * companies_contact_email_key. NOT the same fact as "that email has an
       * account" — that case is now linked rather than refused, so repeating
       * the old wording here would send an admin looking for a duplicate login
       * that is perfectly fine to reuse. What actually collided is the CONTACT
       * ADDRESS, which is unique per company by index.
       */
      return {
        success: false,
        error: "Another company already uses that contact email. Each company needs its own.",
      };
    }
    return { success: false, error: insertError?.message ?? "Failed to insert company." };
  }

  const companyId = (row as { id: string }).id;

  // 3. Insert the owner membership row. company_members is the source of
  //    truth for tenant resolution, so a company without it would resolve
  //    only through the companies.user_id fallback — roll the whole
  //    provisioning back rather than leave a half-provisioned tenant.
  //
  //    `name` and `email` are written HERE, the same way invite acceptance
  //    writes them (ai-dashboard/accept/actions.ts). Leaving them null was the
  //    original defect: every founding member of every company had a blank
  //    row, and each reader of that column improvised its own fallback —
  //    "Member" in the hiring-team picker, unfindable in search, and no
  //    address at all for booking mail. The auth user was created from
  //    contact_email a few lines up, so both values are already in hand.
  const { error: memberError } = await supabase.from("company_members").insert({
    company_id: companyId,
    user_id: userId,
    // The local-part fallback matches acceptance exactly, so a company created
    // without a contact name gets the same treatment as an invitee without one.
    name: contact_name || contact_email.split("@")[0],
    email: contact_email,
    role: "owner",
    status: "active",
  });

  if (memberError) {
    await supabase.from("companies").delete().eq("id", companyId);
    if (createdUserId) await supabase.auth.admin.deleteUser(createdUserId);
    if (memberError.code === "23505") {
      /*
       * company_members is unique on (company_id, user_id) and this company was
       * created seconds ago, so this cannot mean "already a member of a
       * company" — belonging to ANOTHER company is legal and is the whole point
       * of the link path. Report it as the unexpected thing it is.
       */
      return { success: false, error: `Couldn't add the owner: ${memberError.message}` };
    }
    return { success: false, error: memberError.message };
  }

  revalidatePath("/admin/companies");
  return { success: true, data: { id: companyId, linked } };
}


export async function updateCompany(
  id: string,
  updates: {
    name?: string;
    contact_name?: string;
    contact_email?: string;
    status?: CompanyStatus;
  },
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  // NOTE: `slug` is deliberately absent from this patch and from the `updates`
  // type above, so a rename CANNOT change it.
  //
  // The slug is the company's careers link — /jobs?company=<slug> — which they
  // paste into job ads, email signatures and their own site. Regenerating it on
  // rename would silently break every copy already in circulation, and the new
  // URL would be one nobody has. Job slugs are frozen after creation for the
  // same reason.
  //
  // The displayed NAME still updates everywhere, including on existing job
  // posts via syncJobsCompanyName below — only the URL handle is stable. If a
  // company ever genuinely needs a new slug, that is a deliberate one-off with
  // a redirect, not a side effect of editing a text field.
  const patch: Record<string, unknown> = {};
  if (typeof updates.name === "string") patch.name = updates.name.trim();
  if (typeof updates.contact_name === "string") {
    patch.contact_name = updates.contact_name.trim();
  }
  if (updates.status) patch.status = updates.status;

  const supabase = createServiceClient();

  // Email edits must also swap the Supabase auth login email —
  // companies.contact_email and auth.users.email are seeded together at
  // create-time but nothing keeps them in sync afterwards, so a DB-only patch
  // would silently desync login. Order: validate → auth first (the likely
  // failure) → DB → best-effort auth rollback if the DB write fails after
  // auth already changed.
  let authEmailChanged = false;
  let rollbackUserId: string | null = null;
  let rollbackEmail: string | null = null;

  if (typeof updates.contact_email === "string" && updates.contact_email.trim().length > 0) {
    const newEmail = updates.contact_email.trim().toLowerCase();
    if (!isValidEmail(newEmail)) {
      return { success: false, error: "Please enter a valid email address." };
    }

    const { data: currentRow, error: fetchErr } = await supabase
      .from("companies")
      .select("user_id, contact_email")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) return { success: false, error: fetchErr.message };
    const current = currentRow as { user_id: string | null; contact_email: string | null } | null;
    if (!current || !current.user_id) {
      return { success: false, error: "Company not found." };
    }

    const oldEmail = current.contact_email ?? "";
    if (oldEmail.toLowerCase() !== newEmail) {
      // Deterministic collision answer BEFORE calling GoTrue. GoTrue returns a
      // friendly "already registered" for some collisions and a generic 500 for
      // others — soft-deleted users, unconfirmed signups, races — and the
      // generic one is what reached production as "Error updating user".
      // Checking first means the message no longer depends on which shape
      // comes back.
      //
      // An id match against THIS user is not a collision: it means auth already
      // holds the new address and only the DB copy was stale, so letting the
      // update through repairs the drift.
      const existingId = await findAuthUserIdByEmail(newEmail);
      if (existingId && existingId !== current.user_id) {
        return {
          success: false,
          error: "This email is already registered to another account.",
        };
      }

      const { error: authErr } = await supabase.auth.admin.updateUserById(current.user_id, {
        email: newEmail,
        email_confirm: true,
      });
      if (authErr) {
        // Forensic trail — this path previously logged nothing at all, so a
        // failure left no server-side record of what GoTrue actually said.
        // The address itself is PII and logs are retained and broadly readable,
        // so only the DOMAIN is recorded: enough to tell a typo'd domain from a
        // genuine collision without storing the person's address.
        console.error("[admin/companies] auth email update failed", {
          companyId: id,
          userId: current.user_id,
          emailDomain: newEmail.split("@")[1] ?? "(none)",
          status: authErr.status,
          code: authErr.code,
          message: authErr.message,
        });

        const msg = authErr.message ?? "Failed to update auth email.";
        if (isAlreadyRegistered(msg)) {
          return {
            success: false,
            error: "This email is already registered to another account.",
          };
        }
        // A 5xx from GoTrue ("Error updating user") carries no cause. In
        // practice it is usually a collision the pre-check could not see, such
        // as a soft-deleted row. Say something actionable instead of passing
        // the raw string to an admin who can do nothing with it.
        if ((authErr.status ?? 0) >= 500) {
          return {
            success: false,
            error:
              "Couldn't update the login email. It may already be in use by another Remotiv account.",
          };
        }
        return { success: false, error: msg };
      }
      authEmailChanged = true;
      rollbackUserId = current.user_id;
      rollbackEmail = oldEmail;
      patch.contact_email = newEmail;
    }
  }

  if (Object.keys(patch).length === 0) {
    return { success: true, data: undefined };
  }

  const { error } = await supabase.from("companies").update(patch).eq("id", id);
  if (error) {
    if (authEmailChanged && rollbackUserId && rollbackEmail) {
      // Best-effort: put the auth email back so login and record don't
      // silently diverge. If the rollback itself fails there's nothing
      // sensible we can do from here — surface the original DB error.
      await supabase.auth.admin.updateUserById(rollbackUserId, {
        email: rollbackEmail,
        email_confirm: true,
      });
    }
    return { success: false, error: error.message };
  }

  // Carry the edit onto the owner's company_members row.
  //
  // This block used to NULL name and email instead of writing them. That was a
  // reasonable answer to the problem it faced — the row was written at
  // provisioning and updated by nothing, so a stale copy outranked the truth in
  // getCompanyContext (`member.name || company.contact_name`) and on the Team
  // page — but it fixed staleness by guaranteeing emptiness, and emptiness has
  // its own readers who cannot fall through to companies.contact_name:
  //
  //   • the hiring-team picker and job team list render the literal "Member";
  //   • search matches on `name.ilike`/`email.ilike`, and NULL matches neither,
  //     so the owner cannot be found by their own name or address;
  //   • booking mail had no host address at all.
  //
  // Keeping the copy IN STEP is what the settings action already does when a
  // member changes their own email, so this is now the one rule rather than
  // two contradictory ones: whoever edits the identity updates every copy of
  // it. Provisioning writes both fields, this keeps them true.
  //
  // An emptied contact_name still writes NULL — that is not a stale value, and
  // the fall-through to companies.contact_name remains the right answer when
  // there is genuinely no name to show.
  //
  // Only the OWNER's row: an invited member's name is their own, set at accept
  // time, and no admin edit of the company speaks for it.
  //
  // Best-effort: the company edit has already committed and must not be
  // reported as failed because the copy didn't land.
  if (patch.contact_name !== undefined || patch.contact_email !== undefined) {
    const identity: Record<string, unknown> = {};
    if (typeof patch.contact_name === "string") {
      identity.name = patch.contact_name || null;
    }
    if (typeof patch.contact_email === "string") {
      identity.email = patch.contact_email;
    }
    const { error: cacheErr } = await supabase
      .from("company_members")
      .update(identity)
      .eq("company_id", id)
      .eq("role", "owner");
    if (cacheErr) {
      console.error("[admin/companies] owner identity copy failed (non-fatal)", {
        companyId: id,
        error: cacheErr.message,
      });
    }
  }

  // Keep jobs.company in step with the rename.
  //
  // jobs.company is free text stamped at creation, so before this a rename left
  // every existing job advertising the OLD name on remotiv.work/jobs.
  //
  // Same denormalised-identity class as company_members.name, resolved the
  // OPPOSITE way, and the difference is what the field is FOR. company_members
  // .name is read once per request beside a companies row we already load, so
  // clearing it and resolving at read time costs nothing. jobs.company is read
  // on the public jobs list — the hottest page on the site — whose LIST_SELECT
  // deliberately avoids joins for payload size. Adding a companies join to
  // every anonymous page view, to correct a value that changes approximately
  // never, is the wrong trade.
  //
  // On the history argument: a job's company name at posting time IS history,
  // but this column is not a historical record — it is the label on a LIVE
  // listing, which makes a present-tense claim that this company is hiring
  // right now. A candidate reading a defunct name is simply being told
  // something false. If the posting-time name is ever wanted it belongs in a
  // separate snapshot column, exactly as job_title_snapshot does for
  // applications — not smuggled in as the display field.
  //
  // Scoped to this company's jobs by company_id, so no other tenant's rows are
  // touched. Best-effort for the same reason as the block above: the rename has
  // already committed and must not report failure because a sync didn't land.
  if (typeof patch.name === "string") {
    const synced = await syncJobsCompanyName(
      supabase,
      id,
      patch.name,
      "admin/companies",
    );
    // The public list and the job detail pages cache the old name.
    if (synced) revalidatePath("/jobs");
  }

  revalidatePath("/admin/companies");
  return { success: true, data: undefined };
}

export async function resetCompanyPassword(
  id: string,
  newPassword: string,
): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  if (!isValidPassword(newPassword)) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  const supabase = createServiceClient();
  const { data: row, error: fetchErr } = await supabase
    .from("companies")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) return { success: false, error: fetchErr.message };
  if (!row || !(row as { user_id: string | null }).user_id) {
    return { success: false, error: "Company has no linked auth user." };
  }

  const userId = (row as { user_id: string }).user_id;
  const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updateErr) return { success: false, error: updateErr.message };

  // Re-arm the must-change gate so the owner is asked to pick their own
  // password the next time they sign in.
  await supabase
    .from("companies")
    .update({ must_change_password: true })
    .eq("id", id);

  revalidatePath("/admin/companies");
  return { success: true, data: undefined };
}

export async function deleteCompany(id: string): Promise<MutationResult<undefined>> {
  await requireSuperAdmin();

  const supabase = createServiceClient();

  // Resolve the auth user_id BEFORE deleting the companies row — once the row
  // is gone we lose the link.
  const { data: row } = await supabase
    .from("companies")
    .select("user_id")
    .eq("id", id)
    .maybeSingle();
  const userId = (row as { user_id: string | null } | null)?.user_id ?? null;

  // Delete the companies row first; cascade in the schema removes
  // company_members. If this fails, abort before touching the auth user.
  const { error: delErr } = await supabase.from("companies").delete().eq("id", id);
  if (delErr) return { success: false, error: delErr.message };

  if (userId) {
    // Best-effort auth-user cleanup. We don't fail the action if this throws —
    // the companies row is already gone so the contract is fulfilled.
    await supabase.auth.admin.deleteUser(userId);
  }

  revalidatePath("/admin/companies");
  return { success: true, data: undefined };
}

// ── Background queue (cross-company, super-admin only) ───────

/*
 * ── How the cross-company read is made safe ──
 *
 * background_jobs carries a company_id but is DELIBERATELY not scoped by it
 * here: the whole point of this panel is to see one queue across every
 * company, which is why it exists on /admin/companies and nowhere else.
 *
 * The guard is therefore the only thing standing between this data and a
 * tenant, and it is applied in THREE independent places:
 *
 *   1. page.tsx resolves the role and redirects anything that is not
 *      super_admin away from /admin/companies before rendering.
 *   2. Every function below calls requireSuperAdmin(), which throws. That is
 *      the one that actually matters — a server action is a POST endpoint and
 *      is reachable regardless of which page rendered it, so the page-level
 *      redirect protects navigation and nothing else.
 *   3. The reads run through the service client, which is server-only; no
 *      anon or user-scoped client can reach the table at all (RLS is on with
 *      no policies).
 *
 * A company admin who guesses these action ids gets an exception, not a row.
 */

export async function fetchQueueHealth(): Promise<QueueHealth> {
  await requireSuperAdmin();
  return readQueueHealth();
}

/**
 * Put one dead job back on the queue.
 *
 * ── Why this cannot re-run work that already succeeded ──
 *
 * Two independent reasons, and the first is the one that holds even under a
 * race:
 *
 * 1. The UPDATE is CONDITIONAL — `.eq("status", "dead")` is part of the write,
 *    not a check performed before it. A job that left 'dead' between this page
 *    rendering and the button being pressed simply matches no row, and the
 *    action reports that rather than resurrecting it. Nothing that is queued,
 *    running or succeeded can be touched by this call, whatever id is passed.
 *
 * 2. Every handler is itself idempotent, so even a genuine double-run is a
 *    no-op rather than duplicated work: handleTranscribe returns early when
 *    transcript_status is already 'done'; send_message skips when its log row
 *    is already queued/sent/skipped/cancelled, so nobody is emailed twice;
 *    ai_cv_score and ai_scorecard upsert on their natural key; both purges are
 *    driven by a selector that stops matching once the row is cleared.
 *
 * attempts resets to 0 so the exponential backoff starts clean rather than
 * from the hour-long ceiling the job died at, and locked_at/locked_by are
 * cleared so no stale lease blocks the claim.
 */
export async function retryDeadJob(
  jobId: string,
): Promise<MutationResult<{ retried: number }>> {
  await requireSuperAdmin();
  if (!jobId) return { success: false, error: "No job specified." };

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("background_jobs")
    .update({
      status: "queued",
      attempts: 0,
      last_error: null,
      run_after: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
    })
    .eq("id", jobId)
    .eq("status", "dead")
    .select("id");

  if (error) return { success: false, error: error.message };
  const retried = (data ?? []).length;
  if (retried === 0) {
    return {
      success: false,
      error: "That job is no longer dead — it may already have been retried.",
    };
  }

  revalidatePath("/admin/companies");
  return { success: true, data: { retried } };
}

/**
 * Put every dead job of one type back on the queue.
 *
 * Same conditional write as the single retry, so the same guarantee holds for
 * every row it touches. Scoped to ONE type on purpose: dead jobs cluster by
 * cause — a missing API key kills every transcribe and nothing else — and a
 * single "retry everything" button would replay unrelated failures whose cause
 * is still present, burning attempts and putting them straight back in dead.
 */
export async function retryDeadJobsOfType(
  type: string,
): Promise<MutationResult<{ retried: number }>> {
  await requireSuperAdmin();
  if (!type) return { success: false, error: "No type specified." };
  // Only types this build knows about. An arbitrary string here would let a
  // caller reset rows belonging to a handler that no longer exists.
  if (!QUEUE_TYPES.includes(type)) {
    return { success: false, error: "Unknown job type." };
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("background_jobs")
    .update({
      status: "queued",
      attempts: 0,
      last_error: null,
      run_after: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
    })
    .eq("type", type)
    .eq("status", "dead")
    .select("id");

  if (error) return { success: false, error: error.message };
  const retried = (data ?? []).length;
  if (retried === 0) {
    return { success: false, error: "No dead jobs of that type to retry." };
  }

  revalidatePath("/admin/companies");
  return { success: true, data: { retried } };
}
