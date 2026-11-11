# Design audit - AI dashboard Applicants side drawer

Read-only audit of the applicant detail panel that opens when a row on
`/ai-dashboard/applicants` is clicked. Written as a spec for Claude Design, in
the same format as `docs/DESIGN-AUDIT-APPLICANTS-LIST.md`. No code was changed.

**Line numbers are from the WORKING TREE at HEAD fe5f829 (11 Nov 2026), which
carries uncommitted #76 edits to `_applicants-client.tsx` and other applicants
files from another session. They may shift when that work lands.** Unless
another file is named, `:NNNN` means
`src/app/ai-dashboard/(gated)/applicants/_applicants-client.tsx`.

Values marked COMPUTED were derived, not read; nothing was measured in a
browser. Claims are PROVEN (file:line) unless marked POSSIBLE. No real data
appears here; the candidate is "Candidate A".

---

## 0. How to read the sizes

Same rule as the list audit: everything sits inside `.ai-shell { zoom: 0.82 }`
(`src/app/ai-dashboard/ai-dashboard.css:30`). Sizes are written `CSS / screen`,
where screen = CSS x 0.82. **Breakpoints are real browser widths** and are not
scaled. Inside the shell, full height is `--vh-full: calc(100vh / 0.82)`
(`ai-dashboard.css:39`).

Conversions used in this file (CSS -> screen): 4 -> 3.3, 7 -> 5.7, 9 -> 7.4,
10 -> 8.2, 10.5 -> 8.6, 11 -> 9.0, 11.5 -> 9.4, 12 -> 9.8, 12.5 -> 10.3,
13 -> 10.7, 13.5 -> 11.1, 14 -> 11.5, 15 -> 12.3, 17 -> 13.9, 18 -> 14.8,
19 -> 15.6, 20 -> 16.4, 21 -> 17.2, 22 -> 18.0, 25 -> 20.5, 26 -> 21.3,
30 -> 24.6, 34 -> 27.9, 42 -> 34.4, 54 -> 44.3, 112 -> 91.8, 200 -> 164,
1100 -> 902.

---

## 1. Frame

**Element** (`:1735-1743`)
- A `<div role="dialog" aria-modal="true" tabIndex={-1}>`, labelled
  "`<name>` - applicant detail".
- `position: fixed; right: 0; top: 0`, `z-index: 95`.
- Height `var(--vh-full)`, the full real viewport.
- Width `100%`, capped at `max-width: min(96%, 1100px)`, so `1100px / 902` at most.
  - COMPUTED: the cap is hit at real widths of about 940px and up (1100 / 0.82 / 0.96 ≈ 1146 CSS).
  - Below that it is 96% of the screen, leaving a 4% strip of the list visible on the left.
  - There is no separate phone layout for the frame.
- Background `--ai-surface #FFFFFF`. Shadow `-24px 0 70px rgba(20,16,32,.24)`, cast to the left.
- No radius, no border, no scrim. Focus outline suppressed (`outline-none`).
- A vertical flex column: a fixed header, then a scrolling body.

**Behind the drawer** (`:5739-5741`)
- The list is not covered by a scrim. It fades to 30% opacity and stops taking
  pointer events.
- `useModalFocus` makes everything outside the drawer `inert` (section 8).
- Page scroll is locked: `lockScroll` defaults on (`src/hooks/use-modal-focus.ts`,
  `document.body.style.overflow = "hidden"`).
- Other overlays sit above the drawer at `z-[100]`: the add-candidate dialog
  (`:6334`), the delete confirm (`:6521`) and the email Composer (`:6300`).
- Stale comment, POSSIBLE: `:4603` calls the drawer "a fixed overlay with a
  backdrop-blur". The frame at `:1742` has no backdrop-blur.

**Top row** (`:1751-1804`, inside the header)
- **"Back to applicants"** on the left (`:1755-1762`): ChevronLeft icon,
  `12.5px / 10.3` semibold, `--ai-t3`.
  - Hover: `--ai-inset` fill and `--ai-t1` text. Radius 11px.
  - Calls `onClose`.
- On the right: **Previous**, the counter **"N of M"** and **Next** (`:1772-1795`).
  - Each arrow is a `PANEL_ICON_BTN` (`:1004-1005`): `30px / 24.6` square,
    radius 11px, `1px` `--ai-line` border, `--ai-t3`, 14px icon, disabled at 40%.
  - The counter is `11.5px / 9.4` semibold, tabular numbers, `--ai-t3`.
  - Then a **Close (X)** icon button, the same style, `aria-label="Close"`.
  - The arrows are **hidden, not disabled**, when the panel was deep-linked to
    someone outside the current filters (`position` is null, `:1767-1771`).
  - They step through the **filtered population across page boundaries**. A
    step off the page loads the next page first (`stepApplicant`, `:5036-5054`;
    arithmetic in `list-state.ts:549-600`, tested in `list-step.test.ts`).
  - In Review-top-10 mode they step within the 10 (`:5039-5042`).

