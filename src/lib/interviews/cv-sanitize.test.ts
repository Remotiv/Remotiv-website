/**
 * CV sanitising for the AI Video Interview provider (lib/interviews/cv-sanitize.ts):
 * what must go, what must stay, and that the function is pure. Every name,
 * email, phone number, link and address below is a made-up fixture value.
 *
 *   node --test src/lib/interviews/cv-sanitize.test.ts
 */
// @ts-nocheck - same reason as paging.test.ts: Node's `.ts` specifier vs this tsconfig.
import assert from "node:assert/strict";
import { test } from "node:test";

const { ADDRESS_TAG, EMAIL_TAG, LINK_TAG, PHONE_TAG, sanitizeCvForInterview } = await import(
  "./cv-sanitize.ts"
);

const TAG = { emails: EMAIL_TAG, phones: PHONE_TAG, links: LINK_TAG };
const ZERO = { emails: 0, phones: 0, links: 0, addresses: 0 };

/** [kind, the contact detail] - each is embedded in a sentence before sanitising. */
const MUST_REMOVE = [
  ["emails", "jane.doe@example.com"],
  ["emails", "j_doe+cv@mail.example.co.uk"],
  ["emails", "first.middle.last@company.com.pk"],
  ["emails", "a.b+jobs+2024@example.io"],
  ["emails", "Name.Surname@Company.com.pk"],
  ["emails", "jane [at] example [dot] com"],
  ["emails", "jane(at)example(dot)com"],
  ["emails", "jane at example dot com"],
  ["emails", "jane [at] example.com"],
  // Pakistan
  ["phones", "+92 300 1234567"],
  ["phones", "+92-321-7654321"],
  ["phones", "+923001234567"],
  ["phones", "0300-1234567"],
  ["phones", "0300 1234567"],
  ["phones", "03001234567"],
  ["phones", "(0300) 1234567"],
  ["phones", "(+92) 300 1234567"],
  ["phones", "0092 300 1234567"],
  ["phones", "042-35761234"],
  // United States
  ["phones", "+1 (555) 123-4567"],
  ["phones", "+1 555.123.4567"],
  ["phones", "(555) 123-4567"],
  ["phones", "555-123-4567"],
  ["phones", "555.123.4567"],
  // United Kingdom
  ["phones", "+44 20 7946 0958"],
  ["phones", "+44 7700 900123"],
  ["phones", "020 7946 0958"],
  ["phones", "07700 900123"],
  // United Arab Emirates
  ["phones", "+971 50 123 4567"],
  ["phones", "+971-4-123-4567"],
  ["phones", "050 123 4567"],
  ["phones", "00971 50 123 4567"],
  // Links
  ["links", "https://example.com/cv"],
  ["links", "http://jane.dev"],
  ["links", "www.janedoe.com"],
  ["links", "linkedin.com/in/jane-doe"],
  ["links", "LinkedIn.com/in/jane-doe"],
  ["links", "https://www.linkedin.com/in/jane-doe-12345/"],
  ["links", "github.com/janedoe"],
  ["links", "GitHub.com/janedoe/payments-api"],
  ["links", "janedoe.netlify.app"],
  ["links", "janedoe.github.io"],
  ["links", "janedoe.github.io/payments-demo"],
  ["links", "jane-doe.vercel.app"],
  ["links", "janedoe.wixsite.com/portfolio"],
  ["links", "janedoe.wordpress.com"],
  ["links", "janedoe.blogspot.com"],
  ["links", "janedoe.carrd.co"],
  ["links", "janedoe.notion.site"],
  ["links", "linktr.ee/janedoe"],
  ["links", "about.me/janedoe"],
  ["links", "behance.net/janedoe"],
  ["links", "acme.com/careers"],
];

