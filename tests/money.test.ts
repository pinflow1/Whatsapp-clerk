import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNaira } from "../src/lib/nlp/money";

function amountOf(text: string): number {
  const r = parseNaira(text);
  assert.ok(r.ok, `expected "${text}" to parse, got: ${r.ok ? "" : r.reason}`);
  return r.ok ? r.amount : NaN;
}

function refused(text: string): string {
  const r = parseNaira(text);
  assert.ok(!r.ok, `expected "${text}" to be refused, got ${r.ok ? r.amount : ""}`);
  return r.ok ? "" : r.reason;
}

describe("the ways the spec says people write money", () => {
  it("80k", () => assert.equal(amountOf("80k"), 80000));
  it("80,000", () => assert.equal(amountOf("80,000"), 80000));
  it("₦80,000", () => assert.equal(amountOf("₦80,000"), 80000));
  it("80 thousand", () => assert.equal(amountOf("80 thousand"), 80000));
  it("80 grand", () => assert.equal(amountOf("80 grand"), 80000));
});

describe("other normal spellings", () => {
  const cases: Array<[string, number]> = [
    ["80K", 80000],
    ["80 k", 80000],
    ["80000", 80000],
    ["₦ 80,000", 80000],
    ["N80,000", 80000],
    ["n80,000", 80000],
    ["N 80,000", 80000],
    ["NGN 80,000", 80000],
    ["#80,000", 80000],
    ["80,000 naira", 80000],
    ["80k naira only", 80000],
    ["80 Thousand Naira", 80000],
    ["80,000.50", 80000.5],
    ["₦80,000.00", 80000],
    ["1.5k", 1500],
    ["1.1k", 1100],
    ["0.5k", 500],
    ["1.5m", 1500000],
    ["2 million", 2000000],
    ["1 mil", 1000000],
    ["800", 800],
    ["800 each", 800],
    ["800 per piece", 800],
    ["800 a piece", 800],
    ["1,200", 1200],
    ["1,250,000", 1250000],
    ["  80k  ", 80000],
    ["80k.", 80000],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" is ${expected}`, () => assert.equal(amountOf(text), expected));
  }

  it("never returns floating-point dust", () => {
    assert.equal(amountOf("1.1k"), 1100);
    assert.equal(amountOf("2.3k"), 2300);
    assert.equal(amountOf("4.35m"), 4350000);
  });
});

describe("things it must refuse, so the person gets asked", () => {
  it("empty or blank", () => {
    assert.match(refused(""), /no amount/);
    assert.match(refused("   "), /no amount/);
  });

  it("words instead of digits", () => {
    refused("eighty thousand");
    refused("a hundred");
  });

  it("negative amounts", () => {
    assert.match(refused("-5k"), /negative/);
    assert.match(refused("−80,000"), /negative/);
  });

  it("two amounts", () => {
    assert.match(refused("80k or 90k"), /more than one/);
    assert.match(refused("80k + 20k"), /more than one/);
    assert.match(refused("80 000"), /more than one/);
  });

  it("commas in the wrong places", () => {
    assert.match(refused("8,0000"), /commas/);
    assert.match(refused("80,00"), /commas/);
    assert.match(refused("1,2"), /commas/);
  });

  it("unknown words after the number", () => {
    assert.match(refused("80kk"), /did not understand/);
    assert.match(refused("80 dollars"), /did not understand/);
  });

  it("not money at all", () => {
    refused("abc");
    refused("k");
    refused("₦");
    refused("N/A");
    refused("80k?? maybe");
  });

  it("absurdly large amounts", () => {
    assert.match(refused("999,999,999,999,999"), /too large/);
    assert.match(refused("5000000 m"), /too large/);
  });

  it("zero is readable (the sale checker decides what to do with it)", () => {
    assert.equal(amountOf("0"), 0);
  });
});
