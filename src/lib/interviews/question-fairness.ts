/**
 * The question fairness check for AI Video Interview job questions (AI-Guided
 * drafting). One pure module, so the server and the wizard apply the same rule:
 *
 *   - every AI draft, before the recruiter sees it (draftAiGuidedQuestions);
 *   - every question saved on a job with AI Video Interview on, recruiter
 *     edits included (buildPatch, jobs/actions.ts), its scoring guide too.
 *
 * A flagged question is blocked with a plain message naming the question and
 * the topic; the recruiter rewords it. Nothing is rewritten for them.
 *
 * ── False positives ──────────────────────────────────────────
 *
 * Many protected words are also ordinary job words. Each topic below is a
 * phrase, not a bare word, and a word that has a common job meaning only
 * counts when the question makes it about the candidate ("your family",
 * "are you married"). So these stand: "national sales team", "international
 * markets", "native mobile app", "healthcare product", "health and safety",
 * "family-owned business", "office politics", "European Union", "SQL UNION",
 * "credit union", "criminal law case", "race condition", "page", "agency",
 * "salary benchmarking", "users with disabilities" (an accessibility role).
 * The list of examples is pinned in question-fairness.test.ts.
 */

/** What the review panel shows when a draft fails, whatever failed. */
export const DRAFT_FAILED = "Couldn't draft questions - please try again.";
/** What it shows when the recruiter has drafted too often (job-question-draft). */
export const DRAFT_RATE_LIMITED =
  "Too many drafts in a short time - please try again in a few minutes.";

export const FAIRNESS_TOPICS = [
  "age",
  "family or marital status",
  "pregnancy",
  "health or disability",
  "religion",
  "nationality or ethnicity",
  "gender",
  "sexuality",
  "political views",
  "union membership",
  "a criminal record",
  "salary history",
  "gaps in employment",
] as const;
export type FairnessTopic = (typeof FAIRNESS_TOPICS)[number];

/**
 * Each rule is a list of phrases. A word with an ordinary job meaning appears
 * only inside a phrase that makes it about the candidate ("your health", "do
 * you have children"), never alone and never after a loose "you ... " gap:
 * "how do you monitor service health" and "how do you navigate office
 * politics" are job questions.
 */
const RULES: readonly (readonly [FairnessTopic, RegExp])[] = [
  [
    "age",
    /\b(?:how old|date of birth|birth ?date|when were you born|year (?:you were|were you) born|your age|what age are you|are you (?:over|under) \d+|too (?:young|old)|digital native|retirement plans|plan(?:ning)? to retire)\b/i,
  ],
  [
    "family or marital status",
    /\b(?:married|marital|spouse|husband|wife|maiden name|start a family|your (?:family|children|kids|childcare|dependants|dependents)|do you have (?:any )?(?:children|kids|dependants|dependents)|are you (?:a )?(?:parent|mother|father|single))\b/i,
  ],
  [
    "pregnancy",
    /\b(?:pregnan\w*|your (?:maternity|paternity|parental) leave|planning (?:a |any )?(?:maternity|paternity|parental) leave|expecting a (?:baby|child))\b/i,
  ],
  [
    "health or disability",
    /\b(?:medical (?:condition|history)|health (?:condition|problem|issue)s?|your (?:own )?(?:health|mental health|physical health|illness|disabilit\w*|medication|sick (?:days|leave))|mental health (?:condition|problem|issue)s?|(?:do|did) you have (?:a |any )?(?:disabilit\w*|impairment|illness|medical condition|health (?:condition|issue|problem)s?)|are you disabled|sick days (?:did )?you)\b/i,
  ],
  [
    "religion",
    /\b(?:religio\w*|pray(?:er|ers|ing)?|church|mosque|synagogue|temple|place of worship|your faith)\b/i,
  ],
  [
    "nationality or ethnicity",
    /\b(?:nationality|national origin|citizenship|ethnic\w*|racial|caste|country of origin|mother tongue|native (?:\w+ )?(?:language|speaker|tongue)|where are you (?:originally )?from|where were you born|your (?:race|accent|home country|origins?))\b/i,
  ],
  [
    "gender",
    /\b(?:male or female|man or (?:a )?woman|gender identity|your (?:gender|sex|pronouns))\b/i,
  ],
  [
    "sexuality",
    /\b(?:sexual orientation|sexuality|gay|lesbian|bisexual|heterosexual|homosexual)\b/i,
  ],
  [
    "political views",
    /\b(?:political (?:party|parties|views?|beliefs?|affiliations?|opinions?|leanings?)|your politics|(?:who|how) did you vote|(?:do|did) you vote)\b/i,
  ],
  [
    "union membership",
    /\b(?:trade union|labou?r union|union member\w*|unioni[sz]\w*|join(?:ed)? a union|(?:are|were) you in a union)\b/i,
  ],
  [
    "a criminal record",
    /\b(?:criminal (?:record|history|background|convictions?)|police record|felon(?:y|ies)|(?:been|ever been) (?:convicted|arrested)|(?:served|been in|spent time in) (?:jail|prison))\b/i,
  ],
  [
    "salary history",
    /\b(?:salary history|(?:current|previous|past|last|present) (?:salary|pay|compensation|wage|earnings)|how much (?:do|did) you (?:earn|make|get paid)|what (?:do|did) you (?:earn|make)|what were you paid)\b/i,
  ],
];