/** [input, expected]: an address part goes whole; a label stays. */
const ADDRESSES = [
  ["Address: House 12, Street 5, G-10/2, Islamabad", `Address: ${ADDRESS_TAG}`],
  ["Home address - 45 Mall Road, Lahore", `Home address - ${ADDRESS_TAG}`],
  ["Permanent Address: Gulberg III, Lahore", `Permanent Address: ${ADDRESS_TAG}`],
  ["House No. 123, Street 4, Gulberg III, Lahore", ADDRESS_TAG],
  ["H# 12, Block C, DHA Phase 6, Lahore", ADDRESS_TAG],
  ["Flat 4B, Marina Heights, Dubai", ADDRESS_TAG],
  ["Apartment 7, Clifton Block 2, Karachi", ADDRESS_TAG],
  ["Plot 45-B, Industrial Area, Rawalpindi", ADDRESS_TAG],
  ["Street 5, Sector F-7, Islamabad", ADDRESS_TAG],
  ["221B Baker Street, London NW1 6XE", ADDRESS_TAG],
  ["1600 Pennsylvania Avenue NW, Washington, DC 20500", ADDRESS_TAG],
  ["P.O. Box 12345, Dubai, UAE", ADDRESS_TAG],
  // Postcodes on their own: the city and country stay.
  ["Lahore 54000, Pakistan", `Lahore ${ADDRESS_TAG}, Pakistan`],
  ["Karachi, 75500", `Karachi, ${ADDRESS_TAG}`],
  ["Sindh 75500 Pakistan", `Sindh ${ADDRESS_TAG} Pakistan`],
  ["Austin, TX 78701", `Austin, TX ${ADDRESS_TAG}`],
  ["Manchester M1 1AE, UK", `Manchester ${ADDRESS_TAG}, UK`],
];

/** Each is the whole input, and must come back byte-for-byte with nothing counted. */
const MUST_KEEP = [
  "5 years of experience",
  "10+ years of experience",
  "2019-2023",
  "Backend Engineer, 2019-2021",
  "Backend Engineer, 2019 - 2021",
  "Jan 2020 – Present",
  "Jan 2020 - Dec 2021",
  "Started 03/2021",
  "01/2019 - 03/2021",
  "2020-01 - 2021-03",
  "01.2019 - 03.2021",
  "Promoted in 2015 2016 2017",
  "Graduated 1998",
  "Cut latency by 95%",
  "99.9% uptime",
  "Served 5,000 users",
  "Served 50000 users across 12 cities",
  "Raised $2.5M",
  "Screened 2,500 applicants",
  "1,000,000+ requests a day",
  "Expected salary PKR 150,000 - 200,000",
  "Expected salary 150000-200000",
  "ASP.NET, ASP.NET Core and ASP.NET/MVC",
  "VB.NET and ADO.NET",
  "Node.js, Next.js 16, Vue.js/Nuxt.js",
  "C# and .NET 6",
  "Python 3.11",
  "React 18.2.0",
  "Socket.IO and socket.io for realtime",
  "GPA 3.5",
  "CGPA 3.72/4.00",
  "B.Com/M.Com from Lahore",
  "B.Tech in Computer Science",
  // A degree that PDF extraction auto-linked; seen in a real CV.
  "Degree: http://B.Com, Punjab University",
  "ISO 9001 certified",
  "24/7 on-call",
  "Q3 2021 launch",
  "Led the team.In 2019 we shipped",
  "e.g. React, i.e. the frontend",
  "Microsoft Office 365 and Adobe Creative Suite 6",
  "Revenue stayed flat 20% below target",
  "Phase 2 of the migration, Block 3 of training",
  "Analyst at a Wall Street bank",
  "IP address management and DNS",
  "Addressed 200 support tickets a week",
  "Lahore, Pakistan",
  "Remote, based in Karachi",
  // Bare employer and product domains: where someone worked stays.
  "Backend Engineer at acme.com, 2019-2021",
  "Built hiring tools for remotiv.work",
  "Seller integrations for daraz.pk and olx.com.pk",
  "Shipped features on Upwork.com and Fiverr.com",
  "Personal site portfolio.dev",
  "Interned at Systems Ltd (systemsltd.com)",
];

