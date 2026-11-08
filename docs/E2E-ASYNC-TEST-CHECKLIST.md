# End-to-end test: async video interview (production)

A hands-on check of the whole async interview, from sending the invite to reading the scorecard, on remotiv.work with dummy data. Written for Waleed to run himself. Async interviews only: live AI interviews stay off.

## Before you start

- **Time:** about 60 minutes in total, including about 10 minutes of waiting for transcripts and the scorecard.
- **You need:** a laptop or phone with a camera and microphone, an email inbox you control for the dummy candidate, and a second browser (or a private window).
- **Use dummy data only.** Use your own test email. Leave the phone number empty, because an invite also queues a WhatsApp message when a phone number is present.
- **One invite uses one interview from the company's monthly allowance.**
- **Quoted text:** text in "quotes" is exactly what the screen or email says. A few existing screens still use a long dash; this checklist writes those with a plain hyphen and marks them "(long dash on screen)". They are listed in "Known wording issues" at the end.

## If something fails

Stop at that step and send the team:

1. The step number (for example "C4").
2. The time it happened, with your time zone.
3. A screenshot of the whole page, including the address bar.
4. What you clicked just before.
5. For anything after "Submit interview": the time you submitted.

Do not retry more than once before reporting. A retry can hide the problem.

## A. Setup

| Step | What Waleed does (exact clicks) | What he should see (exact text) | PASS if | FAIL if |
|---|---|---|---|---|
| A1 | Open remotiv.work and sign in to the company dashboard with a test company you own. | The dashboard with "Applicants" in the left menu. | You are signed in to the test company, not a real customer's. | You land in a real customer's company. |
| A2 | Create a job (or edit an existing test job). On the "Interview questions" step, add 3 questions. For each, leave the rubric empty. | The step title "Interview questions". | 3 questions are saved. | The questions do not save. |
| A3 | In the same job, open "More options" and switch on "Async video interview". | The row "Async video interview" with "Candidates record answers in their own time, with no interviewer on the call." and the label "Active now". | The switch stays on after "Save changes" or "Publish job". | The switch turns itself off, or the job does not save. |
| A4 | In the same "More options" list, look at "AI Video Interview". Leave it OFF. | The row "AI Video Interview" with the label "Not yet active". | It is off. | It is on. |
| A5 | Go to "Applicants", click "Add candidate". Fill in the name and your test email, attach any dummy PDF CV, pick the test job, and click "Add candidate". | The new applicant appears in the list. | The applicant is there, with your test email. | The applicant is missing, or shows someone else's email. |

**About the rubric:** none of the questions in production has a rubric today. The AI still scores each answer, using its general rules for whether the answer addresses the question, not rules written for this job. The score is advisory either way.

## B. Invite

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| B1 | Open the test applicant. In the "Async Video Interview" section, read the text. | "No interview sent" and "The candidate records answers to the job's questions in their own time. Remotiv scores the transcript and you watch whichever answers matter." | The button "Send async interview" is shown. | No button, or the message "Add interview questions to this job first - there's nothing to ask yet." (long dash on screen). |
| B2 | Click "Send async interview". | A short note "Interview sent". The section status becomes "Sent - not started" (long dash on screen). | Both appear. | "Couldn't send - please try again." (long dash on screen), or nothing changes. |
| B3 | Check the test inbox (and spam) within 2 minutes. | Subject "Your video interview for [job title] at [company name]". A link "Start your interview". The sentence "The link works until [date]. There's a practice round first, and it isn't recorded." | The email arrives, with the right job and company name, and the date is 5 days from today. | No email after 5 minutes, or the wrong job, company or date. |
| B4 | Also check that there is NO "Send AI interview" button anywhere in the applicant's interview area. | Only the async section offers a send button. | No live interview can be sent. | A "Send AI interview" button is shown. |

## C. Candidate

