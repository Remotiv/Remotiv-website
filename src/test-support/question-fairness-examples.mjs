/**
 * The question fairness check's examples (question-fairness.ts), shared by
 * question-fairness.test.ts and the job save test (ai-guided-drafts.test.ts).
 */

/** At least two ways of asking each protected topic. */
export const BLOCKED = {
  age: ["How old are you?", "What is your date of birth?", "Are you over 50?"],
  "family or marital status": [
    "Are you married?",
    "Do you have children?",
    "How will your family feel about the travel?",
  ],
  pregnancy: [
    "Are you pregnant or planning a family soon?",
    "Will you need your maternity leave soon?",
  ],
  "health or disability": [
    "Do you have any medical condition we should know about?",
    "Do you have a disability?",
    "How is your mental health?",
  ],
  religion: ["What religion do you practise?", "Do you go to church on Sundays?"],
  "nationality or ethnicity": [
    "What is your nationality?",
    "Where are you originally from?",
    "Are you a native English speaker?",
  ],
  gender: ["Are you male or female?", "What are your pronouns?"],
  sexuality: ["What is your sexual orientation?", "Are you gay?"],
  "political views": ["Which political party do you support?", "Who did you vote for?"],
  "union membership": ["Are you a trade union member?", "Have you ever joined a union?"],
  "a criminal record": ["Do you have a criminal record?", "Have you ever been arrested?"],
  "salary history": ["What is your current salary?", "How much did you earn in your last job?"],
  "gaps in employment": [
    "Why is there a gap in your employment history?",
    "Explain any gaps in your CV.",
  ],
};

/**
 * Third-person bias and proxy requirements, as a recruiter or a model might
 * write them in a question or a scoring guide. [text, topic].
 */
export const BLOCKED_THIRD_PERSON = [
  ["Prefer candidates who do not have children.", "family or marital status"],
  [
    "Best suited to someone without kids who can travel at short notice.",
    "family or marital status",
  ],
  ["The ideal hire must be single.", "family or marital status"],
  ["Applicants must be single to work weekends.", "family or marital status"],
  ["Young candidates will pick this up faster.", "age"],
  ["Score younger candidates higher.", "age"],
  ["Strong answers usually come from candidates under 30.", "age"],
  ["Candidates under 30 years old are preferred.", "age"],
  ["Recent graduates only.", "age"],
  ["Male candidates preferred.", "gender"],
  ["Female candidates only.", "gender"],
  ["She will need to handle late calls with the US team.", "gender"],
  ["He will lead the support rota from day one.", "gender"],
  ["A native speaker is preferred.", "nationality or ethnicity"],
  ["Native speakers only.", "nationality or ethnicity"],
  ["No gaps in employment.", "gaps in employment"],
];

/** Legitimate job topics next to those phrases. Never blocked. */
export const ALLOWED_THIRD_PERSON = [
  "Tell me about your experience working with children in a classroom.",
  "Tell me how you kept children safe on a busy childcare day.",
  "Tell me about a children's education platform you worked on.",
  "Tell me about a healthcare product you helped launch.",
  "Tell me about growing a family-owned business's online sales.",
  "Tell me how you would improve our graduate program for next year's intake.",
  "Fluent English is required for client calls: tell me about a difficult call you led.",
  "Native-level English is needed for client calls: tell me about one you led.",
  "A strong answer shows over 5 years of experience running support teams.",
  "A strong answer gets first-response times under 30 minutes.",
  "The service must be single-tenant: tell me how you would design it.",
  "Tell me about a single sign-on rollout you led.",
  "Tell me about a time a client said he will cancel unless a bug was fixed.",
  "Tell me how you closed a skills gap in your team.",
];

/** Ordinary job questions that share a word with a protected topic. Never blocked. */
export const ALLOWED = [
  "Tell me about leading our national sales team through a reorganisation.",
  "Tell me about a time you opened up international markets for a product.",
  "Tell me about a time you shipped a native mobile app.",
  "Tell me about a healthcare product you helped launch.",
  "Tell me about how you ran health and safety checks on a busy site.",
  "Tell me about growing a family-owned business's online sales.",
  "How do you navigate office politics when priorities clash?",
  "Tell me about a deal you closed with a client in the European Union.",
  "Tell me about a query where you used SQL UNION to combine results.",
  "Tell me about a credit union customer you supported.",
  "Tell me about a criminal law case you prepared for trial.",
  "Tell me about a race condition you found and fixed.",
  "Tell me about a landing page you improved for an agency client.",
  "Tell me about a salary benchmarking project you ran for HR.",
  "Tell me about making an app accessible to users with disabilities.",
  "How do you monitor service health in production?",
  "Tell me about a time you had to retire a legacy service.",
  "Tell me about your relationship with a difficult stakeholder.",
  "Tell me about your background in data engineering.",
  "Tell me about a children's education platform you worked on.",
  "Tell me about the last package you shipped to npm.",
];