**Phone behaviour**
- Same overlay at 96% width.
- Below a real 525px:
  - the header score ring and its divider are hidden (`:1854-1883`);
  - the "Communication" tab reads "Comms" (`:1996-1999`).
- The drawer-header test comment records the header as 163px tall at 360px and
  375px (`:1840-1846`, CSS px, measured there and not here).
- The Profile, Review-evidence and dimension grids go single-column below a real
  840px (sections 4.1 and 4.2).

---

## 2. Header

The header is white, with a `1px` `--ai-line` bottom border. Padding is
`22px / 18.0` on the sides and `16px / 13.1` on top (`:1746`).
- The gutter is deliberately 22, not the design's 30, to line up with the body (`:1741-1745`).

**Identity row** (`:1807-1880`), gap `15px / 12.3`, bottom padding `16px`.

| Element | Spec |
|---|---|
| Avatar (`:1808-1813`) | `54px / 44.3` circle. Sora 800 initials, `18px / 14.8`. Same 6-tint hash as the list. Ring `0 0 0 3px rgba(126,71,255,.1)`. |
| Name (`:1815-1817`) | `<h2>`, Sora 800, `21px / 17.2`, line-height 1.15, letter-spacing -0.03em, `--ai-t1`, **truncates** on one line |
| Identity line (`:1821-1838`) | `12.5px / 10.3` medium `--ai-t3`. Order: **email** (bold, `--ai-t2`, truncates), a dot, location ("City, Country", only if present), a dot, "Applied 14 Oct 2026". The dot (`IdDot`, `:614-616`) is `3px` `--ai-t4`. |
| Score, at a real 525px and up (`:1854-1883`) | Mini ring `42px / 34.4`, radius 18, stroke 4, track `--ai-slate-tint` (`DrawerMiniRing`, `:619-650`). Number in Sora 800 `14px / 11.5` `--ai-t1`. Beside it the band label (`12.5px` bold): "Strong match" (80 and up), "Moderate match" (60-79), "Needs review" (below 60) (`lib/score-bands.ts:15-19`, `:46-50`). If adjusted, "Adjusted" underneath (`11px` semibold `--ai-t3`). Then a `1px x 36px` divider. **No ring at all when unscored** (`:1849-1851`). |
| Stage control (`:1917-1954`) | Label "Stage" `11.5px` bold `--ai-t3`. A native `<select id="applicant-stage">`: radius 11px, `--ai-inset` fill, `1px` `--ai-line` border, padding `9px 34px 9px 30px`, `13px / 10.7` bold `--ai-t1`. A `7px` `--ai-t3` dot sits inside on the left and a chevron on the right. Focus: purple border plus a `3px` purple ring at 16%. Disabled (70%, wait cursor) while saving. Deliberately **neutral**: no per-stage colour (`:1889-1895`). |
| Stage, hiring manager on a decision stage (`:1900-1914`) | Read-only text in the same box, with "Only an owner, admin or recruiter can change this." (`11px` `--ai-t3`). A hiring manager's select leaves out Hired and Rejected (`:1940-1942`; same rule as the server's `canChangeStage`). |

- The header has no chips. "Top match" does not appear in the drawer.
- "Worth a look" shows in the body as a banner instead (section 4).

---

## 3. Tabs

**The strip** (`:1979-2006`)
- Horizontal scroll, never wraps (`overflow-x-auto`), gap `26px / 21.3`.
- A right-edge fade mask appears when there is more to scroll (`TAB_FADE_MASK`, `:1024`).
- The active tab is scrolled into view (`:1603-1618`, `tab-scroll.ts`).

**Each tab** (`PANEL_TAB_BASE`, `:1011-1012`)
- A `<button>`, `13px / 10.7` bold, `12px` bottom padding, no wrap.
- Underline: `2px` tall, top corners rounded, `1px` below the button so it sits
  on the header's bottom border.
- Active: text `--ai-t1`, underline `--ai-sidebar #141020`.
- Inactive: `--ai-t3`, `--ai-t1` on hover, no underline.
- The active state is announced with `aria-current="page"` (`:1988`).

**The six tabs** (`PANEL_TABS`, `:203-230`), in order:

| Label | `?tab=` value | Notes |
|---|---|---|
| Profile | `profile` | default |
| Review | `review` | |
| Communication (**"Comms"** below a real 525px) | `comm` | the URL value is `comm`, and must stay so: shared links use it (`:205-210`) |
| Interviews | `interviews` | |
| Timeline | `timeline` | replaced the old stage-history card on Profile (`:216-222`) |
| Comments | `comments` | no count beside the label, on purpose (`:223-228`); the pane head carries it |

