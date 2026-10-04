// The contract between the AI and our code: what the model is allowed to say.
//
// Rule: the model reports what the message SAYS, as written. It never looks anything up,
// matches a product, or does money maths. Later code does that:
//   product_text  = the words the person typed ("wp"), not a database match
//   amount_text   = the money as typed ("80k"); our own parser reads it, the model's
//                   `amount` is only a cross-check
//   null          = "not stated", which later code answers by asking, never by guessing

import type { Validation } from "../llm/structured";

export const INTENTS = [
  "record_sale",
  "correct_sale",
  "undo_sale",
  "query_stock",
  "query_low_stock",
  "query_restock_list",
  "query_sales",
  "update_restock",
  "unknown",
] as const;
export type Intent = (typeof INTENTS)[number];

export const AMOUNT_BASES = ["total", "per_unit"] as const;
export const PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "date"] as const;
export const SALES_METRICS = ["revenue", "units", "transactions", "summary"] as const;
export const GROUPINGS = ["none", "product", "staff"] as const;
export const RESTOCK_WORDS = ["pending", "ordered", "received"] as const;

export type AmountBasis = (typeof AMOUNT_BASES)[number];
export type Period = (typeof PERIODS)[number];
export type SalesMetric = (typeof SALES_METRICS)[number];
export type Grouping = (typeof GROUPINGS)[number];
export type RestockWord = (typeof RESTOCK_WORDS)[number];

export interface SaleItemDraft {
  product_text: string | null;
  quantity: number | null;
  amount_text: string | null;
  amount: number | null;
  /** "per_unit" for "at 800 each": our code multiplies, the model never does. */
  amount_basis: AmountBasis | null;
}

export interface RecordSale {
  intent: "record_sale";
  items: SaleItemDraft[];
  /** One amount covering every item ("... for 58k"). Later code asks how to split it. */
  total_amount_text: string | null;
}
export interface CorrectSale {
  intent: "correct_sale";
  /** null = the person's most recent sale */
  product_text: string | null;
  /** The quantity they say it used to be ("not 100"): lets us check we found the right sale. */
  old_quantity: number | null;
  new_quantity: number | null;
  new_amount_text: string | null;
  new_amount: number | null;
}
export interface UndoSale {
  intent: "undo_sale";
  product_text: string | null;
}
export interface QueryStock {
  intent: "query_stock";
  product_text: string | null;
}
export interface QueryLowStock {
  intent: "query_low_stock";
}
export interface QueryRestockList {
  intent: "query_restock_list";
}
export interface QuerySales {
  intent: "query_sales";
  period: Period | null;
  /** YYYY-MM-DD, only when period is "date" */
  date: string | null;
  metric: SalesMetric;
  product_text: string | null;
  staff_text: string | null;
  group_by: Grouping;
}
export interface UpdateRestock {
  intent: "update_restock";
  product_text: string | null;
  status: RestockWord | null;
  quantity: number | null;
}
export interface UnknownIntent {
  intent: "unknown";
  /** For our logs only. Never shown to the user. */
  reason: string | null;
}

export type Interpretation =
  | RecordSale
  | CorrectSale
  | UndoSale
  | QueryStock
  | QueryLowStock
  | QueryRestockList
  | QuerySales
  | UpdateRestock
  | UnknownIntent;

// ---------- validator ----------

const MAX_TEXT = 200;
const MAX_ITEMS = 20;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function text(o: Obj, key: string, at: string, errors: string[]): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    errors.push(`${at}${key} must be a string or null`);
    return null;
  }
  const t = v.trim();
  if (t.length > MAX_TEXT) {
    errors.push(`${at}${key} is too long`);
    return null;
  }
  return t === "" ? null : t;
}

function num(o: Obj, key: string, at: string, errors: string[]): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    errors.push(`${at}${key} must be a number or null (not text)`);
    return null;
  }
  return v;
}

