# Browser automation against production

This applies to every automated browser that can reach remotiv.work or the
production database: Claude in Chrome, the Claude desktop app's built-in
browser, Playwright, Puppeteer, or any script that drives a page.

## Staging is the default

Run browser checks on staging. The staging harness (`scripts/staging/`) cannot
reach production at all: `network-guard.mjs` aborts any request to another
Supabase project and fails the run. A check goes to production only when it
cannot be made on staging, and the request to run it says which check and why.

## Production automation is read-only. No exceptions.

Before any production run:

- Waleed approves that run, explicitly, in advance. Approval covers one run,
  not the next one.
- The browser is signed in only as a dedicated test account. Never a real
  customer's account, and never a session that happens to be signed in.

During the run, automation may only:

- Open pages and read from them.
- Return counts, booleans, timings, element tags and classes, and record ids
  by their last 6 characters. Nothing else leaves the page.

It must never:

- Write anything, of any kind, to any record. This includes test applicants and
  test accounts, and a change that would be put back afterwards.
- Send anything: no message, email, WhatsApp, interview invite, booking link or
  calendar event.
- Create, change or cancel a booking or an interview.
- Delete, upload, download or export anything.
- Submit any form, public or signed in, including a draft save.
- Open any page under `/admin`.
- Run SQL. A query is written out for Waleed to run by hand.
- Read candidate or company text: names, emails, phone numbers, CV text, notes,
  row text, button text, `aria-label`s or the page title on a page that lists
  real people. Scope the selector to the element needed first, then read only
  the allowed shapes above.
- Take a screenshot, recording or page capture that contains real candidate or
  company data.

## Manual QA by a person is a separate workflow

A person testing production by hand (for example `docs/E2E-ASYNC-TEST-CHECKLIST.md`)
works under that checklist, with their own judgement and their own accounts.
That workflow is not an exception to these rules, and automation may not do
anything there on the grounds that a person could do it by hand.

## If a rule is broken

1. Stop the run at once. Do not try to finish the check.
2. Record exactly what was captured or changed: which page, what kind of data,
   the size of any capture, and which record by its last 6 id characters.
   Record no personal data in the report itself.
3. Delete any capture that holds real data, everywhere it was saved.
4. If anything was written or sent, do not try to undo it from the browser.
   Report it, and let Waleed decide the repair.
5. Report it to Waleed straight away, in the same session.