**Tab behaviour**
- An invalid `?tab=` value falls back to Profile (`isPanelTab`, `:232-234`; `:4650-4654`).
- **The tab is sticky across applicants**: opening another row keeps the
  current tab (`openApplicant` passes `panelTab`, `:4685-4691`).
- Panes **unmount** rather than hide, because the Interviews pane fires 3
  fetches on mount (`:2013-2015`).

---

## 4. Body and each tab's content

**Body** (`:2016`)
- `--ai-inset #F7F3EF` background. Padding `22px` on the sides, `18px` top, `28px` bottom.
- It is the only vertical scroll container (`overflow-y-auto`).
- Content is laid out as white cards.

**Card primitive** (`PaneCard`, `:4130-4152`; `CARD_SURFACE`, `:1031-1032`)
- White, radius `20px / 16.4`, `1px` `--ai-line` border, shadow `0 6px 30px rgba(20,16,32,.06)`.
- Padding `20px 22px`.
- Title `<h3>` in Sora 700, `15px / 12.3`, letter-spacing -0.02em, `--ai-t1`.
- Optional meta on the right, `11px` medium `--ai-t3`.
- `14px` gap below the head.

**"Worth a look" banner** (`:2021-2051`)
- Above every tab, when the row is flagged.
- Lime `#D9F972` fill, radius 16px, padding `13px 16px`.
- A `30px` flag disc.
- Title "Worth a look" in Sora 700 `13px` `#2F3A00`.
- The reason underneath in `12px` `#2F3A00` at 70%. Fallback text: "Met your auto-shortlist mark."
- An icon-only dismiss button (`26px`, `aria-label="Dismiss flag"`). Its title
  reads "Clears the flag. A materially better score later flags them again."

### 4.1 Profile (`:2053-2290`)

**Layout**
- Two columns from a real 840px: `minmax(0,1.32fr) | minmax(0,1fr)`, gap `20px` (`:2054`).
- One column below that.

**Left column, card "Application"** (`:2056-2140`)
- "Applied to **<job title>** · 28d ago". It reads "Added to" on a manually added
  row (`:2059-2061`). `13px` `--ai-t3`, with the title bold `--ai-t1`.
- Manual row: the "Added by team" chip, plus "Not emailed - they didn't apply
  through the job board." (`12px` `--ai-t4`, `:2068-2075`).
- Actions sit under a hairline (`:2079`), in two equal buttons:
  - **CV button** (`:2082-2099`): a real `<a href="/api/cv/company-application/<id>" target="_blank">`.
    - Purple fill with a purple shadow when a CV exists.
    - Otherwise a dead `--ai-inset` button in `--ai-t4`.
    - Label: "Open CV" / "No CV" / "CV expired" (`cvLabel`, `:415-418`).
  - **Email** (`:2103-2111`): white outline button, which turns dark on hover.
    It opens the in-app Composer, **not** `mailto:` (`:2100-2102`).
  - Both: radius 12px, padding `11px 12px`, `13px` bold, 15px icon.
- Expired CV note: "CVs are deleted 24 months after the application. Everything
  else on this applicant is unaffected." (`11.5px` `--ai-t4`, `:2129-2134`).
- A general "Replace / Add CV" button was **removed on purpose**. Do not
  reintroduce it (`:2112-2126`).

**Left column, card "Screening questions"** (`:2141-2215`)
- Only when the job asked questions.
- Failed read: a red notice, "The screening answers couldn't be loaded. That
  isn't the same as the candidate answering nothing - close and reopen to try again."
- Loading: two pulsing bars.
- Intro line: "Answered by the candidate at apply time and checked against the
  thresholds you set. Self-reported - not verified by Remotiv." (`11.5px` `--ai-t3`)
- Each answer is a bordered box: radius 12px, padding `11px 13px`, hover inset.
  - The question: `12px` `--ai-t3`, plus an **"Essential"** pill (purple tint,
    `10px` bold uppercase) when it is essential.
  - The answer: `14px` bold `--ai-t1`. "-" if empty.
  - A result pill (`10.5px` semibold): "Meets threshold" (slate) or "Below threshold" (amber).
  - **Deliberately not green**, because nothing was verified (`:2186-2193`).
  - **No pill at all** when no threshold was set (`scored === false`, `:2194-2201`).

**Right column, card "Details"** (`:2219-2248`)
- Only when at least one value exists (`hasDetails`, `:1658-1666`).
- Rows (`DetailRow`, `:4162-4169`): label `--ai-t3` on the left, value bold
  `--ai-t1` on the right, `13.5px / 11.1`, `9px` top and bottom padding,
  hairline dividers.
- Rows in order, each only if present:
  - **Location**
  - **Experience** ("N years")
  - **Notice period**
  - **Availability**
  - **Phone**
  - **LinkedIn**: a purple "Profile" link with an external-link icon, opening in a new tab.
- POSSIBLE: values have no truncate or `min-w-0`, so a very long availability or
  notice-period text could push the row wide. Not checked in a browser.