test(`must remove: ${MUST_REMOVE.length} emails, phones and links, each tagged and counted under its own kind`, () => {
  assert.ok(MUST_REMOVE.length >= 50);
  for (const [kind, value] of MUST_REMOVE) {
    const { text, counts } = sanitizeCvForInterview(`Contact: ${value} (any time).`);
    assert.equal(text, `Contact: ${TAG[kind]} (any time).`, value);
    assert.deepEqual(counts, { ...ZERO, [kind]: 1 }, value);
  }
});

test(`addresses: ${ADDRESSES.length} street, unit, P.O. Box, labelled and postcode forms`, () => {
  for (const [input, expected] of ADDRESSES) {
    const { text, counts } = sanitizeCvForInterview(input);
    assert.equal(text, expected, input);
    assert.deepEqual(counts, { ...ZERO, addresses: 1 }, input);
  }
});

test(`must keep: ${MUST_KEEP.length} dates, numbers, money, versions, tech names and employer domains, untouched`, () => {
  assert.ok(MUST_KEEP.length >= 45);
  for (const value of MUST_KEEP) {
    const { text, counts } = sanitizeCvForInterview(value);
    assert.equal(text, value, value);
    assert.deepEqual(counts, ZERO, value);
  }
});

test("a whole CV header: every detail goes, every separator and the rest of the CV stay", () => {
  const cv = [
    "Jane Doe - Senior Backend Engineer",
    "House 12, Street 5, Islamabad | jane.doe+cv@example.com | +92 300 1234567 | 0321-7654321",
    "linkedin.com/in/jane-doe • github.com/janedoe · jane.netlify.app | acme.com",
    "Experience: 2019-2023 at Acme, 5 years, ASP.NET Core and Node.js, served 5,000 users.",
  ].join("\n");
  const { text, counts } = sanitizeCvForInterview(cv);
  assert.deepEqual(counts, { emails: 1, phones: 2, links: 3, addresses: 1 });
  assert.equal(
    text,
    [
      "Jane Doe - Senior Backend Engineer",
      `${ADDRESS_TAG} | ${EMAIL_TAG} | ${PHONE_TAG} | ${PHONE_TAG}`,
      `${LINK_TAG} • ${LINK_TAG} · ${LINK_TAG} | acme.com`,
      "Experience: 2019-2023 at Acme, 5 years, ASP.NET Core and Node.js, served 5,000 users.",
    ].join("\n"),
  );
});

test("a long prose line keeps its words: only the address itself is tagged", () => {
  const line =
    "Moved the delivery team from our old office at 12 Mall Road into a shared space, then led the rollout of the new React and Node.js dispatch system for 40 drivers over 2021.";
  assert.ok(line.length > 160);
  const { text, counts } = sanitizeCvForInterview(line);
  assert.equal(text, line.replace("12 Mall Road", ADDRESS_TAG));
  assert.deepEqual(counts, { ...ZERO, addresses: 1 });
});

test("a CV with no contact details comes back unchanged", () => {
  const cv = [
    "Senior Backend Engineer",
    "",
    "Summary",
    "Backend engineer with 8 years building payment systems in TypeScript and Go.",
    "",
    "Experience",
    "Acme Payments - Lead Engineer (Jan 2020 - Present)",
    "- Cut settlement latency by 95% and kept 99.9% uptime across 3 regions.",
    "- Led a team of 6; shipped the ledger rewrite on Node.js 20 and PostgreSQL 16.",
    "Systems Ltd - Software Engineer (2016-2019)",
    "- Built reporting for 5,000 merchants; ASP.NET Core, C# and .NET 6.",
    "",
    "Education",
    "BS Computer Science, Punjab University, 2012-2016, CGPA 3.72/4.00",
    "",
    "Skills: TypeScript, Go, PostgreSQL, Redis, Kafka, AWS, Docker",
  ].join("\n");
  assert.deepEqual(sanitizeCvForInterview(cv), { text: cv, counts: ZERO });
});