Use a second browser or a private window for the candidate, so you are not signed in to the dashboard.

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| C1 | Click "Start your interview" in the email. | The heading "Your video interview", the company and job, "Questions", "Time needed", "Complete by", "There's a practice round first." and the button "Get started". | All shown, with 3 questions. | "This link isn't valid", or the wrong company or job. |
| C2 | Click "Get started". | The heading "Before you start" and "Please read these - they matter." (long dash on screen). Four rows: "You're being recorded", "A person makes the decision", "Kept for 6 months, then deleted", "Answer in your own words". A checkbox "I understand and agree to be recorded." | All four rows and the checkbox. | Any row missing. |
| C3 | Tick the checkbox and continue. Then, when the browser asks, allow camera and microphone. | The heading "Check your setup" and "All three need to pass before you start. This takes a few seconds." Camera, Microphone and Connection each pass. Microphone shows "Picking up sound clearly" once you speak. | All three pass. | Any stays blocked after you allowed it. |
| C4 | Do the practice question. Click "Try a practice question", record a few words, watch it back. | "Practice question", "Practice - not shared" (middle dot on screen), then "Your practice recording" and "Can you see and hear yourself clearly?" | You see and hear yourself. | No picture or no sound. |
| C5 | Click "Start question 1". Answer normally for about 30 seconds (at least 2 full sentences), then click "Done". | "Question 1 of 3", the recording timer, then "Saving your answer". It moves to question 2 by itself. | It saves and moves on. | An error such as "That answer didn't upload." that does not clear on "Retry upload". |
| C6 | Question 2: the near-silent answer. Click record, stay silent (or say only "um"), wait about 15 seconds, click "Done". | "Question 2 of 3", then "Saving your answer". | It saves and moves on. | It refuses to save. |
| C7 | Question 3: answer normally for about 30 seconds, click "Done". | "Question 3 of 3", then "Saving your answer". | It saves. | Error that does not clear. |
| C8 | On the review screen, check all 3 answers are listed, then click "Submit interview". | "Review your answers", 3 answers each with "Watch", then "Submitting is final." under the button. | The button is available. | It says a question is still to answer. |
| C9 | After submitting, read the page. | "That's everything - thank you" (long dash on screen), "What happens next", "Your interview has been submitted. The hiring team will review it and may contact you..." and "You can close this page now. The link won't work again." | All shown. No score, number or verdict appears anywhere. | Any score or verdict is shown to the candidate. |

Write down the time you submitted.

## D. Link safety

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| D1 | Click "Start your interview" in the email again (same browser). | "You've already submitted", "Your answers were received on [date]..." and "Answers can't be changed once submitted." | The interview does not reopen. No camera prompt. | The recorder opens again. |
| D2 | Copy the link and open it in a new private window. | The same "You've already submitted" screen. | Same as D1. | The recorder opens. |
| D3 | In the private window, change one character of the link and open it. Then try one with half the link deleted. | "This link isn't valid" and "We couldn't find an interview for this link. It may have been mistyped, or only part of it was copied." | Both show this screen. | Anything else, especially another interview. |

## E. Transcription

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| E1 | Back in the dashboard, open the applicant and click "Watch the interview" (or go to "Interviews" and open it). Do this within a minute of submitting. | On an answer still being transcribed: the title "Transcript not available yet" and "This answer is being transcribed. This may take a few minutes." | That wording, with no mention of transcription being "switched on". | It says "Transcription isn't switched on for this workspace". |
| E2 | Wait. Refresh every minute. | Each answer's transcript appears. | Answers 1 and 3 show their words within about 5 minutes of submitting. | Any answer still says "being transcribed" after 15 minutes. |
| E3 | Look at answer 2 (the near-silent one). | Either a very short transcript, or "Transcription didn't complete" with a short reason. | It settles into one of those two within about 15 minutes. | It stays on "being transcribed" after 15 minutes. |

## F. Scorecard

Do not press "Score interview" at any point. The scorecard should arrive on its own.

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| F1 | Keep refreshing the review page. | The top strip changes from "Not scored yet" to a score out of 100 with a short verdict. | It arrives within about 5 minutes of the last transcript, without you pressing anything. | Still "Not scored yet" after 20 minutes, or it only arrives after pressing "Score interview". |
| F2 | Read the confidence badge on the strip. | "low confidence". | Low, because one answer could not be scored. | "high confidence" or "medium confidence". |
| F3 | Look next to the confidence badge. | A second badge: "Partial". | "Partial" is shown. | No "Partial". |
| F4 | Read the summary under the verdict. | It ends with "Based on 2 of 3 questions - see the individual answers for why the rest were not scored." | That sentence, with a plain hyphen. | The sentence is missing, or the numbers are wrong. |
| F5 | Open answer 2's score. | "Not scored", with one of these reasons: "Too little speech to assess (N words).", "The transcriber found almost no speech in this recording.", "No usable speech - N words across N seconds of audio." or "Transcription failed for this answer, so there are no words to assess." | Answer 2 is not scored and says why. Answers 1 and 3 have scores. | Answer 2 has a score, or 1 or 3 do not. |
| F6 | Scan every message on the strip, the transcripts and the answer scores for a long dash. | Plain hyphens only in the new messages above. | None of the messages in E1, F1 to F5 contains a long dash. | Any of those messages contains one. (Known older ones are listed at the end.) |

**What the silent answer produces:** the AI does not score an answer with almost no words. It is marked "Not scored" with the reason, the card is labelled "Partial", and confidence is lowered to low, so a missing answer never looks like a confident result.

