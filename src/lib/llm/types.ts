// Shared types for the LLM layer.
// The model only turns text into JSON text. Nothing in here can touch the database.

export interface LLMRequest {
  /** Our instructions. Never put user text in here. */
  system: string;
  /** The untrusted message from a person. */
  user: string;
}

export interface LLMResponse {
  /** Raw text the model returned. Expected to be a JSON document. */
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
}

/** Everything the app knows about a model provider. Gemini and Groq both fit this. */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateJSON(req: LLMRequest): Promise<LLMResponse>;
}

export type LLMErrorKind =
  | "config" // missing or wrong settings (API key, provider name)
  | "http" // the API answered with an error status
  | "timeout" // no answer in time
  | "network" // could not reach the API
  | "blocked" // the provider refused to answer (safety filter)
  | "empty" // answered with no text
  | "invalid_json" // the text was not valid JSON
  | "invalid_shape"; // the JSON did not match our contract

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly status?: number;

  constructor(kind: LLMErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LLMError";
    this.kind = kind;
    this.status = status;
  }

  /** Worth trying again unchanged: rate limits, server faults, timeouts, network blips. */
  get retryable(): boolean {
    if (this.kind === "timeout" || this.kind === "network") return true;
    return this.kind === "http" && this.status !== undefined && (this.status === 429 || this.status >= 500);
  }
}
