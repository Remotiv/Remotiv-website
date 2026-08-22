"use client";

import { AlertTriangle, Calendar, Check, Clock, Globe, Video, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The candidate's booking page.
 *
 * ── The timezone is detected AND changeable ──────────────────
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is the browser's answer
 * and is right most of the time. It is wrong often enough to matter: a VPN, a
 * laptop set up in another country and never changed, a corporate image built
 * abroad, someone travelling. A silently wrong zone means a missed interview
 * that neither side can explain afterwards, because both are looking at a
 * confirmation that says the time they expected.
 *
 * So the detected zone is shown, in words, next to every time — and it is a
 * select the candidate can change, which re-renders every slot immediately.
 * Whatever they choose is what gets posted and stored on the booking.
 */

type Slot = { startIso: string; endIso: string };

type State =
  | { kind: "loading" }
  | { kind: "error"; code: string }
  | {
      kind: "open";
      slots: Slot[];
      hostTimezone: string;
      truncated: boolean;
      durationMinutes: number;
      jobTitle: string;
      companyName: string;
      hostName: string;
      candidateFirstName: string;
      expiresAt: string | null;
    }
  | {
      kind: "unavailable";
      reason: string;
      jobTitle: string;
      companyName: string;
      hostName: string;
    }
  | {
      kind: "booked";
      scheduledStart: string;
      scheduledEnd: string;
      hostTimezone: string | null;
      meetingUrl: string | null;
      jobTitle: string;
      companyName: string;
      hostName: string;
      durationMinutes: number;
      /* Both decided server-side. They are NOT the same question: cancel stays
         open after reschedule closes. */
      canReschedule: boolean;
      canCancel: boolean;
      /** Present when a move is still allowed; drives the same picker. */
      slots: Slot[];
    }
  | {
      kind: "cancelled";
      scheduledStart: string | null;
      cancelledBy: string | null;
      cancelReason: string | null;
      jobTitle: string;
      companyName: string;
      hostName: string;
    };

/**
 * Zones offered in the picker.
 *
 * A curated list plus whatever the browser detected, rather than the full IANA
 * set: 400-odd entries in a native select is not a chooser, and a candidate
 * correcting a wrong guess almost always wants a major city near them. The
 * detected zone is always present even when it is not on the list, so nobody
 * is forced to pick a zone that is not theirs.
 */
const COMMON_ZONES = [
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Warsaw",
  "Europe/Istanbul",
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Manila",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Sydney",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
];

const CARD = "rounded-2xl border border-gray-100 bg-white p-6 shadow-sm";

function detectZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every time on this page goes through here, with an explicit zone. */
function fmt(iso: string, zone: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...options,
  }).format(new Date(iso));
}

/**
 * A genuinely sortable calendar-date key: "2026-09-01".
 *
 * ── Why this is not `fmt(...)` with numeric options ──────────
 *
 * It was, and that was the bug. `fmt` is pinned to "en-GB", so numeric date
 * options render dd/mm/yyyy — and comparing "01/09/2026" against "24/08/2026"
 * as strings puts September before August. The day strip showed
 * Tue 1 Sept … Fri 4 Sept, Mon 24 Aug — and a fortnight window crosses a month
 * boundary roughly half the time, so this was live for about half of all
 * candidates.
 *
 * `formatToParts` removes the assumption rather than swapping one locale for
 * another: the parts are read by NAME and reassembled, so no locale's date
 * order can change the result.
 */
function dayKey(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function zoneLabel(iso: string, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date(iso));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone;
  }
}