**Right column, card "Danger"** (`:2263-2277`)
- A "Delete applicant" button: danger tint, `--ai-danger` text, `12px` semibold, trash icon.
- It opens a confirm dialog; it does not delete on click.
- Note underneath: "Permanently removes this applicant, their CV file, their AI
  scorecard and their pipeline history. This cannot be undone." (**`10px / 8.2` `--ai-t4`**)

### 4.2 Review (`:2296-2685`)

**Score card**
- White card, radius 20px, `28px` margin below (`:2301`).
- When scored: three columns from a real 840px (`auto | 1fr | auto`), gap
  `30px`, padding `24px 26px` (`:2303`).
  - **Ring** (`ReviewScoreRing`, `:652-683`): `112px / 91.8`, radius 49, stroke 9,
    track `--ai-slate-tint`.
    - The number in Sora 800, `34px / 27.9`, `--ai-t1`.
    - "OUT OF 100" underneath, `10.5px` bold uppercase `--ai-t3`.
    - Below the ring, a band pill (`10.5px` bold uppercase): "Strong" (mint),
      "Moderate" (amber) or "Needs review" (danger tint) (`score-bands.ts:32-36`, `:60-64`).
  - **Middle column**:
    - The model's **verdict**, `<h2>` in Sora 800 `19px / 15.6`. It is omitted on
      scorecards older than v4 (`:2321-2325`).
    - A **confidence badge**: "High / Medium / Low confidence", in mint / amber /
      slate (`CONFIDENCE_BADGE`, `:600-612`). Low is never green.
    - The lede (`scoreLede`, `:396-404`): "Based on how much the CV actually
      showed." / "Scored against this job's stated requirements." / "Scored by a
      reviewer. The AI did not produce a score for this CV."
    - Then " Self-reported thresholds met: N%." when present.
    - **Adjusted**: "AI scored 72" (or "Scored by hand") plus the byline
      " · adjusted by <name> on 12 Mar 2026" (`adjustmentByline`, `:354-363`).
      **The AI's own number stays on screen** beside the human one (`:2345-2353`).
    - Small print, `11px` `--ai-t3`, above a hairline: "Scored from written
      application text only. Remotiv AI does not analyse face, voice or accent,
      and the score is advisory - a person decides." Then the provenance
      " Model vNN · scored 17 Sep 2026.", only when the AI itself scored
      (`scoreProvenance`, `:377-385`).
  - **Right column**:
    - **Re-score**, plus "Uses one AI scoring credit" (`11px`). Only for roles
      that can re-score, and hidden when the score is stale.
    - **"Adjust score"** / **"Edit adjustment"**.
    - Buttons use `REVIEW_BTN_SEC` (`:1027-1028`): radius 11px, `13.5px` bold,
      white with a `--ai-line-strong` border.
- **Unscored** (`:2405-2470`): one centred block.
  - The heading and body come from `unscoredCardState`
    (`src/app/ai-dashboard/lib/unscored-card.ts`).
  - The border is dashed while in progress or retrying, and invisible otherwise.
  - Possible controls: "Upload a readable CV" (a PDF file input), "Open job
    settings" plus a hint, and "Score it yourself" / "Edit adjustment".
- **Adjust form** (`ScoreAdjustForm`, `:1051-1137`): purple-tint box, radius 16px.
  - "YOUR SCORE" label, a 0-100 slider plus a `72px` number input, and "The AI scored N."
  - "WHY WAS THE AI WRONG?" textarea, with placeholder text.
  - Buttons "Save adjustment" (purple) and "Cancel".
  - Error text "Enter a whole number from 0 to 100." in `#C4362F`.
- **Adjustment record** (`AdjustmentRecord`, `:1139-1181`): an inset box with the
  byline, the reviewer's note in italics with a left rule, and Edit / Revert buttons.
- **Scoring tip card** under the score card: only when scored, the tip isn't
  dismissed, and the row is not "Worth a look" (`:2509-2511`).

**Model output**
- Only when the AI itself produced a scorecard (`ai_status === "scored"`, `:2525`).
- **Summary**: a card titled "Summary".
  - Meta on the right: "Generated from the CV" or "...and N screening answers"
    (`summarySource`, `:1334-1344`).
  - Body `13px` line-height 1.72 `--ai-t2`.
- **Scored dimensions**: a sub-head (Sora 700 `15px` plus a hairline, `:1183-1201`),
  then a card of rows (`ScoredDimension`, `:1384-1449`).
  - Grid from a real 840px: `200px | bar | score`.
  - The four names: Requirements match, Experience depth, Domain relevance,
    Responsibilities fit (`:588-593`).
  - Bar: `8px` tall on a slate track, in the band colour.
  - The score in Sora 800 `25px / 20.5`, band ink colour, plus "/100" (`12px`).
  - The reasoning below, `12.5px` `--ai-t2`, indented `216px` from 840px.
  - A missing dimension reads "Not scored".
