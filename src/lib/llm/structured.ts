// Turns a model reply into a typed, validated value, or fails loudly.
// The model's JSON is never trusted: it must pass a validator before anything uses it.

import { LLMError } from "./types";
import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface StructuredResult<T> {
  value: T;
  /** 1 = the model got it right first time. */
  attempts: number;
  provider: string;
  model: string;
  latencyMs: number;
  raw: string;
}

/** Pulls one JSON value out of model text. Tolerates ```json fences and stray prose. */
export function parseModelJson(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    // fall through to the object-only fallback
  }
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  throw new LLMError("invalid_json", "The model reply was not valid JSON");
}

type Attempt<T> =
  | { ok: true; value: T; res: LLMResponse }
  | { ok: false; kind: "invalid_json" | "invalid_shape"; message: string; ms: number };

async function attemptOnce<T>(
  provider: LLMProvider,
  system: string,
  user: string,
  validate: (raw: unknown) => Validation<T>,
): Promise<Attempt<T>> {
  let res: LLMResponse;
  try {
    res = await provider.generateJSON({ system, user });
  } catch (e) {
    if (e instanceof LLMError && e.kind === "invalid_json") {
      return { ok: false, kind: "invalid_json", message: "Your reply was not valid JSON.", ms: 0 };
    }
    throw e; // network, timeout, auth, blocked...: not the model's formatting, so don't retry here
  }

  let parsed: unknown;
  try {
    parsed = parseModelJson(res.text);
  } catch {
    return { ok: false, kind: "invalid_json", message: "Your reply was not valid JSON.", ms: res.latencyMs };
  }

  const check = validate(parsed);
  if (!check.ok) {
    return { ok: false, kind: "invalid_shape", message: check.errors.join("; "), ms: res.latencyMs };
  }
  return { ok: true, value: check.value, res };
}

/**
 * Calls the model, parses and validates the reply. If the reply is malformed it asks once
 * more, telling the model what was wrong. Transport faults (rate limits, timeouts, bad
 * keys) are not retried here: the providers already handled the retryable ones.
 */
export async function generateStructured<T>(
  provider: LLMProvider,
  req: LLMRequest,
  validate: (raw: unknown) => Validation<T>,
  opts: { maxAttempts?: number } = {},
): Promise<StructuredResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  let system = req.system;
  let totalMs = 0;

  for (let attempt = 1; ; attempt++) {
    const r = await attemptOnce(provider, system, req.user, validate);
    if (r.ok) {
      totalMs += r.res.latencyMs;
      return {
        value: r.value,
        attempts: attempt,
        provider: r.res.provider,
        model: r.res.model,
        latencyMs: totalMs,
        raw: r.res.text,
      };
    }
    totalMs += r.ms;
    if (attempt >= maxAttempts) {
      throw new LLMError(r.kind, `Model output rejected after ${attempt} attempt(s): ${r.message}`);
    }
    // Feedback goes in our instructions, never into the user's text.
    system = `${req.system}\n\nYour previous reply was rejected: ${r.message}\nReply again with ONLY the corrected JSON object.`;
  }
}
