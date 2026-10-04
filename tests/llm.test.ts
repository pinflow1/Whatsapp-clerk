import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GeminiProvider,
  GroqProvider,
  LLMError,
  createLLMProvider,
  generateStructured,
  parseModelJson,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GROQ_MODEL,
} from "../src/lib/llm";
import type { LLMProvider, LLMRequest, Validation } from "../src/lib/llm";

// ---------- helpers ----------

function mockFetch(queue: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("mock fetch: no more queued responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const noSleep = async () => {};
const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));
const headersOf = (call: { init: RequestInit }) => call.init.headers as Record<string, string>;
const geminiOk = (text: string) => reply({ candidates: [{ content: { parts: [{ text }] } }] });
const groqOk = (content: string) => reply({ choices: [{ message: { content } }] });

function rejectsWith(kind: string) {
  return (e: unknown) => e instanceof LLMError && e.kind === kind;
}

// ---------- Gemini ----------

describe("GeminiProvider", () => {
  it("sends instructions and the user message separately, with the key in a header", async () => {
    const { fn, calls } = mockFetch([geminiOk('{"ok":true}')]);
    const p = new GeminiProvider({ apiKey: "secret-key", fetch: fn, sleep: noSleep });
    const out = await p.generateJSON({ system: "RULES", user: "Sold 5 wp" });

    assert.equal(out.text, '{"ok":true}');
    assert.equal(out.provider, "gemini");
    assert.equal(out.model, DEFAULT_GEMINI_MODEL);
    assert.equal(
      calls[0].url,
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
    assert.equal(headersOf(calls[0])["x-goog-api-key"], "secret-key");
    assert.ok(!calls[0].url.includes("secret-key"), "the key must never be in the URL");

    const body = bodyOf(calls[0]);
    assert.equal(body.systemInstruction.parts[0].text, "RULES");
    assert.equal(body.contents[0].role, "user");
    assert.equal(body.contents[0].parts[0].text, "Sold 5 wp");
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.ok(!JSON.stringify(body.systemInstruction).includes("Sold 5 wp"), "user text must stay out of instructions");
  });

  it("joins text parts and skips thought parts", async () => {
    const { fn } = mockFetch([
      reply({
        candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { text: '{"a":' }, { text: "1}" }] } }],
      }),
    ]);
    const p = new GeminiProvider({ apiKey: "k", fetch: fn });
    assert.equal((await p.generateJSON({ system: "s", user: "u" })).text, '{"a":1}');
  });

  it("reports a safety block", async () => {
    const { fn } = mockFetch([reply({ promptFeedback: { blockReason: "SAFETY" } })]);
    const p = new GeminiProvider({ apiKey: "k", fetch: fn });
    await assert.rejects(p.generateJSON({ system: "s", user: "u" }), rejectsWith("blocked"));
  });

  it("reports an empty answer", async () => {
    const { fn } = mockFetch([reply({ candidates: [{ finishReason: "MAX_TOKENS" }] })]);
    const p = new GeminiProvider({ apiKey: "k", fetch: fn });
    await assert.rejects(p.generateJSON({ system: "s", user: "u" }), rejectsWith("empty"));
  });

  it("retries once on a server fault, then succeeds", async () => {
    const { fn, calls } = mockFetch([reply({ error: "busy" }, 503), geminiOk("{}")]);
    const sleeps: number[] = [];
    const p = new GeminiProvider({ apiKey: "k", fetch: fn, sleep: async (ms) => void sleeps.push(ms) });
    assert.equal((await p.generateJSON({ system: "s", user: "u" })).text, "{}");
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [400]);
  });

  it("retries on 429 and gives up after the retry budget", async () => {
    const { fn, calls } = mockFetch([reply({}, 429), reply({}, 429)]);
    const p = new GeminiProvider({ apiKey: "k", fetch: fn, sleep: noSleep });
    await assert.rejects(p.generateJSON({ system: "s", user: "u" }), (e: unknown) => {
      return e instanceof LLMError && e.kind === "http" && e.status === 429;
    });
    assert.equal(calls.length, 2);
  });

  it("does not retry a bad request or a bad key", async () => {
    const { fn, calls } = mockFetch([reply({ error: "API key not valid" }, 400)]);
    const p = new GeminiProvider({ apiKey: "k", fetch: fn, sleep: noSleep });
    await assert.rejects(p.generateJSON({ system: "s", user: "u" }), rejectsWith("http"));
    assert.equal(calls.length, 1);
  });

  it("times out instead of hanging", async () => {
    const hang = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      })) as typeof fetch;
    const p = new GeminiProvider({ apiKey: "k", fetch: hang, timeoutMs: 20, retries: 0 });
    await assert.rejects(p.generateJSON({ system: "s", user: "u" }), rejectsWith("timeout"));
  });

  it("reports a network failure", async () => {
    const { fn } = mockFetch([new Error("socket hang up")]);
    const p = new GeminiProvider({ apiKey: "k", fetch: fn, retries: 0 });
    await assert.rejects(p.generateJSON({ system: "s", user: "u" }), rejectsWith("network"));
  });

  it("refuses to start without an API key", () => {
    assert.throws(() => new GeminiProvider({ apiKey: "" }), rejectsWith("config"));
  });
});