- **Evidence**: four boxes, always all four, two columns from a real 840px (`:2575-2668`).
  - Each box (`EvidenceList`) has a titled pill and a count:

    | Box | Colour |
    |---|---|
    | Strengths | mint |
    | Must-haves met | purple; count "N/M", "None" or "-" |
    | Missing requirements | danger |
    | Risks to verify | amber |

  - Rows are `12.5px` `--ai-t2` with a `16px` round icon: check, warning or cross.
  - **"View evidence"** reveals a verbatim CV quote in italics with a left rule (`:695-722`).
  - Each empty box has its own sentence, for example "Nothing in the CV was
    evidenced strongly enough to quote." The empty states are findings, not
    missing UI (`:2577-2581`).
- **Stale banner** (`:2672-2694`): amber-tint box.
  - "Scored against older criteria" plus an explanation.
  - "Re-score this applicant" (purple).
- **Re-score strip** (`:2703-2721`): only for unscored rows where a re-score can
  help. "Re-run the AI on this CV - uses one AI scoring credit."

### 4.3 Communication (`:2725-2793`)

- One card titled **"Messages"**: sent email plus received WhatsApp, merged by time (`mergeComm`, `:2891`).
- **Sent entries** (`MessageEntry`, `:2960`):
  - A left rule, the message text `13.5px`, and a meta line `11.5px`.
  - Status chips, `9.5px` 800 uppercase: amber, slate or danger.
  - Sender initials in an `18px` mint disc.
- **Received WhatsApp** (`InboundEntry`, `:2927`):
  - A green left rule (`2.5px`), body `13.5px` with line breaks kept, a "WhatsApp" mint chip.
  - A media-only message shows an italic placeholder in `--ai-t4`.
- Empty: "Nothing sent or received yet." (`13px` italic `--ai-t4`).
- Errors (`13px` `--ai-danger`), separate for each direction:
  - "Couldn't load the messages sent to this candidate just now - nothing has
    been lost. Close the panel and reopen it to try again."
  - "Couldn't load this candidate's WhatsApp replies just now. Anything they sent
    is still stored."
- Truncation notes, when a cap is hit (`12px` `--ai-t3`): "Older messages aren't
  shown - this trail carries the most recent N sent", and the same for replies.
- Basis notes for why WhatsApp can't be matched (`INBOUND_BASIS_NOTE`, `:2795-2805`):
  no phone on file, number not normalisable, or number not unique.
- There is no composer in this pane. Email is sent from Profile's Email button (`:2729-2732`).

### 4.4 Interviews (`:2812-2817`; `_interview-panel.tsx:340-357`)

- Four stacked sections, gap `28px`:
  1. Async AI interview (`AsyncSection`)
  2. Live AI video (`LiveInterviewSection`)
  3. "Call with your team" booking (`BookingSection`, `_interview-panel.tsx:1125`)
  4. The final-interview card (`_final-interview-card.tsx`)
- Each section head (`SubHead`, `_interview-panel.tsx:83-93`): Sora 700
  `17px / 13.9`, a status badge, and a hairline.
- It is a separate subsystem with its own fetches, dialogs and tests. A redesign
  should treat it as a block.

### 4.5 Timeline (`TimelinePane`, `:3603`)

- One card, **"Activity"**, with meta "Newest first · N events" (`:3640`).
- Rows (`TimelineRow`, `:3569`): grid `34px | 1fr | max-content`.
  - Avatar: a `34px` circle with initials, or a rounded slate square with an
    icon for "Remotiv AI" or "Automatic email" (`:3135-3136`, `:3492`).
  - Text `12.5px` `--ai-t2`, max width `700px`, with a suffix in `--ai-t3`.
  - A comment body shows in an inset bubble.
  - The time is on the right, `11px` semibold `--ai-t3` (`fmtTimelineStamp`, `:3542`).
- The events merge: Applied (made up from the application date), stage moves,
  score events, comments and messages (`buildTimeline`, `:3452`).
- Notices (`TIMELINE_NOTICE`, `:3591`): red for failed history or messages
  ("...couldn't be loaded, so entries are missing..."), inset for a truncation.

### 4.6 Comments (`CommentsPane`, `:3715`)

- One card, **"Team comments"**. The meta is the live count, shown only when above 0.
- **Composer** (`COMMENT_TEXTAREA`, `:3697`):
  - Radius 12px, `13.5px`, minimum height `96px`, placeholder "What do you make
    of this candidate?".
  - Purple focus ring.
  - Disclosure underneath: "Visible to everyone on this job's team. Comments are
    part of the candidate's..." (`11.5px` `--ai-t3` with an icon).
  - Post button: pill shape, purple (`COMMENT_PRIMARY`, `:3699`).
- Empty: "No comments yet. Comments are attributed and timestamped, and you can
  reply to one, or..." (`11.5px` `--ai-t4`).
