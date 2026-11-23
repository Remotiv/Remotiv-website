/**
 * #74 part 2: with no re-render after a note save, the dashboard's own list is
 * what a reopened drawer reads. Save, close, reopen: the NEW note. A failed
 * save leaves the list alone: the OLD note.
 *
 *   node --test src/app/admin/talent/talent-note-reopen.test.ts
 *
 * The shipped TalentDashboard is server-rendered with the drawer open on a
 * profile taken from the list (reopening the drawer is exactly that: the
 * drawer mounts and reads profile.notes into its text box). withSavedNote is
 * the shipped list update; that the drawer calls it on success only is
 * pinned in talent-refresh.test.ts (D3). There is no DOM library in this repo,
 * so the click itself is not simulated. Synthetic data.
 */
// @ts-nocheck - same reason as the other node:test files.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("../../../test-support/node-resolve.mjs", import.meta.url));
register(new URL("../../../test-support/tsx-load.mjs", import.meta.url));
register(
  `data:text/javascript,${encodeURIComponent(`
const STUBS = {
  "next/navigation": "export function useRouter() { throw new Error('no router on the Talent page'); } export function usePathname() { return '/admin/talent'; } export function useSearchParams() { return new URLSearchParams(); }",
  "next/image": "export default function Image(p) { return globalThis.__createElementForTests('img', { src: p.src, alt: p.alt }); }",
  "next/dynamic": "export default function dynamic() { return function Dynamic() { return null; }; }",
  "./top-nav": "export function TopNav() { return null; }",
  "@/app/admin/talent/actions": ["updateTalentStatus", "setTalentFlag", "saveTalentNote", "deleteTalentProfile", "fetchTalentInviteStatuses", "sendClaimInvites"].map((n) => "export async function " + n + "() { throw new Error('not called during render'); }").join("\\n"),
};
export async function resolve(specifier, context, next) {
  const stub = STUBS[specifier];
  if (stub !== undefined) {
    return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
  }
  return next(specifier, context);
}
`)}`,
);

const { createElement } = await import("react");
globalThis.__createElementForTests = createElement;
const { renderToString } = await import("react-dom/server");
const { TalentDashboard, withSavedNote } = await import("../_components/talent-dashboard.tsx");

const OPEN = "t0000000-0000-0000-0000-00000000a001";
const OTHER = "t0000000-0000-0000-0000-00000000a002";

const profile = (id, notes) => ({
  id,
  first_name: "Synthetic",
  last_name: id.slice(-4),
  email: `${id.slice(-4)}@example.invalid`,
  phone: null,
  city: "Lahore",
  country: "Pakistan",
  linkedin_url: null,
  github_url: null,
  job_title: "Engineer",
  role_category: "Engineering",
  years_experience: 4,
  industry: null,
  degree: null,
  institution: null,
  skills: ["Kotlin"],
  experience: [],
  summary: "Builds apps.",
  availability: null,
  work_type: null,
  notice_period: null,
  work_location: null,
  salary_min: null,
  salary_max: null,
  avatar_url: "/avatars/male-001.webp",
  cv_url: null,
  cv_path: null,
  status: "approved",
  is_shortlisted: false,
  is_placed: false,
  is_paused: false,
  is_archived: false,
  approved_at: "2026-10-02T00:00:00Z",
  claimed_at: null,
  user_id: null,
  notes,
  created_at: "2026-10-01T00:00:00Z",
});

const OLD = "Old synthetic note.";
const NEW = "New synthetic note.";
const LIST = [profile(OPEN, OLD), profile(OTHER, "Untouched note.")];

/** The drawer opened on `openId`, reading its note from `profiles`. */
const reopen = (profiles, openId = OPEN) =>
  renderToString(
    createElement(TalentDashboard, {
      email: "admin@example.invalid",
      userRole: "super_admin",
      initialProfiles: profiles,
      initialOpenId: openId,
      initialSearch: "",
    }),
  );

/** The drawer's note box, and only it. */
const noteBox = (html) => {
  const boxes = [...html.matchAll(/<textarea[^>]*>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]);
  assert.equal(boxes.length, 1, "exactly one note box: the drawer is open");
  return boxes[0];
};

test("N1. before any save, the drawer shows the stored note (the render path is real)", () => {
  assert.equal(noteBox(reopen(LIST)), OLD);
});

test("N2. save, close, reopen: the drawer shows the NEW note, stored by trimToNull", () => {
  const afterSave = withSavedNote(LIST, OPEN, `  ${NEW}  `);
  assert.equal(noteBox(reopen(afterSave)), NEW);
  assert.equal(afterSave.find((p) => p.id === OPEN).notes, NEW, "trimmed like the server");
});

test("N3. a failed save leaves the list alone: reopen shows the OLD note", () => {
  // On failure the drawer never calls onNoteSaved (D3), so the list is LIST.
  assert.equal(noteBox(reopen(LIST)), OLD);
});

test("N4. withSavedNote: a blank note is stored as none, and no other profile changes", () => {
  const cleared = withSavedNote(LIST, OPEN, "   ");
  assert.equal(cleared.find((p) => p.id === OPEN).notes, null);
  assert.equal(noteBox(reopen(cleared)), "");
  assert.equal(cleared[1], LIST[1], "the other profile is the same object");
  assert.equal(noteBox(reopen(withSavedNote(LIST, OPEN, NEW), OTHER)), "Untouched note.");
});
