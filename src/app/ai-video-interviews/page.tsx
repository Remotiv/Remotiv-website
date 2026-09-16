import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { submitContact } from "@/app/contact/actions";
import { Navbar } from "@/components/navbar";
import type { CSSPropertiesWithVars } from "@/lib/css-types";
import "./ai-video-interviews.css";

// Route-specific metadata. Kept in page.tsx rather than a sibling layout:
// the layouts on /about, /jobs and friends exist to host BreadcrumbList
// JSON-LD alongside the metadata, and this page has none to host — it is
// noindex, so structured data would have nothing to feed.
//
// Open Graph and Twitter are set here in full because metadata merges
// shallowly: a page that sets neither inherits the homepage's objects whole,
// and shares of this URL showed the homepage's title, description, image and
// an og:url of https://remotiv.work. Setting the objects replaces them.
//
// The share image is this route's own opengraph-image.tsx and twitter-image.tsx,
// the homepage card's pattern with this page's copy. File-based images take
// priority over the metadata object, so `images` is deliberately left unset
// here. Without those files this page would show no image, not the homepage's
// "Hire Top 1% Senior Engineering Talent" card.
//
// The description says only what ships: the Async Video Interview, scored
// from the transcript with evidence per score. The conversational interview
// is named as in development, never as available.
const AVI_TITLE = "AI Video Interviews — Remotiv";
const AVI_DESCRIPTION =
  "Screen candidates with Async Video Interviews, scored from the transcript with evidence behind every score. Conversational AI Video Interviews are in development.";

export const metadata: Metadata = {
  title: AVI_TITLE,
  description: AVI_DESCRIPTION,
  // The root keywords ("Pakistan engineers", "staff augmentation", ...) describe
  // the hiring marketplace, not this product. null drops the inherited tag
  // rather than replacing it: search engines ignore meta keywords, so a
  // page-specific list would add nothing.
  keywords: null,
  // Canonical path is relative; Next.js resolves it against `metadataBase`
  // (set in src/app/layout.tsx).
  alternates: { canonical: "/ai-video-interviews" },
  openGraph: {
    title: AVI_TITLE,
    description: AVI_DESCRIPTION,
    url: "/ai-video-interviews",
    siteName: "Remotiv",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: AVI_TITLE,
    description: AVI_DESCRIPTION,
    creator: "@remotiv",
  },
  // Deliberately noindex while this page is under construction.
  // REMOVE THIS, add navbar + footer links, and add the route to
  // sitemap.ts before launch.
  robots: { index: false, follow: false },
};

