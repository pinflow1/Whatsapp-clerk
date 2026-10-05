// Live check: sends the test messages to the REAL Gemini and Groq APIs, grades every
// reading through the app's own checks, and writes a summary you can read on your phone.
// Run it from GitHub: Actions -> "Live model check" -> Run workflow.
// It is not part of the normal tests (those never call a real API).

import { appendFileSync } from "node:fs";
import { LLMError, createLLMProvider } from "../../src/lib/llm";
import type { LLMProvider } from "../../src/lib/llm";
import { interpretMessage } from "../../src/lib/nlp/prompt";
import { EVAL_CASES, describeOutcome, outcomeOf } from "./cases";
import type { EvalCase } from "./cases";

export interface CaseResult {
  id: string;
  message: string;
  passed: boolean;
  /** what the app would do with the model's reading */
  detail: string;
  reason: string | null;
  /** the model's reading, as JSON */
  said: string | null;
  latencyMs: number | null;
  attempts: number | null;
}

export interface ProviderReport {
  name: string;
  model: string;
  results: CaseResult[];
  /** set when the provider could not be graded at all */
  fatal: string | null;
}

export interface EvalOptions {
  today: string;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/** How long a rate-limit message says to wait. Understands Groq ("try again in 7.5s") and Gemini ("retryDelay": "23s"). */
export function parseWaitMs(message: string): number {
  const gemini = message.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/);
  if (gemini) return Math.ceil(Number(gemini[1]) * 1000) + 500;
  const groq = message.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|m|s)\s*)+)/i);
  if (groq) {
    let total = 0;
    for (const part of groq[1].matchAll(/(\d+(?:\.\d+)?)(ms|m|s)/g)) {
      const n = Number(part[1]);
      total += part[2] === "ms" ? n : part[2] === "m" ? n * 60_000 : n * 1000;
    }
    return Math.ceil(total) + 500;
  }
  return 20_000;
}

async function withPatience<T>(fn: () => Promise<T>, o: EvalOptions, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof LLMError) || e.kind !== "http" || e.status !== 429 || attempt >= 4) throw e;
      const wait = Math.min(parseWaitMs(e.message), 65_000);
      o.log(`[${label}] rate limited, waiting ${Math.round(wait / 1000)}s`);
      await o.sleep(wait);
    }
  }
}

function hint(e: LLMError): string {
  const base =
    e.status === 401 || e.status === 403
      ? "The API key was refused. Check the secret's value and that the key is allowed to use this API."
      : e.status === 404
        ? "The model name was not found. Set GEMINI_MODEL or GROQ_MODEL to a model your account can use."
        : e.status === 400
          ? "The API rejected our request (details below), so a setting we send may not suit this model."
          : "Could not reach the API.";
  return `${base} ${e.message}`.slice(0, 600);
}

/** A first-call failure that means every later call would fail the same way. */
function stopsEverything(e: LLMError): boolean {
  if (e.kind === "config" || e.kind === "network" || e.kind === "timeout") return true;
  return e.kind === "http" && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429;
}

