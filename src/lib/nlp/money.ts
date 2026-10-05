// Reads money the way people type it in Nigeria. Plain code, no AI:
// the model copies the words ("80k"), this file turns them into a number.
// It refuses anything it is not sure about, so the caller asks the person instead of guessing.

export type MoneyResult = { ok: true; amount: number } | { ok: false; reason: string };

export const MAX_AMOUNT = 999_999_999_999;

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  grand: 1_000,
  m: 1_000_000,
  mil: 1_000_000,
  million: 1_000_000,
};

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

const fail = (reason: string): MoneyResult => ({ ok: false, reason });

/** "80k", "₦80,000", "N80,000", "80 thousand", "80 grand", "1.5m", "800 each" -> a number of naira. */
export function parseNaira(input: string): MoneyResult {
  let s = input.toLowerCase().trim();
  if (s === "") return fail("no amount given");
  if (/^[-−–]/.test(s)) return fail("an amount cannot be negative");

  s = s
    .replace(/[₦#]/g, " ")
    .replace(/\b(ngn|naira|only|each|apiece|total|per|unit|piece|pcs|a)\b/g, " ")
    .replace(/^\s*n\s*(?=\d)/, "")
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:]+$/, "")
    .trim();

  const m = s.match(/^(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([a-z]+)?$/);
  if (!m) {
    const numbers = s.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
    return fail(numbers.length > 1 ? "more than one amount" : "could not read the amount");
  }

  const [, numberText, word] = m;
  if (numberText.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(numberText)) {
    return fail("the commas in the amount look wrong");
  }

  let multiplier = 1;
  if (word !== undefined) {
    const known = MULTIPLIERS[word];
    if (known === undefined) return fail(`did not understand "${word}"`);
    multiplier = known;
  }

  const amount = round2(Number(numberText.replace(/,/g, "")) * multiplier);
  if (!Number.isFinite(amount)) return fail("could not read the amount");
  if (amount > MAX_AMOUNT) return fail("the amount is too large");
  return { ok: true, amount };
}
