"use client";

import { useEffect, useRef, useState } from "react";

const CALENDLY_URL =
  "https://calendly.com/waleed-izww/intro-call?hide_event_type_details=1&hide_gdpr_banner=1";

export default function CalendlyEmbed() {
  const [scriptFailed, setScriptFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const injectScript = () => {
      const id = "calendly-widget-script";
      if (document.getElementById(id)) return;
      const s = document.createElement("script");
      s.id = id;
      s.src = "https://assets.calendly.com/assets/external/widget.js";
      s.async = true;
      s.onerror = () => setScriptFailed(true);
      document.body.appendChild(s);
    };

    // Old browsers without IntersectionObserver: fall back to immediate inject.
    if (typeof IntersectionObserver === "undefined") {
      injectScript();
      return;
    }

    const el = containerRef.current;
    if (!el) {
      injectScript();
      return;
    }

    // Preload ~200px before the embed enters the viewport so the widget is
    // ready by the time the user actually scrolls to it. Visitors who use the
    // email form instead never pay the cost.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            injectScript();
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      aria-label="Booking calendar"
      className="calendly-inline-widget overflow-hidden rounded-3xl bg-white shadow-[0_4px_24px_rgba(0,0,0,0.08)]"
      data-url={CALENDLY_URL}
      style={{ minWidth: 320, height: 700 }}
    >
      {scriptFailed && (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[#666]">
          <p>
            Having trouble loading the scheduler?{" "}
            <a href="#booking-form" className="underline">
              Use the form below
            </a>{" "}
            to request a time.
          </p>
        </div>
      )}
    </div>
  );
}
