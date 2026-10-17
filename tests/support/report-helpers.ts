// Shared by the report tests: a stand-in database that records what it was asked, the shop's
// sample people and products, and readers for the captured database output.

import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuerySales } from "../../src/lib/nlp/interpretation";
import { parseDailyReport, parseSalesSummary, parseStockLevels } from "../../src/lib/reports/queries";
import type { DailyReport, SalesSummary, StockLevel } from "../../src/lib/reports/queries";
import { answerQuery } from "../../src/lib/reports/answer";
import type { AnswerContext, QueryInterpretation } from "../../src/lib/reports/answer";
import { fixture } from "./report-fixtures";
import type { FixtureName } from "./report-fixtures";

export const OWNER = "a0000000-0000-0000-0000-000000000001";
export const CHIDI = "a0000000-0000-0000-0000-000000000002";
export const AMAKA = "a0000000-0000-0000-0000-000000000003";
export const WP = "b0000000-0000-0000-0000-000000000001";

// ---------- a stand-in database that records what it was asked ----------

export type Handler = (args: Record<string, unknown>) => unknown;
export interface Call {
  fn: string;
  args: Record<string, unknown>;
}

export function fakeDb(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      const handler = handlers[fn];
      if (!handler) return { data: null, error: { message: `unexpected call to ${fn}`, code: "XX" } };
      return { data: handler(args), error: null }; // a handler that throws makes the call reject
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

/** Answers with the real captured database output. */
export const REAL: Record<string, Handler> = {
  sales_summary: (a) => {
    if (a.p_staff_id === AMAKA) return fixture("salesAmaka");
    if (a.p_product_id === WP) return fixture("salesWp");
    return a.p_from === "2026-09-30" ? fixture("salesAll") : fixture("salesEmpty");
  },
  stock_levels: (a) => (a.p_product_id === null ? fixture("stockAll") : a.p_product_id === WP ? fixture("stockWp") : []),
  low_stock_list: () => fixture("low"),
  restock_list: () => fixture("restock"),
  daily_report: () => fixture("daily0930"),
};

export const PRODUCTS = [
  { id: WP, name: "White Paper", aliases: ["wp", "white papers"] },
  { id: "b0000000-0000-0000-0000-000000000002", name: "Brown Paper", aliases: ["bp"] },
  { id: "b0000000-0000-0000-0000-000000000003", name: "Gold Border", aliases: ["gb"] },
  { id: "b0000000-0000-0000-0000-000000000004", name: "Floral", aliases: ["floral design"] },
  { id: "b0000000-0000-0000-0000-000000000005", name: "Ribbon", aliases: [] },
];
export const STAFF = [
  { id: OWNER, name: "Owner" },
  { id: CHIDI, name: "Chidi" },
  { id: AMAKA, name: "Amaka" },
];

// Monday 5 Oct 2026
export const ctx = (db: SupabaseClient, today = "2026-10-05"): AnswerContext => ({ db, today, products: PRODUCTS, staff: STAFF });

export const sales = (o: Partial<Omit<QuerySales, "intent">> = {}): QuerySales => ({
  intent: "query_sales",
  period: null,
  date: null,
  metric: "summary",
  product_text: null,
  staff_text: null,
  group_by: "none",
  ...o,
});

export async function ask(q: QueryInterpretation, handlers: Record<string, Handler> = REAL, today?: string) {
  const { db, calls } = fakeDb(handlers);
  const outcome = await answerQuery(ctx(db, today), q);
  return { outcome, calls };
}

// Real database output, read through the same checks the app uses.
export function daily(name: FixtureName = "daily0930"): DailyReport {
  const r = parseDailyReport(fixture(name));
  assert.ok(r, `${name} should be readable`);
  return r;
}
export function summary(name: FixtureName): SalesSummary {
  const r = parseSalesSummary(fixture(name));
  assert.ok(r, `${name} should be readable`);
  return r;
}
export function stockLevels(name: FixtureName = "stockAll"): StockLevel[] {
  const r = parseStockLevels(fixture(name));
  assert.ok(r, `${name} should be readable`);
  return r;
}
