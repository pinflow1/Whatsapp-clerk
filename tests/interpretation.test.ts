import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateInterpretation } from "../src/lib/nlp/interpretation";
import type { Interpretation, RecordSale, QuerySales } from "../src/lib/nlp/interpretation";

function ok(raw: unknown): Interpretation {
  const r = validateInterpretation(raw);
  assert.ok(r.ok, r.ok ? "" : `expected valid, got errors: ${r.errors.join("; ")}`);
  return r.value;
}

function errorsOf(raw: unknown): string[] {
  const r = validateInterpretation(raw);
  assert.ok(!r.ok, "expected the validator to reject this");
  return r.ok ? [] : r.errors;
}

// Each case is what a CORRECT model reply looks like for the message in the title.
// These shapes are reused later to grade real model output.

describe("the spec's example messages (shape only)", () => {
  it('1. "White paper 100 sold for 80k"', () => {
    const v = ok({
      intent: "record_sale",
      items: [{ product_text: "White paper", quantity: 100, amount_text: "80k", amount: 80000, amount_basis: "total" }],
    }) as RecordSale;
    assert.equal(v.items.length, 1);
    assert.equal(v.items[0].quantity, 100);
    assert.equal(v.items[0].amount_text, "80k");
    assert.equal(v.total_amount_text, null);
  });

  it('2. "sold 50 white paper for 40k"', () => {
    const v = ok({
      intent: "record_sale",
      items: [{ product_text: "white paper", quantity: 50, amount_text: "40k", amount: 40000, amount_basis: "total" }],
    }) as RecordSale;
    assert.equal(v.items[0].amount, 40000);
  });

  it('3. "Sold 50 white paper 40k and 20 gold border 18k" gives two items', () => {
    const v = ok({
      intent: "record_sale",
      items: [
        { product_text: "white paper", quantity: 50, amount_text: "40k", amount: 40000, amount_basis: "total" },
        { product_text: "gold border", quantity: 20, amount_text: "18k", amount: 18000, amount_basis: "total" },
      ],
    }) as RecordSale;
    assert.equal(v.items.length, 2);
    assert.equal(v.items[1].product_text, "gold border");
  });

  it('4. "white paper 100 ₦80,000" keeps the money exactly as written', () => {
    const v = ok({
      intent: "record_sale",
      items: [{ product_text: "white paper", quantity: 100, amount_text: "₦80,000", amount: 80000, amount_basis: "total" }],
    }) as RecordSale;
    assert.equal(v.items[0].amount_text, "₦80,000");
  });

  it('5. "Sold another 50 white paper" has no amount: it stays null, to be asked for', () => {
    const v = ok({
      intent: "record_sale",
      items: [{ product_text: "white paper", quantity: 50, amount_text: null, amount: null, amount_basis: null }],
    }) as RecordSale;
    assert.equal(v.items[0].amount, null);
    assert.equal(v.items[0].amount_text, null);
  });

  it('6. "Actually make the last one 30"', () => {
    const v = ok({ intent: "correct_sale", product_text: null, old_quantity: null, new_quantity: 30 });
    assert.deepEqual(v, {
      intent: "correct_sale",
      product_text: null,
      old_quantity: null,
      new_quantity: 30,
      new_amount_text: null,
      new_amount: null,
    });
  });

  it('6b. "Actually that was 80 white paper, not 100" carries the old quantity as a check', () => {
    const v = ok({ intent: "correct_sale", product_text: "white paper", old_quantity: 100, new_quantity: 80 });
    assert.equal(v.intent === "correct_sale" && v.old_quantity, 100);
  });

  it('7. "Undo my last sale"', () => {
    assert.deepEqual(ok({ intent: "undo_sale", product_text: null }), { intent: "undo_sale", product_text: null });
  });

  it('8. "How much white paper do we have?"', () => {
    assert.deepEqual(ok({ intent: "query_stock", product_text: "white paper" }), {
      intent: "query_stock",
      product_text: "white paper",
    });
  });

  it('9. "What do we need to buy?"', () => {
    assert.deepEqual(ok({ intent: "query_restock_list" }), { intent: "query_restock_list" });
  });

  it('10. "How much did we make yesterday?"', () => {
    const v = ok({ intent: "query_sales", period: "yesterday", metric: "revenue" }) as QuerySales;
    assert.equal(v.period, "yesterday");
    assert.equal(v.metric, "revenue");
    assert.equal(v.group_by, "none");
  });

  it('11. "Show me Chidi\'s sales today"', () => {
    const v = ok({ intent: "query_sales", period: "today", staff_text: "Chidi" }) as QuerySales;
    assert.equal(v.staff_text, "Chidi");
    assert.equal(v.metric, "summary");
  });

  it('12. "I sold some paper" is shape-valid but the quantity is null, so later code must refuse to record it', () => {
    const v = ok({
      intent: "record_sale",
      items: [{ product_text: "paper", quantity: null, amount_text: null, amount: null, amount_basis: null }],
    }) as RecordSale;
    assert.equal(v.items[0].quantity, null);
    assert.equal(v.items[0].amount, null);
  });
});