// ---------- Groq ----------

describe("GroqProvider", () => {
  it("sends an OpenAI-style chat request in JSON mode", async () => {
    const { fn, calls } = mockFetch([groqOk('{"ok":true}')]);
    const p = new GroqProvider({ apiKey: "gk", fetch: fn });
    const out = await p.generateJSON({ system: "Reply as JSON.", user: "Sold 5 wp" });

    assert.equal(out.text, '{"ok":true}');
    assert.equal(out.provider, "groq");
    assert.equal(out.model, DEFAULT_GROQ_MODEL);
    assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(headersOf(calls[0]).authorization, "Bearer gk");

    const body = bodyOf(calls[0]);
    assert.equal(body.model, DEFAULT_GROQ_MODEL);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.deepEqual(body.messages, [
      { role: "system", content: "Reply as JSON." },
      { role: "user", content: "Sold 5 wp" },
    ]);
  });

  it('adds the word "JSON" when the instructions forgot it (Groq requires it)', async () => {
    const { fn, calls } = mockFetch([groqOk("{}")]);
    await new GroqProvider({ apiKey: "k", fetch: fn }).generateJSON({ system: "Extract the sale.", user: "u" });
    assert.match(bodyOf(calls[0]).messages[0].content, /JSON/);
  });

  it("reports an empty answer", async () => {
    const { fn } = mockFetch([groqOk("   ")]);
    await assert.rejects(new GroqProvider({ apiKey: "k", fetch: fn }).generateJSON({ system: "s", user: "u" }), rejectsWith("empty"));
  });

  it("treats Groq's json_validate_failed as bad model output, not a transport fault", async () => {
    const { fn, calls } = mockFetch([reply({ error: { code: "json_validate_failed" } }, 400)]);
    const p = new GroqProvider({ apiKey: "k", fetch: fn, sleep: noSleep });
    await assert.rejects(p.generateJSON({ system: "s", user: "u" }), rejectsWith("invalid_json"));
    assert.equal(calls.length, 1);
  });

  it("retries on 429", async () => {
    const { fn, calls } = mockFetch([reply({}, 429), groqOk("{}")]);
    const p = new GroqProvider({ apiKey: "k", fetch: fn, sleep: noSleep });
    assert.equal((await p.generateJSON({ system: "s", user: "u" })).text, "{}");
    assert.equal(calls.length, 2);
  });

  it("refuses to start without an API key", () => {
    assert.throws(() => new GroqProvider({ apiKey: "" }), rejectsWith("config"));
  });
});

// ---------- parseModelJson ----------

describe("parseModelJson", () => {
  it("parses plain JSON", () => assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 }));
  it("strips code fences", () => assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 }));
  it("finds the object inside stray prose", () => {
    assert.deepEqual(parseModelJson('Sure! Here you go: {"a":1} Hope that helps.'), { a: 1 });
  });
  it("rejects text with no JSON", () => {
    assert.throws(() => parseModelJson("I could not understand that."), rejectsWith("invalid_json"));
  });
  it("rejects broken JSON", () => {
    assert.throws(() => parseModelJson('{"a": 1,'), rejectsWith("invalid_json"));
  });
});

// ---------- generateStructured ----------

function fakeProvider(script: Array<string | LLMError>) {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: "fake",
    model: "fake-1",
    async generateJSON(req) {
      requests.push(req);
      const next = script.shift();
      if (next === undefined) throw new Error("fake provider: script ran out");
      if (next instanceof LLMError) throw next;
      return { text: next, provider: "fake", model: "fake-1", latencyMs: 5 };
    },
  };
  return { provider, requests };
}

const needsN = (raw: unknown): Validation<number> => {
  if (typeof raw === "object" && raw !== null && typeof (raw as { n?: unknown }).n === "number") {
    return { ok: true, value: (raw as { n: number }).n };
  }
  return { ok: false, errors: ["n must be a number"] };
};