export async function runProvider(
  name: string,
  provider: LLMProvider,
  cases: EvalCase[],
  o: EvalOptions,
): Promise<ProviderReport> {
  const report: ProviderReport = { name, model: provider.model, results: [], fatal: null };

  for (const [i, c] of cases.entries()) {
    if (i > 0) await o.sleep(o.delayMs);
    const base = { id: c.id, message: c.message };
    try {
      const r = await withPatience(() => interpretMessage(provider, c.message, { today: o.today }), o, name);
      const outcome = outcomeOf(r.interpretation);
      const reason = c.expect(outcome);
      report.results.push({
        ...base,
        passed: reason === null,
        detail: describeOutcome(outcome),
        reason,
        said: JSON.stringify(r.interpretation),
        latencyMs: r.llm?.latencyMs ?? null,
        attempts: r.llm?.attempts ?? null,
      });
    } catch (e) {
      const err = e instanceof LLMError ? e : new LLMError("network", e instanceof Error ? e.message : String(e));
      const modelFault = err.kind === "invalid_shape" || err.kind === "invalid_json";
      report.results.push({
        ...base,
        passed: false,
        detail: modelFault ? "model reply rejected" : `error: ${err.kind}`,
        reason: modelFault ? `the model's reply broke the rules even after a retry: ${err.message}` : `${err.kind}: ${err.message}`,
        said: null,
        latencyMs: null,
        attempts: null,
      });
      if (i === 0 && !modelFault && stopsEverything(err)) {
        report.fatal = hint(err);
        o.log(`[${name}] stopped: ${report.fatal}`);
        break;
      }
    }
    const last = report.results[report.results.length - 1];
    o.log(`[${name}] ${i + 1}/${cases.length} ${last.passed ? "PASS" : "FAIL"} ${c.message}`);
  }
  return report;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function passRate(r: ProviderReport): number {
  return r.results.length === 0 ? 0 : r.results.filter((x) => x.passed).length / r.results.length;
}

export function isGreen(reports: ProviderReport[], minPass: number): boolean {
  return reports.length > 0 && reports.every((r) => r.fatal === null && passRate(r) >= minPass);
}

export function renderMarkdown(reports: ProviderReport[], minPass: number): string {
  const out: string[] = ["# Live model check", ""];
  for (const r of reports) {
    out.push(`## ${r.name} (${r.model})`);
    if (r.fatal !== null) {
      out.push(`**Could not be graded.** ${r.fatal}`, "");
      continue;
    }
    const passed = r.results.filter((x) => x.passed).length;
    const times = r.results.map((x) => x.latencyMs).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const retried = r.results.filter((x) => (x.attempts ?? 1) > 1).length;
    const median = times.length > 0 ? `${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s` : "n/a";
    const slowest = times.length > 0 ? `${(times[times.length - 1] / 1000).toFixed(1)}s` : "n/a";
    const verdict = passRate(r) >= minPass ? "good enough" : `below the ${Math.round(minPass * 100)}% bar`;
    out.push(
      `**${passed}/${r.results.length} passed** (${verdict}). Median reply ${median}, slowest ${slowest}. ${retried} needed a second try.`,
      "",
      "| | Message | What the app would do |",
      "|---|---|---|",
    );
    for (const x of r.results) out.push(`| ${x.passed ? "✅" : "❌"} | ${esc(x.message)} | ${esc(x.detail)} |`);
    const bad = r.results.filter((x) => !x.passed);
    if (bad.length > 0) {
      out.push("", "### What went wrong");
      for (const x of bad) {
        out.push(`- **${esc(x.message)}**: ${esc(x.reason ?? "")}`);
        if (x.said) out.push(`  - the model said: \`${x.said.slice(0, 500)}\``);
      }
    }
    out.push("");
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const which = (process.env.EVAL_PROVIDERS ?? "both").toLowerCase();
  const names = which === "both" ? ["gemini", "groq"] : [which];
  if (names.some((n) => n !== "gemini" && n !== "groq")) {
    console.error(`EVAL_PROVIDERS must be both, gemini or groq (got "${which}")`);
    process.exitCode = 2;
    return;
  }
  const suite = process.env.EVAL_SUITE === "all" ? "all" : "spec";
  const cases = EVAL_CASES.filter((c) => suite === "all" || c.spec);
  const minPass = Number(process.env.EVAL_MIN_PASS ?? "0.9");
  const opts: EvalOptions = {
    today: "2026-10-05",
    delayMs: Number(process.env.EVAL_DELAY_MS ?? "1500"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  };
  console.log(`Grading ${names.join(" and ")} on ${cases.length} messages (suite: ${suite})`);

  const reports = await Promise.all(
    names.map(async (name): Promise<ProviderReport> => {
      try {
        const provider = createLLMProvider({ ...process.env, LLM_PROVIDER: name });
        return await runProvider(name, provider, cases, opts);
      } catch (e) {
        return { name, model: "?", results: [], fatal: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const markdown = renderMarkdown(reports, minPass);
  console.log(`\n${markdown}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if (!isGreen(reports, minPass)) process.exitCode = 1;
}

// Only start when run directly (the unit tests import this file and must not call any API).
if ((process.argv[1] ?? "").replace(/\\/g, "/").endsWith("tests/live/run.ts")) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
