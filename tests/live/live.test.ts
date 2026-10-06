import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LLMError } from "../src/lib/llm";
import type { LLMProvider, LLMRequest } from "../src/lib/llm";
import { PROMPT_EXAMPLES } from "../src/lib/nlp/prompt";
import { EVAL_CASES, describeOutcome, outcomeOf } from "./live/cases";
import { isGreen, parseWaitMs, passRate, renderMarkdown, runProvider } from "./live/run";
import type { EvalOptions } from "./live/run";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

describe("the live-check cases", () => {
  it("has the 12 spec messages and unique ids and messages", () => {
    assert.equal(EVAL_CASES.filter((c) => c.spec).length, 12);
    assert.equal(new Set(EVAL_CASES.map((c) => c.id)).size, EVAL_CASES.length);
    assert.equal(new Set(EVAL_CASES.map((c) => norm(c.message))).size, EVAL_CASES.length);
  });

  it("never grades on a message the prompt already shows as an example", () => {
    const shown = new Set(PROMPT_EXAMPLES.map((e) => norm(e.message)));
    for (const c of EVAL_CASES) assert.ok(!shown.has(norm(c.message)), `"${c.message}" is in the prompt`);
  });

  it("a perfect model passes every case (so no expectation is mistaken)", () => {
    for (const c of EVAL_CASES) {
      const reason = c.expect(outcomeOf(c.ideal));
      assert.equal(reason, null, `${c.id} "${c.message}": ${reason}`);
    }
  });

  it("a model that always says 'unknown' fails nearly everything (so no expectation is vacuous)", () => {
    const passes = EVAL_CASES.filter((c) => c.expect(outcomeOf({ intent: "unknown", reason: null })) === null).map((c) => c.id);
    // Only these may pass: cases that expect 'unknown', or that only require "not recorded".
    assert.deepEqual(passes.sort(), ["e14", "e17", "e25", "e26", "s12"]);
  });

  it("a model that reads the wrong quantity or amount fails the sale cases", () => {
    const wrong = outcomeOf({
      intent: "record_sale",
      items: [{ product_text: "white paper", quantity: 10, amount_text: "80k", amount: 80000, amount_basis: "total" }],
      total_amount_text: null,
    });
    assert.notEqual(EVAL_CASES.find((c) => c.id === "s01")!.expect(wrong), null);
  });

  it("describes every ideal outcome in plain words", () => {
    for (const c of EVAL_CASES) assert.ok(describeOutcome(outcomeOf(c.ideal)).length > 0);
  });
});

describe("the expectations refuse wrong answers, not just accept right ones", () => {
  const byId = (id: string) => EVAL_CASES.find((c) => c.id === id)!;
  /** Grade case `id` against what a perfect model would say for `otherId`. */
  const gradeWith = (id: string, otherId: string) => byId(id).expect(outcomeOf(byId(otherId).ideal));

  it("a question of the wrong kind", () => {
    for (const [id, other] of [["e07", "e08"], ["e08", "e07"], ["e10", "e08"], ["e11", "e12"], ["e12", "e11"], ["s05", "e07"]]) {
      assert.notEqual(gradeWith(id, other), null, `${id} accepted the answer to ${other}`);
    }
  });

  it("a refusal for the wrong reason", () => {
    for (const [id, other] of [["e13", "e15"], ["e15", "e13"], ["e16", "e13"]]) {
      assert.notEqual(gradeWith(id, other), null, `${id} accepted the answer to ${other}`);
    }
  });

  it("a sale that must not be recorded, but is", () => {
    for (const id of ["s12", "e14", "e17"]) assert.notEqual(gradeWith(id, "s01"), null, `${id} let a ready sale through`);
  });

  it("the right intent with the wrong details", () => {
    assert.notEqual(gradeWith("s07", "e19"), null); // undo, but of the wrong product
    assert.notEqual(gradeWith("s10", "e21"), null); // a sales question, but the wrong period
    const wrongQuantity = outcomeOf({ intent: "correct_sale", product_text: null, old_quantity: null, new_quantity: 31, new_amount_text: null, new_amount: null });
    assert.notEqual(byId("s06").expect(wrongQuantity), null);
  });
});