/**
 * Third-person bias and proxy requirements: the way a scoring guide (or a
 * question) slants toward a kind of person without asking them anything.
 * "Prefer candidates who do not have children", "young candidates", "under
 * 30", "recent graduates only", "male candidates", "she will", "native
 * speakers only", "no gaps in employment", "must be single".
 *
 * Each phrase needs a person or a requirement around the word, so these
 * stand: "working with children" (a teaching or childcare role), "graduate
 * program" (the company's own scheme), "native-level English" and "fluent
 * English" (the job needs the language), "over 5 years of experience",
 * "response times under 30 minutes", "single-tenant", "single sign-on", and
 * "a client said he will cancel" (reported speech about someone else).
 */
const THIRD_PERSON_RULES: readonly (readonly [FairnessTopic, RegExp])[] = [
  [
    "age",
    /\b(?:(?:young|younger|youthful|old|older|mature) (?:candidates?|applicants?|people|persons?|hires?|talent|workers?|staff|team members?)\b|(?:candidates?|applicants?|someone|people|persons?|hires?) (?:\w+ ){0,2}(?:under|over|below|above|younger than|older than) (?:the age of )?\d{2}(?: years(?: old| of age))?(?=\s*(?:$|[.,;:!?)]|only\b|and\b|or\b))|(?:under|over|younger than|older than) \d{2} years (?:old|of age)\b|aged (?:between )?\d{2} ?(?:-|to|and) ?\d{2}\b|age (?:limit|range|requirement|cap)\b|recent grad\w* only\b|only recent grad\w*|(?:must|should|needs? to) be (?:a )?recent grad\w*|prefer\w* (?:a )?recent grad\w*|digital natives?\b)/i,
  ],
  [
    "family or marital status",
    /\b(?:(?:without|no|not have|n't have|have no|has no|with no) (?:any |young |small )?(?:children|kids|dependants|dependents|family (?:commitments|responsibilities|obligations|ties))\b(?!['\u2019])|childless|child-free|unmarried|single (?:candidates?|applicants?|people|persons?)\b|(?:must|should|needs? to|has to) be single(?=\s*(?:$|[.,;:!?)]|(?:and|or|to|for|because|so|as|if|since|while|during|at|on)\b))|(?:must|should) not be married)/i,
  ],
  [
    "gender",
    /\b(?:(?:male|female|men|women|man|woman) (?:candidates?|applicants?|hires?|only)\b|(?:prefer\w*|ideally|must be|should be) (?:a )?(?:man|woman|male|female)\b|(?<!\b(?:said|says|promised|claimed|thinks|thought|felt|feels|warned|told us) )(?:she|he) (?:will|should|must|needs? to|has to)\b)/i,
  ],
  [
    "nationality or ethnicity",
    /\b(?:native (?:\w+ )?speakers? (?:only|required|preferred)\b|(?:must|should|needs? to) be (?:a )?native\b(?![- ]level)|native[- ]born)/i,
  ],
  [
    "gaps in employment",
    /\b(?:(?:no|without|any) (?:\w+ )?gaps? in (?:their |your |the |his |her )?(?:employment|career|cv|resume|work history)|(?:employment|career|cv|resume) gaps?\b|gaps? in (?:your|their|his|her|the candidate's) (?:employment|career|cv|resume|work history)|continuous employment)/i,
  ],
];

/**
 * The protected topic this text asks about or slants toward, or null. Questions
 * to the candidate are checked first, then third-person bias; the first rule
 * that matches wins.
 */
export function questionFairnessIssue(text: string): FairnessTopic | null {
  const t = (text ?? "").replace(/\s+/g, " ");
  if (!t.trim()) return null;
  for (const [topic, pattern] of RULES) if (pattern.test(t)) return topic;
  for (const [topic, pattern] of THIRD_PERSON_RULES) if (pattern.test(t)) return topic;
  return null;
}

const quote = (text: string) => {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

/** The message shown for a blocked question: names it and the topic. */
export function fairnessBlockMessage(
  position: number,
  text: string,
  topic: FairnessTopic,
  part: "question" | "scoring guide" = "question",
): string {
  const where = part === "question" ? "" : "'s scoring guide";
  return `Question ${position}${where} ("${quote(text)}") touches on ${topic}, which can't be used to judge a candidate. Please reword it to focus on the job.`;
}

/**
 * The first block among these questions, in order, or null when all are fine.
 * Blank questions are skipped (they are dropped on save). The scoring guide is
 * checked too: it is how every answer is marked.
 */
export function firstFairnessBlock(
  questions: readonly { question?: string | null; rubric?: string | null }[],
): string | null {
  let position = 0;
  for (const q of questions) {
    const text = (q?.question ?? "").trim();
    if (!text) continue;
    position += 1;
    const topic = questionFairnessIssue(text);
    if (topic) return fairnessBlockMessage(position, text, topic);
    const guide = (q?.rubric ?? "").trim();
    const guideTopic = questionFairnessIssue(guide);
    if (guideTopic) return fairnessBlockMessage(position, text, guideTopic, "scoring guide");
  }
  return null;
}