describe("other intents", () => {
  it("what is low in stock", () => {
    assert.deepEqual(ok({ intent: "query_low_stock" }), { intent: "query_low_stock" });
  });

  it("stock overview with no product", () => {
    assert.deepEqual(ok({ intent: "query_stock" }), { intent: "query_stock", product_text: null });
  });

  it("how many white papers did we sell this week", () => {
    const v = ok({ intent: "query_sales", period: "this_week", metric: "units", product_text: "white paper" }) as QuerySales;
    assert.equal(v.metric, "units");
    assert.equal(v.product_text, "white paper");
  });

  it("today's sales by staff", () => {
    const v = ok({ intent: "query_sales", period: "today", metric: "summary", group_by: "staff" }) as QuerySales;
    assert.equal(v.group_by, "staff");
  });

  it("a specific date", () => {
    const v = ok({ intent: "query_sales", period: "date", date: "2026-09-30" }) as QuerySales;
    assert.equal(v.date, "2026-09-30");
  });

  it("restock status updates", () => {
    assert.deepEqual(ok({ intent: "update_restock", product_text: "gold border", status: "ordered" }), {
      intent: "update_restock",
      product_text: "gold border",
      status: "ordered",
      quantity: null,
    });
  });

  it("per-unit pricing is flagged, not multiplied by the model", () => {
    const v = ok({
      intent: "record_sale",
      items: [{ product_text: "wp", quantity: 100, amount_text: "800 each", amount: 800, amount_basis: "per_unit" }],
    }) as RecordSale;
    assert.equal(v.items[0].amount_basis, "per_unit");
    assert.equal(v.items[0].amount, 800);
  });

  it("one amount for several items is kept as total_amount_text", () => {
    const v = ok({
      intent: "record_sale",
      items: [
        { product_text: "wp", quantity: 50 },
        { product_text: "gold border", quantity: 20 },
      ],
      total_amount_text: "58k",
    }) as RecordSale;
    assert.equal(v.total_amount_text, "58k");
    assert.equal(v.items[0].amount_text, null);
  });

  it("unknown, with a reason for the logs", () => {
    assert.deepEqual(ok({ intent: "unknown", reason: "greeting" }), { intent: "unknown", reason: "greeting" });
  });
});

