import Anthropic from "@anthropic-ai/sdk";

export const AI_MATCHING_MODEL = "claude-haiku-4-5-20251001";

// Construct the client lazily (per call) rather than at module import.
// In Next.js, process.env may not be populated at import time for route
// modules, which caused "Could not resolve authentication method".
let cached: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!cached) {
    cached = new Anthropic({ apiKey });
  }
  return cached;
}
