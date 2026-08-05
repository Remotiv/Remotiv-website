"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  getCompanyContext,
  requireCompanyRole,
} from "@/app/ai-dashboard/lib/company-guards";
import {
  buildPlaceholders,
  PLACEHOLDER_KEYS,
  renderCopy,
} from "@/lib/email/candidate/render";
import {
  defaultTemplate,
  LIFECYCLE_TEMPLATES,
  MANUAL_DEFAULTS,
} from "@/lib/email/candidate/templates";
import type { TemplateRow } from "./template-types";

// NB: a "use server" module may only export async functions — every export is
// compiled into a server action. Shapes live in ./template-types.ts.

type MutationResult<T = undefined> =
  | { success: true; data: T }
  | { success: false; error: string };

const SUBJECT_MAX = 200;
const BODY_MAX = 20_000;

/** Every `{{ token }}` in a string, lowercased. */
const TOKEN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

/**
 * Reject tokens the renderer cannot fill.
 *
 * renderTemplate silently replaces an unknown token with an empty string. That
 * is right at SEND time — a candidate must never receive a raw `{{ }}` — and
 * wrong at EDIT time, where the same silence means a company writes
 * "{{hiring_manager}}" today and discovers a sentence with a hole in it weeks
 * later, in mail that has already gone out. So it is a hard failure here, and
 * the message names the token and lists what is available.
 */
function unknownPlaceholders(...parts: string[]): string[] {
  const known = new Set(PLACEHOLDER_KEYS as readonly string[]);
  const bad = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(TOKEN)) {
      const key = (match[1] ?? "").toLowerCase();
      if (!known.has(key)) bad.add(match[1] ?? "");
    }
  }
  return [...bad];
}

/**
 * An unclosed or malformed brace pair.
 *
 * `{{candidate_first_name}` renders literally — the token regex never matches
 * it — so it reaches the candidate as visible braces. Counting the delimiters
 * catches the typo the placeholder check cannot see.
 */
function hasBrokenBraces(value: string): boolean {
  const opens = (value.match(/\{\{/g) ?? []).length;
  const closes = (value.match(/\}\}/g) ?? []).length;
  return opens !== closes;
}

/**
 * Strip everything a company-authored body must not carry into a candidate's
 * inbox.
 *
 * This is deliverability and sender reputation before it is XSS: the message
 * leaves on Remotiv's verified domain, so a script tag, a tracking pixel or a
 * remote iframe in one tenant's template is a spam complaint against every
 * tenant's mail. Allowing a narrow set of formatting tags and dropping the rest
 * is the only version of this that stays safe as the editor grows.
 *
 * Removed outright, content and all: script, style, iframe, object, embed,
 * link, meta. Everything else keeps its text but loses any tag outside the
 * allow-list, plus every event handler, `javascript:` URL and inline style.
 */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "ul",
  "ol",
  "li",
  "a",
  "blockquote",
]);

function sanitizeBody(html: string): string {
  let out = html.replace(
    /<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
    "",
  );
  // Self-closing or unterminated versions of the same, which the pair above
  // cannot match.
  out = out.replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, "");

  out = out.replace(/<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (_m, close, tag, attrs) => {
    const name = String(tag).toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return "";
    if (close) return `</${name}>`;

    // Only href survives, and only when it is a plain http(s) or mailto link.
    if (name === "a") {
      const href = /href\s*=\s*["']([^"']*)["']/i.exec(String(attrs))?.[1] ?? "";
      const safe = /^(https?:|mailto:)/i.test(href.trim());
      return safe ? `<a href="${href.trim().replace(/"/g, "&quot;")}">` : "<a>";
    }
    return `<${name}>`;
  });

  return out.trim();
}

/**
 * The company's stored override for one template.
 *
 * `templateKey` is null for lifecycle events — one row per event, so the
 * (company_id, event) pair is already unique — and the key for composer
 * templates, which all share event='manual'. Stating the null explicitly is
 * what keeps this maybeSingle() single now that manual rows can be many.
 */
