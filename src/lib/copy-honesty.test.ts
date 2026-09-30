/**
 * Phase 7 source pins: user-facing copy the code disproved.
 *
 * Every assertion here exists because a string in the product claimed something
 * the implementation does not do. Each test pins BOTH directions - the false
 * sentence is gone, and the true one is present - because a copy fix is undone
 * by an ordinary edit, not by a failing build. Several also pin the code fact
 * the wording rests on, so that changing the behaviour without the words (or
 * the words without the behaviour) fails here.
 *
 *   node --test src/lib/copy-honesty.test.ts
 */
// @ts-nocheck — same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const flow = src("../app/interview/[token]/_flow.tsx");
const applyModal = src("../app/jobs/_apply-modal.tsx");
const signup = src("../app/signup/signup-client.tsx");
const remotivJob = src("../app/jobs/[slug]/_remotiv-detail.tsx");
const talentSignup = src("../app/join-as-talent/page.tsx");
const freelancerSignup = src("../app/join-as-freelancer/page.tsx");
const settings = src("../app/ai-dashboard/(gated)/settings/_settings-client.tsx");
const templatesCard = src("../app/ai-dashboard/(gated)/settings/_templates-card.tsx");
const team = src("../app/ai-dashboard/(gated)/team/_team-client.tsx");
const panel = src("../app/ai-dashboard/(gated)/applicants/_interview-panel.tsx");
const roles = src("../app/ai-dashboard/lib/company-roles.ts");
const applicants = src("../app/ai-dashboard/(gated)/applicants/_applicants-client.tsx");
const interviewsList = src("../app/ai-dashboard/(gated)/interviews/_interviews-client.tsx");
const review = src("../app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx");
const privacy = src("../app/privacy/page.tsx");
const aiResults = src("../app/ai-results/page.tsx");
const aviPage = src("../app/ai-video-interviews/page.tsx");
const browse = src("../app/browse-talent/_browse-client.tsx");
const staffAug = src("../app/services/staff-augmentation/page.tsx");
const vetting = src("../components/home/vetting-process.tsx");
const aiRecruiter = src("../components/home/ai-recruiter.tsx");
const notify = src("./calendar/notify.ts");
const claimVerification = src("./email/templates/claim-verification.ts");

/* ── The candidate's interview ──────────────────────────────── */

test("C7-01: the Submitted screen promises no email that the code will not send", () => {
  assert.doesNotMatch(flow, /hear back by email either way/);
  assert.match(flow, /If the hiring team sends an update, it will arrive by email from Remotiv/);
  // The code fact: the only automated stage mail is the rejection, per job.
  const triggers = src("./email/candidate/triggers.ts");
  assert.match(triggers, /send_rejection_email\b/);
  assert.match(triggers, /=== true/);
});

test("C7-03: the consent card threatens no AI-use detection, because none exists", () => {
  assert.doesNotMatch(flow, /easy to spot/);
  assert.doesNotMatch(flow, /counts against you/);
  assert.match(
    flow,
    /Please don&apos;t read from a script or an AI tool|Please don't read from a script or an AI tool/,
  );
  // Nothing anywhere scores or flags AI assistance.
  const scoring = src("./ai/interview-scoring.ts");
  assert.doesNotMatch(scoring, /plagiaris|ai[-_ ]?detect|authenticity/i);
});

test("N3: the scoring row is conditional on the flag; the recording row is not", () => {
  // Scoring is env-gated, so the row may not assert it unconditionally.
  assert.doesNotMatch(flow, /Answers are transcribed and scored/);
  assert.match(flow, /Answers are transcribed\. Where AI scoring is enabled/);
  assert.doesNotMatch(flow, /lead="AI scores, a person decides"/);
  const scoring = src("./ai/interview-scoring.ts");
  assert.match(scoring, /AI_INTERVIEW_SCORING_ENABLED/);
  // Being recorded is unconditional and must stay that way: no hedge in the
  // recording row's lead or body, and the agreement still names recording.
  assert.match(flow, /lead="You're being recorded"/);
  assert.match(
    flow,
    /body=\{`Your video answers are saved and shared with \$\{companyName\}'s hiring team\.`\}/,
  );
  assert.match(flow, /I understand and agree to be recorded\./);
  const recordingRow = flow.slice(
    flow.indexOf(`lead="You're being recorded"`),
    flow.indexOf(`lead="A person makes the decision"`),
  );
  assert.ok(recordingRow.length > 0, "the two rows are in the expected order");
  assert.doesNotMatch(recordingRow, /Where|where|may |if |unless /);
});