const ERROR_COPY: Record<string, string> = {
  not_found: "This booking link isn't valid. Check the link in your email, or reply to it.",
  expired: "This booking link has expired. Reply to the email and we'll send a new one.",
  cancelled: "This interview was cancelled. Reply to the email if that's unexpected.",
  slot_taken: "That time was just taken. Pick another below.",
  too_late_to_move:
    "This interview is less than 24 hours away, so it can't be moved now — but you can still cancel it.",
  too_late_to_cancel: "This interview has already started.",
  already_cancelled: "This interview is already cancelled.",
  not_booked: "This interview isn't booked, so there's nothing to change.",
  provider_failed:
    "We couldn't move it in the interviewer's calendar, so nothing was changed. Try again in a moment.",
  already_booked: "This interview is already booked.",
  bad_timezone: "That timezone wasn't recognised. Pick one from the list.",
  calendar_failed: "We couldn't put that on the interviewer's calendar. Try another time.",
  unavailable: "Times aren't available right now. Try again shortly.",
  network: "Something went wrong. Check your connection and try again.",
};

export function BookingClient({ token }: { token: string }) {
  const [zone, setZone] = useState<string>("UTC");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** null = just viewing. "reschedule" opens the picker, "cancel" the prompt. */
  const [mode, setMode] = useState<"reschedule" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Detection runs in an effect, not during render: the server has no zone and
  // rendering one there would produce a hydration mismatch on every visit.
  useEffect(() => {
    setZone(detectZone());
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/book/${token}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) {
        setState({ kind: "error", code: body?.error ?? "network" });
        return;
      }
      // The route names its variants in `state`; the client discriminates on
      // `kind`. One rename at the boundary rather than two vocabularies.
      setState({ ...body, kind: body.state } as State);
    } catch {
      setState({ kind: "error", code: "network" });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const zoneOptions = useMemo(() => {
    const set = new Set(COMMON_ZONES);
    if (zone) set.add(zone);
    return [...set].sort();
  }, [zone]);

  const confirm = useCallback(
    async (slot: Slot) => {
      setConfirming(slot.startIso);
      setNotice(null);
      try {
        const res = await fetch(`/api/book/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The candidate's CHOSEN zone, not the detected one — they may have
          // corrected it, and the correction is the whole point.
          body: JSON.stringify({ startIso: slot.startIso, timezone: zone }),
        });
        const body = await res.json();
        if (!res.ok) {
          setNotice(ERROR_COPY[body?.error] ?? ERROR_COPY.network);
          // A lost race means the offer is stale. Re-read rather than leaving
          // a slot on screen that is no longer bookable.
          if (body?.error === "slot_taken") void load();
          return;
        }
        setState((prev) => ({
          kind: "booked",
          scheduledStart: body.scheduledStart,
          scheduledEnd: body.scheduledEnd,
          hostTimezone: body.hostTimezone,
          meetingUrl: body.meetingUrl,
          jobTitle: prev.kind === "open" ? prev.jobTitle : "your interview",
          companyName: prev.kind === "open" ? prev.companyName : "",
          hostName: prev.kind === "open" ? prev.hostName : "",
          durationMinutes: prev.kind === "open" ? prev.durationMinutes : 30,
          // Straight from the server's answer, never inferred here.
          canReschedule: body.canReschedule === true,
          canCancel: body.canCancel === true,
          // The confirm response carries no slot list; the next load() does.
          slots: [],
        }));
      } catch {
        setNotice(ERROR_COPY.network);
      } finally {
        setConfirming(null);
      }
    },
    [token, zone, load],
  );

  /** Cancel, with an optional reason. Reloads so the page shows the outcome. */
  const cancelBooking = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/book/${token}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setNotice(ERROR_COPY[body?.error] ?? ERROR_COPY.network);
        return;
      }
      setMode(null);
      await load();
    } catch {
      setNotice(ERROR_COPY.network);
    } finally {
      setBusy(false);
    }
  }, [token, reason, load]);

  /** Move to a slot the candidate picked while in reschedule mode. */
  const rescheduleTo = useCallback(
    async (slot: Slot) => {
      setConfirming(slot.startIso);
      setNotice(null);
      try {
        const res = await fetch(`/api/book/${token}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ startIso: slot.startIso, timezone: zone }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setNotice(ERROR_COPY[body?.error] ?? ERROR_COPY.network);
          // A lost race or a closed window both mean the offer is stale.
          if (body?.error === "slot_taken" || body?.error === "too_late_to_move") {
            setMode(null);
            await load();
          }
          return;
        }
        setMode(null);
        await load();
      } catch {
        setNotice(ERROR_COPY.network);
      } finally {
        setConfirming(null);
      }
    },
    [token, zone, load],
  );

  /**
   * Slots grouped by the candidate's LOCAL day.
   *
   * Grouped in the candidate's own zone, not the host's: a 09:00 Karachi slot
   * is the previous evening in Los Angeles, and filing it under the host's
   * date would put a Tuesday time under a Wednesday heading.
   */
  const days = useMemo(() => {
    /*
     * One source, two entry points. An "open" booking is choosing its first
     * time; a "booked" one in reschedule mode is choosing a replacement. Same
     * slots, same grouping, same buttons — so the two paths cannot drift into
     * looking or behaving differently.
     */
    const source = state.kind === "open" ? state.slots : state.kind === "booked" ? state.slots : [];
    if (source.length === 0) return [];
    const groups = new Map<string, Slot[]>();
    for (const slot of source) {
      groups.set(dayKey(slot.startIso, zone), [
        ...(groups.get(dayKey(slot.startIso, zone)) ?? []),
        slot,
      ]);
    }
    return (
      [...groups.entries()]
        .map(([key, slots]) => ({ key, slots, first: slots[0] }))
        /*
         * Sorted on the INSTANT, not on any rendered string.
         *
         * `dayKey` is now genuinely yyyy-mm-dd so a string sort would also
         * work, but ordering days by a formatted value is what broke this in
         * the first place. The timestamp cannot be reinterpreted by a locale,
         * a zone or a format option, so it is what the order depends on. The
         * key is left to do the one job it is good at: identity.
         *
         * Slots arrive from the server already ascending and grouping
         * preserves that, so `first` is the earliest of its day.
         */
        .sort((a, b) => Date.parse(a.first?.startIso ?? "") - Date.parse(b.first?.startIso ?? ""))
    );
  }, [state, zone]);

  // The first day with anything on it. Re-derived when the zone changes, since
  // a zone change can move slots across a date boundary.
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const selected = days.find((d) => d.key === activeDay) ?? days[0] ?? null;

  /**
   * Every slot for the selected day, split by part of day.
   *
   * ── Sections, not a sample ───────────────────────────────────
   *
   * All of them are here. 32 times at 15 minutes is a lot to scan as one
   * undifferentiated block, so they are sectioned into Morning / Afternoon /
   * Evening — which is how a person thinks about a day anyway, and how they
   * narrow it. Nothing is hidden and nothing is dropped; the headings just give
   * the eye somewhere to land.
   */
  const sections = useMemo(() => {
    if (!selected) return [];
    const buckets: { label: string; slots: Slot[] }[] = [
      { label: "Morning", slots: [] },
      { label: "Afternoon", slots: [] },
      { label: "Evening", slots: [] },
    ];
    for (const slot of selected.slots) {
      const hour = Number(fmt(slot.startIso, zone, { minute: undefined }).slice(0, 2));
      const bucket = hour < 12 ? buckets[0] : hour < 17 ? buckets[1] : buckets[2];
      bucket?.slots.push(slot);
    }
    return buckets.filter((b) => b.slots.length > 0);
  }, [selected, zone]);

  return (
    <main className="min-h-screen bg-remotiv-bg px-4 py-10 font-sans">
      <div className="mx-auto w-full max-w-2xl">
        {state.kind === "loading" && (
          <div className={CARD}>
            <p className="text-sm text-gray-400">Loading your interview times…</p>
          </div>
        )}

        {state.kind === "error" && (
          <div className={CARD}>
            <AlertTriangle className="mb-3 size-6 text-amber-500" strokeWidth={2} />
            <h1 className="font-heading text-xl font-bold text-gray-900">Can't open this link</h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              {ERROR_COPY[state.code] ?? ERROR_COPY.network}
            </p>
          </div>
        )}

        {state.kind === "unavailable" && (
          <div className={CARD}>
            <Calendar className="mb-3 size-6 text-gray-300" strokeWidth={2} />
            <h1 className="font-heading text-xl font-bold text-gray-900">
              We can't show times right now
            </h1>
            {/*
              Deliberately NOT "no times available". The calendar could not be
              read, which is a different fact, and telling the candidate their
              interviewer is fully booked would leave them waiting on a diary
              nobody ever checked.
            */}
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              There's a problem reading {state.hostName || "your interviewer"}'s calendar, so we
              can't offer times yet. They've been told — you'll hear from{" "}
              {state.companyName || "the team"} shortly. Nothing you need to do.
            </p>
          </div>
        )}

        {state.kind === "booked" && (
          <div className={CARD}>
            <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-remotiv-green/15">
              <Check className="size-5 text-emerald-900" strokeWidth={2.6} />
            </span>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-gray-900">
              You're booked
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              {state.jobTitle}
              {state.companyName ? ` · ${state.companyName}` : ""}
            </p>

            <div className="mt-5 rounded-2xl bg-gray-50 p-5">
              <p className="font-heading text-lg font-bold text-gray-900">
                {fmt(state.scheduledStart, zone, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </p>
              <p className="mt-1 text-sm text-gray-600">
                {fmt(state.scheduledStart, zone)} – {fmt(state.scheduledEnd, zone)}{" "}
                <span className="text-gray-400">
                  ({zoneLabel(state.scheduledStart, zone)} · {zone})
                </span>
              </p>
              {state.hostTimezone && state.hostTimezone !== zone && (
                <p className="mt-2 text-xs text-gray-400">
                  That's {fmt(state.scheduledStart, state.hostTimezone)} for{" "}
                  {state.hostName || "your interviewer"} in {state.hostTimezone}.
                </p>
              )}
            </div>

            {state.meetingUrl ? (
              <a
                href={state.meetingUrl}
                className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-remotiv-purple px-5 py-3 text-sm font-bold text-white transition-colors hover:bg-[#6D38F0]"
              >
                <Video className="size-4" strokeWidth={2.2} />
                Join the interview
              </a>
            ) : (
              <p className="mt-5 text-sm text-gray-500">
                Your interviewer will send joining details separately.
              </p>
            )}

            <p className="mt-5 text-xs leading-relaxed text-gray-400">
              A confirmation is on its way to your inbox, and it's in{" "}
              {state.hostName || "your interviewer"}'s calendar.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-5">
              {state.canReschedule && (
                <button
                  type="button"
                  onClick={() => setMode("reschedule")}
                  className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-remotiv-purple hover:text-remotiv-purple"
                >
                  Change the time
                </button>
              )}
              {state.canCancel && (
                <button
                  type="button"
                  onClick={() => setMode("cancel")}
                  className="rounded-xl px-4 py-2.5 text-sm font-semibold text-gray-500 transition-colors hover:text-[#E0524B]"
                >
                  Cancel interview
                </button>
              )}
            </div>

            {/*
              THE BLOCKED-RESCHEDULE MESSAGE.

              Shown only when moving has closed but cancelling has not — the one
              state where the two rules diverge, and the one most likely to read
              as an arbitrary refusal.

              It leads with what they CAN do. "You can no longer move this" as an
              opening clause is a door closing; the same fact after "it's less
              than 24 hours away" is a reason, and putting the cancel option in
              the same breath means the sentence ends with an action rather than
              a wall. It also says what to do if they need a different time,
              because that is the actual want behind pressing Change.
            */}
            {!state.canReschedule && state.canCancel && (
              <p className="mt-3 text-xs leading-relaxed text-gray-400">
                This interview is less than 24 hours away, so the time is now fixed. You can still
                cancel it if you can't make it — and if you need a different time, cancel and reply
                to your email, and {state.hostName || "your interviewer"} will send a new
                invitation.
              </p>
            )}

            {mode === "reschedule" && (
              <div className="mt-4 border-t border-gray-100 pt-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="m-0 text-[13px] font-semibold text-gray-700">
                    Pick a new time — your joining link stays the same.
                  </p>
                  <button
                    type="button"
                    onClick={() => setMode(null)}
                    className="text-[13px] font-semibold text-gray-400 hover:text-gray-700"
                  >
                    Keep the current time
                  </button>
                </div>
                {days.length === 0 ? (
                  <p className="m-0 text-sm text-gray-500">
                    No other times are free in the next two weeks. Reply to your email and{" "}
                    {state.hostName || "your interviewer"} will find one with you.
                  </p>
                ) : (
                  <SlotPicker
                    days={days}
                    selected={selected}
                    sections={sections}
                    zone={zone}
                    confirming={confirming}
                    onSelectDay={setActiveDay}
                    onPick={(slot) => void rescheduleTo(slot)}
                  />
                )}
              </div>
            )}

            {mode === "cancel" && (
              <div className="mt-4 rounded-2xl border border-gray-200 p-4">
                <label
                  htmlFor="cancel-reason"
                  className="mb-2 block text-[13px] font-semibold text-gray-700"
                >
                  Cancel this interview?
                </label>
                {/*
                  OPTIONAL, and labelled as such. A required reason is how
                  someone abandons the cancellation and simply doesn't turn up,
                  which is the outcome this whole screen exists to prevent.
                */}
                <input
                  id="cancel-reason"
                  type="text"
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className="mb-3 w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-remotiv-purple"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void cancelBooking()}
                    className="rounded-xl bg-[#E0524B] px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? "Cancelling…" : "Yes, cancel it"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode(null)}
                    className="rounded-xl px-4 py-2.5 text-sm font-semibold text-gray-500"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {state.kind === "cancelled" && (
          <div className={CARD}>
            <span className="mb-4 flex size-11 items-center justify-center rounded-full bg-gray-100">
              <X className="size-5 text-gray-500" strokeWidth={2.4} />
            </span>
            <h1 className="font-heading text-2xl font-bold tracking-tight text-gray-900">
              Interview cancelled
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              {state.jobTitle}
              {state.companyName ? ` · ${state.companyName}` : ""}
            </p>
            {state.scheduledStart && (
              <p className="mt-4 text-sm text-gray-400 line-through">
                {fmt(state.scheduledStart, zone, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
                {", "}
                {fmt(state.scheduledStart, zone)}
              </p>
            )}
            {state.cancelReason && (
              <p className="mt-3 text-sm text-gray-500">Reason given: {state.cancelReason}</p>
            )}
            <p className="mt-5 text-sm leading-relaxed text-gray-500">
              {state.cancelledBy === "recruiter"
                ? `${state.hostName || "Your interviewer"} will be in touch if there's another time that works.`
                : "Reply to your email if you'd like to arrange another time."}
            </p>
          </div>
        )}

        {state.kind === "open" && (
          <>
            <div className="mb-4">
              <h1 className="font-heading text-2xl font-bold tracking-tight text-gray-900">
                {state.candidateFirstName ? `Hi ${state.candidateFirstName} — pick` : "Pick"} a time
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-gray-500">
                {state.durationMinutes}-minute interview for{" "}
                <span className="font-semibold text-gray-700">{state.jobTitle}</span>
                {state.companyName ? ` at ${state.companyName}` : ""}, with{" "}
                {state.hostName || "the hiring team"}.
              </p>
            </div>

            <div className={`${CARD} mb-4 flex flex-wrap items-center gap-3`}>
              <Globe className="size-4 shrink-0 text-gray-400" strokeWidth={2} />
              <label htmlFor="tz" className="text-[13px] font-semibold text-gray-700">
                Times shown in
              </label>
              <select
                id="tz"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
                className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-800 outline-none focus:border-remotiv-purple"
              >
                {zoneOptions.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
              <span className="text-xs text-gray-400">
                Not your timezone? Change it — every time below updates.
              </span>
            </div>

            {notice && (
              <p className="mb-4 flex items-start gap-2.5 rounded-2xl border border-amber-300/50 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
                <AlertTriangle className="mt-px size-4 shrink-0" strokeWidth={2.2} />
                {notice}
              </p>
            )}

            {state.slots.length === 0 ? (
              <div className={CARD}>
                <Clock className="mb-3 size-6 text-gray-300" strokeWidth={2} />
                <p className="text-sm font-bold text-gray-900">
                  No times free in the next two weeks
                </p>
                <p className="mt-2 text-sm leading-relaxed text-gray-500">
                  {state.hostName || "Your interviewer"}'s calendar is full. Reply to your email and
                  they'll find a time with you directly.
                </p>
              </div>
            ) : (
              <div className={CARD}>
                {/*
                  ONE DAY AT A TIME.

                  The old page rendered every day at once, which is why the
                  offer had to be sampled down to 40 and ended up showing
                  09:00, 11:00, 13:00 on a completely free diary. A candidate
                  does not compare fourteen days simultaneously — they pick a
                  day, then a time. Choosing the day first means the times
                  below can be ALL of them.
                */}
                <SlotPicker
                  days={days}
                  selected={selected}
                  sections={sections}
                  zone={zone}
                  confirming={confirming}
                  onSelectDay={setActiveDay}
                  onPick={(slot) => void confirm(slot)}
                />
              </div>
            )}

            {state.truncated && state.slots.length > 0 && (
              <p className="mt-4 text-xs leading-relaxed text-gray-400">
                This day has more free times than we can list. If none of these work, reply to your
                email and we'll find another.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

type DayGroup = { key: string; slots: Slot[]; first: Slot | undefined };

/**
 * The day strip and the day's times.
 *
 * Extracted so the FIRST booking and a RESCHEDULE render the identical control.
 * They are the same choice — which of the interviewer's free times suits you —
 * and two copies of this markup would have drifted apart the first time either
 * was touched.
 */
function SlotPicker({
  days,
  selected,
  sections,
  zone,
  confirming,
  onSelectDay,
  onPick,
}: {
  days: DayGroup[];
  selected: DayGroup | null;
  sections: { label: string; slots: Slot[] }[];
  zone: string;
  confirming: string | null;
  onSelectDay: (key: string) => void;
  onPick: (slot: Slot) => void;
}) {
  return (
    <>
      <div
        className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-2"
        role="tablist"
        aria-label="Choose a day"
      >
        {days.map((day) => {
          const first = day.first?.startIso;
          const active = selected?.key === day.key;
          if (!first) return null;
          return (
            <button
              key={day.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelectDay(day.key)}
              className={`shrink-0 rounded-xl border px-3.5 py-2 text-center transition-colors ${
                active
                  ? "border-remotiv-purple bg-remotiv-purple text-white"
                  : "border-gray-200 text-gray-700 hover:border-remotiv-purple"
              }`}
            >
              <span className="block text-[11px] font-semibold uppercase tracking-wide opacity-80">
                {fmt(first, zone, {
                  weekday: "short",
                  hour: undefined,
                  minute: undefined,
                })}
              </span>
              <span className="block text-sm font-bold">
                {fmt(first, zone, {
                  day: "numeric",
                  month: "short",
                  hour: undefined,
                  minute: undefined,
                })}
              </span>
              {/* The count is the honest signal that a day is busy —
                            previously every day looked equally sparse. */}
              <span className="block text-[11px] opacity-70">
                {day.slots.length} {day.slots.length === 1 ? "time" : "times"}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="flex flex-col gap-4">
          {sections.map((section) => (
            <div key={section.label}>
              {/* Only labelled when there is more than one section —
                            a single "Morning" heading over four buttons is
                            furniture, not information. */}
              {sections.length > 1 && (
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-gray-400">
                  {section.label}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {section.slots.map((slot) => (
                  <button
                    key={slot.startIso}
                    type="button"
                    disabled={confirming !== null}
                    onClick={() => onPick(slot)}
                    className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold tabular-nums text-gray-700 transition-colors hover:border-remotiv-purple hover:bg-remotiv-purple hover:text-white disabled:opacity-50"
                  >
                    {confirming === slot.startIso ? "Booking…" : fmt(slot.startIso, zone)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
