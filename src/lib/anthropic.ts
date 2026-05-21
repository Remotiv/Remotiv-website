import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.warn("[anthropic] ANTHROPIC_API_KEY is not set — AI Matching will fail until configured.");
}

export const anthropic = new Anthropic({
  apiKey: apiKey ?? "",
});

export const AI_MATCHING_MODEL = "claude-haiku-4-5-20251001";
