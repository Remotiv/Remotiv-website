# Background worker scheduler

The background worker is not triggered by Vercel Cron. `vercel.json` has no `crons` block. An external service, cron-job.org, calls the worker on a schedule. If those calls stop, background jobs stop.

The settings below live in cron-job.org (Waleed's account) and cannot be read from this repo. They were recorded on 2026-11-06. If you change them there, update this file.

## What runs where

| Job in cron-job.org | Calls | Schedule | Auth |
|---|---|---|---|
| Remotiv worker | `https://remotiv.work/api/jobs/worker` | About every minute | Header `Authorization: Bearer <CRON_SECRET>` |
| Remotiv worker health | `https://remotiv.work/api/health/worker` | Every 10 minutes | None |

- **Timezone:** both jobs are set to Asia/Karachi.
- **Notifications:** cron-job.org failure and auto-disable emails are on.
- **Secret:** the `CRON_SECRET` value lives only in Vercel environment variables and the cron-job.org job header. Never write it in this repo.
- **Address:** use `remotiv.work` without `www`. The `www` address answers with a 308 redirect.
- **Staging:** a staging deployment has no schedule, and step 7 of `scripts/staging/README-steps.md` keeps `CRON_SECRET` absent there. Do not point a scheduler at it.

## What one worker tick does

Each call to `/api/jobs/worker` accepts GET or POST and does the following, in order:

1. Re-queues interview transcriptions that were never queued.
2. Ends live interviews that ran past their time limit.
3. Schedules recurring maintenance such as purges. The tick is the only scheduler for these.
4. Recovers jobs left behind by a crashed run.
5. Claims up to 10 due jobs and runs up to 4 at a time, within a budget of about 55 seconds.
6. Writes the `worker_heartbeats` row, even when there was nothing to do.

So when the worker stops, all of the above stops. Jobs can still be added to the queue, and they wait there until the worker runs again.

| Worker response | Meaning |
|---|---|
| 200 with `ok: true` | The tick ran. Individual jobs can still have failed; those are counted in the response. |
| 401 | The secret is missing or wrong. |
| 503 | `CRON_SECRET` is not set on the deployment, so the route refuses every request. |
| 500 with `ok: false` | The tick failed before finishing, usually because the queue was unreachable. |

## How the health check works

`/api/health/worker` reads the heartbeat row and nothing else. It needs no secret, and it returns only a yes or no plus an age.

| Health response | Meaning |
|---|---|
| 200 `{ ok: true, ageSeconds }` | The last tick finished within the last 10 minutes. |
| 503 `{ ok: false, ageSeconds }` | The last tick is older than 10 minutes. |
| 503 `{ ok: false, reason }` | `reason` is `no_heartbeat` or `heartbeat_unreadable`, for example because the database is down. |
| 429 `{ ok: false, reason: "rate_limited" }` | More than 60 requests in a minute. This is not a worker problem. |

Any 503 makes the health job fail, and that failure is what makes cron-job.org send an email.

When the worker recovers after a gap longer than 10 minutes, its first tick also sends admins one "Background worker was not running" notification.

## Runbook: worker looks stopped

1. Open `https://remotiv.work/api/health/worker`. `ok: false` or a high `ageSeconds` means the worker is stale.
2. Check the job history in cron-job.org for failures or an auto-disabled job. Re-enable the job if it was disabled.
3. Check that the Vercel deployment is Ready and that the project is not paused.
4. If `CRON_SECRET` was rotated, update it in both the Vercel environment variables and the cron-job.org job header, then redeploy. A 401 in the job history points to this.
5. Confirm the health route shows `ok: true` within about 2 minutes.

## Incident: 3 to 6 November 2026

The worker stopped from 3 Nov 21:47 UTC to 6 Nov about 09:30 UTC, about 60 hours. cron-job.org failed while Vercel had paused the site, and the job stayed failed after that. It was fixed on 6 Nov, and the "Remotiv worker health" job was added the same day so that a stopped worker now sends an email.
