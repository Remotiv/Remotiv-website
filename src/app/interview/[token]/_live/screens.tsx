import {
  Check,
  Clock,
  Mic,
  MicOff,
  Monitor,
  TriangleAlert,
  User,
  Video,
  VideoOff,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import type { liveConsentScreen } from "@/lib/interviews/live-consent";
import type { MediaFault, Platform } from "../_permissions";
import {
  BLOCKED,
  BUSY,
  CHECK,
  CONNECTING,
  CONSENT,
  DUPLICATE_BUTTON,
  ENDING,
  endingNote,
  faultHelp,
  INTERVIEW,
  SAVING,
  WELCOME,
} from "./copy";
import type { LiveState } from "./machine";
import type { PieceView } from "./video-pieces";

/**
 * The live screen's views (AVI commit 10). Presentational only: everything
 * comes in as props, so each screen is rendered in tests without a browser
 * (screens.test.ts). live-flow.tsx owns the media, the transport and the
 * video, and hands this the state.
 */

export type LiveConsentView = NonNullable<ReturnType<typeof liveConsentScreen>>;
export type CheckState = "pend" | "ok" | "bad";

export type LiveScreenProps = {
  state: LiveState;
  companyName: string;
  interviewer: string;
  minutes: number;
  questionCount: number;
  /** Null while the consent text is not final: the interview stays closed. */
  consent: LiveConsentView | null;
  agreed: boolean;
  check: {
    cam: CheckState;
    mic: CheckState;
    net: CheckState;
    micLevel: number;
    fault: MediaFault | null;
    asked: boolean;
    requesting: boolean;
    platform: Platform;
  };
  /** Attaches the camera stream to a preview element as it mounts. */
  previewRef: (el: HTMLVideoElement | null) => void;
  micLevel: number;
  timeLeftSeconds: number | null;
  pieces: PieceView[];
  /** The demo only: name the ending and what the provider sent, under the ending. */
  showEnding?: boolean;
  on: {
    begin(): void;
    toggleAgree(v: boolean): void;
    agree(): void;
    ask(): void;
    retryCheck(): void;
    start(): void;
    retryStart(): void;
    endRequest(): void;
    endCancel(): void;
    endConfirm(): void;
    takeOver(): void;
  };
};

const H1 =
  "iv-sora m-0 mb-2 text-[25px] font-extrabold leading-tight tracking-[-0.035em] text-[var(--t1)]";
const LEAD = "m-0 mb-5 text-sm leading-relaxed text-[var(--t2)]";
const SMALL = "m-0 mt-[11px] text-center text-[12.5px] leading-relaxed text-[var(--t3)]";

function mmss(total: number): string {
  const s = Math.max(0, Math.floor(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Meter({ level }: { level: number }) {
  return (
    <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <i
          key={i}
          className={`w-[3px] rounded-sm ${level * 7 > i ? "bg-[var(--mint)]" : "bg-[var(--line-strong)]"}`}
          style={{ height: 6 + (level * 7 > i ? i * 1.6 : 0) }}
        />
      ))}
    </span>
  );
}

function Row({
  state,
  icon,
  title,
  meter,
}: {
  state: CheckState;
  icon: React.ReactNode;
  title: string;
  meter?: number;
}) {
  const tone =
    state === "ok"
      ? "bg-[var(--mint-tint)] text-[var(--mint-ink)]"
      : state === "bad"
        ? "bg-[var(--red-tint)] text-[var(--red-ink)]"
        : "bg-[var(--inset)] text-[var(--t4)]";
  return (
    <div
      className="flex items-center gap-3 border-b border-[var(--line-soft)] px-3.5 py-3 text-[13.5px] last:border-b-0"
      data-check={state}
    >
      <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${tone}`}>
        {state === "ok" ? <Check className="size-3.5" strokeWidth={2.4} /> : icon}
      </span>
      <span className="min-w-0 flex-1 font-bold text-[var(--t1)]">{title}</span>
      {meter !== undefined && <Meter level={meter} />}
    </div>
  );
}

function Notice({ heading, body, icon }: { heading: string; body: string; icon: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
      <span className="mb-[18px] flex size-[72px] items-center justify-center rounded-3xl bg-[var(--inset)] text-[var(--t3)]">
        {icon}
      </span>
      <h1 tabIndex={-1} data-screen-heading className={`${H1} mb-2.5 text-[23px]`}>
        {heading}
      </h1>
      <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">{body}</p>
    </div>
  );
}

function Welcome(p: LiveScreenProps) {
  return (
    <div className="iv-card" data-live-screen="welcome">
      <h1 tabIndex={-1} data-screen-heading className={H1}>
        {WELCOME.heading}
      </h1>
      <p className={LEAD}>{WELCOME.lead(p.interviewer, p.companyName)}</p>
      <ul className="m-0 mb-5 list-none space-y-2 p-0">
        {WELCOME.facts(p.minutes, p.questionCount).map((fact) => (
          <li
            key={fact}
            className="flex items-start gap-2.5 text-[13.5px] leading-snug text-[var(--t1)]"
          >
            <Check className="mt-0.5 size-4 shrink-0 text-[var(--mint-ink)]" strokeWidth={2.4} />
            {fact}
          </li>
        ))}
      </ul>
      <button type="button" className="iv-btn iv-purple" onClick={p.on.begin}>
        {WELCOME.button}
      </button>
    </div>
  );
}

function Consent(p: LiveScreenProps) {
  const c = p.consent;
  if (!c) return <Blocked {...p} kind="locked" />;
  return (
    <div className="iv-card" data-live-screen="consent">
      <h1 tabIndex={-1} data-screen-heading className={H1}>
        {c.heading}
      </h1>
      <p className={LEAD}>{c.intro}</p>
      <div className="mb-4 overflow-hidden rounded-[14px] border border-[var(--line)]">
        {c.rows.map((row) => (
          <div
            key={row.lead}
            className="border-b border-[var(--line-soft)] px-3.5 py-3 last:border-b-0"
          >
            <p className="m-0 text-[13.5px] font-bold text-[var(--t1)]">{row.lead}</p>
            <p className="m-0 mt-1 text-[13px] leading-relaxed text-[var(--t2)]">{row.body}</p>
          </div>
        ))}
      </div>
      <p className="m-0 mb-4 text-[12.5px] leading-relaxed text-[var(--t3)]">
        {c.smallPrint}{" "}
        <Link
          className="font-semibold text-[var(--purple)] underline"
          href="/privacy"
          target="_blank"
          rel="noreferrer"
        >
          {CONSENT.privacy}
        </Link>
      </p>
      <label className="mb-4 flex cursor-pointer items-start gap-3 text-[13.5px] leading-snug text-[var(--t1)]">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[var(--purple)]"
          checked={p.agreed}
          onChange={(e) => p.on.toggleAgree(e.target.checked)}
        />
        {c.checkbox}
      </label>
      {p.state.consentFailed && (
        <p role="alert" className="m-0 mb-3 text-[13px] font-semibold text-[var(--red-ink)]">
          {CONSENT.failed}
        </p>
      )}
      <button
        type="button"
        className="iv-btn iv-purple"
        disabled={!p.agreed || p.state.savingConsent}
        onClick={p.on.agree}
      >
        {p.state.savingConsent ? CONSENT.saving : CONSENT.button}
      </button>
      {!p.agreed && <p className={SMALL}>{CONSENT.unticked}</p>}
    </div>
  );
}

function CheckScreen(p: LiveScreenProps) {
  const k = p.check;
  const passed = k.cam === "ok" && k.mic === "ok" && k.net === "ok";
  const help = k.fault ? faultHelp(k.fault, k.platform) : null;
  return (
    <div className="iv-card" data-live-screen="check">
      <h1 tabIndex={-1} data-screen-heading className={H1}>
        {CHECK.heading}
      </h1>
      <p className={LEAD}>{CHECK.lead}</p>
      <div className="ivl-cam mb-4">
        <video ref={p.previewRef} playsInline muted autoPlay />
        {k.cam !== "ok" && (
          <User className="relative z-[1] size-[46px] text-white/20" strokeWidth={1.4} />
        )}
      </div>
      <div className="mb-4 overflow-hidden rounded-[14px] border border-[var(--line)]">
        <Row
          state={k.cam}
          icon={
            k.cam === "bad" ? (
              <VideoOff className="size-[15px]" />
            ) : (
              <Video className="size-[15px]" />
            )
          }
          title={CHECK.camera[k.cam]}
        />
        <Row
          state={k.mic}
          icon={
            k.mic === "bad" ? <MicOff className="size-[15px]" /> : <Mic className="size-[15px]" />
          }
          title={CHECK.mic[k.mic]}
          meter={k.mic !== "bad" && k.asked ? k.micLevel : undefined}
        />
        <Row state={k.net} icon={<Wifi className="size-[15px]" />} title={CHECK.net[k.net]} />
      </div>
      {help && (
        <div
          role="alert"
          className="mb-4 rounded-[14px] border border-[rgba(224,82,75,0.26)] bg-[var(--red-tint)] px-[15px] py-[13px]"
        >
          <p className="m-0 text-[12.5px] font-bold leading-relaxed text-[var(--red-ink)]">
            {help.title}
          </p>
          <ol className="m-0 mt-2 list-decimal pl-[18px] text-[12.5px] leading-relaxed text-[var(--red-ink)]">
            {help.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      {!k.asked && !k.fault && (
        <button
          type="button"
          className="iv-btn iv-purple mb-2.5"
          disabled={k.requesting}
          onClick={p.on.ask}
        >
          {k.requesting ? CHECK.asking : CHECK.ask}
        </button>
      )}
      {(k.fault || k.net === "bad") && (
        <button
          type="button"
          className="iv-btn iv-ghost mb-2.5"
          disabled={k.requesting}
          onClick={p.on.retryCheck}
        >
          {CHECK.retry}
        </button>
      )}
      {k.asked && !k.fault && (
        <button type="button" className="iv-btn iv-purple" disabled={!passed} onClick={p.on.start}>
          {CHECK.start}
        </button>
      )}
      {passed && <p className={SMALL}>{CHECK.startNote(p.interviewer)}</p>}
    </div>
  );
}

function Connecting(p: LiveScreenProps) {
  return (
    <div className="iv-card" data-live-screen="connecting">
      <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
        <span className="iv-spin mb-5" />
        <h1 tabIndex={-1} data-screen-heading className={`${H1} text-[23px]`}>
          {CONNECTING.heading(p.interviewer)}
        </h1>
        <p className="m-0 text-sm leading-relaxed text-[var(--t2)]">{CONNECTING.lead}</p>
      </div>
    </div>
  );
}

function Interview(p: LiveScreenProps) {
  const s = p.state;
  const agent = s.agent;
  const initial = p.interviewer.trim()[0]?.toUpperCase() ?? "A";
  return (
    <div data-live-screen="interview" data-agent={agent ?? "joining"}>
      <h1 className="sr-only">{WELCOME.heading}</h1>
      <div className="ivl-grid mb-4">
        <section className="ivl-agent" aria-label={p.interviewer}>
          <span
            className="ivl-orb iv-sora text-[30px] font-extrabold"
            data-agent={agent ?? "joining"}
            aria-hidden
          >
            {initial}
          </span>
          <p className="m-0 text-[15px] font-bold text-[var(--purple-ink)]">{p.interviewer}</p>
          <p className="m-0 text-[13px] font-semibold text-[var(--purple-ink)]/80" data-agent-state>
            {agent ? INTERVIEW.state[agent] : INTERVIEW.waiting}
          </p>
        </section>
        <section className="ivl-cam" aria-label={INTERVIEW.you}>
          <video ref={p.previewRef} playsInline muted autoPlay />
          <span className="ivl-cam-label">
            <span className="ivl-dot" data-on="true" />
            {INTERVIEW.recording}
            <Meter level={p.micLevel} />
          </span>
        </section>
      </div>

      <div
        className="ivl-caption mb-3"
        role="status"
        aria-live="polite"
        aria-label={INTERVIEW.captionLabel(p.interviewer)}
        data-caption
      >
        {s.caption ?? ""}
      </div>
      {agent === "listening" && (
        <p className="m-0 mb-3 text-[13px] leading-relaxed text-[var(--t2)]" data-listening-hint>
          {INTERVIEW.listeningHint(p.interviewer)}
        </p>
      )}
      {s.timeUp && (
        <p role="status" className="m-0 mb-3 text-[13px] font-semibold text-[var(--amber-ink)]">
          {INTERVIEW.timeUp(p.interviewer)}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 flex items-center gap-2 text-[13px] text-[var(--t2)]" data-time-left>
          <Clock className="size-4" strokeWidth={2} />
          {INTERVIEW.timeLeft}{" "}
          <b className="tabular-nums text-[var(--t1)]">{mmss(p.timeLeftSeconds ?? 0)}</b>
        </p>
        {s.endPressed ? (
          <p className="m-0 text-[13px] font-semibold text-[var(--t2)]">{INTERVIEW.ending}</p>
        ) : (
          !s.confirmingEnd && (
            <button
              type="button"
              className="iv-btn iv-ghost"
              style={{ width: "auto", paddingInline: 22 }}
              onClick={p.on.endRequest}
              data-action="end"
            >
              {INTERVIEW.end}
            </button>
          )
        )}
      </div>
      {s.confirmingEnd && (
        <div
          role="alertdialog"
          aria-label={INTERVIEW.confirmTitle}
          className="iv-card mt-3"
          data-confirm-end
        >
          <p className="m-0 text-[15px] font-bold text-[var(--t1)]">{INTERVIEW.confirmTitle}</p>
          <p className="m-0 mb-3 mt-1 text-[13px] text-[var(--t2)]">{INTERVIEW.confirmBody}</p>
          <div className="iv-brow flex gap-2.5">
            <button type="button" className="iv-btn iv-ghost" onClick={p.on.endCancel}>
              {INTERVIEW.confirmNo}
            </button>
            <button
              type="button"
              className="iv-btn iv-dark"
              onClick={p.on.endConfirm}
              data-action="end-confirm"
            >
              {INTERVIEW.confirmYes}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Saving(p: LiveScreenProps) {
  const total = p.pieces.length;
  const saved = p.pieces.filter((x) => x.state === "saved").length;
  const failed = p.pieces.some((x) => x.state === "failed");
  return (
    <div className="iv-card" data-live-screen="saving">
      <div className="flex flex-col items-center px-1 pb-2 pt-3.5 text-center">
        <span className="iv-spin mb-5" />
        <h1 tabIndex={-1} data-screen-heading className={`${H1} text-[23px]`}>
          {SAVING.heading}
        </h1>
        <p className="m-0 mb-1.5 text-sm leading-relaxed text-[var(--t2)]">{SAVING.lead}</p>
        <p
          className="m-0 text-[13px] font-semibold text-[var(--t1)]"
          data-pieces-saved={saved}
          data-pieces-total={total}
        >
          {SAVING.progress(saved, total)}
        </p>
        {failed && (
          <p role="alert" className="m-0 mt-3 text-[13px] font-semibold text-[var(--red-ink)]">
            {SAVING.failed}
          </p>
        )}
      </div>
    </div>
  );
}

function Done(p: LiveScreenProps) {
  const ending = ENDING[p.state.ending ?? "other"];
  return (
    <div className="iv-card" data-live-screen="done" data-ending={p.state.ending ?? "other"}>
      <Notice
        heading={ending.heading}
        body={ending.body(p.companyName)}
        icon={<Check className="size-[34px]" strokeWidth={2.2} />}
      />
      {p.pieces.some((x) => x.state === "refused") && (
        <p className="m-0 mt-3 text-center text-[13px] text-[var(--t2)]" data-video-not-saved>
          {SAVING.notSaved}
        </p>
      )}
      {p.showEnding && (
        <p
          className="m-0 mt-3 rounded-xl bg-[var(--inset)] px-3 py-2 text-center text-[12px] leading-relaxed text-[var(--t2)]"
          data-ending-note
        >
          {endingNote(p.state.ending ?? "other", p.state.endCause)}
        </p>
      )}
    </div>
  );
}

function Busy(p: LiveScreenProps) {
  return (
    <div className="iv-card" data-live-screen="busy">
      <Notice
        heading={BUSY.heading}
        body={BUSY.lead}
        icon={<Clock className="size-[34px]" strokeWidth={2.2} />}
      />
      <button type="button" className="iv-btn iv-purple mt-3" onClick={p.on.retryStart}>
        {BUSY.button}
      </button>
    </div>
  );
}

function Blocked(p: LiveScreenProps & { kind?: NonNullable<LiveState["blocked"]> }) {
  const kind = p.kind ?? p.state.blocked ?? "closed";
  const copy = BLOCKED[kind];
  const icon =
    kind === "phone" ? (
      <Monitor className="size-[34px]" strokeWidth={2.2} />
    ) : (
      <TriangleAlert className="size-[34px]" strokeWidth={2.2} />
    );
  return (
    <div className="iv-card" data-live-screen="blocked" data-blocked={kind}>
      <Notice heading={copy.heading} body={copy.body(p.companyName)} icon={icon} />
      {kind === "duplicate" && (
        <button type="button" className="iv-btn iv-purple mt-3" onClick={p.on.takeOver}>
          {DUPLICATE_BUTTON}
        </button>
      )}
    </div>
  );
}

export function LiveScreens(p: LiveScreenProps) {
  switch (p.state.screen) {
    case "welcome":
      return <Welcome {...p} />;
    case "consent":
      return <Consent {...p} />;
    case "check":
      return <CheckScreen {...p} />;
    case "connecting":
      return <Connecting {...p} />;
    case "interview":
      return <Interview {...p} />;
    case "saving":
      return <Saving {...p} />;
    case "done":
      return <Done {...p} />;
    case "busy":
      return <Busy {...p} />;
    case "blocked":
      return <Blocked {...p} />;
  }
}