function oneOf<T extends string>(
  o: Obj,
  key: string,
  allowed: readonly T[],
  at: string,
  errors: string[],
): T | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  errors.push(`${at}${key} must be one of: ${allowed.join(", ")}`);
  return null;
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseItem(raw: unknown, i: number, errors: string[]): SaleItemDraft | null {
  const at = `items[${i}].`;
  if (!isObj(raw)) {
    errors.push(`items[${i}] must be an object`);
    return null;
  }
  return {
    product_text: text(raw, "product_text", at, errors),
    quantity: num(raw, "quantity", at, errors),
    amount_text: text(raw, "amount_text", at, errors),
    amount: num(raw, "amount", at, errors),
    amount_basis: oneOf(raw, "amount_basis", AMOUNT_BASES, at, errors),
  };
}

function parseRecordSale(o: Obj, errors: string[]): RecordSale | null {
  if (!Array.isArray(o.items)) {
    errors.push("items must be an array");
    return null;
  }
  if (o.items.length === 0) {
    errors.push("record_sale needs at least one item");
    return null;
  }
  if (o.items.length > MAX_ITEMS) {
    errors.push(`record_sale can have at most ${MAX_ITEMS} items`);
    return null;
  }
  const items: SaleItemDraft[] = [];
  o.items.forEach((raw, i) => {
    const item = parseItem(raw, i, errors);
    if (item) items.push(item);
  });
  return { intent: "record_sale", items, total_amount_text: text(o, "total_amount_text", "", errors) };
}

function parseQuerySales(o: Obj, errors: string[]): QuerySales {
  const period = oneOf(o, "period", PERIODS, "", errors);
  const date = text(o, "date", "", errors);
  if (date !== null && !isRealDate(date)) errors.push("date must be a real date written YYYY-MM-DD");
  if (period === "date" && date === null) errors.push('period "date" needs a date');
  return {
    intent: "query_sales",
    period,
    date,
    metric: oneOf(o, "metric", SALES_METRICS, "", errors) ?? "summary",
    product_text: text(o, "product_text", "", errors),
    staff_text: text(o, "staff_text", "", errors),
    group_by: oneOf(o, "group_by", GROUPINGS, "", errors) ?? "none",
  };
}

/** Checks the model's JSON against the contract. Unknown extra keys are dropped. */
export function validateInterpretation(raw: unknown): Validation<Interpretation> {
  if (!isObj(raw)) return { ok: false, errors: ["the reply must be a JSON object"] };

  const intent = raw.intent;
  if (typeof intent !== "string" || !(INTENTS as readonly string[]).includes(intent)) {
    return { ok: false, errors: [`intent must be one of: ${INTENTS.join(", ")}`] };
  }

  const errors: string[] = [];
  let value: Interpretation | null = null;

  switch (intent as Intent) {
    case "record_sale":
      value = parseRecordSale(raw, errors);
      break;
    case "correct_sale":
      value = {
        intent: "correct_sale",
        product_text: text(raw, "product_text", "", errors),
        old_quantity: num(raw, "old_quantity", "", errors),
        new_quantity: num(raw, "new_quantity", "", errors),
        new_amount_text: text(raw, "new_amount_text", "", errors),
        new_amount: num(raw, "new_amount", "", errors),
      };
      break;
    case "undo_sale":
      value = { intent: "undo_sale", product_text: text(raw, "product_text", "", errors) };
      break;
    case "query_stock":
      value = { intent: "query_stock", product_text: text(raw, "product_text", "", errors) };
      break;
    case "query_low_stock":
      value = { intent: "query_low_stock" };
      break;
    case "query_restock_list":
      value = { intent: "query_restock_list" };
      break;
    case "query_sales":
      value = parseQuerySales(raw, errors);
      break;
    case "update_restock":
      value = {
        intent: "update_restock",
        product_text: text(raw, "product_text", "", errors),
        status: oneOf(raw, "status", RESTOCK_WORDS, "", errors),
        quantity: num(raw, "quantity", "", errors),
      };
      break;
    case "unknown":
      value = { intent: "unknown", reason: text(raw, "reason", "", errors) };
      break;
  }

  if (errors.length > 0 || value === null) {
    return { ok: false, errors: errors.length > 0 ? errors : ["the reply did not match the contract"] };
  }
  return { ok: true, value };
}