async function ownRow(
  service: ReturnType<typeof createServiceClient>,
  companyId: string,
  event: string,
  templateKey: string | null,
): Promise<{ id: string; subject: string; body: string } | null> {
  let q = service
    .from("message_templates")
    .select("id, subject, body")
    .eq("company_id", companyId)
    .eq("event", event)
    .eq("channel", "email");
  q = templateKey === null ? q.is("template_key", null) : q.eq("template_key", templateKey);
  const { data } = await q.maybeSingle();
  const row = data as { id: string; subject: string | null; body: string | null } | null;
  if (!row?.subject || !row?.body) return null;
  return { id: row.id, subject: row.subject, body: row.body };
}

/**
 * Every template Settings lists, with its Remotiv default alongside whatever
 * the company saved.
 *
 * `customised` is DERIVED by comparing the two, never read from a stored flag.
 * A boolean column drifts from the content the moment anyone edits a row by
 * hand, and then "Revert to Remotiv default" restores something that is no
 * longer the default — the button becomes a lie. Comparing means a company that
 * edits its way back to Remotiv's exact wording correctly reads as default.
 *
 * Readable by every role. Editing is gated separately.
 */
export async function fetchTemplateRows(): Promise<TemplateRow[]> {
  const ctx = await getCompanyContext();
  const service = createServiceClient();

  const { data } = await service
    .from("message_templates")
    .select("id, event, template_key, subject, body, created_at")
    .eq("company_id", ctx.companyId)
    .eq("channel", "email")
    .order("created_at", { ascending: true })
    .limit(200);

  type Saved = {
    event: string;
    template_key: string | null;
    subject: string | null;
    body: string | null;
  };
  const saved = (data ?? []) as Saved[];

  /** Lifecycle overrides, keyed by event. These carry a null template_key. */
  const own = new Map<string, { subject: string; body: string }>();
  /** Composer overrides and company-authored ones, keyed by template_key. */
  const ownManual = new Map<string, { subject: string; body: string }>();

  for (const r of saved) {
    if (!r.subject || !r.body) continue;
    if (r.event === "manual") {
      const key = (r.template_key ?? "").trim();
      if (key) ownManual.set(key, { subject: r.subject, body: r.body });
    } else {
      own.set(r.event, { subject: r.subject, body: r.body });
    }
  }

  const rows: TemplateRow[] = LIFECYCLE_TEMPLATES.map((t) => {
    const def = defaultTemplate(t.event);
    const saved = own.get(t.event) ?? null;
    return {
      key: t.event,
      group: "automatic" as const,
      name: t.name,
      trigger: t.trigger,
      sending: t.sending,
      editable: true,
      defaultSubject: def?.subject ?? "",
      defaultBody: def?.body ?? "",
      subject: saved?.subject ?? def?.subject ?? "",
      body: saved?.body ?? def?.body ?? "",
      customised:
        saved !== null &&
        (saved.subject !== def?.subject || saved.body !== def?.body),
    };
  });

  // Shipped composer templates, each showing whichever copy is in force.
  for (const m of MANUAL_DEFAULTS) {
    const override = ownManual.get(m.id);
    rows.push({
      key: m.id,
      group: "manual",
      name: m.label,
      trigger: "Available in the composer",
      sending: true,
      editable: true,
      defaultSubject: m.subject,
      defaultBody: m.body,
      subject: override?.subject ?? m.subject,
      body: override?.body ?? m.body,
      customised:
        override !== undefined &&
        (override.subject !== m.subject || override.body !== m.body),
    });
  }

  /*
   * Company-authored templates have no Remotiv default behind them, so
   * "Customised" is not a comparison — the whole row is theirs. Revert would
   * have nothing to restore, so the editor disables it and offers Delete.
   */
  const shipped = new Set(MANUAL_DEFAULTS.map((m) => m.id));
  for (const [key, t] of ownManual) {
    if (shipped.has(key)) continue;
    rows.push({
      key,
      group: "manual",
      name: t.subject.slice(0, 60) || "Untitled template",
      trigger: "Available in the composer",
      sending: true,
      editable: true,
      ownAuthored: true,
      defaultSubject: "",
      defaultBody: "",
      subject: t.subject,
      body: t.body,
      customised: true,
    });
  }

  return rows;
}

