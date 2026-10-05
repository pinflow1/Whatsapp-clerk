import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchProduct, normalizeName } from "../src/lib/nlp/matcher";
import { validateSale } from "../src/lib/nlp/validate-sale";
import type { SaleProduct, SaleValidation } from "../src/lib/nlp/validate-sale";
import type { RecordSale, SaleItemDraft } from "../src/lib/nlp/interpretation";

const WP: SaleProduct = { id: "wp-id", name: "White Paper", aliases: ["wp", "white papers"], current_stock: 450 };
const BP: SaleProduct = { id: "bp-id", name: "Brown Paper", aliases: ["bp"], current_stock: 300 };
const GB: SaleProduct = { id: "gb-id", name: "Gold Border", aliases: ["gb"], current_stock: 38 };
const FL: SaleProduct = { id: "fl-id", name: "Floral", aliases: ["floral design"], current_stock: 61 };
const RB: SaleProduct = { id: "rb-id", name: "Ribbon", aliases: [], current_stock: 0 };
const PRODUCTS = [WP, BP, GB, FL, RB];

// ---------- normalising ----------

describe("normalizeName", () => {
  it("lowercases, drops punctuation, reduces plurals", () => {
    assert.equal(normalizeName("White-Papers"), "white paper");
    assert.equal(normalizeName("  GOLD   Borders "), "gold border");
    assert.equal(normalizeName("Glasses"), "glass");
    assert.equal(normalizeName("Berries"), "berry");
    assert.equal(normalizeName("Watches"), "watch");
    assert.equal(normalizeName("dress"), "dress");
    assert.equal(normalizeName("wp"), "wp");
  });
});

// ---------- matching ----------