// ---------- the runner, with stand-in models ----------

const idealByMessage = new Map(EVAL_CASES.map((c) => [c.message, JSON.stringify(c.ideal)]));

function scripted(fn: (req: LLMRequest, call: number) => string | LLMError) {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: "fake",
    model: "fake-1",
    async generateJSON(req) {
      requests.push(req);
      const out = fn(req, requests.length);
      if (out instanceof LLMError) throw out;
      return { text: out, provider: "fake", model: "fake-1", latencyMs: 100 };
    },
  };
  return { provider, requests };
}

function options(overrides: Partial<EvalOptions> = {}) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const o: EvalOptions = {
    today: "2026-10-05",
    delayMs: 1500,
    sleep: async (ms) => void sleeps.push(ms),
    log: (l) => void logs.push(l),
    ...overrides,
  };
  return { o, sleeps, logs };
}

const spec = EVAL_CASES.filter((c) => c.spec);

describe("runProvider", () => {
  it("grades a perfect model at 100% and pauses between messages", async () => {
    const { provider } = scripted((req) => idealByMessage.get(req.user) ?? "{}");
    const { o, sleeps } = options();
    const report = await runProvider("fake", provider, EVAL_CASES, o);
    assert.equal(report.fatal, null);
    assert.equal(report.results.length, EVAL_CASES.length);
    assert.equal(passRate(report), 1);
    assert.ok(isGreen([report], 0.9));
    assert.equal(sleeps.filter((s) => s === 1500).length, EVAL_CASES.length - 1);
  });

  it("reports what went wrong when a model misreads", async () => {
    const { provider } = scripted((req) => {
      if (req.user === "White paper 100 sold for 80k") {
        return JSON.stringify({ intent: "record_sale", items: [{ product_text: "white paper", quantity: 10, amount_text: "80k", amount: 80000, amount_basis: "total" }], total_amount_text: null });
      }
      return idealByMessage.get(req.user) ?? "{}";
    });
    const report = await runProvider("fake", provider, spec, options().o);
    const bad = report.results.filter((r) => !r.passed);
    assert.equal(bad.length, 1);
    assert.match(bad[0].reason ?? "", /White Paper x100 = 80000, got White Paper x10 = 80000/);
    assert.match(bad[0].said ?? "", /"quantity":10/);
  });

  it("is not green when the model keeps saying 'unknown'", async () => {
    const { provider } = scripted(() => '{"intent":"unknown","reason":null}');
    const report = await runProvider("fake", provider, spec, options().o);
    assert.ok(passRate(report) < 0.5);
    assert.ok(!isGreen([report], 0.9));
  });

  it("counts a model that breaks the contract as a failed case and carries on", async () => {
    const { provider } = scripted((req, call) => (call <= 2 ? '{"intent":"nonsense"}' : (idealByMessage.get(req.user) ?? "{}")));
    const report = await runProvider("fake", provider, spec, options().o);
    assert.equal(report.fatal, null);
    assert.equal(report.results.length, spec.length);
    assert.equal(report.results[0].passed, false);
    assert.match(report.results[0].reason ?? "", /broke the rules/);
    assert.equal(report.results[1].passed, true);
  });

  it("waits out a rate limit and then succeeds", async () => {
    let first = true;
    const { provider } = scripted((req) => {
      if (first) {
        first = false;
        return new LLMError("http", 'API returned 429: {"error":{"message":"Rate limit. Please try again in 7.5s."}}', 429);
      }
      return idealByMessage.get(req.user) ?? "{}";
    });
    const { o, sleeps, logs } = options();
    const report = await runProvider("fake", provider, spec.slice(0, 1), o);
    assert.equal(report.results[0].passed, true);
    assert.deepEqual(sleeps, [8000]);
    assert.ok(logs.some((l) => /rate limited, waiting 8s/.test(l)));
  });

  it("gives up on a message after four rate limits", async () => {
    const { provider, requests } = scripted(() => new LLMError("http", "API returned 429: try again in 1s", 429));
    const report = await runProvider("fake", provider, spec.slice(0, 2), options().o);
    assert.equal(report.results[0].passed, false);
    assert.equal(requests.length, 8); // 4 tries for each of 2 messages
    assert.equal(report.fatal, null, "a rate limit is not a reason to stop");
  });

  it("stops at once when the very first call is refused (bad key)", async () => {
    const { provider, requests } = scripted(() => new LLMError("http", 'API returned 401: {"error":"API key not valid"}', 401));
    const report = await runProvider("fake", provider, spec, options().o);
    assert.equal(requests.length, 1);
    assert.match(report.fatal ?? "", /key was refused/);
    assert.ok(!isGreen([report], 0.9));
  });

  it("explains an unknown model name", async () => {
    const { provider } = scripted(() => new LLMError("http", "API returned 404: model not found", 404));
    const report = await runProvider("fake", provider, spec, options().o);
    assert.match(report.fatal ?? "", /GEMINI_MODEL or GROQ_MODEL/);
  });

  it("does not stop for a one-off server fault on the first message", async () => {
    const { provider } = scripted((req, call) => (call === 1 ? new LLMError("http", "API returned 503", 503) : (idealByMessage.get(req.user) ?? "{}")));
    const report = await runProvider("fake", provider, spec, options().o);
    assert.equal(report.fatal, null);
    assert.equal(report.results.length, spec.length);
  });
});