test("C7-24: the consent card names the processors that receive the interview", () => {
  assert.match(flow, /Transcribing is done for us by OpenAI, and any AI scoring by Anthropic/);
  assert.match(flow, /href="\/privacy"/);
  assert.match(flow, /^import Link from "next\/link";$/m);
});

/* ── Applying ───────────────────────────────────────────────── */

test("C7-04: nothing points a candidate at a Terms document that does not exist", () => {
  assert.doesNotMatch(applyModal, /agree to Remotiv&apos;s terms/);
  assert.doesNotMatch(signup, /agree to our Terms/);
  assert.match(applyModal, /Your application is handled as described in our/);
  assert.match(signup, /By signing up, you agree to our\{" "\}/);
  for (const [name, text] of [
    ["apply modal", applyModal],
    ["signup", signup],
  ]) {
    assert.match(text, /href="\/privacy"/, `${name} links to the policy that does exist`);
  }
});

test("C7-05: a Remotiv-owned job promises no AI screen, because none runs", () => {
  assert.doesNotMatch(remotivJob, /AI \+ human screen/);
  assert.match(remotivJob, /title: "Human screen"/);
  // The gate that makes it true: scoring is queued only with a company.
  const applyRoute = src("../app/api/apply/route.ts");
  assert.match(applyRoute, /if \(resolvedJobId && companyIdSnapshot\)/);
});

/* ── Signing up as talent ───────────────────────────────────── */