describe("generateStructured", () => {
  it("returns the value when the first reply is valid", async () => {
    const { provider, requests } = fakeProvider(['{"n": 7}']);
    const r = await generateStructured(provider, { system: "S", user: "U" }, needsN);
    assert.equal(r.value, 7);
    assert.equal(r.attempts, 1);
    assert.equal(requests.length, 1);
  });

  it("asks again, with feedback in the instructions, when the shape is wrong", async () => {
    const { provider, requests } = fakeProvider(['{"n": "seven"}', '{"n": 7}']);
    const r = await generateStructured(provider, { system: "S", user: "My message" }, needsN);
    assert.equal(r.value, 7);
    assert.equal(r.attempts, 2);
    assert.match(requests[1].system, /rejected: n must be a number/);
    assert.equal(requests[1].user, "My message", "the user's text must never be altered");
    assert.ok(!requests[1].user.includes("rejected"));
  });

  it("asks again when the reply is not JSON", async () => {
    const { provider } = fakeProvider(["Sorry, I cannot do that", '{"n": 1}']);
    const r = await generateStructured(provider, { system: "S", user: "U" }, needsN);
    assert.equal(r.attempts, 2);
  });

  it("accepts fenced JSON", async () => {
    const { provider } = fakeProvider(['```json\n{"n": 3}\n```']);
    assert.equal((await generateStructured(provider, { system: "S", user: "U" }, needsN)).value, 3);
  });

  it("gives up after the attempt limit, reporting the last problem", async () => {
    const { provider, requests } = fakeProvider(['{"n": "a"}', '{"n": "b"}']);
    await assert.rejects(generateStructured(provider, { system: "S", user: "U" }, needsN), rejectsWith("invalid_shape"));
    assert.equal(requests.length, 2);
  });

  it("reports invalid_json when every reply is unparseable", async () => {
    const { provider } = fakeProvider(["nope", "still nope"]);
    await assert.rejects(generateStructured(provider, { system: "S", user: "U" }, needsN), rejectsWith("invalid_json"));
  });

  it("retries when the provider itself reports bad JSON (Groq json_validate_failed)", async () => {
    const { provider } = fakeProvider([new LLMError("invalid_json", "Groq could not produce valid JSON"), '{"n": 2}']);
    const r = await generateStructured(provider, { system: "S", user: "U" }, needsN);
    assert.equal(r.attempts, 2);
  });

  it("does not retry transport faults", async () => {
    const { provider, requests } = fakeProvider([new LLMError("http", "API returned 401", 401), '{"n": 1}']);
    await assert.rejects(generateStructured(provider, { system: "S", user: "U" }, needsN), rejectsWith("http"));
    assert.equal(requests.length, 1);
  });

  it("honours maxAttempts = 1", async () => {
    const { provider, requests } = fakeProvider(['{"n": "x"}', '{"n": 1}']);
    await assert.rejects(generateStructured(provider, { system: "S", user: "U" }, needsN, { maxAttempts: 1 }));
    assert.equal(requests.length, 1);
  });
});

// ---------- createLLMProvider ----------

describe("createLLMProvider", () => {
  it("defaults to Gemini", () => {
    const p = createLLMProvider({ GEMINI_API_KEY: "k" });
    assert.equal(p.name, "gemini");
    assert.equal(p.model, DEFAULT_GEMINI_MODEL);
  });

  it("switches to Groq with one setting", () => {
    const p = createLLMProvider({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k" });
    assert.equal(p.name, "groq");
    assert.equal(p.model, DEFAULT_GROQ_MODEL);
  });

  it("is case-insensitive about the provider name", () => {
    assert.equal(createLLMProvider({ LLM_PROVIDER: " Groq ", GROQ_API_KEY: "k" }).name, "groq");
  });

  it("lets the model be overridden", () => {
    assert.equal(createLLMProvider({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.8-flash" }).model, "gemini-3.8-flash");
    assert.equal(createLLMProvider({ LLM_PROVIDER: "groq", GROQ_API_KEY: "k", GROQ_MODEL: "openai/gpt-oss-120b" }).model, "openai/gpt-oss-120b");
  });

  it("explains a missing key", () => {
    assert.throws(() => createLLMProvider({}), /GEMINI_API_KEY/);
    assert.throws(() => createLLMProvider({ LLM_PROVIDER: "groq" }), /GROQ_API_KEY/);
  });

  it("rejects an unknown provider", () => {
    assert.throws(() => createLLMProvider({ LLM_PROVIDER: "openai", GEMINI_API_KEY: "k" }), rejectsWith("config"));
  });

  it("rejects a bad timeout", () => {
    assert.throws(() => createLLMProvider({ GEMINI_API_KEY: "k", LLM_TIMEOUT_MS: "soon" }), rejectsWith("config"));
    assert.throws(() => createLLMProvider({ GEMINI_API_KEY: "k", LLM_TIMEOUT_MS: "-5" }), rejectsWith("config"));
  });
});
  
