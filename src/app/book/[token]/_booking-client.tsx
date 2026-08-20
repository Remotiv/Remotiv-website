"use client";

import { AlertTriangle, Calendar, Check, Clock, Globe, Video } from "lucide-react";
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
        }));
      } catch {
        setNotice(ERROR_COPY.network);
      } finally {
        setConfirming(null);
      }
    },
    [token, zone, load],
  );

  /** Slots grouped by the candidate's local day, so headings match their week. */
  const byDay = useMemo(() => {
    if (state.kind !== "open") return [];
    const groups = new Map<string, Slot[]>();
    for (const slot of state.slots) {
      const key = fmt(slot.startIso, zone, {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: undefined,
        minute: undefined,
      });
      groups.set(key, [...(groups.get(key) ?? []), slot]);
    }
    return [...groups.entries()];
  }, [state, zone]);

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
              <div className="flex flex-col gap-4">
                {byDay.map(([day, slots]) => (
                  <div key={day} className={CARD}>
                    <p className="mb-3 font-heading text-sm font-bold text-gray-900">{day}</p>
                    <div className="flex flex-wrap gap-2">
                      {slots.map((slot) => (
                        <button
                          key={slot.startIso}
                          type="button"
                          disabled={confirming !== null}
                          onClick={() => confirm(slot)}
                          className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:border-remotiv-purple hover:bg-remotiv-purple hover:text-white disabled:opacity-50"
                        >
                          {confirming === slot.startIso ? "Booking…" : fmt(slot.startIso, zone)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {state.truncated && state.slots.length > 0 && (
              <p className="mt-4 text-xs leading-relaxed text-gray-400">
                A selection of times across the next two weeks. If none work, reply to your email
                and we'll find another.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