/**
 * Resolve a Settings row key to the (event, template_key) pair it stores as.
 *
 * Lifecycle events are one-per-event and carry a NULL key — the existing
 * (company_id, event) lookup is already unique for them, so nothing about the
 * automatic path changes. Composer templates all share event='manual' and are
 * told apart only by the key.
 */
function locate(
  key: string,
): { event: string; templateKey: string | null; def: { subject: string; body: string } | null } | null {
  const lifecycle = LIFECYCLE_TEMPLATES.find((t) => t.event === key);
  if (lifecycle) {
    return { event: lifecycle.event, templateKey: null, def: defaultTemplate(lifecycle.event) };
  }

  const shipped = MANUAL_DEFAULTS.find((m) => m.id === key);
  if (shipped) {
    return {
      event: "manual",
      templateKey: shipped.id,
      def: { subject: shipped.subject, body: shipped.body },
    };
  }

  // A company-authored template. `custom:` is the only prefix a client may
  // introduce — a `default:` key that is not in MANUAL_DEFAULTS is a forged or
  // stale key and is refused rather than silently creating an orphan row.
  if (key.startsWith("custom:") && key.length > 7 && key.length <= 80) {
    return { event: "manual", templateKey: key, def: null };
  }
  return null;
}

/** Validate the shared rules and return the sanitised body. */
function vet(
  subject: string,
  rawBody: string,
): { ok: true; subject: string; body: string } | { ok: false; error: string } {
  const s = (subject ?? "").trim();
  if (!s) return { ok: false, error: "Add a subject line." };
  if (s.length > SUBJECT_MAX) {
    return { ok: false, error: `Subject is over ${SUBJECT_MAX} characters.` };
  }

  const b = (rawBody ?? "").trim();
  if (!b) return { ok: false, error: "Write a message." };
  if (b.length > BODY_MAX) {
    return {
      ok: false,
      error: `Message is over the ${BODY_MAX.toLocaleString()} character limit.`,
    };
  }

  if (hasBrokenBraces(s) || hasBrokenBraces(b)) {
    return {
      ok: false,
      error:
        "A placeholder isn't closed properly. Every one needs two braces on both sides, like {{job_title}}.",
    };
  }

  const unknown = unknownPlaceholders(s, b);
  if (unknown.length > 0) {
    const list = unknown.map((u) => `{{${u}}}`).join(", ");
    return {
      ok: false,
      error: `${list} ${unknown.length === 1 ? "isn't a placeholder we can fill" : "aren't placeholders we can fill"} — ${unknown.length === 1 ? "it" : "they"} would send as nothing. Available: ${PLACEHOLDER_KEYS.map((k) => `{{${k}}}`).join(", ")}.`,
    };
  }

  const body = sanitizeBody(b);
  if (!body) return { ok: false, error: "That message has no content we can send." };
  return { ok: true, subject: s, body };
}

/**
 * What this template will actually send.
 *
 * Runs the SAME steps as the dispatcher, in the same order: sanitise the body
 * exactly as saving would store it, then renderCopy against resolved values.
 * The preview is therefore a rendering of the stored-and-sent form rather than
 * of the textarea — the earlier client-side preview showed neither, so a body
 * whose tags sanitisation strips, or a token that renders as nothing, looked
 * fine on screen and arrived different.
 *
 * The candidate is sample data; the company name is the real one, because that
 * is what a candidate would read. Returned as plain text for display.
 */
export async function previewTemplate(input: {
  subject: string;
  body: string;
}): Promise<{ subject: string; body: string }> {
  const ctx = await getCompanyContext();

  const values = buildPlaceholders({
    firstName: "Fatima",
    lastName: "Khan",
    jobTitle: "Senior Frontend Engineer",
    companyName: ctx.company.name,
  });

  const rendered = renderCopy(
    { subject: input.subject ?? "", body: sanitizeBody(input.body ?? "") },
    values,
  );

  return { subject: rendered.subject, body: htmlToReadable(rendered.body) };
}