test("labels that are not an address stay; their contents are still sanitised", () => {
  assert.deepEqual(sanitizeCvForInterview("Email address: jane.doe@example.com"), {
    text: `Email address: ${EMAIL_TAG}`,
    counts: { ...ZERO, emails: 1 },
  });
});

test("sentence punctuation after a link stays; a number never joins across a line break", () => {
  assert.equal(sanitizeCvForInterview("See www.janedoe.com.").text, `See ${LINK_TAG}.`);
  assert.equal(
    sanitizeCvForInterview("Visit jane.netlify.app, then").text,
    `Visit ${LINK_TAG}, then`,
  );
  // Joined across the break this would be 11 digits and read as a phone number.
  const twoLines = "Since 2021\n0300 123 units";
  assert.equal(sanitizeCvForInterview(twoLines).text, twoLines);
});

test("the tags are never matched by the rules, so sanitising twice changes nothing", () => {
  for (const tagged of [
    `${EMAIL_TAG} ${PHONE_TAG} ${LINK_TAG} ${ADDRESS_TAG}`,
    `Address: ${ADDRESS_TAG}`,
    `Home address - ${ADDRESS_TAG}`,
  ]) {
    assert.deepEqual(sanitizeCvForInterview(tagged), { text: tagged, counts: ZERO }, tagged);
  }
  const cv =
    "House 12, Street 5, Lahore | jane.doe@example.com | +92 300 1234567\nlinkedin.com/in/jane-doe\nLahore 54000, Pakistan";
  const once = sanitizeCvForInterview(cv);
  assert.deepEqual(once.counts, { emails: 1, phones: 1, links: 1, addresses: 2 });
  assert.deepEqual(sanitizeCvForInterview(once.text), { text: once.text, counts: ZERO });
});

test("found on real CVs: a scheme glued to the word before it is still a link", () => {
  for (const [input, expected] of [
    ["LinkedInhttps://www.linkedin.com/in/jane-doe", `LinkedIn${LINK_TAG}`],
    ["Portfoliohttps://jane.dev", `Portfolio${LINK_TAG}`],
    ["GitHubhttp://github.com/janedoe | Lahore", `GitHub${LINK_TAG} | Lahore`],
  ]) {
    const { text, counts } = sanitizeCvForInterview(input);
    assert.equal(text, expected, input);
    assert.deepEqual(counts, { ...ZERO, links: 1 }, input);
  }
});

test("found on real CVs: a phone on the same line as dates is tagged, and the dates stay", () => {
  for (const [input, expected, phones] of [
    ["Phone +92 300 1234567 2019-2021 Acme", `Phone ${PHONE_TAG} 2019-2021 Acme`, 1],
    ["0300 1234567 2019-2021 2021-2023", `${PHONE_TAG} 2019-2021 2021-2023`, 1],
    ["2021 03001234567 2019-2023", `2021 ${PHONE_TAG} 2019-2023`, 1],
    ["+92 300 1234567 0321 7654321 2020", `${PHONE_TAG} ${PHONE_TAG} 2020`, 2],
    ["+923001234567 2019-2021 2021-2023", `${PHONE_TAG} 2019-2021 2021-2023`, 1],
  ]) {
    const { text, counts } = sanitizeCvForInterview(input);
    assert.equal(text, expected, input);
    assert.deepEqual(counts, { ...ZERO, phones }, input);
  }
  // A long run of dates alone is still kept whole.
  const dates = "2015-2016 2016-2018 2018-2020 2020-2023";
  assert.deepEqual(sanitizeCvForInterview(dates), { text: dates, counts: ZERO });
});

test("total on empty input", () => {
  for (const empty of ["", null, undefined]) {
    assert.deepEqual(sanitizeCvForInterview(empty), { text: "", counts: ZERO });
  }
});

test("pure: nothing is logged", () => {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(" "));
  try {
    sanitizeCvForInterview(
      "Address: House 12, Street 5 | jane.doe@example.com | +92 300 1234567 | github.com/janedoe",
    );
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(lines, []);
});
