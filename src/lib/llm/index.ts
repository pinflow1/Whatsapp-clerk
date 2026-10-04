// The one place the app asks for a model. Business code never imports Gemini or Groq directly.
//
// Settings (Vercel environment variables):
//   LLM_PROVIDER     "gemini" (default) or "groq"
//   GEMINI_API_KEY   GEMINI_MODEL  (default gemini-3.5-flash-lite)
//   GROQ_API_KEY     GROQ_MODEL    (default openai/gpt-oss-20b)
//   LLM_TIMEOUT_MS   optional, per attempt, default 20000

import { GeminiProvider, GroqProvider } from "./providers";
import { LLMError } from "./types";
import type { LLMProvider } from "./types";

export type Env = Record<string, string | undefined>;

export function createLLMProvider(env: Env = process.env, fetchImpl?: typeof fetch): LLMProvider {
  const which = (env.LLM_PROVIDER ?? "gemini").trim().toLowerCase();

  let timeoutMs: number | undefined;
  if (env.LLM_TIMEOUT_MS) {
    timeoutMs = Number(env.LLM_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new LLMError("config", "LLM_TIMEOUT_MS must be a positive number of milliseconds");
    }
  }

  if (which === "gemini") {
    return new GeminiProvider({
      apiKey: env.GEMINI_API_KEY ?? "",
      model: env.GEMINI_MODEL || undefined,
      timeoutMs,
      fetch: fetchImpl,
    });
  }
  if (which === "groq") {
    return new GroqProvider({
      apiKey: env.GROQ_API_KEY ?? "",
      model: env.GROQ_MODEL || undefined,
      timeoutMs,
      fetch: fetchImpl,
    });
  }
  throw new LLMError("config", `Unknown LLM_PROVIDER "${which}". Use "gemini" or "groq".`);
}

export { GeminiProvider, GroqProvider, DEFAULT_GEMINI_MODEL, DEFAULT_GROQ_MODEL } from "./providers";
export { generateStructured, parseModelJson } from "./structured";
export type { StructuredResult, Validation } from "./structured";
export { LLMError } from "./types";
export type { LLMErrorKind, LLMProvider, LLMRequest, LLMResponse } from "./types";