/** Collapse rendered HTML to what a mail client shows as text. */
function htmlToReadable(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Save a company override.
 *
 * Saving copy identical to Remotiv's DELETES the row instead of storing a
 * duplicate, so it falls back to the default and reads as such — the same
 * reason Revert deletes rather than copying text in. A company-authored
 * template has no default to match, so it is always stored.
 */
export async function saveTemplate(input: {
  event: string;
  subject: string;
  body: string;
}): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");
  const service = createServiceClient();

  const target = locate(input.event);
  if (!target) return { success: false, error: "That template can't be edited." };

  const vetted = vet(input.subject, input.body);
  if (!vetted.ok) return { success: false, error: vetted.error };

  const matchesDefault =
    target.def !== null &&
    vetted.subject === target.def.subject &&
    vetted.body === target.def.body;

  if (matchesDefault) {
    let del = service
      .from("message_templates")
      .delete()
      .eq("company_id", ctx.companyId)
      .eq("event", target.event)
      .eq("channel", "email");
    del =
      target.templateKey === null
        ? del.is("template_key", null)
        : del.eq("template_key", target.templateKey);
    await del;
    revalidatePath("/ai-dashboard/settings");
    return { success: true, data: undefined };
  }

  const existing = await ownRow(service, ctx.companyId, target.event, target.templateKey);
  const { error } = existing
    ? await service
        .from("message_templates")
        .update({
          subject: vetted.subject,
          body: vetted.body,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .eq("company_id", ctx.companyId)
    : await service.from("message_templates").insert({
        company_id: ctx.companyId,
        event: target.event,
        channel: "email",
        template_key: target.templateKey,
        subject: vetted.subject,
        body: vetted.body,
        is_default: false,
      });

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/settings");
  return { success: true, data: undefined };
}

/**
 * Drop the company's override, or delete a template they wrote themselves.
 *
 * DELETES the row rather than writing today's default text into it. Copying
 * would freeze the wording at this moment, so every later improvement Remotiv
 * makes to that template would stop reaching the company — they would be on a
 * private copy they never chose to author.
 */
export async function revertTemplate(
  event: string,
): Promise<MutationResult<undefined>> {
  const ctx = await requireCompanyRole("owner", "admin");
  const service = createServiceClient();

  const target = locate(event);
  if (!target) return { success: false, error: "That template can't be edited." };

  let del = service
    .from("message_templates")
    .delete()
    .eq("company_id", ctx.companyId)
    .eq("event", target.event)
    .eq("channel", "email");
  del =
    target.templateKey === null
      ? del.is("template_key", null)
      : del.eq("template_key", target.templateKey);

  const { error } = await del;
  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/settings");
  return { success: true, data: undefined };
}

/**
 * Create a company-authored composer template.
 *
 * The key is generated SERVER-side as `custom:<uuid>` and never taken from the
 * client. Two things follow: a collision with a shipped `default:` key is
 * impossible because the namespaces are disjoint by prefix, and a client cannot
 * claim a key belonging to another template — locate() refuses any `default:`
 * key that is not in MANUAL_DEFAULTS.
 */
export async function createManualTemplate(): Promise<MutationResult<{ key: string }>> {
  const ctx = await requireCompanyRole("owner", "admin");
  const service = createServiceClient();

  const key = `custom:${randomUUID()}`;
  const { error } = await service.from("message_templates").insert({
    company_id: ctx.companyId,
    event: "manual",
    channel: "email",
    template_key: key,
    subject: "Untitled template",
    body: "Hi {{candidate_first_name}},\n\n",
    is_default: false,
  });

  if (error) return { success: false, error: error.message };

  revalidatePath("/ai-dashboard/settings");
  return { success: true, data: { key } };
}
