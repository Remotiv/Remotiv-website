import { type NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/app/api/_lib/rate-limit";
import { getAnthropic } from "@/lib/anthropic";

export const runtime = "nodejs";

// Haiku — cheapest model; chat replies are short (max_tokens 300) so each
// turn costs a fraction of a cent.
const CHAT_MODEL = "claude-haiku-4-5-20251001";
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2000;
const MAX_REPLY_TOKENS = 300;

const SYSTEM_PROMPT = `You are Remotiv's AI assistant — a helpful, friendly sales and support agent for Remotiv (remotiv.work), a Pakistan-based remote talent marketplace.

About Remotiv:
- Remotiv connects global companies with Pakistan's top vetted remote talent
- Services: Recruitment, Staff Augmentation, Dedicated Teams, Payroll Services
- Talent covers: Software Engineers, Designers, Growth Marketers, Customer Support, Data Analysts, and more
- Hiring process: Companies find talent → submit a hire request → Remotiv matches and vets → intro call within 24-48 hours
- Pricing: Competitive rates ($25-50/hr avg for senior talent)
- All talent is pre-vetted and English-proficient

Your behavior:
- Be concise (2-3 sentences max per response unless asked for detail)
- Be warm and professional
- Guide visitors toward taking action: booking a meeting (/book-a-meeting), browsing talent (/browse-talent or /hire-remote), or contacting the team (/contact)
- If asked about pricing details or specific availability, suggest they book a meeting or contact the team
- If asked something you don't know about Remotiv, say so honestly and suggest they contact talent@remotiv.work
- Never make up information about specific candidates or availability
- Never discuss competitors negatively
- You are powered by AI (Claude by Anthropic) — be honest if asked`;

type ChatMessage = { role: "user" | "assistant"; content: string };

// Validate + normalise the client-supplied history. Returns null when the
// shape is wrong (caller responds 400). Drops leading assistant turns (the
// widget's greeting) and merges consecutive same-role turns, since the
// Anthropic API requires a user-first, alternating message list.
function parseMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    return null;
  }
  const parsed: ChatMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_CHARS) return null;
    parsed.push({ role, content: trimmed });
  }

  while (parsed.length > 0 && parsed[0].role === "assistant") {
    parsed.shift();
  }
  if (parsed.length === 0 || parsed[parsed.length - 1].role !== "user") {
    return null;
  }

  const merged: ChatMessage[] = [];
  for (const m of parsed) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content += `\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

export async function POST(request: NextRequest) {
  const rl = rateLimit(request, { bucketKey: "chat", max: 10, windowMs: 60_000 });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const messages = parseMessages((body as { messages?: unknown })?.messages);
    if (!messages) {
      return NextResponse.json(
        { error: "Invalid messages: expected 1-20 entries of {role, content}, each under 2000 characters, ending with a user message." },
        { status: 400 },
      );
    }

    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: MAX_REPLY_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!reply) {
      console.error("[chat] empty reply from model:", response.stop_reason);
      return NextResponse.json(
        { error: "No reply generated. Please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({ reply });
  } catch (err) {
    console.error("[chat]", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
