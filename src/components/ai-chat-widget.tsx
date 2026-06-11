"use client";

import { Bot } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  type: "user" | "ai";
  text: string;
  timestamp: Date;
}

const MAX_CHARS = 500;
// Last N turns sent to /api/chat so the model has conversation context
// without unbounded token growth.
const HISTORY_LIMIT = 10;

// Public marketing pages only — the widget must not render on admin, auth,
// client-portal, or talent-portal routes.
const ALLOWED_ROUTES = [
  "/",
  "/about",
  "/ai-matching",
  "/ai-results",
  "/become-a-talent",
  "/book-a-meeting",
  "/browse-talent",
  "/contact",
  "/hire-remote",
  "/jobs",
  "/pricing",
  "/remote-ready",
  "/services/dedicated-team",
  "/services/payroll",
  "/services/recruitment",
  "/services/staff-augmentation",
];

const INITIAL_MESSAGES: Message[] = [
  {
    id: "1",
    type: "ai",
    text: "Hi! I'm Remotiv's AI assistant. I can help you learn about our services, find the right talent, or point you in the right direction. What are you looking for?",
    timestamp: new Date(),
  },
];

export function AIChatWidget() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatHistoryRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive when to scroll; values aren't read
  useEffect(() => {
    const el = chatHistoryRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isTyping]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: inputText drives re-measure; value isn't read
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [inputText]);

  // Close on Escape key
  useEffect(() => {
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    if (isOpen) {
      window.addEventListener("keydown", handleEscape);
      return () => window.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen]);

  const handleSend = useCallback(async () => {
    if (!inputText.trim() || inputText.length > MAX_CHARS || isTyping) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: "user",
      text: inputText.trim(),
      timestamp: new Date(),
    };

    // Last HISTORY_LIMIT turns, mapped to the API's {role, content} shape.
    // The server drops the leading assistant greeting itself.
    const history = [...messages, userMessage].slice(-HISTORY_LIMIT).map((m) => ({
      role: m.type === "user" ? ("user" as const) : ("assistant" as const),
      content: m.text,
    }));

    setMessages((prev) => [...prev, userMessage]);
    setInputText("");
    setIsTyping(true);

    let replyText = "Sorry, I couldn't process that. Please try again.";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      const data = (await res.json()) as { reply?: string };
      if (res.ok && typeof data.reply === "string" && data.reply.trim()) {
        replyText = data.reply;
      }
    } catch {
      // network failure — fall through to the generic error reply
    }

    setIsTyping(false);
    const aiMessage: Message = {
      id: (Date.now() + 1).toString(),
      type: "ai",
      text: replyText,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, aiMessage]);
  }, [inputText, isTyping, messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isOverLimit = inputText.length > MAX_CHARS;

  // After all hooks: skip rendering entirely outside the public marketing pages.
  if (!pathname || !ALLOWED_ROUTES.includes(pathname)) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9999] font-[var(--font-sans)]">
      {/* Chat Panel */}
      <div
        className={cn(
          "absolute bottom-[80px] right-0 w-[480px] max-w-[calc(100vw-32px)] origin-bottom-right",
          isOpen ? "animate-[popIn_0.3s_cubic-bezier(0.175,0.885,0.32,1.275)_forwards]" : "hidden",
        )}
      >
        <div className="flex flex-col overflow-hidden rounded-[24px] border border-zinc-600/45 bg-gradient-to-br from-zinc-800/90 to-zinc-900/95 shadow-[0_25px_60px_rgba(0,0,0,0.45)] backdrop-blur-[24px]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-2">
              {isOpen && (
                <div className="size-2 animate-[pulse_2s_ease-in-out_infinite] rounded-full bg-[#49D7A7]" />
              )}
              <span className="text-xs font-medium text-zinc-400">Remotiv AI</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-[#49D7A7]/30 bg-[#49D7A7]/10 px-2.5 py-1 text-[11px] font-semibold text-[#49D7A7]">
                AGENT
              </span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="flex size-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-700/60 hover:text-zinc-300"
                aria-label="Close chat"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Chat History */}
          <div
            ref={chatHistoryRef}
            className="flex max-h-[280px] flex-col gap-3 overflow-y-auto px-5 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-zinc-600/30"
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={cn(
                  "flex max-w-[82%] flex-col",
                  msg.type === "user" ? "self-end items-end" : "self-start items-start",
                )}
              >
                <span className="mb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
                  {msg.type === "user" ? "You" : "Remotiv AI"}
                </span>
                <div
                  className={cn(
                    "rounded-2xl px-3.5 py-2.5 text-sm leading-[1.55]",
                    msg.type === "user"
                      ? "rounded-br-[4px] bg-[#7E47FF]/25 text-zinc-300"
                      : "rounded-bl-[4px] border border-[#49D7A7]/15 bg-[#49D7A7]/10 text-zinc-300",
                  )}
                >
                  {msg.text}
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex w-fit items-center gap-1 rounded-2xl rounded-bl-[4px] border border-[#49D7A7]/15 bg-[#49D7A7]/10 px-3.5 py-2.5">
                <span className="size-1.5 animate-[bounce_1.2s_ease-in-out_infinite] rounded-full bg-[#49D7A7] opacity-50" />
                <span className="size-1.5 animate-[bounce_1.2s_ease-in-out_infinite_0.2s] rounded-full bg-[#49D7A7] opacity-50" />
                <span className="size-1.5 animate-[bounce_1.2s_ease-in-out_infinite_0.4s] rounded-full bg-[#49D7A7] opacity-50" />
              </div>
            )}
          </div>

          {/* Input Area */}
          <div className="relative overflow-hidden">
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell me about the role you're hiring for..."
              className="min-h-[110px] w-full resize-none border-none bg-transparent px-6 py-4 text-[15px] font-normal leading-[1.65] text-zinc-100 outline-none placeholder:text-zinc-600"
              style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
            />
          </div>

          {/* Controls */}
          <div className="px-4 pb-4">
            <div className="flex items-center justify-end gap-3">
              <span
                className={cn(
                  "text-[11px] font-medium",
                  isOverLimit ? "text-red-400" : "text-zinc-600",
                )}
              >
                {inputText.length}/{MAX_CHARS}
              </span>
              <button
                type="button"
                onClick={handleSend}
                disabled={!inputText.trim() || isOverLimit || isTyping}
                className="group relative flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-[#49D7A7] to-[#3bc495] text-white shadow-[0_6px_20px_rgba(73,215,167,0.35)] transition-all hover:scale-110 hover:rotate-[-2deg] hover:shadow-[0_10px_28px_rgba(73,215,167,0.55)] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Send message"
              >
                <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-[#49D7A7] to-[#3bc495] opacity-0 blur-[8px] transition-opacity group-hover:opacity-50" />
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className="relative z-10"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              </button>
            </div>

            {/* Footer */}
            <div className="mt-3 flex items-center justify-between border-t border-zinc-700/60 pt-2.5 text-[11px] text-zinc-600">
              <div className="flex items-center gap-1.5">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
                <span>Proprietary matching engine</span>
              </div>
              <div className="flex items-center gap-1">
                <span>Powered by</span>
                <span className="text-[#49D7A7]">Remotiv</span>
                <span className="text-zinc-500">×</span>
                <span className="text-purple-400">AI</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "group relative flex size-16 items-center justify-center rounded-full border-2 border-white/20 transition-all duration-500 ease-out hover:scale-110 hover:rotate-[5deg]",
          isOpen && "rotate-90 scale-110",
        )}
        style={{
          background:
            "linear-gradient(135deg, rgba(126,71,255,0.85) 0%, rgba(73,215,167,0.85) 100%)",
          boxShadow:
            "0 0 20px rgba(126,71,255,0.65), 0 0 40px rgba(73,215,167,0.35), 0 0 60px rgba(126,71,255,0.25)",
        }}
        aria-label={isOpen ? "Close AI chat" : "Open AI chat"}
      >
        {/* Ping animation - only when chat is closed */}
        {!isOpen && (
          <span className="absolute inset-0 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full bg-[#7E47FF] opacity-20" />
        )}

        {/* 3D highlight */}
        <span className="pointer-events-none absolute inset-0 rounded-full bg-gradient-to-b from-white/20 to-transparent opacity-35" />

        {/* Inner ring */}
        <span className="pointer-events-none absolute inset-0 rounded-full border-2 border-white/10" />

        {/* Icon */}
        <span className="relative z-10 flex items-center justify-center transition-transform duration-400">
          {isOpen ? (
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            // Bot icon — replaces the previous microphone glyph so the
            // floating bubble visually telegraphs "AI assistant" rather
            // than "voice input".
            <Bot
              size={28}
              strokeWidth={2}
              className="text-white"
              aria-hidden="true"
            />
          )}
        </span>
      </button>
    </div>
  );
}