- **Threads**: replies are indented `34px` with a left rule. Each entry has a
  `24px` initials disc (mint) and a body `12.5px` `--ai-t2`. A deleted comment
  shows in italic `--ai-t4`.
- Meta: `11px` `--ai-t4`.
- Actions are text buttons, `11px` bold `--ai-t3`. "Replied to - editing
  closed" shows once someone has replied.

---

## 5. Typography and colour

**Families**
- Sora (`font-heading`): name, avatar initials, card titles, verdict, ring
  numbers, dimension scores, banner title, section heads.
- DM Sans: everything else.

**Sizes, CSS / screen, with weight**
- 8.5 / 7.0 (800): message sender initials
- 9.5 / 7.8 (800): message and WhatsApp chips, comment initials
- 10 / 8.2 (400, 700): Danger note, "Essential" pill
- 10.5 / 8.6 (700): band pill, confidence badge, evidence pills, "OUT OF 100", DrawerLabel, threshold pill
- 11 / 9.0 (500-700): card meta, small print, timeline time, comment actions, "Adjusted"
- 11.5 / 9.4 (600): counter, Stage label, intro lines, message meta
- 12 / 9.8: question text, notes, buttons in the adjust form
- 12.5 / 10.3 (500-700): identity line, Back, evidence rows, dimension reasoning, timeline text, comments
- 13 / 10.7 (700): tabs, stage select, CV and Email buttons, summary body, application line
- 13.5 / 11.1: detail rows, message bodies, review buttons, comment composer
- 14 / 11.5 (700, 800): screening answer, mini-ring number
- 15 / 12.3 (700): card titles, Review sub-heads
- 17 / 13.9 (700): Interviews section heads
- 18 / 14.8 (800): avatar initials
- 19 / 15.6 (800): verdict
- 21 / 17.2 (800): name
- 25 / 20.5 (800): dimension score
- 34 / 27.9 (800): review ring number

**Colour tokens**
- Same `.ai-shell` set as the list audit (`ai-dashboard.css:41-77`):
  - Base: `--ai-surface`, `--ai-inset`, `--ai-sidebar`.
  - Lines: `--ai-line`, `--ai-line-soft`, `--ai-line-strong`.
  - Text: `--ai-t1` to `--ai-t4`.
  - Tint pairs: purple, mint, amber (and its dot), sky, slate.
  - `--ai-danger #C4362F`, `--ai-danger-tint #FBEAE8`, `--ai-purple-hover #6D38F0`.
- Brand: `remotiv-purple`, `remotiv-green`, `remotiv-lime`.
- **Hard-coded hexes in the drawer:**
  - `#2F3A00`: lime banner ink (`:2025-2048`)
  - `#C4362F`: adjust form error, equal to `--ai-danger` (`:1116`)
  - `#6d38ec`: `ADJ_BTN_PRIMARY` hover (`:1000`)
  - `rgba(126,71,255,.1)`: avatar ring
  - `rgba(126,71,255,.3)`: CV button shadow
  - the score band strokes from `scoreBand` (`:449-453`)

---

## 6. Data shown in the drawer

**Drawer-only data** (not on the list): phone, LinkedIn URL, the CV link,
location, years of experience, notice period, availability, screening answers,
the full scorecard (verdict, summary, dimensions, quoted CV evidence, missing
requirements, risks), messages and WhatsApp replies, timeline, team comments and
interview data.

**Must never show:**
- **Raw provider or database error text**:
  - A failed score shows only a known safe sentence; anything else gets the
    fallback (`unscored-card.ts:168-177`).
  - The list's tooltip skips failed rows for the same reason (`:500-507`).
  - `a11y-wiring.test.ts` "A6-26" pins that recruiter surfaces show stored
    errors only through that gate.
  - **POSSIBLE gap**: the unscored body falls back to `headerScore.error` when
    `unscoredCardState` has no facts yet, or the scoring-facts read failed
    (`:2436-2438`).
  - `toScore` passes `error` through from the database unchanged
    (`applicants/actions.ts:240`).
  - So an old failed row could briefly show provider text while the detail
    loads, or keep showing it if that read fails. Not reproduced.
- **A number the AI didn't produce, labelled as the AI's**: `scoreLede`,
  `scoreProvenance` and the "Scored by hand" byline exist to stop this (`:354-404`).
- **A verified look on self-reported data**: the screening pills are never green (`:2186-2193`).
- **The recruiter's own address as sender**: email goes through the Composer, never `mailto:` (`:2100-2102`).

---

## 7. States

**Opening**
- The drawer mounts only after hydration.
  - A deep link opens it in an effect, not on the server, to avoid a
    double-paint (`:4598-4614`).
- A deep link to someone not on the current page is resolved by the detail read
  (`offPageRow`, `:4854`, `:5218`).
