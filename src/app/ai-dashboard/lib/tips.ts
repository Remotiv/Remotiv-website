/**
 * Contextual tips, and the guides the Help launcher lists.
 *
 * Existing workspaces learned this dashboard before several features shipped,
 * so each tip appears once where the feature lives and stays reachable from
 * Help afterwards. One catalogue holds both: the tip on the page and the guide
 * in the panel read the SAME words, because a Help entry that paraphrases the
 * tip it reopens is a second copy to keep true.
 *
 * Pure data — no server imports — so the client panel and the server pages can
 * both hold it. Persistence lives in `tip-state.ts` (read) and
 * `(gated)/tip-actions.ts` (write).
 */

/** One key per tip. Stored verbatim in company_member_tips.tip_key. */
export type TipKey = "team_role_access" | "welcome" | "cv_scoring";

/**
 * Every key, including any that are not guides.
 *
 * Kept beside the type rather than derived from GUIDES: `welcome` is a modal,
 * not a card on a page, and a key list built from the guide catalogue would
 * silently stop accepting it the day the welcome guide is reworded away.
 */
const TIP_KEYS: ReadonlyArray<TipKey> = ["team_role_access", "welcome", "cv_scoring"];

/**
 * What the product does, one line per feature, for the welcome modal.
 *
 * Every line is checked against the code it describes and says only what is
 * true today:
 *
 *   scoring      — cv-scoring.ts sends the job, its must-haves and the
 *                  screening answers, and requires a CV quote behind a
 *                  strength; adjustScore writes human_adjusted_score alone, so
 *                  the OVERALL is overridable and the four dimensions are not.
 *                  The line claims only the overall.
 *
 *                  "Every NEW application" is load-bearing, not filler. Scoring
 *                  failed silently in production for some time, so 34 of 3,015
 *                  applications carry a score and the backlog is deliberately
 *                  not being re-scored: ~20 hours of queue for applications
 *                  nobody is likely to reopen. Drop the word and the first
 *                  thing a reader does after closing this modal - open
 *                  Applicants - contradicts it.
 *   interviews   — SESSION_EXPIRY_DAYS is 5, DEFAULT_ANSWER_SECONDS is 120,
 *                  and the candidate records alone from an emailed link.
 *                  "Structured", never "AI interviews": nothing conducts the
 *                  conversation, and no model speaks to a candidate.
 *   scorecards   — stated plainly, because production now does it:
 *                  AI_INTERVIEW_SCORING_ENABLED is exactly "true" there,
 *                  OPENAI_API_KEY is set, and a re-score has run end to end.
 *                  This line was conditional until that was confirmed.
 *
 *                  scoringEnabled() is UNCHANGED and still gates the work. The
 *                  copy describes the deployment, not the gate: a deployment
 *                  with the variable unset still refuses to score, and the
 *                  review page still says "This interview wasn't scored. The
 *                  recording is unaffected." If the variable is ever cleared,
 *                  this line is the thing that stops being true - not the code.
 *   booking      — BUFFER_MS in calendar/availability.ts is 15 minutes, applied
 *                  to the busy side of real provider free/busy. The line says
 *                  "availability" rather than "free/busy" because the reader is
 *                  a recruiter, and only once, because the sentence already
 *                  ends on "your calendar" and the heading above it is
 *                  "Calendar booking".
 *   access       — getJobScope: owner/admin unscoped, the other two narrowed to
 *                  job_hiring_team membership.
 */
export type WelcomeFeatureId = "cv" | "interviews" | "scorecards" | "booking" | "access";

/** `id` carries the icon choice in the modal — never the index, never the title. */
export type WelcomeFeature = { id: WelcomeFeatureId; title: string; line: string };

export const WELCOME_FEATURES: ReadonlyArray<WelcomeFeature> = [
  {
    id: "cv",
    title: "AI CV scoring",
    line: "Every new application is scored against the job, its must-haves and the screening answers, with quotes from the CV as evidence - and you can override the overall score.",
  },
  {
    id: "interviews",
    title: "Structured video interviews",
    line: "Send a set of questions by email and the candidate records their answers alone: five days to respond, two minutes an answer by default, nobody on a call.",
  },
  {
    id: "scorecards",
    title: "Interview scorecards",
    line: "Answers play back question by question for whoever is reviewing, each with its score, its reasoning and its evidence, and a chip that jumps to the moment a quote came from.",
  },
  {
    id: "booking",
    title: "Calendar booking",
    line: "Candidates book themselves from your real availability, with a fifteen-minute buffer around everything already in your calendar.",
  },
  {
    id: "access",
    title: "Role-based access",
    line: "Owners and admins see the whole workspace; recruiters and hiring managers see only the jobs they have been added to.",
  },
];

export type Guide = {
  key: TipKey;
  /** Heading on the tip card and the title in the Help panel. */
  title: string;
  /** Where the tip itself appears, so the panel can say where it came from. */
  where: string;
  /** Paragraphs, in order. */
  body: readonly string[];
};

/**
 * The guides, in the order the panel lists them.
 *
 * Only tips that have shipped appear. An entry for a tip that does not exist
 * yet would be a promise in the product's own Help panel, and the panel says
 * plainly that more arrive as features ship rather than listing them early.
 */
export const GUIDES: ReadonlyArray<Guide> = [
  {
    key: "welcome",
    title: "What Remotiv does",
    where: "Overview",
    // Derived, not retyped. The modal and this entry are the same five lines,
    // so the list a reader reopens cannot drift from the one they were shown.
    body: WELCOME_FEATURES.map((f) => `${f.title} - ${f.line}`),
  },
  {
    key: "cv_scoring",
    title: 'What "Adjust score" changes',
    where: "Applicants",
    /*
     * Narrowed to the one fact the Review pane does not already carry. That
     * pane already says the score is advisory and a person decides, shows the
     * Adjust score button, says a re-score uses one AI scoring credit, and once the
     * form is open states "The AI scored 87". After an adjustment it reads
     * "Adjusted to 72 from the AI's 87" beside a Revert to AI score button.
     *
     * So what is invisible BEFORE you act is what the adjustment leaves alone:
     * adjustScore writes human_adjusted_score and nothing else, so the four
     * dimension scores and the model's overall both survive it. Knowing the
     * original survives is what makes the button safe to press.
     */
    body: [
      "It moves the overall number only. The four dimension scores below stay as the model wrote them, and its original overall is kept beside yours.",
    ],
  },
  {
    key: "team_role_access",
    title: "Who sees which jobs",
    where: "Team",
    /*
     * Deliberately not "each person only sees their own role's work" — that is
     * true of two of the four roles and false of the other two, and the wrong
     * half is the half that governs candidate data. Owner and admin are
     * company-wide (getJobScope returns `scoped: false` for them); recruiter
     * and hiring manager are narrowed to job_hiring_team membership, and an
     * unassigned one resolves to an EMPTY job list rather than an absent
     * filter. The second paragraph says that out loud because "sees nothing"
     * is the surprising half and the one people get backwards.
     */
    body: [
      "Owners and admins see every job and applicant in the workspace. Recruiters and hiring managers see only the jobs they have been added to.",
      "Each job's hiring team is what grants that access - a recruiter on no jobs sees nothing rather than everything.",
    ],
  },
];

export function getGuide(key: TipKey): Guide | undefined {
  return GUIDES.find((g) => g.key === key);
}

/** Narrows a string off the wire before it reaches a query. */
export function isTipKey(value: string): value is TipKey {
  return TIP_KEYS.includes(value as TipKey);
}
