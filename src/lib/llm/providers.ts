// Gemini and Groq behind one interface. Plain fetch, no SDKs.
// Gemini uses the generateContent endpoint: Google lists it as fully supported,
// while the newer Interactions API is still in beta and changed shape in May 2026.

import { LLMError } from "./types";
import type { LLMProvider, LLMRequest, LLMResponse } from "./types";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface ProviderOptions {
  apiKey: string;
  model?: string;
  /** Per attempt. Default 20 seconds. */
  timeoutMs?: number;
  /** Extra attempts for rate limits, server faults and timeouts. Default 1. */
  retries?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

async function postOnce(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  o: ProviderOptions,
): Promise<unknown> {
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new LLMError("http", `API returned ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new LLMError("invalid_json", "The API reply was not JSON");
    }
  } catch (e) {
    if (e instanceof LLMError) throw e;
    if (ctrl.signal.aborted) throw new LLMError("timeout", `No answer within ${timeoutMs}ms`);
    throw new LLMError("network", e instanceof Error ? e.message : "Network error");
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  o: ProviderOptions,
): Promise<unknown> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = 1 + Math.max(0, o.retries ?? 1);
  let last: LLMError | undefined;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(400 * i);
    try {
      return await postOnce(url, headers, body, o);
    } catch (e) {
      if (!(e instanceof LLMError)) throw e;
      last = e;
      if (!e.retryable) throw e;
    }
  }
  throw last ?? new LLMError("network", "Request failed");
}

// ---------- Gemini ----------

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
}

function readGeminiText(data: unknown): string {
  const d = (data ?? {}) as GeminiResponse;
  if (d.promptFeedback?.blockReason) {
    throw new LLMError("blocked", `Gemini refused the request (${d.promptFeedback.blockReason})`);
  }
  const cand = d.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text.trim()) {
    throw new LLMError("empty", `Gemini returned no text (finishReason: ${cand?.finishReason ?? "none"})`);
  }
  return text;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly opts: ProviderOptions;

  constructor(opts: ProviderOptions) {
    if (!opts.apiKey) throw new LLMError("config", "GEMINI_API_KEY is not set");
    this.opts = opts;
    this.model = opts.model || DEFAULT_GEMINI_MODEL;
  }

  async generateJSON(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    const data = await postJson(
      `${GEMINI_BASE}/models/${encodeURIComponent(this.model)}:generateContent`,
      { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: { responseMimeType: "application/json" },
      },
      this.opts,
    );
    return {
      text: readGeminiText(data),
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}

// ---------- Groq ----------

interface GroqResponse {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
}

function readGroqText(data: unknown): string {
  const choice = ((data ?? {}) as GroqResponse).choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text.trim()) {
    throw new LLMError("empty", `Groq returned no text (finish_reason: ${choice?.finish_reason ?? "none"})`);
  }
  return text;
}

export class GroqProvider implements LLMProvider {
  readonly name = "groq";
  readonly model: string;
  private readonly opts: ProviderOptions;

  constructor(opts: ProviderOptions) {
    if (!opts.apiKey) throw new LLMError("config", "GROQ_API_KEY is not set");
    this.opts = opts;
    this.model = opts.model || DEFAULT_GROQ_MODEL;
  }

  async generateJSON(req: LLMRequest): Promise<LLMResponse> {
    const started = Date.now();
    // Groq's JSON mode requires the word "JSON" somewhere in the prompt.
    const system = /json/i.test(req.system)
      ? req.system
      : `${req.system}\n\nRespond with a single JSON object only.`;
    let data: unknown;
    try {
      data = await postJson(
        GROQ_URL,
        { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        {
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: req.user },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
        },
        this.opts,
      );
    } catch (e) {
      // Groq answers 400 when the model could not produce valid JSON. Treat that as
      // "bad model output" so the structured layer can retry it with feedback.
      if (e instanceof LLMError && e.kind === "http" && e.status === 400 && /json_validate_failed/.test(e.message)) {
        throw new LLMError("invalid_json", "Groq could not produce valid JSON");
      }
      throw e;
    }
    return {
      text: readGroqText(data),
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}