## G. Recruiter screens

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| G1 | Open "Interviews" in the left menu. | The heading "Interviews" and counts such as "Ready to watch", "In progress", "Not started". The test interview under the "Ready" tab. | The interview is listed once, under "Ready". | Missing, duplicated, or under the wrong tab. |
| G2 | Open the applicant. In "Async Video Interview" read the status and card. | "Submitted", "3 of 3 answered", the score out of 100, and "Watch the interview". | All correct. | Wrong status or count. |
| G3 | On the review page, play each answer's video. | The video plays with sound. | All 3 play. | Any video fails to load. |
| G4 | Check the "Back to interviews" link returns to the list. | The list. | It works. | It errors. |

## H. Privacy

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| H1 | Copy the review page address. Sign out, sign in as a DIFFERENT test company, and open that address. | A "not found" page. | Nothing about the interview shows. | Any part of the interview, transcript or score shows. |
| H2 | As the candidate (private window), revisit the link and any page you saw. | No scores anywhere. | The candidate never sees a score or verdict. | A score or verdict is visible. |
| H3 | Read the consent row in C2 again. | "Recordings are stored securely by Remotiv and removed automatically after six months." | Matches. | Different. |

**What is kept, in plain words:** the videos, the transcripts and the AI scores are kept for 6 months from the invitation, then the recordings, transcripts and the AI's written explanations are deleted automatically. The numbers remain. Deleting the interview or the applicant (section J) removes them straight away.

## I. Background health

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| I1 | Before C1, open remotiv.work/api/health/worker. | A short line with "ok":true and an "ageSeconds" number. | "ok":true and ageSeconds under 120. | "ok":false, or ageSeconds over 600. |
| I2 | Repeat after F1. | The same. | "ok":true. | "ok":false. |
| I3 | In cron-job.org, open the "Remotiv worker" job history. | Recent runs with status 202 and a few seconds each. | 202s, each under 10 seconds. | Failures, timeouts, or the job is disabled. (If the history still shows 200s, the latest worker change is not deployed yet: note it, it is not a failure of this test.) |

## J. Clean-up

| Step | What Waleed does | What he should see | PASS if | FAIL if |
|---|---|---|---|---|
| J1 | On the review page, click "Delete". Read the box, then click "Delete permanently". | "Delete this interview?", "3 recordings will be permanently destroyed, along with the transcripts, this interview's answers and every reviewer note", "This cannot be undone." | The interview disappears from "Interviews". | It stays, or an error appears. |
| J2 | Open the applicant, go to "Danger", click "Delete applicant", confirm with "Delete". | "Delete this applicant?" and that the CV file, AI scorecard, pipeline history and interviews are removed. "This cannot be undone." | The applicant disappears from "Applicants". | It stays. |
| J3 | Open the old interview link from the email once more. | "This link isn't valid". | The link is dead. | It opens anything. |

## What cannot be tested safely on production

- **Live AI interviews:** off by design. B4 and A4 only confirm they cannot be started.
- **Expiry after 5 days and the reminder email:** they need you to wait days.
- **Automatic deletion after 6 months.**
- **Transcription or scoring failures, and the worker stopping:** they would need production to break.
- **Re-scoring after an admin replays a failed transcript:** needs a failed job first.
- **WhatsApp invites:** need a real phone number, and send a real message.
- **Several candidates at once, and very large recordings near the 100 MB limit.**

## Known wording issues (not part of this test)

These existing messages still show a long dash. They are not from the recent wording fix, and are listed so they are not reported as new failures:

- The applicant status "Sent - not started".
- "Recorded - not scored yet." on the applicant card.
- "Per-question scores are advisory - a person decides." on the applicant card.
- "Please read these - they matter." on the candidate's consent screen.
- "That's everything - thank you" after submitting.
- The invite email's "There's no call to schedule - you record the answers in your own time, from your phone or laptop."
- "Couldn't send - please try again." and "Add interview questions to this job first - there's nothing to ask yet." on the send button's errors.

## Appendix: where each screen comes from (for the team)

- Applicant interview section: `src/app/ai-dashboard/(gated)/applicants/_interview-panel.tsx`
- Invite email: `src/app/ai-dashboard/(gated)/applicants/interview-actions.ts`
- Candidate screens: `src/app/interview/[token]/_flow.tsx` and `_terminal.tsx`
- Review page: `src/app/ai-dashboard/(gated)/interviews/[sessionId]/_review-client.tsx`
- Interview list: `src/app/ai-dashboard/(gated)/interviews/_interviews-client.tsx`
- Job options: `src/app/ai-dashboard/(gated)/jobs/new/_wizard-client.tsx`
- Worker and health: `docs/OPERATIONS-WORKER-SCHEDULER.md`