- An unknown id closes the drawer and shows a toast: "That applicant isn't in
  your list - they may have been deleted." (`:5124-5131`)

**Loading**
- Per pane: pulsing bars for screening (`:2150-2155`), messages (`:2741-2743`),
  timeline, and comments.
- There is no whole-drawer skeleton. The header renders immediately from the
  list row.

**Errors**
- Each read fails on its own and says which part failed: screening, messages,
  WhatsApp, timeline (sections 4.1 to 4.5).
- A failed read never reads as "empty".

**Scores**
- **No score**: no header ring, and the Review card's unscored block (section 4.2).
- **Adjusted score**:
  - "Adjusted" under the header ring.
  - On Review: "AI scored N" (or "Scored by hand") plus the byline, the AI's
    number kept visible, and the adjustment record with the note.
- **Stale score**: the amber banner, and the card's Re-score button hidden.

**Long text**
- Name and email truncate (`:1815`, `:1822`).
- Location and date don't wrap.
- Message, comment and timeline bodies keep line breaks.
- Summary and verdict wrap.
- Detail values: see the POSSIBLE overflow in section 4.1.

---

## 8. Accessibility

**Focus** (`useModalFocus(panelRef, true, { onClose })`, `:1583`; hook in `src/hooks/use-modal-focus.ts`)
- **Escape** closes only the top overlay. With the Composer open over the
  drawer, Escape closes the Composer first (`:4814`).
- **Tab is trapped** in the drawer.
- **Everything outside is `inert`**. The toast and live region are exempt
  (`data-inert-exempt`: `_components/toast.tsx`, `components/live-region.tsx`).
- **Focus returns** to where it was on close. Body scroll is locked.
- On open, focus goes to the drawer container (`tabIndex=-1`).

**Labels**
- The dialog: `aria-label="<name> - applicant detail"`.
- Previous, Next, Close and "Dismiss flag" have `aria-label`.
- Stage has a real `<label htmlFor>`.
- The two adjust-score inputs have `aria-label`.
- "View evidence" has `aria-expanded`.

**Gaps**
- **Tabs** are buttons with `aria-current="page"`. There is no `role="tablist"`,
  `tab` or `tabpanel`, and no arrow-key movement.
- **Unlabelled textareas** (`:1109`, `:3807`, `:3910`, `:4095`): no `aria-label`
  or `<label>`. The "Why was the AI wrong?" heading is a `<p>` (`DrawerLabel`),
  and the comment boxes rely on placeholder text only.
- Several inputs set `outline-none` and show focus as a border colour only
  (`:1114`, the comment editor).
- The rings are `aria-hidden`. The number is real text, so the score is still read out.
- The "Back to applicants" button and the Close X do the same thing; that is
  harmless.

**Contrast** (same computed ratios as the list audit)

| Colour | Ratio | Used for | Verdict |
|---|---|---|---|
| `--ai-t3 #847E8C` on white | 3.93 | identity line, Stage label, card meta, small print, counter, timeline time | **Fails AA** for text this small |
| `--ai-t4 #B0AAB8` on white | 2.26 | Danger note (10px), "Not emailed" note, CV-expired note, empty Comms line, comment meta, dead CV button | **Fails AA** |
| `--ai-t4` on inset | 2.05 | - | **Fails AA** |

- Worst case: the irreversible-delete warning is `10px / 8.2` on screen at
  ratio 2.26 (`:2273-2276`).

---

## 9. Constraints

**URL**
- `?applicant=<id>&tab=<profile|review|comm|interviews|timeline|comments>`,
  written with `history.replaceState` (`list-state.ts:486-509`, `encodePanelUrl`;
  `:4677-4683`).
- The tab is always written while open. Closing removes both parameters.
- These are shared-link formats (the notification bell links here), so keep the
  names and values (`:205-210`).

**Inert**
- Never put `inert` on the list wrapper by hand. `useModalFocus` records and
  restores it, and a React-set `inert` would be written back after unmount,
  leaving the list dead (`:5729-5738`).

**Nested buttons**
- List rows are `<button>`s, so nothing clickable can go inside them. That is
  why "Worth a look" is dismissed here and not on the row (`:799-829`).

**Clock**
- Every date uses `PageClock`: UTC before hydration, the reader's own clock
  after (`:280-316`). New dates must too.

**Header geometry** (pinned by tests)
- The ring is hidden below 525px.
- The name keeps `min-w-0` and `truncate`.
- The tab strip scrolls and doesn't wrap, keeps its `pb-px -mb-px` underline
  clearance, and stays the tabs' offset parent.
- All in `drawer-header.test.ts`.
- The strip's scroll maths: `tab-scroll.test.ts`. Rects are not used because of
  the zoom (`:1974-1977`).