// Nothing here is default-hidden: the CSS only hides what this script is
// there to reveal, and it is gated on @media (scripting: enabled) as well.
// An earlier round hid content on opacity:0 unconditionally and the caption
// stayed invisible wherever the observer never ran.
const REVEAL_SCRIPT = `(function(){
var r=document.querySelectorAll(".avi2-rail[data-reveal]");
var s=function(e){e.classList.add("avi2-in")};
if(!("IntersectionObserver" in window)){r.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.12});
r.forEach(function(e){o.observe(e)});
setTimeout(function(){r.forEach(function(e){
if(!e.classList.contains("avi2-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 3 gets its own observer rather than sharing section 2's, so that
// REVEAL_SCRIPT above stays byte-identical to what shipped in 08f22aa.
const SECTION3_REVEAL_SCRIPT = `(function(){
var v=document.querySelectorAll(".avi3-viz[data-reveal]");
var s=function(e){e.classList.add("avi3-in")};
if(!("IntersectionObserver" in window)){v.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
v.forEach(function(e){o.observe(e)});
setTimeout(function(){v.forEach(function(e){
if(!e.classList.contains("avi3-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 4 carries its own observer for the same reason section 3 does, plus
// the criterion switcher. Everything the switcher needs is read back off the
// buttons, so the copy has exactly one home — the AVI4_CRITERIA array below.
//
// It mirrors the shipped review screen. A criterion carries a tick, not a
// score — scores belong to answers, and the transcript shows the answer's.
// The evidence is reached through a timestamp chip that seeks the recording,
// as the product's chip does, so the chip moves the depicted player to that
// moment. It also scrolls to and focuses the highlighted passage: below 1180
// the panels stack and the passage is off screen, and focus lands keyboard and
// screen-reader users where the scroll does, which is what the tabindex of -1
// on each evidence turn is for.
const SECTION4_SCRIPT = `(function(){
var sec=document.querySelector(".avi4-sec");if(!sec)return;
var crows=[].slice.call(sec.querySelectorAll(".avi4-crow"));
var txs=[].slice.call(sec.querySelectorAll(".avi4-turns"));
var jump=sec.querySelector("#avi4-d-jump"),now=sec.querySelector("#avi4-p-now"),dur=sec.querySelector("#avi4-p-dur"),fill=sec.querySelector("#avi4-p-fill");
var secs=function(t){var p=t.split(":");return (+p[0])*60+(+p[1])};
var cur=crows.filter(function(x){return x.getAttribute("aria-pressed")==="true"})[0]||crows[0];
function select(b){
if(b===cur)return;cur=b;var id=b.dataset.c;
crows.forEach(function(x){x.setAttribute("aria-pressed",x===b?"true":"false")});
txs.forEach(function(t){t.hidden=(t.id!=="avi4-tx-"+id)});
sec.querySelector("#avi4-d-name").textContent=b.querySelector(".avi4-cname").textContent;
sec.querySelector("#avi4-d-quote").textContent=b.dataset.quote;
sec.querySelector("#avi4-d-q").textContent=b.dataset.q;
sec.querySelector("#avi4-d-time").textContent=b.dataset.time;
jump.setAttribute("aria-label","Play "+b.dataset.q+" from "+b.dataset.time);
now.textContent="0:00";dur.textContent=b.dataset.dur;fill.style.width="0%";
}
crows.forEach(function(b){b.addEventListener("click",function(){select(b)})});
jump.addEventListener("click",function(){
var b=cur,ev=sec.querySelector("#avi4-ev-"+b.dataset.c);
now.textContent=b.dataset.time;
fill.style.width=Math.min(100,secs(b.dataset.time)/secs(b.dataset.dur)*100).toFixed(1)+"%";
if(!ev)return;
var rm=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
if(ev.scrollIntoView)ev.scrollIntoView({block:"center",behavior:rm?"auto":"smooth"});
ev.focus({preventScroll:true});
ev.classList.remove("avi4-flash");void ev.offsetWidth;ev.classList.add("avi4-flash");
});
var v=document.querySelectorAll(".avi4-viz[data-reveal]");
var s=function(e){e.classList.add("avi4-in")};
if(!("IntersectionObserver" in window)){v.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
v.forEach(function(e){o.observe(e)});
setTimeout(function(){v.forEach(function(e){
if(!e.classList.contains("avi4-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 6 carries its own observer for the same reason sections 3 and 4 do:
// so the constants above stay byte-identical to what already shipped. There is
// nothing to switch here, so this is the reveal and nothing else.
const SECTION6_SCRIPT = `(function(){
var a=document.querySelectorAll(".avi6-aside[data-reveal]");
var s=function(e){e.classList.add("avi6-in")};
if(!("IntersectionObserver" in window)){a.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
a.forEach(function(e){o.observe(e)});
setTimeout(function(){a.forEach(function(e){
if(!e.classList.contains("avi6-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 7 carries its own observer for the same reason every section above
// does: so the constants already shipped stay byte-identical.
const SECTION7_SCRIPT = `(function(){
var v=document.querySelectorAll(".avi7-visual[data-reveal]");
var s=function(e){e.classList.add("avi7-in")};
if(!("IntersectionObserver" in window)){v.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
v.forEach(function(e){o.observe(e)});
setTimeout(function(){v.forEach(function(e){
if(!e.classList.contains("avi7-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

const SECTION8_SCRIPT = `(function(){
var v=document.querySelectorAll(".avi8-sec [data-reveal]");
var s=function(e){e.classList.add("avi8-in")};
if(!("IntersectionObserver" in window)){v.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
v.forEach(function(e){o.observe(e)});
setTimeout(function(){v.forEach(function(e){
if(!e.classList.contains("avi8-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 8. The four steps are the candidate route as it actually runs in
// src/app/interview/[token]/_flow.tsx, which is welcome, consent, tech check,
// then record. The practice round between the check and the first question is
// real and is deliberately not shown — it would cost a fifth step.
const AVI8_STEPS = [
  { name: "Invitation", line: "Sent by the hiring team, opened by link" },
  { name: "Consent", line: "Agreed before any recording starts" },
  {
    name: "Setup check",
    line: "Camera, microphone and connection must pass",
  },
  { name: "Interview", line: "Recorded for the hiring team to review" },
];

const SECTION9_SCRIPT = `(function(){
var v=document.querySelectorAll(".avi9-sec [data-reveal]");
var s=function(e){e.classList.add("avi9-in")};
if(!("IntersectionObserver" in window)){v.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
v.forEach(function(e){o.observe(e)});
setTimeout(function(){v.forEach(function(e){
if(!e.classList.contains("avi9-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 9. Two flows that ship today, kept in the order a candidate meets
// them and never merged. The async video interview invite goes over WhatsApp
// and email, and its one reminder is queued for 24 hours before the deadline
// and skipped once the candidate has submitted. Booking is separate and
// email-only: a team member sends the link, the candidate picks a slot the
// host's calendar and working hours leave open — never an open calendar, so
// there is no calendar grid anywhere in the section — and the confirmation
// and any reschedule are emailed to both sides. WhatsApp carries no booking
// message, which is why the depicted WhatsApp is the interview invite.
const AVI9_STEPS = [
  { name: "Invite", line: "Video interview, over WhatsApp and email" },
  {
    name: "Reminder",
    line: "The day before it closes, if they haven’t finished",
  },
  {
    name: "Booking link",
    line: "Emailed when your team wants to meet them",
  },
  {
    name: "Candidate books",
    line: "Picks a slot from your team’s availability",
  },
  {
    name: "Confirmation",
    line: "Reaches both sides, and so does any reschedule",
  },
];

const SECTION10_SCRIPT = `(function(){
var v=document.querySelectorAll(".avi10-sec [data-reveal]");
var s=function(e){e.classList.add("avi10-in")};
if(!("IntersectionObserver" in window)){v.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
v.forEach(function(e){o.observe(e)});
setTimeout(function(){v.forEach(function(e){
if(!e.classList.contains("avi10-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 10. Every figure is the live product's own value, read from the
// analytics dashboard after f6eef5f: 24% completion over 21 invitations, 22
// days from the one completed hire, and a metric the workspace has no evidence
// for yet. The em-dash is the finished state the dashboard actually renders,
// not a placeholder for a number to be filled in later. Tile names are the
// dashboard's own stat keys. A fourth "Hiring bottleneck" tile was dropped:
// the dashboard has no such tile (the bottleneck is a note on its funnel), and
// swapping in another real tile would mean printing a value nobody has read.
const AVI10_TILES = [
  {
    name: "Interview completion",
    value: "24%",
    state: "5 of 21 invitations completed",
  },
  { name: "Time to hire", value: "22d", state: "From 1 completed hire" },
  {
    name: "AI agreement",
    value: null,
    state: "No recruiter adjustments yet",
  },
];

const SECTION11_SCRIPT = `(function(){
var v=document.querySelectorAll(".avi11-sec [data-reveal]");
var s=function(e){e.classList.add("avi11-in")};
if(!("IntersectionObserver" in window)){v.forEach(s);return}
var o=new IntersectionObserver(function(es){es.forEach(function(e){
if(e.isIntersecting){s(e.target);o.unobserve(e.target)}})},{threshold:.1});
v.forEach(function(e){o.observe(e)});
setTimeout(function(){v.forEach(function(e){
if(!e.classList.contains("avi11-in")&&e.getBoundingClientRect().top<innerHeight)s(e)})},2200);
})();`;

// Section 11. Four claims, each one a thing the code does today and nothing
// more. Consent gates the recorder in src/app/interview/[token]/_flow.tsx;
// recordings live in a private bucket and play back through signed URLs with
// a five-minute TTL; a session opens only for the role's hiring team and the
// workspace's owners and admins, and every playback URL a team member is
// granted is written to signed_url_logs; the six-month purge in
// src/lib/interviews deletes the video and the transcript.
//
// Card 03 names owners and admins on purpose: "only the relevant hiring team"
// was exclusive and false. It says playback, not views, because transcript
// and scorecard opens are not logged.
//
// "Remotiv automatically removes ITS recordings" — that word is load-bearing
// and must not be edited out. The purge reaches Remotiv's own copies. It does
// not reach the transcription provider's copy, and the privacy policy is
// explicit about that. Widening the sentence would make the page claim more
// than the product delivers.
const AVI11_CARDS = [
  {
    num: "01",
    title: "Consent first",
    line: "Recording only begins after the candidate explicitly agrees.",
    icon: <path d="M3.6 8.4 6.5 11.3 12.4 5" />,
  },
  {
    num: "02",
    title: "Private recordings",
    line: "Recordings are stored privately and played back through links that expire after five minutes.",
    icon: (
      <>
        <circle cx="8" cy="8" r="5.4" />
        <path d="M8 4.9V8l2.3 1.5" />
      </>
    ),
  },
  {
    num: "03",
    title: "Controlled access",
    line: "Only the hiring team, owners and admins can open an interview. Team playback is logged.",
    icon: <path d="M3.4 4.6h9.2M3.4 8h9.2M3.4 11.4h5.6" />,
  },
  {
    num: "04",
    title: "Deleted after six months",
    line: "Remotiv automatically removes its recordings and transcripts after six months.",
    icon: (
      <>
        <circle cx="8" cy="8" r="5.4" />
        <path d="M5.5 8h5" />
      </>
    ),
  },
];

// Fixed sample data. The roster is international by design — the product sells
// worldwide and a single-country list misrepresents it. Rank 1 is Ayesha Karim,
// the hero's "Ranked 1 of 128" and the same 128 applicants: two different
// leaders of one result set was a contradiction. Lahore is her UTC+5. Ring
// dash offsets are
// precomputed as C x (1 - score/100) so the arc can never disagree with the
// numeral drawn over it; C is 2(pi)r for r=19.
const RING_C = "119.38";
const RANKED = [
  {
    rank: 1,
    initials: "AK",
    name: "Ayesha Karim",
    meta: "6 yrs · Lahore · applied 2 days ago",
    score: 88,
    off: "14.33",
    tone: "mint",
    selected: true,
  },
  {
    rank: 2,
    initials: "PN",
    name: "Priya Nair",
    meta: "8 yrs · Singapore · applied 3 days ago",
    score: 84,
    off: "19.10",
    tone: "mint",
    selected: false,
  },
  {
    rank: 3,
    initials: "SA",
    name: "Sofia Almeida",
    meta: "5 yrs · Lisbon · applied 3 days ago",
    score: 71,
    off: "34.62",
    tone: "amber",
    selected: false,
  },
  {
    rank: 4,
    initials: "OH",
    name: "Omar Haddad",
    meta: "4 yrs · Dubai · applied 4 days ago",
    score: 66,
    off: "40.59",
    tone: "amber",
    selected: false,
  },
  {
    rank: 5,
    initials: "DO",
    name: "Daniel Okafor",
    meta: "3 yrs · Toronto · applied 4 days ago",
    score: 54,
    off: "54.91",
    tone: "red",
    selected: false,
  },
];

// The scorecard deliberately does not pass everything: an amber 74, one
// requirement not evidenced and one point to verify. A card where every line
// is green is evidence of nothing.
const CRITERIA = [
  { label: "Distributed systems in production", score: 92, tone: "mint" },
  { label: "Python · async services", score: 88, tone: "mint" },
  { label: "Leading engineers", score: 74, tone: "amber" },
];

// A separator is decoration, so it is a span marked aria-hidden rather than an
// element picked for the glyph it renders. Each phrase owns its trailing
// separator inside an .avi4-ph, so a wrapped line can never open on a dot.
const SEP = (
  <span className="avi4-sep" aria-hidden="true">
    {" · "}
  </span>
);

// Section 4. The switcher reads name, question, quote, timestamp and recording
// length back off the buttons, so this array is the only copy of any of it.
// A criterion has no score of its own in the product — it is found in the
// transcript or it is not — so `score` here is the score of the ANSWER the
// evidence sits in, and it is drawn on that answer's question row. Timestamps
// and lengths are m:ss within that one answer's recording.
// C = 2(pi)r for r=33. Section 6 draws its score ring with it; section 4's
// ring is always closed, because it marks a criterion as found.
const RING_C_LG = "207.345";
const AVI4_CRITERIA = [
  {
    id: "c1",
    name: "Distributed systems trade-offs",
    q: "Question 1",
    score: 88,
    time: "0:31",
    dur: "1:34",
    quote:
      '"The trade-off is that you stop being able to say “it happened” and start saying “it will have happened”, so anything reading that data has to tolerate being a few seconds behind."',
  },
  {
    id: "c2",
    name: "Handling production incidents",
    q: "Question 2",
    score: 76,
    time: "0:21",
    dur: "1:41",
    quote:
      '"First thing was to stop the bleeding: I rolled the consumer back to the previous version and let the queue drain, so we stopped losing events while we worked out why."',
  },
  {
    id: "c3",
    name: "Communicating with non-engineers",
    q: "Question 3",
    score: 71,
    time: "0:17",
    dur: "0:58",
    quote:
      '"What broke, who it touched, what we’d already done, and when we’d know more. I try not to use the word “queue” in those."',
  },
  {
    id: "c4",
    name: "Mentoring and code review",
    q: "Question 4",
    score: 83,
    time: "0:13",
    dur: "1:12",
    quote:
      '"I stopped leaving line comments for a while and left one comment at the top instead, saying what I’d look at first and why."',
  },
];

// The section is served with the second criterion selected; the inline script
// takes over from the first click.
const AVI4_SELECTED = AVI4_CRITERIA[1];

// Section 4 depicts the Async Video Interview that ships today, so each block
// is one recorded answer to one fixed question the hiring team set for the
// role — never a reply to what the candidate said. There is no interviewer in
// an async interview, so the row above each answer is the question itself,
// labelled the way the review screen labels it ("Question 2 of 5"). Every
// answer is its own recording, so timestamps run from 0:00 within that answer,
// in the review screen's m:ss form, and stay under the default two-minute
// answer limit. The third row of each block is the candidate still talking;
// an earlier version put a reactive follow-up there, which is the unbuilt
// conversational interview.
type Avi4Turn = { who: string; time?: string; say: string; ev?: boolean };

const AVI4_TRANSCRIPT: { id: string; turns: Avi4Turn[] }[] = [
  {
    id: "c1",
    turns: [
      {
        who: "Question 1 of 5",
        say: "When did you trade consistency for speed in a design? What did you give up?",
      },
      {
        who: "Priya Nair",
        time: "0:06",
        say: "Checkout was waiting on three downstream calls it didn't need to wait on. Our p95 was about 1.4 seconds and most of that was us being polite to services that could have been told later.",
      },
      {
        who: "Priya Nair",
        time: "0:31",
        ev: true,
        say: 'So we put a queue in front of the ones that weren\'t on the critical path — notifications, the CRM sync, the loyalty ledger. The trade-off is that you stop being able to say "it happened" and start saying "it will have happened", so anything reading that data has to tolerate being a few seconds behind. We were fine with that everywhere except the ledger, which we left synchronous, because finance reconciles it daily and I didn\'t want to be explaining a gap.',
      },
      {
        who: "Priya Nair",
        time: "1:18",
        say: "Nobody's asked us to change it since.",
      },
    ],
  },
  {
    id: "c2",
    turns: [
      {
        who: "Question 2 of 5",
        say: "Tell us about the last production issue you were personally on the hook for.",
      },
      {
        who: "Priya Nair",
        time: "0:05",
        say: "About six weeks ago we started dropping payment webhooks. Only around two percent, so nobody noticed for a day and a half — it came in as a support ticket, not an alert, which is its own problem.",
      },
      {
        who: "Priya Nair",
        time: "0:21",
        ev: true,
        say: "I took the page around eleven at night. First thing was to stop the bleeding: I rolled the consumer back to the previous version and let the queue drain, so we stopped losing events while we worked out why. Then I pulled the diff — someone had tightened a retry policy two days earlier, and anything over two seconds was being dropped instead of requeued. We replayed about four thousand events out of the dead-letter queue the next morning.",
      },
      {
        who: "Priya Nair",
        time: "1:02",
        say: "We added an alert on dead-letter depth after that, which we should have had already. I'll be honest though, we never did a proper write-up. It was quarter end and it slipped.",
      },
    ],
  },
  {
    id: "c3",
    turns: [
      {
        who: "Question 3 of 5",
        say: "How do you explain a technical problem to people who aren't engineers?",
      },
      {
        who: "Priya Nair",
        time: "0:04",
        say: "It depends who's asking. Support wants to know what to tell customers. Finance wants to know whether the numbers are wrong.",
      },
      {
        who: "Priya Nair",
        time: "0:17",
        ev: true,
        say: "For the webhook one I wrote two paragraphs in the channel: what broke, who it touched, what we'd already done, and when we'd know more. I try not to use the word \"queue\" in those. It's harder than it sounds — I've had feedback before that I go too deep too fast when someone asks a simple question.",
      },
      {
        who: "Priya Nair",
        time: "0:49",
        say: "Writing it down first is what helps most.",
      },
    ],
  },
  {
    id: "c4",
    turns: [
      {
        who: "Question 4 of 5",
        say: "What does your code review look like when you work with junior engineers?",
      },
      {
        who: "Priya Nair",
        time: "0:05",
        say: 'I try to separate "this is wrong" from "this isn\'t how I\'d have written it", and only block on the first one.',
      },
      {
        who: "Priya Nair",
        time: "0:13",
        ev: true,
        say: "With the two juniors last year I stopped leaving line comments for a while and left one comment at the top instead, saying what I'd look at first and why. It's slower for me. But they came back having made a change of their own rather than typing in exactly what I'd written, and after a couple of months I was reviewing their work the same way I review anyone's.",
      },
      {
        who: "Priya Nair",
        time: "1:04",
        say: "I do the same with new starters now.",
      },
    ],
  },
];

// Section 12b. Ported from the FAQ on /services/dedicated-team — same four-row
// accordion, same ARIA, new questions. Answer 4 is future tense and must stay
// that way until the conversational interview ships: an earlier version said
// the AI already follows up, and nothing in the product does.
const AVI12_FAQS = [
  {
    q: "What is an Async Video Interview?",
    a: "Remotiv combines structured video interviews with AI-assisted evaluation, transcripts and evidence-backed scorecards so recruiters can review candidates consistently.",
  },
  {
    q: "Does AI make the hiring decision?",
    a: "No. Remotiv helps evaluate and organise candidate evidence. Your hiring team decides who moves forward.",
  },
  {
    q: "Can recruiters review the original interview?",
    a: "Yes. Recruiters can review the candidate's recorded answers, transcript and the evidence behind each interview score.",
  },
  {
    q: "Will Remotiv support live AI interviews?",
    a: "Yes. Conversational AI Video Interviews with adaptive follow-up questions are in development. They will be available separately from Remotiv's existing Async Video Interview.",
  },
];

// The original card's three ticks are "We respond within 24 hours", "No
// retainer fees — pay only when you hire" and "100% confidential — your data
// stays private". Only the first survives the move: the second describes the
// hiring service's pricing and is simply untrue of this product, and the third
// is the banned encryption line wearing a different hat. The two replacements
// are claims section 11 already makes on this page and the code backs —
// consent gates the recorder, and the six-month purge is real.
const AVI12_CHECKS = [
  "We respond within 24 hours",
  "Consent before any recording starts",
  "Recordings and transcripts deleted after six months",
];

// The inquiry card has no service dropdown; every submission from this page is
// tagged with this constant so it can be told apart from the five other forms
// in the admin inbox. 34 characters, inside submitContact's 50-char cap on the
// service field — keep it that way if the wording ever changes.
const AVI12_SERVICE = "AI Video Interviews — Early Access";

// submitContact returns prose, not codes, and src/app/contact/actions.ts is
// outside this task's scope, so the panel has to be chosen by matching those
// strings. If its wording changes this falls through to the generic panel,
// which is the safe direction to fail in.
function avi12ErrorPanel(message: string): string {
  if (message.startsWith("Too many")) return "avi12-e-rate";
  if (message.endsWith("is required.") || message.startsWith("Please enter")) {
    return "avi12-e-input";
  }
  return "avi12-e-server";
}

async function submitEarlyAccess(formData: FormData) {
  "use server";
  const read = (key: string) => String(formData.get(key) ?? "");
  // A throw inside submitContact used to become a 500, which replaced the whole
  // page with the app's error screen. It now lands on the server-error panel,
  // with or without JavaScript. redirect() stays outside the try: it works by
  // throwing, and a catch around it would swallow the redirect itself.
  let panel: string;
  try {
    const result = await submitContact({
      name: read("name"),
      email: read("email"),
      company: read("company"),
      service: AVI12_SERVICE,
      message: read("message"),
      companyUrl: read("company_url"),
    });
    panel = result.success ? "avi12-sent" : avi12ErrorPanel(result.error);
  } catch (error) {
    console.error("[ai-video-interviews] submitContact threw:", error);
    panel = "avi12-e-server";
  }
  // With JavaScript on, SECTION12_SCRIPT submits with fetch and adds
  // avi12_js=1. fetch cannot read a redirect's fragment, so that request also
  // gets the result in the query string, which response.url does expose. The
  // script never navigates to that URL; it only reads it. A no-JS POST never
  // carries the field, so its redirect is unchanged: a bare fragment for :target.
  // Absolute path, not a bare fragment: redirect() resolves against the request.
  const query = formData.get("avi12_js") === "1" ? `?avi12=${panel}` : "";
  redirect(`/ai-video-interviews${query}#${panel}`);
}

// Section 12. Three jobs: the accordion, the inquiry submit, and mirroring the
// URL fragment onto the result panels.
//
// THE SUBMIT IS OWNED HERE when JavaScript is on. A capture listener on the
// document stops the submit event before React's root listener sees it, and
// posts the form with fetch to the same URL a no-JS browser posts to - the
// server action's own progressive-enhancement endpoint, not Next's private
// action protocol. That buys four things React's path could not give:
//   - a dropped connection or a 500 lands on the server-error panel, instead
//     of throwing to the root error boundary and replacing the whole page;
//   - busy lasts exactly as long as the request (cleared in finally), where
//     an 8-second timer used to re-enable a still-pending submit, and React
//     then queued the second one behind the first;
//   - a submit while one is pending is dropped, so Enter cannot send twice;
//   - the form is never re-rendered, so what the visitor typed survives an
//     error. It is cleared on success only.
// The action answers avi12_js=1 with ?avi12=<panel> as well as the fragment,
// because fetch cannot read a fragment; the id is checked against RESULTS so a
// response can only ever open a real panel.
//
// Focus moves to the panel that lands, and only after a submit this script
// made. hashchange, popstate and the MutationObserver re-run sync() for any
// other reason - "Submit Another", back, a cold load - without moving focus.
//
// Without JavaScript none of this runs: the form posts, the action redirects
// to the fragment, and :target shows the panel. That is the architecture, and
// a browser without fetch falls back to React's own action path the same way.
//
// data-show stays because Chrome does not recompute :target after a soft
// navigation, which is what React's fallback path performs. Everything is
// delegated or re-queried, and the MutationObserver re-applies data-show,
// because that path REPLACES the card's DOM nodes. It watches childList only,
// and sync() only touches attributes, so it cannot retrigger itself.
//
// The 30-second abort cannot know whether the request reached the server, so
// it opens a panel that says to email rather than try again.
const SECTION12_SCRIPT = `(function(){
var RESULTS=["avi12-sent","avi12-e-input","avi12-e-rate","avi12-e-server"];
var pending=false;
function sync(){var h=location.hash.slice(1),hit=false;
[].slice.call(document.querySelectorAll(".avi12-sent,.avi12-err")).forEach(function(p){
if(p.id===h){p.setAttribute("data-show","");hit=true}else p.removeAttribute("data-show")});
return hit}
function land(id){
if(location.hash!=="#"+id)location.hash=id;
sync();
var p=document.getElementById(id);if(!p)return;
p.setAttribute("tabindex","-1");
p.addEventListener("blur",function(){p.removeAttribute("tabindex")},{once:true});
p.focus()}
document.addEventListener("click",function(e){
var b=e.target&&e.target.closest?e.target.closest(".avi12-faq-btn"):null;
if(!b)return;
var it=b.closest(".avi12-faq-item"),was=it.getAttribute("data-open")==="true";
[].slice.call(document.querySelectorAll(".avi12-faq-item")).forEach(function(o){
var ob=o.querySelector(".avi12-faq-btn"),os=o.querySelector(".avi12-faq-sign"),on=(o===it)&&!was;
o.setAttribute("data-open",on?"true":"false");
if(ob)ob.setAttribute("aria-expanded",on?"true":"false");
if(os)os.textContent=on?"\\u2212":"+"})});
document.addEventListener("submit",function(e){
var f=e.target;
if(!f.classList||!f.classList.contains("avi12-form"))return;
if(!window.fetch||!window.FormData||!window.Promise||!Promise.prototype.finally)return;
e.preventDefault();e.stopImmediatePropagation();
if(pending)return;
pending=true;f.setAttribute("data-busy","");
var body=new FormData(f),result="avi12-e-server";
body.append("avi12_js","1");
var ctl=window.AbortController?new AbortController():null;
var timer=ctl?setTimeout(function(){ctl.abort()},30000):0;
fetch(location.pathname,{method:"POST",body:body,credentials:"same-origin",signal:ctl?ctl.signal:undefined})
.then(function(r){var m=/[?&]avi12=([a-z0-9-]+)/.exec(r.url);
if(m&&RESULTS.indexOf(m[1])>-1)result=m[1]},
function(err){if(err&&err.name==="AbortError")result="avi12-e-timeout"})
.finally(function(){
clearTimeout(timer);pending=false;f.removeAttribute("data-busy");
if(result==="avi12-sent")f.reset();
land(result)})},true);
addEventListener("hashchange",sync);
addEventListener("popstate",sync);
if(window.MutationObserver)new MutationObserver(sync).observe(document.body,{childList:true,subtree:true});
sync();
})();`;

// Sections 1 to 3 of 13. Sections 4-13 are still to design; per the handoff
// they should keep alternating cream and white rather than repeat either
// treatment.
export default function AIVideoInterviewsPage() {
  return (
    <>
      <Navbar />
      <main id="main">
        <section className="avi-hero" data-bg="grid">
          {/* Four background treatments ship together and are switched by the
              data-bg attribute on .avi-hero, so the choice stays reversible
              without a rebuild: grid (shipped), scale, rules, none. */}
          <div className="avi-bg" aria-hidden="true">
            <div className="avi-bg-grid" />
            <div className="avi-bg-rules" />
            <div className="avi-bg-scale">
              <div className="avi-bg-tk" />
              <div className="avi-bg-tk5" />
              <div className="avi-bg-base" />
              <div className="avi-bg-riser" />
              <div className="avi-bg-mk" />
              <div className="avi-bg-flag">86</div>
              <div className="avi-bg-num" style={{ left: "34px" }}>
                0
              </div>
              <div className="avi-bg-num" style={{ left: "50%" }}>
                50
              </div>
              <div className="avi-bg-num" style={{ right: "34px" }}>
                100
              </div>
            </div>
          </div>

          <div className="avi-inner">
            <div className="avi-grid">
              <div>
                <div className="avi-eyebrow">
                  <i />
                  AI Video Interviews
                </div>
                <h1>
                  Your team shouldn&rsquo;t spend its <span className="avi-stick">week</span> on
                  first-round screening.
                </h1>
                <p className="avi-sub">
                  Remotiv ranks applications, runs structured interviews with shortlisted
                  candidates, and turns every candidate into a recruiter-ready, evidence-backed
                  scorecard — all in one workflow. Your hiring team makes the final decision.
                </p>
                {/* The handoff pointed these at /early-access and /demo;
                    neither route exists. The primary now resolves — section 12
                    at the foot of this page owns id="early-access". The demo
                    button goes to /book-a-meeting, the same route the navbar's
                    global CTA uses. */}
                <div className="avi-ctas">
                  <a className="avi-btn-primary" href="#early-access">
                    Join Early Access<em>→</em>
                  </a>
                  <Link className="avi-btn-secondary" href="/book-a-meeting">
                    Book a Demo
                  </Link>
                </div>
                {/* Each phrase owns its trailing middot so a separator can
                    never begin a wrapped line. Do not join these into one
                    " · " string. */}
                <p className="avi-trust">
                  <span className="avi-trust-item">
                    Transcript-only evaluation
                    <span className="avi-d">&nbsp;·</span>
                  </span>{" "}
                  <span className="avi-trust-item">
                    Evidence behind every score
                    <span className="avi-d">&nbsp;·</span>
                  </span>{" "}
                  <span className="avi-trust-item">No automated rejection</span>
                </p>
              </div>

              <div className="avi-stack">
                <div className="avi-sheet" aria-hidden="true" />
                <div className="avi-sheet avi-sheet--front" aria-hidden="true" />
                <div className="avi-rankchip">
                  Ranked 1 of 128<em>Top match</em>
                </div>
                <article className="avi-sc" aria-label="Candidate scorecard">
                  <div className="avi-sc-top">
                    <div className="avi-sc-av">AK</div>
                    <div>
                      <div className="avi-sc-name">Ayesha Karim</div>
                      <div className="avi-sc-role">Senior Backend Engineer · Remote, UTC+5</div>
                    </div>
                    <div className="avi-sc-score">
                      <b>86</b>
                      <span>Overall</span>
                    </div>
                  </div>
                  <div className="avi-sc-crit">
                    <div className="avi-crow">
                      <p>Systems design</p>
                      <div className="avi-bar">
                        <i style={{ width: "88%" }} />
                      </div>
                      <b>88</b>
                    </div>
                    <div className="avi-crow">
                      <p>Debugging under pressure</p>
                      <div className="avi-bar">
                        <i style={{ width: "84%" }} />
                      </div>
                      <b>84</b>
                    </div>
                    <div className="avi-crow">
                      <p>Async communication</p>
                      <div className="avi-bar avi-bar--amber">
                        <i style={{ width: "79%" }} />
                      </div>
                      <b>79</b>
                    </div>
                  </div>
                  <div className="avi-sc-ev">
                    <p className="avi-sc-ev-label">
                      Evidence<span className="avi-sep">·</span>Systems design
                      <span className="avi-sep">·</span>04:12
                    </p>
                    <p className="avi-sc-ev-quote">
                      &ldquo;We were paging twice a week, so I moved retries onto an idempotent
                      queue. Alerts went to zero and stayed there for two quarters.&rdquo;
                    </p>
                  </div>
                  <div className="avi-sc-foot">
                    <p>
                      <b>Recommendation only.</b> Your team can adjust or override any score.
                    </p>
                    {/* Depicted, not operable: a span rather than a button, so
                        nothing here is focusable or announced as a control. */}
                    <span className="avi-sc-override" aria-hidden="true">
                      <i />
                      Adjust
                    </span>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>

        {/* Section 2 of 13 — the product demo, "the rail". White ground
            against the hero's cream. The six stages wrap 3 + 3 rather than
            running across in one row: inside the 1100 container a six-track
            row leaves ~155px per stage, which is about nineteen characters
            of measure. The 3 + 3 wrap puts the tracks at ~300px. */}
        <section className="avi2-sec">
          <div className="avi2-wrap">
            <div className="avi2-slab">
              <div className="avi2-head">
                <div>
                  <p className="avi2-eyeb">
                    <i />
                    Inside Remotiv
                  </p>
                  {/* One interview, not two: the technical round at stage 05 is
                      the conversational AI Video Interview, which is in
                      development. It stays on the rail marked as coming. */}
                  <h2>
                    One interview happens before you spend a{" "}
                    <span className="avi2-stick">minute</span> of your week.
                  </h2>
                  <p className="avi2-lede">
                    Applications arrive and get ranked, and the candidates you invite sit an Async
                    Video Interview on your team&apos;s own questions. Remotiv scores the
                    transcript. Then it stops.
                  </p>
                </div>
                {/* "02 of them interviews" counts the rail, which still shows
                    both - stage 05 carries its own flag. Qualifying it here
                    widened this column by 80px and took a line off the lede. */}
                <div className="avi2-count">
                  <div>
                    <b>06</b>
                    <span>stages, end to end</span>
                  </div>
                  <div className="avi2-m">
                    <b>02</b>
                    <span>of them interviews</span>
                  </div>
                  <div>
                    <b>01</b>
                    <span>decision, and it&apos;s yours</span>
                  </div>
                </div>
              </div>

              <div className="avi2-rail" data-reveal>
                <section
                  className="avi2-run avi2-run--one"
                  style={{ "--i": 0 } as CSSPropertiesWithVars}
                >
                  <p className="avi2-plabel">
                    Rank, then the first interview
                    <em>Your team only sends the invite</em>
                  </p>
                  {/* The rule is two segments: faint across 01-02, bright
                      under 03. Carries no meaning a screen reader can use. */}
                  <div className="avi2-rrow avi2-g3" aria-hidden="true">
                    <b className="avi2-s1" />
                    <b className="avi2-s2 avi2-bright" />
                  </div>
                  <ol className="avi2-stops avi2-g3">
                    <li className="avi2-st">
                      <p className="avi2-st__n">01</p>
                      <h3 className="avi2-st__t">Applications arrive</h3>
                      <p className="avi2-st__d">
                        Every applicant lands in one place, in one format.
                      </p>
                    </li>
                    <li className="avi2-st">
                      <p className="avi2-st__n">02</p>
                      <h3 className="avi2-st__t">AI CV ranking</h3>
                      <p className="avi2-st__d">
                        Ranked against the role you wrote, not against keywords.
                      </p>
                    </li>
                    <li className="avi2-st avi2-st--key">
                      <div className="avi2-box">
                        <div className="avi2-st__meta">
                          <p className="avi2-st__n">03</p>
                          <p className="avi2-badge">
                            <i />
                            Introductory
                          </p>
                        </div>
                        <h3 className="avi2-st__t">Async Video Interview</h3>
                        <p className="avi2-st__d">
                          Communication and fit, answered in the candidate&apos;s own hours.
                        </p>
                      </div>
                    </li>
                  </ol>
                </section>

                <section
                  className="avi2-run avi2-run--two"
                  style={{ "--i": 1 } as CSSPropertiesWithVars}
                >
                  <p className="avi2-plabel">
                    Scorecard, technical round, decision
                    <em>Ends with a person, not a score</em>
                  </p>
                  <div className="avi2-rrow avi2-g3" aria-hidden="true">
                    <b className="avi2-s1 avi2-bright" />
                    <b className="avi2-s2 avi2-mint" />
                    <s />
                  </div>
                  <ol className="avi2-stops avi2-g3">
                    <li className="avi2-st">
                      <p className="avi2-st__n">04</p>
                      {/* Non-breaking hyphen (U+2011): a plain one lets the
                          title break into three lines in a 300px track. */}
                      <h3 className="avi2-st__t">Evidence&#8209;backed scorecard</h3>
                      <p className="avi2-st__d">Every score carries the moment it came from.</p>
                    </li>
                    <li className="avi2-st avi2-st--key">
                      <div className="avi2-box">
                        <div className="avi2-st__meta">
                          <p className="avi2-st__n">05</p>
                          <p className="avi2-badge">
                            <i />
                            Technical
                          </p>
                          <p className="avi2-soon">Coming soon</p>
                        </div>
                        <h3 className="avi2-st__t">Conversational AI Video Interview</h3>
                        <p className="avi2-st__d">
                          Follow-up questions on what the candidate says.
                        </p>
                      </div>
                    </li>
                    <li className="avi2-st avi2-st--dest">
                      <div className="avi2-box">
                        <div className="avi2-st__meta">
                          <p className="avi2-st__n">06</p>
                          <p className="avi2-badge">
                            <i />
                            Human
                          </p>
                        </div>
                        <h3 className="avi2-st__t">Human decision</h3>
                        <p className="avi2-st__d">
                          A person on your team decides. No candidate is ever auto-rejected.
                        </p>
                      </div>
                    </li>
                  </ol>
                </section>

                <div className="avi2-artrow">
                  <div className="avi2-fragcol">
                    <div className="avi2-frag">
                      <p className="avi2-frag__tag">
                        Ayesha Karim<s>·</s>Senior Backend Engineer
                      </p>
                      <div className="avi2-frag__row">
                        <p>Systems design</p>
                        <div className="avi2-bar">
                          <i style={{ width: "88%" }} />
                        </div>
                        <b>88</b>
                      </div>
                      <div className="avi2-frag__row">
                        <p>Async communication</p>
                        <div className="avi2-bar avi2-bar--amber">
                          <i style={{ width: "79%" }} />
                        </div>
                        <b>79</b>
                      </div>
                      <div className="avi2-frag__ev">
                        <p>
                          &ldquo;We were paging twice a week, so I moved retries onto an idempotent
                          queue. Alerts went to zero and stayed there for two quarters.&rdquo;
                        </p>
                        <em>Systems design · 04:12 · transcript</em>
                      </div>
                      {/* The transcript-only disclosure that sat here was word for
                          word section 4's, which is the section about scoring from
                          a transcript. It says it there instead. */}
                      <div className="avi2-frag__foot">
                        {/* Depicted, not operable: a span rather than a button, so
                            nothing here is focusable or announced as a control. */}
                        <span className="avi2-adjust" aria-hidden="true">
                          <i />
                          Adjust
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="avi2-cap">
                    <b>Stage 04, redrawn</b>
                    <p>
                      The scorecard your team opens after each interview — with the transcript
                      sitting behind every number.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="avi3-sec">
          <div className="avi3-wrap">
            <header className="avi3-head">
              <div>
                <p className="avi3-eyeb">
                  <i />
                  AI CV Ranking
                </p>
                <h2>
                  Know who to interview <span className="avi3-stick">before</span> you send the
                  invite.
                </h2>
                <p className="avi3-lede">
                  Remotiv scores every CV against the criteria of the role — not just keyword
                  matches — then shows what fits, what&rsquo;s missing, and what your hiring team
                  should verify. Interview invitations start from a ranked list, not an application
                  pile.
                </p>
              </div>
              <ul className="avi3-pts">
                <li>Scored against the actual role criteria — not just keyword matching</li>
                <li>Missing requirements are shown clearly, not buried inside a score</li>
                <li>Points to verify are surfaced for the recruiter</li>
                <li>
                  Change the role criteria and re-score candidates against the updated version
                </li>
              </ul>
            </header>

            <div className="avi3-viz" data-reveal>
              <div className="avi3-panel avi3-panel--list">
                <div className="avi3-p__head">
                  <div>
                    <p className="avi3-p__ttl">Senior Backend Engineer</p>
                    <p className="avi3-p__sub">128 applicants · ranked on criteria fit</p>
                  </div>
                  <p className="avi3-chip">Sorted by score</p>
                </div>
                <ol className="avi3-rows">
                  {RANKED.map((c) => (
                    <li
                      key={c.name}
                      className={c.selected ? "avi3-row avi3-is-sel" : "avi3-row"}
                      aria-current={c.selected ? "true" : undefined}
                    >
                      <p className="avi3-rk">{c.rank}</p>
                      <span className={`avi3-av avi3-av--${c.rank}`} aria-hidden="true">
                        {c.initials}
                      </span>
                      <div className="avi3-who">
                        <p className="avi3-nm">{c.name}</p>
                        <p className="avi3-mt">{c.meta}</p>
                      </div>
                      <div className={`avi3-ring avi3-ring--${c.tone}`}>
                        <svg viewBox="0 0 44 44" aria-hidden="true">
                          <circle className="avi3-trk" cx="22" cy="22" r="19" />
                          <circle
                            className="avi3-val"
                            cx="22"
                            cy="22"
                            r="19"
                            style={
                              {
                                "--c": RING_C,
                                "--off": c.off,
                                "--i": c.rank - 1,
                              } as CSSPropertiesWithVars
                            }
                          />
                        </svg>
                        <b>{c.score}</b>
                      </div>
                    </li>
                  ))}
                </ol>
                <p className="avi3-p__foot">
                  Showing the top 5 of 128. Rank moves when the role criteria change.
                </p>
              </div>

              <div className="avi3-panel avi3-panel--score">
                <div className="avi3-p__head">
                  <div>
                    <p className="avi3-p__ttl">Ayesha Karim</p>
                    <p className="avi3-p__sub">Rank 1 · Senior Backend Engineer</p>
                  </div>
                  <p className="avi3-chip avi3-chip--pp">
                    <i />
                    Re-scored on criteria v3
                  </p>
                </div>

                <div className="avi3-overall">
                  <div className="avi3-ring avi3-ring--lg avi3-ring--mint">
                    <svg viewBox="0 0 76 76" aria-hidden="true">
                      <circle className="avi3-trk" cx="38" cy="38" r="33" />
                      <circle
                        className="avi3-val"
                        cx="38"
                        cy="38"
                        r="33"
                        style={
                          { "--c": "207.35", "--off": "24.88", "--i": 0 } as CSSPropertiesWithVars
                        }
                      />
                    </svg>
                    <b>88</b>
                  </div>
                  <div className="avi3-overall__t">
                    <p className="avi3-conf">High confidence</p>
                    <p>
                      Nine of twelve criteria are evidenced directly, two are partial and one is not
                      — all listed below.
                    </p>
                    <p className="avi3-was">
                      Was 81 on criteria v2 — Kubernetes was added on 21 Aug and 34 candidates were
                      re-scored.
                    </p>
                  </div>
                </div>

                <div className="avi3-crits">
                  <p className="avi3-lbl">Criteria breakdown</p>
                  {CRITERIA.map((c, i) => (
                    <div className="avi3-crit" key={c.label}>
                      <p>{c.label}</p>
                      <div className={`avi3-bar avi3-bar--${c.tone}`}>
                        <i style={{ width: `${c.score}%`, "--i": i } as CSSPropertiesWithVars} />
                      </div>
                      <b>{c.score}</b>
                    </div>
                  ))}
                </div>

                <div className="avi3-notes">
                  <div className="avi3-note">
                    <p className="avi3-lbl">Not evidenced</p>
                    <p>
                      <b>Kubernetes in production.</b> The CV covers Docker and ECS. Nothing on
                      Kubernetes either way — treat it as unknown, not absent.
                    </p>
                  </div>
                  <div className="avi3-note avi3-note--pp">
                    <p className="avi3-lbl">Points to verify</p>
                    <p>
                      <b>Scope of the lead role.</b> Describes leading six engineers; no dates are
                      given for that period. Worth asking in the screen.
                    </p>
                  </div>
                </div>

                <div className="avi3-p__disc">
                  {/* The claim here used to be that CV text is the only input.
                      It is not: the scorer also reads location, years and
                      screening answers, and the CV itself carries the name. What
                      is true and specific is the evidence gate — every quote is
                      checked against the CV, and a claim whose quote is not
                      found there is dropped (verifyEvidence in cv-scoring). */}
                  <p>
                    Every claim quotes the CV, and a claim whose quote isn’t found there is dropped.
                  </p>
                  {/* Depicted, not operable: a span rather than a button, so
                      nothing here is focusable or announced as a control. */}
                  <span className="avi3-ghost" aria-hidden="true">
                    Open full scorecard
                    <i />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Reading order and prefix number deliberately do not match from here
            down: the page runs 2, 3, 7, 4, 6. Section 2 lays out six numbered
            stages, and the sections that expand them used to run 02, 04, 06,
            03/05 — the interviews arrived after the scorecard they produce and
            after the decision that follows. Moving this block ahead of section
            4 puts the pipeline back in its own order. The avi7- prefix stays
            avi7-: renaming would touch every rule and comment in the
            stylesheet and change nothing a visitor sees. */}
        <section className="avi7-sec">
          <div className="avi7-wrap">
            <div className="avi7-grid">
              <header>
                <p className="avi7-eyebrow">How you interview</p>
                <h2 className="avi7-h2">You set the interview. Remotiv runs it.</h2>
                {/* Only the async screen ships. The second stage and the whole
                    call mockup are the conversational AI Video Interview, which
                    is in development, so both carry a "Coming soon" flag that is
                    part of the design, not a footnote. Remove the flags only in
                    the same change that ships the product. */}
                <p className="avi7-lede">
                  Remotiv supports the Async Video Interview today, with Conversational AI Video
                  Interviews and adaptive follow-ups in development.
                </p>

                <div className="avi7-stages">
                  <div className="avi7-stage">
                    <h3>Async Video Interview</h3>
                    <p className="avi7-meta">
                      <span className="avi7-frag">Basic screening</span>{" "}
                      <span className="avi7-frag">structured questions</span>{" "}
                      <span className="avi7-frag">candidate&rsquo;s own time</span>
                    </p>
                  </div>
                  <div className="avi7-stage">
                    <h3>
                      Conversational AI Video Interview{" "}
                      <span className="avi7-soon">Coming soon</span>
                    </h3>
                    <p className="avi7-meta">
                      <span className="avi7-frag">Your team&rsquo;s questions</span>{" "}
                      <span className="avi7-frag">adaptive follow-ups</span>{" "}
                      <span className="avi7-frag">criteria-based scoring</span>
                    </p>
                  </div>
                </div>

                <p className="avi7-note">
                  Async Video Interviews are evaluated from the transcript, and conversational ones
                  will be too.
                </p>
              </header>

              <div className="avi7-visual" data-reveal>
                <div className="avi7-frame">
                  <p className="avi7-flag">
                    <span className="avi7-soon avi7-soon--on-dark">Coming soon</span>
                    <span>Not available yet</span>
                  </p>
                  <div className="avi7-tile avi7-tile--ai">
                    <span className="avi7-mark">
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <circle cx="10" cy="7" r="3.1" fill="currentColor" stroke="none" />
                        <path
                          d="M4.2 16.6a5.8 5.8 0 0 1 11.6 0v.6H4.2Z"
                          fill="currentColor"
                          stroke="none"
                        />
                      </svg>
                    </span>
                  </div>
                  {/* fill inside a tile that aspect-ratio has already sized, so the
                      photo reserves its box before it loads and contributes no layout
                      shift. The widths in sizes track the tile, not the viewport: it
                      is half the frame's inner width at every breakpoint. */}
                  <div className="avi7-tile">
                    <Image
                      src="/ai-video-interview.webp"
                      alt="A smiling bearded man in a blue shirt, on camera as the candidate in a preview of the upcoming Conversational AI Video Interview"
                      fill
                      sizes="(max-width: 639.98px) 40vw, (max-width: 1180px) 27vw, 21vw"
                      className="avi7-shot"
                    />
                  </div>
                  <p className="avi7-plab">AI Interviewer</p>
                  <p className="avi7-plab avi7-plab--quiet">Candidate</p>
                  <div className="avi7-cap">
                    <p className="avi7-olab">Question 4</p>
                    <p className="avi7-oq">
                      Tell me about a backend system you designed for scale.
                    </p>
                    <p className="avi7-olab">Follow-up</p>
                    <p className="avi7-oq">How did you handle failures when traffic spiked?</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="avi4-sec">
          <div className="avi4-wrap">
            <header>
              <p className="avi4-eyebrow">Evidence</p>
              <h2 className="avi4-h2">
                Every score points to the <span className="avi4-stick">words</span> behind it.
              </h2>
              <p className="avi4-lede">
                Remotiv scores what a candidate said, then shows the evidence behind each criterion.
                Every criterion includes the supporting transcript evidence and a timestamp that
                plays the matching moment in the interview recording.
              </p>
            </header>

            <div className="avi4-viz" data-reveal>
              <div className="avi4-panel">
                <div className="avi4-phead">
                  <p className="avi4-ptitle">Interview transcript</p>
                  <p className="avi4-psub">
                    <span className="avi4-ph">Priya Nair{SEP}</span>
                    <span className="avi4-ph">Senior Backend Engineer{SEP}</span>
                    <span className="avi4-ph">26 Aug{SEP}</span>
                    Async
                  </p>
                </div>

                {AVI4_TRANSCRIPT.map((block) => (
                  <div
                    key={block.id}
                    className="avi4-turns"
                    id={`avi4-tx-${block.id}`}
                    hidden={block.id !== AVI4_SELECTED.id}
                  >
                    {block.turns.map((turn) => (
                      <article
                        key={turn.time ?? turn.who}
                        className={turn.ev ? "avi4-turn avi4-turn--ev" : "avi4-turn"}
                        id={turn.ev ? `avi4-ev-${block.id}` : undefined}
                        tabIndex={turn.ev ? -1 : undefined}
                      >
                        <p className="avi4-who">
                          <span className="avi4-ph">
                            <b>{turn.who}</b>
                            {SEP}
                          </span>
                          {turn.time ??
                            `Scored ${AVI4_CRITERIA.find((c) => c.id === block.id)?.score}`}
                        </p>
                        <p className="avi4-say">{turn.say}</p>
                      </article>
                    ))}
                  </div>
                ))}

                {/* Depicted, not operable: the product's player for the selected
                    answer. The timestamp chip in the criteria panel moves it,
                    which is the chip's real behaviour — it seeks the video. */}
                <div className="avi4-player" aria-hidden="true">
                  <span className="avi4-play" />
                  <span className="avi4-ptrack">
                    <i id="avi4-p-fill" />
                  </span>
                  <span className="avi4-ptime">
                    <span id="avi4-p-now">0:00</span> /{" "}
                    <span id="avi4-p-dur">{AVI4_SELECTED.dur}</span>
                  </span>
                </div>
              </div>

              <div className="avi4-panel avi4-panel--crit">
                <div className="avi4-phead">
                  <p className="avi4-ptitle">Interview criteria</p>
                  <p className="avi4-psub">
                    <span className="avi4-ph">Found in the transcript{SEP}</span>
                    four criteria for this role
                  </p>
                </div>

                <ul className="avi4-crits">
                  {AVI4_CRITERIA.map((c) => (
                    <li key={c.id}>
                      <button
                        className="avi4-crow"
                        type="button"
                        aria-pressed={c.id === AVI4_SELECTED.id}
                        data-c={c.id}
                        data-q={c.q}
                        data-time={c.time}
                        data-dur={c.dur}
                        data-quote={c.quote}
                      >
                        <span className="avi4-cname">{c.name}</span>
                        <span className="avi4-ctick" aria-hidden="true">
                          <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M3.6 8.4 6.6 11.3 12.4 5.2" />
                          </svg>
                        </span>
                        <span className="avi4-sr">, found in the transcript</span>
                      </button>
                    </li>
                  ))}
                </ul>

                <div className="avi4-detail">
                  <p className="avi4-slabel">Selected criterion</p>
                  <div className="avi4-chead">
                    <p className="avi4-cbig" id="avi4-d-name">
                      {AVI4_SELECTED.name}
                    </p>
                    <div className="avi4-ring">
                      <svg viewBox="0 0 76 76" aria-hidden="true">
                        <circle className="avi4-trk" cx="38" cy="38" r="33" />
                        <circle
                          className="avi4-val"
                          cx="38"
                          cy="38"
                          r="33"
                          style={
                            {
                              "--c": RING_C_LG,
                              "--off": "0",
                              "--i": 0,
                            } as CSSPropertiesWithVars
                          }
                        />
                      </svg>
                      <span className="avi4-rtick" aria-hidden="true">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5.5 12.6 10 17 18.6 7.6" />
                        </svg>
                      </span>
                      <span className="avi4-sr">Found in the transcript</span>
                    </div>
                  </div>
                  <blockquote className="avi4-quote">
                    <p id="avi4-d-quote">{AVI4_SELECTED.quote}</p>
                  </blockquote>
                  <div className="avi4-evfoot">
                    <p className="avi4-stamp">
                      <span className="avi4-ph">
                        <span id="avi4-d-q">{AVI4_SELECTED.q}</span>
                        {SEP}
                      </span>
                      Priya Nair
                    </p>
                    <button
                      className="avi4-ghost"
                      type="button"
                      id="avi4-d-jump"
                      aria-label={`Play ${AVI4_SELECTED.q} from ${AVI4_SELECTED.time}`}
                    >
                      <span id="avi4-d-time">{AVI4_SELECTED.time}</span>
                    </button>
                  </div>
                  <p className="avi4-caveat">
                    The quote is the highlighted passage in the transcript. Its timestamp plays the
                    recording from that moment.
                  </p>
                  {/* Shortened, not deleted. This is the page's only statement
                      that interview scoring ignores face, voice and accent, and
                      section 4 is the section about scoring from a transcript. */}
                  <p className="avi4-disc">
                    Scored from the transcript text — no face, voice or accent analysis.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="avi6-sec">
          <div className="avi6-wrap">
            <div className="avi6-slab">
              <div className="avi6-grid">
                <header>
                  <p className="avi6-eyebrow">Human decision</p>
                  <h2 className="avi6-h2">Recommendations, never decisions.</h2>
                  <p className="avi6-lede">
                    Remotiv ranks and scores candidates, but it never moves or rejects anyone
                    automatically. Your team makes every stage change and can override any score —
                    with the AI&apos;s original kept for reference.
                  </p>
                </header>

                <div className="avi6-aside" data-reveal>
                  <div className="avi6-card">
                    <div className="avi6-split">
                      <div>
                        <p className="avi6-slabel">AI recommendation</p>
                        <div className="avi6-ident">
                          <p className="avi6-name">Priya Nair</p>
                          <div className="avi6-ring">
                            <svg viewBox="0 0 76 76" aria-hidden="true">
                              <circle className="avi6-trk" cx="38" cy="38" r="33" />
                              <circle
                                className="avi6-val"
                                cx="38"
                                cy="38"
                                r="33"
                                style={
                                  {
                                    "--c": RING_C_LG,
                                    "--off": "49.763",
                                    "--i": 0,
                                  } as CSSPropertiesWithVars
                                }
                              />
                            </svg>
                            <b>76</b>
                          </div>
                        </div>
                        <p className="avi6-flag">Flagged for shortlist</p>
                        <p className="avi6-only">Recommendation only</p>
                      </div>

                      <div className="avi6-human">
                        <p className="avi6-slabel avi6-slabel--quiet">Your team decides</p>
                        <div className="avi6-ctls">
                          <span className="avi6-ghost">Advance</span>
                          <span className="avi6-ghost">Hold</span>
                          <span className="avi6-ghost">Reject</span>
                        </div>
                        <p className="avi6-hint">No stage changes until someone makes one.</p>
                      </div>
                    </div>

                    <div className="avi6-over">
                      <div>
                        <p className="avi6-olab">Recruiter override</p>
                        <p className="avi6-onum">
                          <span className="avi6-was">76</span>
                          <span className="avi6-arrow" aria-hidden="true">
                            →
                          </span>
                          <span>82</span>
                        </p>
                      </div>
                      <p className="avi6-kept">Original AI score: 76 retained</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="avi8-sec">
          <div className="avi8-wrap">
            <div className="avi8-grid">
              <header className="avi8-copy">
                <p className="avi8-eyebrow">Candidate experience</p>
                <h2 className="avi8-h2">
                  Great candidates shouldn&rsquo;t be limited by time zones.
                </h2>
                <p className="avi8-lede">
                  A candidate in Lahore can interview for a company in New York without either side
                  finding a shared hour. Remotiv captures the interview so the hiring team can
                  review it when they&rsquo;re ready.
                </p>
              </header>

              <div className="avi8-aside" data-reveal>
                <figure className="avi8-frag">
                  <div className="avi8-fhead">
                    <p className="avi8-slabel">Setup check</p>
                    <p className="avi8-time">
                      <span className="avi8-ph">
                        Lahore
                        <span className="avi8-sep" aria-hidden="true">
                          {" · "}
                        </span>
                      </span>
                      21:40
                    </p>
                  </div>
                  <ul className="avi8-checks">
                    <li className="avi8-check">
                      <svg className="avi8-ico" viewBox="0 0 22 22" aria-hidden="true">
                        <rect x="2.5" y="6" width="12" height="10" rx="2.5" />
                        <path d="M14.5 10.5 19.5 8v6l-5-2.5Z" />
                      </svg>
                      <span className="avi8-clab">Camera</span>
                      <span className="avi8-cstate">
                        <svg className="avi8-tick" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3.2 8.4 6.5 11.7 12.8 5" />
                        </svg>
                        Ready
                      </span>
                    </li>
                    <li className="avi8-check">
                      <svg className="avi8-ico" viewBox="0 0 22 22" aria-hidden="true">
                        <rect x="8.25" y="2.5" width="5.5" height="10" rx="2.75" />
                        <path d="M5.5 10.5a5.5 5.5 0 0 0 11 0M11 16v3.5M8 19.5h6" />
                      </svg>
                      <span className="avi8-clab">Microphone</span>
                      <span className="avi8-cstate">
                        <svg className="avi8-tick" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3.2 8.4 6.5 11.7 12.8 5" />
                        </svg>
                        Ready
                      </span>
                    </li>
                    <li className="avi8-check">
                      <svg className="avi8-ico" viewBox="0 0 22 22" aria-hidden="true">
                        <path d="M2.5 8a12 12 0 0 1 17 0M5.8 11.4a7.4 7.4 0 0 1 10.4 0M9 14.8a2.8 2.8 0 0 1 4 0" />
                        <circle cx="11" cy="18.2" r=".9" fill="currentColor" stroke="none" />
                      </svg>
                      <span className="avi8-clab">Connection</span>
                      <span className="avi8-cstate">
                        <svg className="avi8-tick" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3.2 8.4 6.5 11.7 12.8 5" />
                        </svg>
                        Stable
                      </span>
                    </li>
                  </ul>
                  <p className="avi8-note">All three pass before the interview can start.</p>
                  {/* Depicted, not operable: a span rather than a button, so
                      nothing here is focusable or announced as a control. */}
                  <span className="avi8-ghost" aria-hidden="true">
                    Start interview
                  </span>
                </figure>
              </div>
            </div>

            <ol className="avi8-steps" data-reveal>
              {AVI8_STEPS.map((s, i) => (
                <li
                  className="avi8-step"
                  key={s.name}
                  style={{ "--i": i } as CSSPropertiesWithVars}
                >
                  <span className="avi8-num">{i + 1}</span>
                  <h3 className="avi8-sname">{s.name}</h3>
                  <p className="avi8-sline">{s.line}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="avi9-sec">
          <div className="avi9-wrap">
            <header className="avi9-copy">
              <p className="avi9-eyebrow">Automation</p>
              <h2 className="avi9-h2">
                From invitation to booked interview, without the back-and-forth.
              </h2>
              <p className="avi9-lede">
                Interview invitations and reminders go out over WhatsApp and email. Booking links
                let candidates pick a slot from your team&rsquo;s availability, and confirmations
                and any rescheduling reach both sides.
              </p>
            </header>

            <div className="avi9-body">
              <ol className="avi9-flow" data-reveal>
                {AVI9_STEPS.map((s, i) => (
                  <li
                    className="avi9-step"
                    key={s.name}
                    style={{ "--i": i } as CSSPropertiesWithVars}
                  >
                    <h3 className="avi9-sname">{s.name}</h3>
                    <p className="avi9-sline">{s.line}</p>
                  </li>
                ))}
              </ol>

              <div className="avi9-aside" data-reveal>
                <figure className="avi9-frag">
                  <div className="avi9-fhead">
                    <p className="avi9-slabel">WhatsApp</p>
                    <p className="avi9-chan">
                      Tue
                      <span className="avi9-sep" aria-hidden="true">
                        {" · "}
                      </span>
                      09:02
                    </p>
                  </div>

                  {/* The sender is the hiring company, not Remotiv. */}
                  <div className="avi9-who">
                    <span className="avi9-av" aria-hidden="true">
                      V
                    </span>
                    <span>
                      <span className="avi9-wname">Vantera</span>
                    </span>
                  </div>

                  <div className="avi9-chat">
                    <div className="avi9-bub">
                      {/* The async interview invite, the one message WhatsApp
                          really carries alongside its reminder. Its variables are
                          the template's own: first name, company, role, minutes
                          (12 unless the job sets one) and deadline, which is five
                          days after a Tuesday send. The wording itself lives in
                          Meta, not this repo. */}
                      <p className="avi9-mtext">
                        Hi Ayesha &mdash; we&rsquo;d like to invite you to a video interview for
                        Senior Backend Engineer. It takes about 12 minutes. Please finish by Sunday.
                      </p>
                      {/* Depicted, not operable: a span rather than a button, so
                          nothing here is focusable or announced as a control. */}
                      <span className="avi9-ghost" aria-hidden="true">
                        Start interview
                      </span>
                      <p className="avi9-stamp">
                        09:02
                        <svg className="avi9-ticks" viewBox="0 0 18 12" aria-hidden="true">
                          <path d="M1.5 6.6 4.4 9.5 9.6 3.2" />
                          <path d="M8.2 6.6 11.1 9.5 16.3 3.2" />
                        </svg>
                      </p>
                    </div>
                  </div>

                  <p className="avi9-deliv">
                    <svg className="avi9-tick" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.2 8.4 6.5 11.7 12.8 5" />
                    </svg>
                    <span>
                      <span className="avi9-ph">
                        Delivered
                        <span className="avi9-sep" aria-hidden="true">
                          {" · "}
                        </span>
                      </span>
                      also sent by email
                    </span>
                  </p>
                </figure>
              </div>
            </div>
          </div>
        </section>

        <section className="avi10-sec">
          <div className="avi10-wrap">
            <header>
              <p className="avi10-eyebrow">Hiring analytics</p>
              <h2 className="avi10-h2">
                See what the data says &mdash; and when it doesn&rsquo;t say{" "}
                <span className="avi10-hl">enough</span> yet.
              </h2>
              <p className="avi10-lede">
                Remotiv tracks interview activity and hiring movement, but it doesn&rsquo;t turn
                missing data into confident-looking metrics. When there isn&rsquo;t enough evidence
                for a conclusion, the dashboard says so.
              </p>
            </header>

            <div className="avi10-panelo" data-reveal>
              <figure className="avi10-panel">
                <div className="avi10-phead">
                  <h3 className="avi10-ptitle">
                    Analytics
                    <span className="avi10-sep" aria-hidden="true">
                      {" · "}
                    </span>
                    <span className="avi10-pmeta">Vantera workspace</span>
                  </h3>
                  {/* Depicted, not operable: a span rather than a button, so
                      nothing here is focusable or announced as a control. */}
                  <span className="avi10-ghost" aria-hidden="true">
                    All time
                    <svg className="avi10-gico" viewBox="0 0 9 9" aria-hidden="true">
                      <path d="M1.4 3.2 4.5 6.3 7.6 3.2" />
                    </svg>
                  </span>
                </div>

                <div className="avi10-cards">
                  {AVI10_TILES.map((t, i) => (
                    <div
                      className="avi10-tile"
                      key={t.name}
                      style={{ "--i": i } as CSSPropertiesWithVars}
                    >
                      <p className="avi10-tname">{t.name}</p>
                      <p className="avi10-val">
                        {t.value ?? (
                          <>
                            <span aria-hidden="true">&mdash;</span>
                            <span className="avi10-sr">No value reported</span>
                          </>
                        )}
                      </p>
                      <p className="avi10-state">{t.state}</p>
                    </div>
                  ))}
                </div>

                <figcaption className="avi10-note">
                  <p className="avi10-nlabel">When a number appears</p>
                  <p className="avi10-ntext">
                    A metric is reported once this workspace&rsquo;s own activity supports it.
                    Nothing here is modelled, benchmarked against other companies or estimated to
                    fill a gap &mdash; where the evidence isn&rsquo;t there yet, Remotiv prints an
                    em-dash instead of a number it can&rsquo;t stand behind.
                  </p>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="avi11-sec">
          <div className="avi11-wrap">
            <header>
              <p className="avi11-eyebrow">Security &amp; responsible AI</p>
              <h2 className="avi11-h2">
                Candidate data stays <span className="avi11-hl">protected</span> throughout the
                interview.
              </h2>
              <p className="avi11-lede">
                Candidates know when they&rsquo;re being recorded, who will see their answers, and
                how long their interview data is kept.
              </p>
            </header>

            <div className="avi11-cards" data-reveal>
              {AVI11_CARDS.map((c, i) => (
                <article
                  className="avi11-card"
                  key={c.num}
                  style={{ "--i": i } as CSSPropertiesWithVars}
                >
                  <p className="avi11-num" aria-hidden="true">
                    {c.num}
                  </p>
                  <span className="avi11-tile" aria-hidden="true">
                    <svg className="avi11-tico" viewBox="0 0 16 16" aria-hidden="true">
                      {c.icon}
                    </svg>
                  </span>
                  <h3 className="avi11-ctitle">{c.title}</h3>
                  <p className="avi11-ctext">{c.line}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Section 12a — the early-access card, ported from the "Send an
            Inquiry" block that opens the closing pair on every service page.
            Not imported: five inline copies of that card already exist across
            the site and that is the established pattern here.

            Inquiry first, FAQ last. That is the rendered order on all four
            service pages; their source order reads the other way only because
            both blocks sit in helpers declared above the component.

            id="early-access" is what both hero buttons have been pointing at
            since section 1 shipped. It resolves for the first time here. */}
        <section className="avi12-cta" id="early-access">
          <div className="avi12-cta-wrap">
            <div className="avi12-card">
              <div className="avi12-copy">
                {/* the bullet is a literal character on all four originals,
                    not a marker, so it is one here too */}
                <span className="avi12-pill">• Early Access</span>
                <h2 className="avi12-h2">Ready to spend less time on first-round screening?</h2>
                <p className="avi12-lede">
                  Join early access to see how Remotiv can fit into your hiring workflow.
                </p>
                <ul className="avi12-checks">
                  {AVI12_CHECKS.map((item) => (
                    <li className="avi12-check" key={item}>
                      <span className="avi12-cico" aria-hidden="true">
                        <svg viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M2 6l3 3 5-5" />
                        </svg>
                      </span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="avi12-panel">
                {/* Result panels take focus when a script-owned submit lands on
                    them. They are NOT focusable in the markup: Chrome focuses a
                    focusable fragment target on any hash navigation, so a
                    tabIndex here moved focus on a cold load or a manual hash
                    change as well. The script adds tabindex="-1" at the moment
                    it lands a result and removes it on blur. They carry no
                    live-region role: focus is what announces them, and a live
                    region on a panel that also receives focus is read twice. */}
                <div className="avi12-sent" id="avi12-sent">
                  <div className="avi12-sent-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  </div>
                  <h3 className="avi12-sent-h3">Inquiry Sent!</h3>
                  <p className="avi12-sent-p">
                    Thanks for reaching out. We&rsquo;ll get back to you within 24 hours.
                  </p>
                  {/* a link, not a button: moving the fragment off #avi12-sent
                      is what brings the form back */}
                  <a className="avi12-again" href="#early-access">
                    Submit Another Inquiry →
                  </a>
                </div>

                <form className="avi12-form" action={submitEarlyAccess}>
                  <h3 className="avi12-form-h3">Send an Inquiry</h3>

                  {/* Server-rendered error panels rather than one with a dynamic
                      message: this page is statically prerendered, so there is
                      nowhere to put a runtime string. The action redirects to
                      whichever fragment matches. */}
                  <p className="avi12-err" id="avi12-e-input">
                    Please check your name, work email and message, then try again.
                  </p>
                  <p className="avi12-err" id="avi12-e-rate">
                    Too many submissions. Please wait a moment and try again.
                  </p>
                  <p className="avi12-err" id="avi12-e-server">
                    We couldn&rsquo;t send your inquiry. Please try again or email us at{" "}
                    <a href="mailto:talent@remotiv.work">talent@remotiv.work</a>.
                  </p>
                  {/* Opened only by the script's 30-second abort. A timed-out
                      request may still have reached the server, so this one
                      says not to send again. The server never redirects here. */}
                  <p className="avi12-err" id="avi12-e-timeout">
                    This is taking longer than it should, and your inquiry may already have reached
                    us. Please don&rsquo;t send it again &mdash; email{" "}
                    <a href="mailto:talent@remotiv.work">talent@remotiv.work</a>
                    {" and we’ll confirm."}
                  </p>

                  {/* Honeypot — hidden from humans, filled by bots. inert because
                      tabIndex={-1} only keeps it out of the Tab order: after a
                      rejected submit, Next's hash-scroll handler skipped the
                      still-hidden error panel, walked to the next sibling and
                      called focus() on this field, so a keyboard user typing
                      next filled the trap and their inquiry was silently
                      discarded as a bot's. An inert field cannot take focus and
                      is still submitted, so bots still trip it. */}
                  <input
                    className="avi12-hp"
                    type="text"
                    name="company_url"
                    tabIndex={-1}
                    autoComplete="off"
                    aria-hidden="true"
                    inert
                  />

                  <div className="avi12-row">
                    <div>
                      <label className="avi12-label" htmlFor="avi12-name">
                        Full Name{" "}
                        <span className="avi12-req" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <input
                        className="avi12-input"
                        id="avi12-name"
                        name="name"
                        type="text"
                        required
                        maxLength={100}
                        placeholder="Your name"
                      />
                    </div>
                    <div>
                      <label className="avi12-label" htmlFor="avi12-company">
                        Company{" "}
                        <span className="avi12-req" aria-hidden="true">
                          *
                        </span>
                      </label>
                      <input
                        className="avi12-input"
                        id="avi12-company"
                        name="company"
                        type="text"
                        required
                        maxLength={100}
                        placeholder="Company name"
                      />
                    </div>
                  </div>

                  <div className="avi12-field">
                    <label className="avi12-label" htmlFor="avi12-email">
                      Work Email{" "}
                      <span className="avi12-req" aria-hidden="true">
                        *
                      </span>
                    </label>
                    <input
                      className="avi12-input"
                      id="avi12-email"
                      name="email"
                      type="email"
                      required
                      maxLength={254}
                      placeholder="you@company.com"
                    />
                  </div>

                  <div className="avi12-field">
                    <label className="avi12-label" htmlFor="avi12-message">
                      Message{" "}
                      <span className="avi12-req" aria-hidden="true">
                        *
                      </span>
                    </label>
                    {/* no rows attribute: the originals size this from
                        min-height alone, and rows=3 made it 92px rather than
                        68px once the font steps up below the sm breakpoint */}
                    <textarea
                      className="avi12-input"
                      id="avi12-message"
                      name="message"
                      required
                      maxLength={5000}
                      placeholder="Tell us about the role..."
                    />
                  </div>

                  <button className="avi12-submit" type="submit">
                    <span className="avi12-sub-idle">Send Inquiry →</span>
                    <span className="avi12-sub-busy">Sending…</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
        </section>

        {/* Section 12b — FAQ, ported from the one on /services/dedicated-team,
            where it is likewise the last section on the page. This section and
            the card above it are deliberately outside
            SECTION-4-DESIGN-CONTRACT.md; the long header comment above the
            .avi12- rules in ai-video-interviews.css says why. */}
        <section className="avi12-faq">
          <div className="avi12-faq-wrap">
            <div className="avi12-faq-intro">
              {/* No eyebrow, and the same heading the four service pages use.
                  Every other section on this page opens with an eyebrow; this
                  one does not, because the block it is copying does not. */}
              <h2 className="avi12-faq-h2">Questions We Hear Most</h2>
              {/* the same sentence the four service pages carry under this
                  heading — furniture, so it is ported rather than rewritten */}
              <p className="avi12-faq-lede">
                For any unanswered questions, reach out to our team. We&apos;ll respond as soon as
                possible.
              </p>
            </div>

            <div className="avi12-faq-col">
              <div className="avi12-faq-list">
                {AVI12_FAQS.map((f, i) => (
                  <div className="avi12-faq-item" key={f.q} data-open={i === 0 ? "true" : "false"}>
                    <button
                      type="button"
                      className="avi12-faq-btn"
                      id={`avi12-faq-button-${i}`}
                      aria-expanded={i === 0}
                      aria-controls={`avi12-faq-panel-${i}`}
                    >
                      <span className="avi12-faq-q">{f.q}</span>
                      <span className="avi12-faq-sign" aria-hidden="true">
                        {i === 0 ? "−" : "+"}
                      </span>
                    </button>
                    {/* <section> rather than the original's <div role="region">
                        — a named section already has that role, and Biome
                        rejects the explicit one. Same tree, one less attribute.
                        The inner div is load-bearing: the 0fr -> 1fr panel
                        needs one grid child to clip, not the text itself.
                        A collapsed panel is visibility:hidden in the CSS, so
                        its answer and its region leave the accessibility tree;
                        height 0 alone left all four readable and all four
                        regions exposed as landmarks. */}
                    <section
                      className="avi12-faq-panel"
                      id={`avi12-faq-panel-${i}`}
                      aria-labelledby={`avi12-faq-button-${i}`}
                    >
                      <div>
                        <p className="avi12-faq-a">{f.a}</p>
                      </div>
                    </section>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>
      {/* Entrance observer. Raw inline script rather than next/script so the
          page stays a server component — the same pattern as the JSON-LD in
          src/app/join-as-talent/layout.tsx. The 2.2s timeout is a safety net
          for the case where the observer never fires but the rail is already
          on screen; without IntersectionObserver everything just shows. */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 2 entrance observer
        dangerouslySetInnerHTML={{ __html: REVEAL_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 3 entrance observer
        dangerouslySetInnerHTML={{ __html: SECTION3_REVEAL_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 4 entrance observer and criterion switcher
        dangerouslySetInnerHTML={{ __html: SECTION4_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 6 entrance observer
        dangerouslySetInnerHTML={{ __html: SECTION6_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 7 entrance observer
        dangerouslySetInnerHTML={{ __html: SECTION7_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 8 entrance observer
        dangerouslySetInnerHTML={{ __html: SECTION8_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 9 entrance observer
        dangerouslySetInnerHTML={{ __html: SECTION9_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 10 entrance observer
        dangerouslySetInnerHTML={{ __html: SECTION10_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 11 entrance observer
        dangerouslySetInnerHTML={{ __html: SECTION11_SCRIPT }}
      />
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: inline bootstrap script for the section 12 FAQ accordion and inquiry result panels
        dangerouslySetInnerHTML={{ __html: SECTION12_SCRIPT }}
      />
    </>
  );
}
