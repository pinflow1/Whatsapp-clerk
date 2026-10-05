// The validation layer between the AI's reading of a message and the database.
// It answers one question: can this be recorded exactly as stated?
//   ready   yes. Here are the verified items, ready for record_sale.
//   ask     something is missing or unclear. Here is the one question to send back.
//   reject  it cannot be recorded as stated, and here is why.
// Nothing is invented: missing information is asked for, never filled in.
// The database engine still re-checks stock atomically; this just gives friendly answers first.

import type { RecordSale } from "./interpretation";
import { matchProduct } from "./matcher";
import type { MatchableProduct } from "./matcher";
import { MAX_AMOUNT, parseNaira } from "./money";

export const MAX_QUANTITY = 1_000_000; // same cap the database enforces

export interface SaleProduct extends MatchableProduct {
  current_stock: number;
}

export interface SaleContext {
  products: SaleProduct[];
  /** Admin setting. When false (the default), a sale can never take stock below zero. */
  allowNegativeStock?: boolean;
}

export interface ReadyItem {
  productId: string;
  productName: string;
  quantity: number;
  /** Line total in naira */
  amount: number;
}

/** What the question is about, so the chat layer can remember it while waiting for the answer. */
export type Need =
  | { kind: "product_missing"; itemIndex: number }
  | { kind: "product_unknown"; itemIndex: number; text: string }
  | { kind: "product_choice"; itemIndex: number; candidates: Array<{ id: string; name: string }> }
  | { kind: "product_confirm"; itemIndex: number; candidate: { id: string; name: string } }
  | { kind: "quantity"; itemIndex: number }
  | { kind: "amount"; itemIndex: number }
  | { kind: "amount_conflict"; itemIndex: number; readings: [number, number] }
  | { kind: "split_total"; totalText: string };

export type RejectCode = "invalid_quantity" | "quantity_too_large" | "insufficient_stock" | "invalid_amount";

export type SaleValidation =
  | { status: "ready"; items: ReadyItem[]; total: number }
  | { status: "ask"; question: string; need: Need }
  | { status: "reject"; code: RejectCode; message: string };

const naira = (n: number) => `₦${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const ask = (question: string, need: Need): SaleValidation => ({ status: "ask", question, need });
const reject = (code: RejectCode, message: string): SaleValidation => ({ status: "reject", code, message });

function orList(names: string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

export function validateSale(sale: RecordSale, ctx: SaleContext): SaleValidation {
  const many = sale.items.length > 1;
  const picked: Array<{ product: SaleProduct; quantity: number }> = [];

  // Pass 1: which product, and how many.
  for (let i = 0; i < sale.items.length; i++) {
    const item = sale.items[i];
    if (item.product_text === null) {
      return ask("Which product did you sell?", { kind: "product_missing", itemIndex: i });
    }

    const found = matchProduct(item.product_text, ctx.products);
    if (found.kind === "none") {
      return ask(`I couldn't find "${item.product_text}" in your products. What did you mean?`, {
        kind: "product_unknown",
        itemIndex: i,
        text: item.product_text,
      });
    }
    if (found.kind === "ambiguous") {
      const names = found.candidates.map((c) => c.name);
      return ask(`I found multiple ${item.product_text.toLowerCase()} products. Did you mean ${orList(names)}?`, {
        kind: "product_choice",
        itemIndex: i,
        candidates: found.candidates.map((c) => ({ id: c.id, name: c.name })),
      });
    }
    if (found.kind === "confirm") {
      return ask(`Did you mean ${found.product.name}?`, {
        kind: "product_confirm",
        itemIndex: i,
        candidate: { id: found.product.id, name: found.product.name },
      });
    }
    const product = found.product;

    const q = item.quantity;
    if (q === null) {
      return ask(`How many ${product.name} did you sell?`, { kind: "quantity", itemIndex: i });
    }
    if (!Number.isInteger(q)) {
      return ask(`How many ${product.name}? Please send a whole number.`, { kind: "quantity", itemIndex: i });
    }
    if (q <= 0) {
      return reject(
        "invalid_quantity",
        'The quantity must be more than zero. If a sale was a mistake, say "undo my last sale".',
      );
    }
    if (q > MAX_QUANTITY) {
      return reject("quantity_too_large", `${q.toLocaleString("en-US")} is too many to record at once. Please check the number.`);
    }
    picked.push({ product, quantity: q });
  }

  // Stock, on the combined quantity (the same product can appear on two lines).
  if (!ctx.allowNegativeStock) {
    const needed = new Map<string, { product: SaleProduct; qty: number }>();
    for (const { product, quantity } of picked) {
      const entry = needed.get(product.id) ?? { product, qty: 0 };
      entry.qty += quantity;
      needed.set(product.id, entry);
    }
    for (const { product, qty } of needed.values()) {
      if (qty > product.current_stock) {
        return reject(
          "insufficient_stock",
          product.current_stock <= 0
            ? `No ${product.name} in stock.`
            : `Only ${product.current_stock} ${product.name} in stock, but this sale needs ${qty}.`,
        );
      }
    }
  }

  // Pass 2: the money.
  const items: ReadyItem[] = [];
  let total = 0;
  for (let i = 0; i < sale.items.length; i++) {
    const item = sale.items[i];
    const { product, quantity } = picked[i];
    let text = item.amount_text;
    let basis = item.amount_basis ?? "total";
    let modelReading = item.amount;

    if (text === null && modelReading === null && sale.total_amount_text !== null) {
      if (many) {
        return ask(
          `I see one amount (${sale.total_amount_text}) for ${sale.items.length} items. How much was each one?`,
          { kind: "split_total", totalText: sale.total_amount_text },
        );
      }
      text = sale.total_amount_text;
      basis = "total";
      modelReading = null;
    }

    const askAmount = (): SaleValidation =>
      ask(many ? `What was the amount for ${product.name}?` : "What was the total sale amount?", {
        kind: "amount",
        itemIndex: i,
      });

    // A number with no written amount behind it cannot be checked, so it is not used.
    if (text === null) return askAmount();

    const parsed = parseNaira(text);
    if (!parsed.ok) {
      return ask(`I couldn't read the amount "${text}". Please send it as a number, like 80k or 80,000.`, {
        kind: "amount",
        itemIndex: i,
      });
    }

    // The model's own reading is only a cross-check. A mismatch means one of us misread it.
    if (modelReading !== null && Math.abs(modelReading - parsed.amount) >= 0.005) {
      return ask(`I'm not sure about the amount. Was it ${naira(parsed.amount)} or ${naira(modelReading)}?`, {
        kind: "amount_conflict",
        itemIndex: i,
        readings: [parsed.amount, modelReading],
      });
    }

    const lineTotal = basis === "per_unit" ? round2(parsed.amount * quantity) : parsed.amount;
    if (lineTotal > MAX_AMOUNT) {
      return reject("invalid_amount", "That amount is too large to record. Please check it.");
    }
    if (lineTotal <= 0) return askAmount();

    items.push({ productId: product.id, productName: product.name, quantity, amount: lineTotal });
    total = round2(total + lineTotal);
  }

  return { status: "ready", items, total };
}