describe("parseWaitMs", () => {
  it("reads Groq's wording", () => {
    assert.equal(parseWaitMs("Please try again in 7.5s."), 8000);
    assert.equal(parseWaitMs("Rate limit reached. Please try again in 1m12.5s. Need more tokens?"), 73000);
    assert.equal(parseWaitMs("Please try again in 250ms"), 750);
  });

  it("reads Gemini's retry delay", () => {
    assert.equal(parseWaitMs('{"error":{"details":[{"retryDelay": "23s"}]}}'), 23500);
  });

  it("falls back to 20 seconds", () => {
    assert.equal(parseWaitMs("Too many requests"), 20000);
  });
});

describe("renderMarkdown", () => {
  it("shows a table, the score, and what went wrong", async () => {
    const { provider } = scripted((req) =>
      req.user === "Undo my last sale" ? '{"intent":"unknown","reason":null}' : (idealByMessage.get(req.user) ?? "{}"),
    );
    const report = await runProvider("gemini", provider, spec, options().o);
    const md = renderMarkdown([report], 0.9);
    assert.match(md, /## gemini \(fake-1\)/);
    assert.match(md, /\*\*11\/12 passed\*\*/);
    assert.match(md, /\| ✅ \| White paper 100 sold for 80k \| ready: White Paper ×100 ₦80,000 \|/);
    assert.match(md, /\| ❌ \| Undo my last sale \|/);
    assert.match(md, /### What went wrong/);
    assert.match(md, /expected undo_sale, model said unknown/);
  });

  it("says plainly when a provider could not be graded", () => {
    const md = renderMarkdown([{ name: "groq", model: "?", results: [], fatal: "GROQ_API_KEY is not set" }], 0.9);
    assert.match(md, /\*\*Could not be graded\.\*\* GROQ_API_KEY is not set/);
  });

  it("escapes characters that would break a table", async () => {
    const { provider } = scripted(() => '{"intent":"unknown","reason":null}');
    const odd = [{ ...spec[0], message: "a | b\nc" }];
    const md = renderMarkdown([await runProvider("x", provider, odd, options().o)], 0.9);
    assert.match(md, /a \\\| b c/);
  });
});