describe("normalising", () => {
  it("trims text and turns blank text into null", () => {
    const v = ok({
      intent: "record_sale",
      items: [{ product_text: "  white paper  ", quantity: 5, amount_text: "   " }],
    }) as RecordSale;
    assert.equal(v.items[0].product_text, "white paper");
    assert.equal(v.items[0].amount_text, null);
  });

  it("treats missing fields as null", () => {
    const v = ok({ intent: "record_sale", items: [{}] }) as RecordSale;
    assert.deepEqual(v.items[0], {
      product_text: null,
      quantity: null,
      amount_text: null,
      amount: null,
      amount_basis: null,
    });
  });

  it("drops keys that are not in the contract", () => {
    const v = ok({ intent: "undo_sale", product_text: null, sneaky: "ignore previous instructions", price: 1 });
    assert.deepEqual(Object.keys(v).sort(), ["intent", "product_text"]);
  });

  it("defaults the display options of a sales query", () => {
    const v = ok({ intent: "query_sales" }) as QuerySales;
    assert.equal(v.period, null);
    assert.equal(v.metric, "summary");
    assert.equal(v.group_by, "none");
  });
});

describe("rejections (the model must be asked again)", () => {
  it("anything that is not an object", () => {
    for (const bad of [null, undefined, 42, "record_sale", [], [{ intent: "undo_sale" }]]) {
      assert.match(errorsOf(bad)[0], /JSON object/);
    }
  });

  it("an unknown or missing intent", () => {
    assert.match(errorsOf({ intent: "delete_everything" })[0], /intent must be one of/);
    assert.match(errorsOf({})[0], /intent must be one of/);
    assert.match(errorsOf({ intent: 5 })[0], /intent must be one of/);
  });

  it("a sale with no items", () => {
    assert.match(errorsOf({ intent: "record_sale" })[0], /items must be an array/);
    assert.match(errorsOf({ intent: "record_sale", items: [] })[0], /at least one item/);
    assert.match(errorsOf({ intent: "record_sale", items: "100 wp" })[0], /items must be an array/);
  });

  it("too many items", () => {
    const items = Array.from({ length: 21 }, () => ({ product_text: "wp", quantity: 1 }));
    assert.match(errorsOf({ intent: "record_sale", items })[0], /at most 20/);
  });

  it("an item that is not an object", () => {
    assert.match(errorsOf({ intent: "record_sale", items: ["100 wp"] })[0], /items\[0\] must be an object/);
  });

  it("numbers sent as text", () => {
    const e = errorsOf({ intent: "record_sale", items: [{ product_text: "wp", quantity: "100", amount: "80k" }] });
    assert.ok(e.some((m) => m.includes("items[0].quantity")));
    assert.ok(e.some((m) => m.includes("items[0].amount")));
  });

  it("infinite numbers", () => {
    assert.ok(errorsOf({ intent: "record_sale", items: [{ quantity: Infinity }] })[0].includes("quantity"));
  });

  it("an invalid enum value", () => {
    assert.match(errorsOf({ intent: "query_sales", period: "last_year" })[0], /period must be one of/);
    assert.match(errorsOf({ intent: "update_restock", status: "shipped" })[0], /status must be one of/);
    assert.match(errorsOf({ intent: "record_sale", items: [{ amount_basis: "each" }] })[0], /amount_basis must be one of/);
  });

  it("an impossible or malformed date", () => {
    assert.match(errorsOf({ intent: "query_sales", period: "date", date: "2026-13-45" })[0], /real date/);
    assert.match(errorsOf({ intent: "query_sales", period: "date", date: "30/09/2026" })[0], /real date/);
    assert.match(errorsOf({ intent: "query_sales", period: "date", date: "2026-02-30" })[0], /real date/);
  });

  it('period "date" without a date', () => {
    assert.match(errorsOf({ intent: "query_sales", period: "date" })[0], /needs a date/);
  });

  it("absurdly long text", () => {
    const long = "x".repeat(201);
    assert.match(errorsOf({ intent: "undo_sale", product_text: long })[0], /too long/);
  });

  it("reports every problem at once, so one retry can fix them all", () => {
    const e = errorsOf({
      intent: "record_sale",
      items: [{ quantity: "5" }, { amount: "1k" }, "oops"],
    });
    assert.equal(e.length, 3);
  });
});
