// Answers the questions people ask: stock and price, low stock, the restock list, and sales.
// It takes the AI's reading of the message (already checked against the contract) and does the
// rest in plain code: find the product or person, pick the dates, ask the database, write the
// reply. The AI never sees these figures. Nothing is guessed: when a name could mean more than
// one thing, or is only a close spelling, the answer is a question.
// Phase 7 note: "me" and "my own sales" need to know who is asking, which arrives with roles.
// SERVER ONLY: it uses the service-role client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueryLowStock, QueryRestockList, QuerySales, QueryStock } from "../nlp/interpretation";
import { matchProduct } from "../nlp/matcher";
import type { MatchableProduct } from "../nlp/matcher";
import { resolvePeriod } from "./dates";
import {
  formatLowStock,
  formatRestockList,
  formatSalesAnswer,
  formatStockList,
  formatStockOne,
  orList,
} from "./format";
import { getLowStock, getRestockList, getSalesSummary, getStockLevels } from "./queries";
import type { ReportError } from "./queries";

export type QueryInterpretation = QueryStock | QueryLowStock | QueryRestockList | QuerySales;

export interface AnswerContext {
  db: SupabaseClient;
  /** Today's date in the shop's timezone, YYYY-MM-DD (see todayIn). */
  today: string;
  /** Active products with their short names, used to read product_text. */
  products: MatchableProduct[];
  /** Active staff, used to read staff_text. */
  staff: Array<{ id: string; name: string }>;
}

type Named = { id: string; name: string };

/** What the question is about, so the chat layer can remember it while waiting for the answer. */
export type QueryNeed =
  | { kind: "product_unknown"; text: string }
  | { kind: "product_choice"; candidates: Named[] }
  | { kind: "product_confirm"; candidate: Named }
  | { kind: "staff_unknown"; text: string }
  | { kind: "staff_choice"; candidates: Named[] }
  | { kind: "staff_confirm"; candidate: Named };

export type QueryOutcome =
  /** The finished reply, ready to send. */
  | { status: "answer"; text: string }
  /** One question to send back before this can be answered. */
  | { status: "ask"; question: string; need: QueryNeed }
  /** Cannot be answered. `message` is safe to show; `detail` is for the logs only. */
  | { status: "reject"; code: string; message: string; detail?: string };

const answer = (text: string): QueryOutcome => ({ status: "answer", text });

const failed = (e: ReportError): QueryOutcome => ({
  status: "reject",
  code: e.code,
  message: "Sorry, I couldn't get that just now. Please try again in a moment.",
  detail: e.message,
});

const named = (x: Named): Named => ({ id: x.id, name: x.name });

// ---------- finding the product or person that was named ----------

type Found = { item: MatchableProduct | null } | { outcome: QueryOutcome };

const asking = (question: string, need: QueryNeed): Found => ({ outcome: { status: "ask", question, need } });

function findProduct(typed: string, products: MatchableProduct[]): Found {
  const m = matchProduct(typed, products);
  switch (m.kind) {
    case "match":
      return { item: m.product };
    case "confirm":
      return asking(`Did you mean ${m.product.name}?`, { kind: "product_confirm", candidate: named(m.product) });
    case "ambiguous":
      return asking(
        `I found multiple ${typed.toLowerCase()} products. Did you mean ${orList(m.candidates.map((c) => c.name))}?`,
        { kind: "product_choice", candidates: m.candidates.map(named) },
      );
    case "none":
      return asking(`I couldn't find "${typed}" in your products. What did you mean?`, {
        kind: "product_unknown",
        text: typed,
      });
  }
}

function findStaff(typed: string, staff: Named[]): Found {
  // People are matched the same careful way as products: exact, then unique part of a name, then a
  // close spelling that must be confirmed.
  const m = matchProduct(
    typed,
    staff.map((s) => ({ id: s.id, name: s.name, aliases: [] })),
  );
  switch (m.kind) {
    case "match":
      return { item: m.product };
    case "confirm":
      return asking(`Did you mean ${m.product.name}?`, { kind: "staff_confirm", candidate: named(m.product) });
    case "ambiguous":
      return asking(`More than one person fits "${typed}". Did you mean ${orList(m.candidates.map((c) => c.name))}?`, {
        kind: "staff_choice",
        candidates: m.candidates.map(named),
      });
    case "none":
      return asking(`I couldn't find anyone called "${typed}" on the team. Who did you mean?`, {
        kind: "staff_unknown",
        text: typed,
      });
  }
}

// ---------- the questions ----------

async function answerStock(ctx: AnswerContext, q: QueryStock): Promise<QueryOutcome> {
  if (q.product_text === null) {
    const all = await getStockLevels(ctx.db);
    return all.ok ? answer(formatStockList(all.data)) : failed(all.error);
  }

  const found = findProduct(q.product_text, ctx.products);
  if ("outcome" in found) return found.outcome;
  if (found.item === null) return failed({ code: "INTERNAL_ERROR", message: "a matched product was missing" });

  const r = await getStockLevels(ctx.db, found.item.id);
  if (!r.ok) return failed(r.error);
  if (r.data.length === 0) {
    return { status: "reject", code: "PRODUCT_NOT_FOUND", message: `${found.item.name} is no longer in the product list.` };
  }
  return answer(formatStockOne(r.data[0]));
}

async function answerSales(ctx: AnswerContext, q: QuerySales): Promise<QueryOutcome> {
  const period = resolvePeriod(q.period, q.date, ctx.today);
  if (!period.ok) return { status: "reject", code: "INVALID_PERIOD", message: period.message };

  const product: Found = q.product_text === null ? { item: null } : findProduct(q.product_text, ctx.products);
  if ("outcome" in product) return product.outcome;

  const person: Found = q.staff_text === null ? { item: null } : findStaff(q.staff_text, ctx.staff);
  if ("outcome" in person) return person.outcome;

  const r = await getSalesSummary(ctx.db, {
    from: period.range.from,
    to: period.range.to,
    productId: product.item?.id ?? null,
    staffId: person.item?.id ?? null,
  });
  if (!r.ok) return failed(r.error);

  return answer(
    formatSalesAnswer(r.data, {
      label: period.range.label,
      metric: q.metric,
      groupBy: q.group_by,
      productName: product.item?.name ?? null,
      staffName: person.item?.name ?? null,
    }),
  );
}

/** Answers one question. Never throws: a database problem comes back as a "reject". */
export async function answerQuery(ctx: AnswerContext, q: QueryInterpretation): Promise<QueryOutcome> {
  switch (q.intent) {
    case "query_low_stock": {
      const r = await getLowStock(ctx.db);
      return r.ok ? answer(formatLowStock(r.data)) : failed(r.error);
    }
    case "query_restock_list": {
      const r = await getRestockList(ctx.db);
      return r.ok ? answer(formatRestockList(r.data)) : failed(r.error);
    }
    case "query_stock":
      return answerStock(ctx, q);
    case "query_sales":
      return answerSales(ctx, q);
  }
  }
  