test("C7-09/C7-09b: both signup flows disclose that an approved profile is public", () => {
  for (const [name, text] of [
    ["talent", talentSignup],
    ["freelancer", freelancerSignup],
  ]) {
    assert.doesNotMatch(text, /only shared with matched employers/, `${name}: old footer survives`);
    assert.doesNotMatch(text, /stays private until matched/, `${name}: old step header survives`);
    assert.match(
      text,
      /If approved, your profile page is public\./,
      `${name}: no footer disclosure`,
    );
    assert.match(text, /anyone with the link can open/, `${name}: no public-page disclosure`);
    assert.match(text, /public page on remotiv\.work/, `${name}: no success-screen disclosure`);
    // The indexing claim is gone deliberately. The visibility work set
    // `robots: index false` on profile pages and removed them from the
    // sitemap, so telling an applicant that search engines can index their
    // profile would now be the false half of a true sentence.
    assert.doesNotMatch(text, /search engines can index/, `${name}: stale indexing claim`);
  }
  // The CV claim on the talent flow's upload step was the fourth false one.
  assert.doesNotMatch(talentSignup, /reviewed by our team and matched employers/);
  assert.match(talentSignup, /shared with companies\s+hiring on Remotiv/);
  // The code fact the disclosure rests on: approval alone still makes the page
  // readable by anyone holding the link. The gate moved out of the query and
  // into the shared predicate, so it is pinned there now rather than as a
  // PostgREST filter on this page.
  const publicProfile = src("../app/talent/[id]/page.tsx");
  assert.match(publicProfile, /isTalentPublic\(/);
  assert.match(publicProfile, /kind: "public"/);
  const visibility = src("./talent-visibility.ts");
  assert.match(visibility, /row\.approved_at !== null/);
  // De-indexed, so the sitemap no longer advertises these pages.
  const sitemap = src("../app/sitemap.ts");
  assert.doesNotMatch(sitemap, /from\("talent_profiles"\)/);
});

test("C7-09-05: the submit-time agreement is untouched, pending the historical decision", () => {
  assert.match(
    talentSignup,
    /By submitting your profile, you agree that your information may be shared/,
  );
});

test("C7-10: the freelancer profile claims the marketplace, not AI Talent Match", () => {
  assert.doesNotMatch(freelancerSignup, /this powers AI Talent Match/);
  assert.match(freelancerSignup, /this is your public listing/);
  // The talent flow's identical sentence is TRUE and must survive: that flow
  // writes talent_profiles, which is the only table the matcher reads.
  assert.match(talentSignup, /this powers AI Talent Match/);
  const matching = src("./ai-matching.ts");
  assert.match(matching, /from\("talent_profiles"\)/);
  assert.doesNotMatch(matching, /hire_remote_profiles/);
});

/* ── What the recruiter is told ─────────────────────────────── */

test("C7-18/C7-19: Settings lists the mail that really sends automatically", () => {
  assert.doesNotMatch(settings, /no other stage sends anything/);
  assert.match(settings, /No other stage\s+change sends anything on its own/);
  assert.match(settings, /a reminder the day before an interview closes/);
  // And the Interview template says what it does not control.
  assert.match(templatesCard, /template\.key === "interview"/);
  assert.match(templatesCard, /separate wording that this template does not control/);
});

test("C7-20: the Team page invents no interview count and names the unbuilt feature", () => {
  assert.doesNotMatch(team, /0 interviews run this month/);
  assert.doesNotMatch(team, /interviews run this month/);
  assert.doesNotMatch(team, /AI interviews and candidate verification aren&apos;t built yet/);
  assert.match(team, /The live AI interviewer and candidate verification aren&apos;t built yet/);
});

test("C7-21: the drawer does not assert WhatsApp delivery it never awaits", () => {
  assert.doesNotMatch(panel, /Sends a fresh invitation by email and WhatsApp/);
  assert.match(panel, /queues a WhatsApp message as well/);
});

test("C7-28: the unbuilt round is described as unbuilt, not as generating questions", () => {
  assert.doesNotMatch(panel, /Questions are generated from this application/);
  assert.match(panel, /Still in development, so a candidate can&apos;t start this round yet/);
  // The code fact: the send path freezes the job's fixed questions.
  const actions = src("../app/ai-dashboard/(gated)/applicants/interview-actions.ts");
  assert.match(actions, /loadQuestionsSnapshot/);
});

test("C7-32: admin access does not claim billing, which is owner-only", () => {
  assert.doesNotMatch(roles, /admin: "Billing/);
  assert.match(roles, /admin: "Jobs · Applicants · Team"/);
  assert.match(roles, /return role === "owner";/);
});

test("C7-33: the Applicants page describes scoring in the present tense", () => {
  assert.doesNotMatch(applicants, /Your AI recruiter will/);
  assert.doesNotMatch(applicants, /once your recruiter has read each CV/);
  assert.match(applicants, /Each new application is <LimeHighlight>scored against the job/);
  assert.match(applicants, /Ranked by AI score\. Anything without a score sits at the end\./);
  assert.match(applicants, /Newest first\. Scores don't affect this order\./);
});

/* ── Retention ──────────────────────────────────────────────── */

test("C7-25: every retention string is anchored to the invitation, as the data is", () => {
  for (const [name, text] of [
    ["interviews list", interviewsList],
    ["review page", review],
  ]) {
    assert.doesNotMatch(text, /after submission/, `${name}: submission anchor survives`);
    assert.doesNotMatch(text, /Retention starts at submission/, name);
  }
  assert.match(interviewsList, /6 months after the invitation is sent/);
  assert.match(review, /six months after the invitation was sent, as scheduled/);
  assert.match(review, /Retention started when the invitation was sent/);
  assert.match(review, /six months after the invitation was sent\.`/);
  // The null-delete_after branch promises no deletion, because none happens.
  assert.match(review, /No deletion date is recorded for this interview/);
  const purge = src("./interviews/purge.ts");
  assert.match(purge, /\.lte\("delete_after", now\)/);
  // The anchor itself: delete_after is written from invite time.
  const actions = src("../app/ai-dashboard/(gated)/applicants/interview-actions.ts");
  assert.match(actions, /function inviteDates\(\)/);
  assert.match(actions, /getMonth\(\) \+ RETENTION_MONTHS/);
});

test("C7-23/N2: the policy describes what survives a purge and what OpenAI receives", () => {
  assert.match(privacy, /the scorecard is kept with the application after the/);
  assert.match(privacy, /short quotes from your answers that it cites as its\s+evidence/);
  assert.match(privacy, /our record of the emails and messages we sent you/);
  // OpenAI receives the recording, not "the audio": the upload is a webm blob.
  assert.doesNotMatch(privacy, /receives the audio of/);
  assert.match(privacy, /receives the\s+recording of your video interview answers/);
  const transcribe = src("./interviews/transcribe.ts");
  assert.match(transcribe, /video\/webm/);
  // The header inventory names the rows that outlive the purge.
  assert.match(privacy, /interview_answer_scores\s+SURVIVE the interview purge/);
  assert.match(privacy, /communication_logs\s+NOTHING expires these/);
});

/* ── What the buyer is told ─────────────────────────────────── */

test("C7-16: signing up is not sold as unlimited, because the free tier is capped", () => {
  assert.doesNotMatch(aiResults, /Sign up for unlimited AI Talent Match/);
  assert.match(aiResults, /Unlimited search and contact unlock come with a paid plan/);
  assert.match(aiResults, /Checkout is not open yet/);
  const matching = src("./ai-matching.ts");
  assert.match(matching, /const DAILY_LIMIT = 3;/);
});

test("C7-17: the conversational round is labelled in development wherever it is listed", () => {
  assert.doesNotMatch(aviPage, /<span>of them interviews<\/span>/);
  assert.match(aviPage, /<span>interview live today<\/span>/);
  assert.match(aviPage, /Follow-up questions on what the candidate says\. In development\./);
  assert.match(aviPage, /<span className="avi7-frag">in development<\/span>/);
  // Still noindex until the feature ships.
  assert.match(aviPage, /index: false/);
});

test("C7-37: no canonical or JSON-LD url points at the www host, which redirects", () => {
  for (const rel of [
    "../app/services/recruitment/layout.tsx",
    "../app/services/dedicated-team/layout.tsx",
    "../app/services/staff-augmentation/layout.tsx",
    "../app/services/payroll/layout.tsx",
    "../app/services/recruitment/page.tsx",
    "../app/services/dedicated-team/page.tsx",
    "../app/services/staff-augmentation/page.tsx",
    "../app/services/payroll/page.tsx",
  ]) {
    assert.doesNotMatch(src(rel), /https:\/\/www\.remotiv\.work/, rel);
  }
  // The host they must agree with.
  assert.match(src("../app/layout.tsx"), /metadataBase: new URL\("https:\/\/remotiv\.work"\)/);
});

test("C7-13: no surface states a pool size for a set the code queries", () => {
  assert.doesNotMatch(browse, /import \{ MARKETING_STATS \}/);
  assert.doesNotMatch(browse, /<span className="bt-pool-label">Total Candidates<\/span>/);
  assert.doesNotMatch(signup, /import \{ MARKETING_STATS \}/);
  assert.match(signup, /Start browsing our talent pool/);
  assert.doesNotMatch(staffAug, /scans \$\{MARKETING_STATS\.talentPool\} profiles/);
  assert.match(staffAug, /searches our approved talent pool in seconds/);
  assert.match(staffAug, /searches our approved talent pool and surfaces/);
  assert.doesNotMatch(vetting, /1M\+/);
  assert.match(vetting, /searches our approved talent pool/);
  // The homepage says what its engine searches in two places, and they must
  // agree: the vetting section above and the AI-recruiter section.
  assert.doesNotMatch(aiRecruiter, /1M\+/);
  assert.match(aiRecruiter, /Our matching engine searches our approved talent pool/);
});

/* ── Email mechanics ───────────────────────────────────────── */

test("C7-07: the claim link states the life its token actually has", () => {
  assert.doesNotMatch(claimVerification, /expires in 24 hours/);
  assert.match(claimVerification, /This link expires in 7 days\./);
  const invite = src("../app/api/admin/send-invite/route.ts");
  assert.match(invite, /TOKEN_EXPIRY_MS = 7 \* 24 \* 60 \* 60 \* 1000/);
});

test("C7-08a: no booking email invites a reply it sends with no reply-to", () => {
  assert.doesNotMatch(notify, /reply to this email/i);
  assert.match(notify, /Your booking link no longer works/);
  // The reason it would be false: these sends carry no Reply-To.
  assert.match(notify, /replyTo: null/);
});