**Tests that pin drawer source text** (they read the file text, not the page)
- `applicants/drawer-header.test.ts`: header and tab-strip classes.
- `_components/a11y-wiring.test.ts`:
  - `_applicants-client.tsx` must use `useModalFocus` **exactly 3 times** (`:65`);
  - no private Escape handlers;
  - the safe-sentence gate (A6-26).
- `applicants/screening-export.test.ts`
- `applicants/search-floor.test.ts`
- `applicants/stage-tabs.test.ts`
- `lib/copy-honesty.test.ts` (`:31`)
- `lib/ai/cv-scoring-cap-wiring.test.ts` (`:203`)
- `lib/interview-cap-wiring.test.ts` (`:184`)
- `ai-dashboard/lib/company-roles.test.ts` (`DRAWER`, `:96`): the role rules
  for the stage select.
- `app/interview/[token]/async-copy-dashes.test.ts` (`:89`): no long dashes in copy.

Changing copy or classes in the drawer means updating these in the same change.

**Ownership**
- The Interviews tab is its own subsystem (`_interview-panel.tsx`,
  `_final-interview-card.tsx`), with many tests (`final-*`, `live-*`, `booking-*`).

**File size**
- Everything above is in `_applicants-client.tsx`, along with the list. That
  file currently has another session's uncommitted #76 edits.

---

## 10. If the drawer became an always-open right panel ("Split")

Report only. What would have to change technically.

**1. Focus and modality**
- `useModalFocus` would have to go from the panel, or run with `inertOutside: false`,
  `lockScroll: false` and no trap.
- Otherwise the list beside it is dead and the page can't scroll.
- That changes the `useModalFocus` count pinned by `a11y-wiring.test.ts` (3, `:65`).
- `role="dialog"` and `aria-modal` should become a labelled region:
  `role="region"`, or `complementary` with `aria-label`.

**2. The list stops fading**
- The `openRow ? "pointer-events-none opacity-30"` wrapper (`:5739-5741`) would be
  removed, so the list stays clickable.
- Clicking another row then just swaps the panel's content.
- The selected-row purple tint and bar (list audit, section 4) become the main
  "where am I" signal.

**3. Escape**
- With no overlay, Escape has nothing to close. It should do nothing, or clear
  the selection. It must still close the Composer and dialogs above (stack
  behaviour in `lib/a11y/modal-stack`).

**4. Default selection and the URL**
- `?applicant=` can stay as it is.
- An always-open panel needs a rule for no `?applicant=`: select the first row,
  or show an empty "pick an applicant" panel.
- Auto-selecting would write a URL the reader never asked for. Keep it to state
  and only write the URL on a click, or accept the extra history entries
  (`replaceState`, so no Back-button cost).
- The deep-link-after-hydration rule (`:4598-4614`) still applies.

**5. Width and layout**
- The panel would no longer be `fixed`. It would share the page with the list,
  for example a two-column grid inside `PageContainer` (`max-width 1560 / 1279`)
  with the list on the left.
- At 1100px CSS the panel alone exceeds most screens, so the panel and list
  widths need redefining.
- The list's 960px minimum-width grid (list audit, section 2) can't sit beside
  the panel. The list would need a narrow row variant (the card layout, or fewer
  columns).
- The real-1049px table/card twin switch (root `layout.tsx:101` plus the
  `data-twin` attributes) would need rethinking: below some width Split can't
  fit and must fall back to list-then-detail.

**6. Phone**
- Split can't work below roughly 1100 real px (COMPUTED from the two minimums).
- The phone view would need either a full-screen sheet (today's overlay, kept
  for narrow widths) or a separate route, e.g. `/applicants/<id>`.
- Keeping the overlay below a breakpoint means two modes in one component, with
  `useModalFocus` on only in overlay mode.

**7. Scrolling**
- Today the body is the only scroller, inside a fixed full-height frame
  (`:2016`), and the page scroll is locked.
- In Split, each column needs its own scroller: the panel sticky at full height
  (`--vh-full` minus the 64px topbar) with `overflow-y-auto` inside, and the list
  scrolling on its own or with the page.
- `h-screen` must not be used inside the shell (zoom).

**8. Previous and Next**
- With the list visible, they duplicate clicking the next row.
- They can stay, since they cross page boundaries and the list can't.
- Moving to a row on another page would also move the list to that page
  (already true: `stepApplicant` calls `setFilters({ page })`, `:5051-5052`).

**9. Mounting cost**
- Panes unmount on tab change and the drawer unmounts on close, so each opening
  re-fetches (Interviews fires 3 reads, `:2013-2015`).
- In Split, clicking down the list would fire the detail reads, plus Interviews
  if that tab is active, for every row clicked. That needs throttling, or
  keeping Profile as the default tab.

**10. Header and tests**
- The header was tuned for a 377px-wide panel at 360px (`:1840-1846`). A narrower
  side panel would hit the same squeeze at desktop widths.
- `drawer-header.test.ts` pins the current classes, so a new header would need
  those pins rewritten, not deleted.