describe("matchProduct", () => {
  it("finds the exact name however it is written", () => {
    for (const text of ["White Paper", "white paper", "WHITE PAPER", "white papers", "White-Paper", "  white   paper "]) {
      const r = matchProduct(text, PRODUCTS);
      assert.ok(r.kind === "match" && r.product.id === "wp-id", `"${text}" should match White Paper`);
    }
  });

  it('finds the short name ("wp")', () => {
    const r = matchProduct("WP", PRODUCTS);
    assert.ok(r.kind === "match" && r.product.id === "wp-id" && r.via === "alias");
    const b = matchProduct("bp", PRODUCTS);
    assert.ok(b.kind === "match" && b.product.id === "bp-id");
  });

  it('does not guess when "paper" fits two products', () => {
    const r = matchProduct("paper", PRODUCTS);
    assert.ok(r.kind === "ambiguous");
    assert.deepEqual(r.kind === "ambiguous" && r.candidates.map((c) => c.name), ["Brown Paper", "White Paper"]);
  });

  it("accepts words that belong to exactly one product", () => {
    const r = matchProduct("gold", PRODUCTS);
    assert.ok(r.kind === "match" && r.product.id === "gb-id" && r.via === "partial");
    const swapped = matchProduct("border gold", PRODUCTS);
    assert.ok(swapped.kind === "match" && swapped.product.id === "gb-id");
  });

  it("asks to confirm a close spelling instead of using it", () => {
    for (const [typo, id] of [
      ["whte paper", "wp-id"],
      ["wite papr", "wp-id"],
      ["gld bordr", "gb-id"],
      ["floarl", "fl-id"],
    ] as const) {
      const r = matchProduct(typo, PRODUCTS);
      assert.ok(r.kind === "confirm" && r.product.id === id, `"${typo}" should ask to confirm ${id}`);
    }
  });

  it("does not fuzzy-match very short text", () => {
    assert.equal(matchProduct("wb", PRODUCTS).kind, "none");
    assert.equal(matchProduct("gp", PRODUCTS).kind, "none");
  });

  it("returns none for things that are not products", () => {
    for (const text of ["xyz", "", "   ", "brown ribbon", "white cards", "!!!"]) {
      assert.equal(matchProduct(text, PRODUCTS).kind, "none", `"${text}"`);
    }
  });

  it("does not turn an unknown product into a similar one by dropping words", () => {
    const only = [{ id: "fl-id", name: "Floral", aliases: [] }];
    assert.equal(matchProduct("floral border", only).kind, "none");
  });

  it("is ambiguous when a name and an alias point at different products", () => {
    const clash = [
      { id: "a", name: "Gold", aliases: [] },
      { id: "b", name: "Shiny", aliases: ["gold"] },
    ];
    assert.equal(matchProduct("gold", clash).kind, "ambiguous");
  });

  it("is ambiguous when two close spellings tie", () => {
    const tie = [
      { id: "a", name: "Silver Paper", aliases: [] },
      { id: "b", name: "Silver Papet", aliases: [] },
    ];
    assert.equal(matchProduct("silver papez", tie).kind, "ambiguous");
  });

  it("lists at most five candidates", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Card ${i} Paper`, aliases: [] }));
    const r = matchProduct("paper", many);
    assert.ok(r.kind === "ambiguous" && r.candidates.length === 5);
  });
});

// ---------- the validation layer ----------

const line = (
  product_text: string | null,
  quantity: number | null,
  amount_text: string | null = null,
  amount: number | null = null,
  amount_basis: SaleItemDraft["amount_basis"] = null,
): SaleItemDraft => ({ product_text, quantity, amount_text, amount, amount_basis });

const sale = (items: SaleItemDraft[], total_amount_text: string | null = null): RecordSale => ({
  intent: "record_sale",
  items,
  total_amount_text,
});

const check = (s: RecordSale, opts: { allowNegativeStock?: boolean; products?: SaleProduct[] } = {}): SaleValidation =>
  validateSale(s, { products: opts.products ?? PRODUCTS, allowNegativeStock: opts.allowNegativeStock });

function expectAsk(v: SaleValidation, question: string | RegExp, kind: string) {
  assert.equal(v.status, "ask", `expected a question, got ${JSON.stringify(v)}`);
  if (v.status !== "ask") return;
  if (typeof question === "string") assert.equal(v.question, question);
  else assert.match(v.question, question);
  assert.equal(v.need.kind, kind);
}

function expectReject(v: SaleValidation, code: string, message?: RegExp) {
  assert.equal(v.status, "reject", `expected a rejection, got ${JSON.stringify(v)}`);
  if (v.status !== "reject") return;
  assert.equal(v.code, code);
  if (message) assert.match(v.message, message);
}

describe("validateSale: sales that are ready", () => {
  it('"White paper 100 sold for 80k"', () => {
    const v = check(sale([line("White paper", 100, "80k", 80000, "total")]));
    assert.deepEqual(v, {
      status: "ready",
      items: [{ productId: "wp-id", productName: "White Paper", quantity: 100, amount: 80000 }],
      total: 80000,
    });
  });

  it("two items in one message", () => {
    const v = check(sale([line("white paper", 50, "40k", 40000, "total"), line("gold border", 20, "18k", 18000, "total")]));
    assert.ok(v.status === "ready");
    assert.equal(v.status === "ready" && v.total, 58000);
    assert.equal(v.status === "ready" && v.items.length, 2);
  });

  it("uses a short name and writes the real product name", () => {
    const v = check(sale([line("wp", 10, "8,000", 8000, "total")]));
    assert.ok(v.status === "ready" && v.items[0].productName === "White Paper");
  });

  it("reads the amount from the typed words even when the model gave no number", () => {
    const v = check(sale([line("wp", 10, "₦8,000", null, "total")]));
    assert.ok(v.status === "ready" && v.items[0].amount === 8000);
  });

  it("one amount for a single item", () => {
    const v = check(sale([line("wp", 100)], "80k"));
    assert.ok(v.status === "ready" && v.total === 80000);
  });

  it('per-unit prices are multiplied by code, not by the model ("at 800 each")', () => {
    const v = check(sale([line("wp", 100, "800 each", 800, "per_unit")]));
    assert.ok(v.status === "ready" && v.items[0].amount === 80000);
  });

  it("per-unit with decimals stays exact", () => {
    const v = check(sale([line("wp", 3, "1.1k each", 1100, "per_unit")]));
    assert.ok(v.status === "ready" && v.items[0].amount === 3300);
  });

  it("allows a sale that takes stock below zero only when the admin setting is on", () => {
    const s = sale([line("ribbon", 5, "750", 750, "total")]);
    expectReject(check(s), "insufficient_stock", /No Ribbon in stock/);
    assert.equal(check(s, { allowNegativeStock: true }).status, "ready");
  });
});

describe("validateSale: it asks instead of guessing", () => {
  it('missing amount: "What was the total sale amount?"', () => {
    expectAsk(check(sale([line("white paper", 100)])), "What was the total sale amount?", "amount");
  });

  it('"Sold another 50 white paper" has no amount', () => {
    expectAsk(check(sale([line("white paper", 50)])), "What was the total sale amount?", "amount");
  });

  it("missing amount on one of several items names the product", () => {
    expectAsk(
      check(sale([line("wp", 5, "4k", 4000, "total"), line("gb", 5)])),
      "What was the amount for Gold Border?",
      "amount",
    );
  });

  it('"Sold 100 paper for 80k" asks which paper', () => {
    expectAsk(
      check(sale([line("paper", 100, "80k", 80000, "total")])),
      "I found multiple paper products. Did you mean Brown Paper or White Paper?",
      "product_choice",
    );
  });

  it('"I sold some paper" is not accepted: first which paper, then how many', () => {
    const first = check(sale([line("paper", null)]));
    expectAsk(first, /multiple paper products/, "product_choice");
    const second = check(sale([line("white paper", null)]));
    expectAsk(second, "How many White Paper did you sell?", "quantity");
  });

  it("missing product", () => {
    expectAsk(check(sale([line(null, 10, "5k", 5000, "total")])), "Which product did you sell?", "product_missing");
  });

  it("unknown product", () => {
    expectAsk(check(sale([line("silk", 10, "5k", 5000, "total")])), /couldn't find "silk"/, "product_unknown");
  });

  it("a close spelling is confirmed first", () => {
    expectAsk(check(sale([line("whte paper", 10, "5k", 5000, "total")])), "Did you mean White Paper?", "product_confirm");
  });

  it("a fractional quantity", () => {
    expectAsk(check(sale([line("wp", 2.5, "5k", 5000, "total")])), /whole number/, "quantity");
  });

  it("one amount for several items: asks how to split it", () => {
    expectAsk(
      check(sale([line("wp", 50), line("gb", 20)], "58k")),
      "I see one amount (58k) for 2 items. How much was each one?",
      "split_total",
    );
  });

  it("an amount it cannot read", () => {
    expectAsk(check(sale([line("wp", 10, "eighty thousand", 80000, "total")])), /couldn't read the amount "eighty thousand"/, "amount");
  });

  it("an amount the model gave without any written amount behind it", () => {
    expectAsk(check(sale([line("wp", 10, null, 80000, "total")])), "What was the total sale amount?", "amount");
  });

  it('the model and the typed words disagree ("80" vs 80000)', () => {
    const v = check(sale([line("wp", 100, "80", 80000, "total")]));
    expectAsk(v, "I'm not sure about the amount. Was it ₦80 or ₦80,000?", "amount_conflict");
  });

  it("zero or negative amounts are asked again", () => {
    expectAsk(check(sale([line("wp", 10, "0", 0, "total")])), "What was the total sale amount?", "amount");
    expectAsk(check(sale([line("wp", 10, "-5k", -5000, "total")])), /couldn't read the amount/, "amount");
  });
});

describe("validateSale: quantities and stock", () => {
  it("zero is refused", () => {
    expectReject(check(sale([line("wp", 0, "5k", 5000, "total")])), "invalid_quantity", /more than zero/);
  });

  it("negative is refused, and points to undo", () => {
    expectReject(check(sale([line("wp", -5, "5k", 5000, "total")])), "invalid_quantity", /undo my last sale/);
  });

  it("absurdly large is refused before stock is even looked at", () => {
    expectReject(check(sale([line("wp", 5_000_000, "5k", 5000, "total")])), "quantity_too_large", /5,000,000/);
  });

  it("the largest allowed quantity still runs into the stock check", () => {
    expectReject(check(sale([line("wp", 1_000_000, "5k", 5000, "total")])), "insufficient_stock");
  });

  it("more than the stock", () => {
    expectReject(
      check(sale([line("wp", 500, "5k", 5000, "total")])),
      "insufficient_stock",
      /Only 450 White Paper in stock, but this sale needs 500/,
    );
  });

  it("exactly the stock is fine", () => {
    assert.equal(check(sale([line("wp", 450, "360k", 360000, "total")])).status, "ready");
  });

  it("the same product on two lines is checked on the combined quantity", () => {
    expectReject(
      check(sale([line("wp", 300, "5k", 5000, "total"), line("white paper", 200, "5k", 5000, "total")])),
      "insufficient_stock",
      /needs 500/,
    );
  });

  it("checks stock before asking for a missing amount", () => {
    expectReject(check(sale([line("wp", 9999)])), "insufficient_stock");
  });

  it("an amount too large to record", () => {
    expectReject(check(sale([line("wp", 2, "900,000,000,000 each", 900_000_000_000, "per_unit")])), "invalid_amount");
  });
});
