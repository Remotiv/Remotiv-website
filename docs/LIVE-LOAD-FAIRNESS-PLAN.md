# #18 AI Video Interview: load, fairness and browser test plan

PLAN ONLY. Nothing here has been run. Live interviews are off for launch; this is
what to run before they are switched on. Staging only (`scripts/staging/`,
network-guarded); production is never touched.

## 1. Load: 10 live interviews at once (staging)

**Setup (needs approval: staging writes).** Seed 10 synthetic applicants on one
synthetic job with a frozen 5-question set, and 10 invited live sessions
(`send-invite` path, email/WhatsApp outbound locked off by the staging guard).
Start the isolated staging app (`npm run staging:app`, arm64) and the worker at
its normal one-minute tick.

**Run.** 10 headless Chrome candidates (Playwright, fake camera and microphone
from a pre-recorded 5-answer WAV/Y4M per candidate) open their links within the
same 10 seconds, consent, and complete the interview. Three runs: the mock
provider (`MockVoxAgent`, free, proves our own pipeline), then the real provider
twice (needs approval: provider cost).

**Measure, per interview and as p50/p95/max:**

| What | How | Pass |
|---|---|---|
| Start time | link open to "conversation started" event (`live_session_events`) | p95 under 5 s |
| Turn audio upload | turn end to `interview_turns.media_path` set | p95 under 10 s, 0 lost |
| Video pieces | reserved vs confirmed `live_video_pieces` | 100% confirmed, 0 orphans after the sweep |
| Transcript lag | turn saved to `transcript_status = done` | p95 under 3 worker ticks |
| Worker queue | `background_jobs` queued depth and age per tick; dead jobs | depth drains within 5 ticks of the last call; 0 dead |
| Outcome | `live_outcome.final` and the scorecard row | 10/10 decided, 10/10 scored (when scoring is on) |
| Errors | `live_session_events` provider_error / connection_lost; server log lines with `[live-` | 0 provider errors; every refusal accounted for |
| Recovery | `[live-turn-recovery]` counts in the tick summary (#15) | 0 turns marked failed by the sweep |

**Also check:** the worker's 4-way concurrency does not starve other job types
during the burst (CV scoring jobs queued alongside still finish), and no call is
cut by the backstop (`live_ended_at` stamped only after each call's real end).

## 2. Fairness: same answer, same score

The scorer reads the transcript only ("Nothing about face, voice or accent is
analysed"), and the interviewer never receives the name (`create-session.ts`).
So unfairness can enter in two places: **transcription** (an accent transcribed
worse loses words) and **the text** (a name or a gendered pronoun in the CV or
answer moving the score). Test each separately.

**2a. Text only, no audio (cheap, needs approval: scoring cost).** Take 5
reference answers per question. Score each one 5 times with only the candidate's
name changed (10 names across regions and genders) and the CV text otherwise
identical. Pass: per answer, the score spread across names is no wider than the
spread of 5 repeat runs with the same name (the scorer's own noise, measured in
the same batch).

**2b. Audio (needs approval: transcription cost and the voices).** The same 5
scripted answers spoken in at least 6 voices: Pakistani, Indian, Nigerian,
British, American, and a non-native speaker. Real people reading the script are
better than TTS; TTS voices are the fallback. Run each through the live
transcription path. Measure word error rate per voice against the script, then
score the transcripts. Pass: WER under 10% for every voice, and the score spread
across voices no wider than 2a's repeat-run spread. A voice outside that is a
transcription problem to fix before launch, not a scoring one.

## 3. Full browser test (staging, one candidate, by hand plus automation)

1. Recruiter: create a live job, freeze questions, invite a synthetic applicant.
2. Candidate (desktop Chrome, Safari, Firefox; iPhone Safari; Android Chrome):
   open link, device check (camera and microphone denied, then allowed),
   consent, interview to the end. Also: close the tab mid-call and reopen;
   lose the network for 20 s; let the time limit run out.
3. Check each case's screen copy (no em dashes, no raw errors), the turn and
   video rows, the event log, and the outcome.
4. Recruiter: review page (playback, transcript, flags, retry transcription on
   an injected failed turn, leave a question out), scorecard, notes.
5. Old links: a re-sent attempt 2 link and an ended interview's link show their
   screens and write nothing after 30 minutes (#17).
6. Retention: move `delete_after` into the past on the synthetic session
   (needs approval: staging write), run the purge, and confirm recordings,
   transcripts, quotes and notes are gone (#21).

## What needs Waleed's approval

- Staging writes: seeding 10 applicants and sessions; the retention step in 3.6.
- Provider cost: the real live provider for two 10-call runs; Whisper for 2b;
  the scorer for 2a and 2b.
- People: the 6 voices for 2b, if real speakers are used.

## Estimated cost and time

Rough, to confirm against current price lists before approval.

| Item | Volume | Estimate |
|---|---|---|
| Live provider | 2 runs x 10 calls x ~10 min = ~200 min | provider's per-minute price x 200; confirm with the provider |
| Whisper (`whisper-1`) | ~200 min (load) + ~60 min (2b) | about $0.006/min, so about $1.60 |
| Scoring | ~20 (load) + 250 (2a) + 30 (2b) scorecards | a few cents each, so roughly $10-25 |
| Engineering time | build the 10-candidate runner (fake media), the fairness scripts, the report | about 2 days, then about 1 day to run and write up |
| Manual browser pass | 5 browsers and devices | about half a day |
