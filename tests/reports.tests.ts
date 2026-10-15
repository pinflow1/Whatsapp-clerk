import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Period } from "../src/lib/nlp/interpretation";
import {
  addDays,
  humanDate,
  isIsoDate,
  resolvePeriod,
  startOfLastMonth,
  startOfMonth,
  startOfWeek,
  todayIn,
} from "../src/lib/reports/dates";
import type { DateRange } from "../src/lib/reports/dates";
import {
  clipMessage,
  count,
  formatDailyReport,
  formatLowStock,
  formatNaira,
  formatNumber,
  formatRestockList,
  formatSalesAnswer,
  formatStockList,
  formatStockOne,
  orList,
  signedCount,
  signedNaira,
} from "../src/lib/reports/format";
import {
  parseDailyReport,
  parseLowStock,
  parseRestock,
  parseSalesSummary,
  parseStockLevels,
} from "../src/lib/reports/queries";
import type { DailyReport, RestockEntry, SalesSummary, StockLevel } from "../src/lib/reports/queries";
import { fixture } from "./reports-fixtures";
import type { FixtureName } from "./reports-fixtures";

// Real database output, read through the same checks the app uses.
function daily(name: FixtureName = "daily0930"): DailyReport {
  const r = parseDailyReport(fixture(name));
  assert.ok(r, `${name} should be readable`);
  return r;
}
function summary(name: FixtureName): SalesSummary {
  const r = parseSalesSummary(fixture(name));
  assert.ok(r, `${name} should be readable`);
  return r;
}
function stockLevels(name: FixtureName = "stockAll"): StockLevel[] {
  const r = parseStockLevels(fixture(name));
  assert.ok(r, `${name} should be readable`);
  return r;
}

// ---------- dates ----------

describe("dates", () => {
  it("adds days across month, year and leap-year edges", () => {
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2027-02-28", 1), "2027-03-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-10-14", 0), "2026-10-14");
    assert.equal(addDays("2026-10-14", -45), "2026-08-30");
  });

  it("knows what is and is not a real calendar date", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2027-02-29", "tomorrow", "2026-1-1", "", "2026-10-14T00:00:00Z"]) {
      assert.equal(isIsoDate(bad), false, `"${bad}" should be refused`);
    }
    for (const good of ["2028-02-29", "2026-10-14", "2026-01-01"]) {
      assert.equal(isIsoDate(good), true, `"${good}" should be accepted`);
    }
    assert.throws(() => addDays("nope", 1), /not a YYYY-MM-DD date/);
  });

  it("weeks run Monday to Sunday", () => {
    assert.equal(startOfWeek("2026-10-14"), "2026-10-12"); // a Wednesday
    assert.equal(startOfWeek("2026-10-12"), "2026-10-12"); // the Monday itself
    assert.equal(startOfWeek("2026-10-18"), "2026-10-12"); // the Sunday at the end
    assert.equal(startOfWeek("2027-01-01"), "2026-12-28"); // across the new year
  });

  it("finds the start of this month and last month", () => {
    assert.equal(startOfMonth("2026-10-14"), "2026-10-01");
    assert.equal(startOfLastMonth("2026-10-14"), "2026-09-01");
    assert.equal(startOfLastMonth("2026-01-15"), "2025-12-01");
    assert.equal(startOfLastMonth("2026-03-31"), "2026-02-01");
  });

  it("writes dates the way people read them", () => {
    assert.equal(humanDate("2026-09-30"), "Wed 30 Sep 2026");
    assert.equal(humanDate("2026-09-29", false), "Tue 29 Sep");
    assert.equal(humanDate("2026-10-01"), "Thu 1 Oct 2026");
    assert.equal(humanDate("garbage"), "garbage");
  });

  it("works out today in the shop's timezone, not UTC", () => {
    const lateEveningUtc = new Date("2026-10-13T23:30:00Z"); // already 00:30 on the 14th in Lagos
    assert.equal(todayIn("Africa/Lagos", lateEveningUtc), "2026-10-14");
    assert.equal(todayIn("UTC", lateEveningUtc), "2026-10-13");
    assert.match(todayIn("Africa/Lagos"), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("resolvePeriod", () => {
  const TODAY = "2026-10-14"; // a Wednesday

  function range(period: Period | null, date: string | null = null, today: string = TODAY): DateRange {
    const r = resolvePeriod(period, date, today);
    assert.ok(r.ok, `expected a range for ${period} on ${today}`);
    return r.range;
  }

  it("today and yesterday", () => {
    assert.deepEqual(range("today"), { from: "2026-10-14", to: "2026-10-15", label: "Today, Wed 14 Oct 2026" });
    assert.deepEqual(range("yesterday"), {
      from: "2026-10-13",
      to: "2026-10-14",
      label: "Yesterday, Tue 13 Oct 2026",
    });
  });

  it("this week runs from Monday through today", () => {
    assert.deepEqual(range("this_week"), {
      from: "2026-10-12",
      to: "2026-10-15",
      label: "This week so far (Mon 12 Oct to Wed 14 Oct)",
    });
    // on a Monday it is just that one day; on a Sunday it is the whole week
    assert.deepEqual(range("this_week", null, "2026-10-12"), {
      from: "2026-10-12",
      to: "2026-10-13",
      label: "This week so far (Mon 12 Oct)",
    });
    assert.deepEqual(range("this_week", null, "2026-10-18"), {
      from: "2026-10-12",
      to: "2026-10-19",
      label: "This week so far (Mon 12 Oct to Sun 18 Oct)",
    });
  });

  it("last week is the whole Monday-to-Sunday before this one", () => {
    assert.deepEqual(range("last_week"), {
      from: "2026-10-05",
      to: "2026-10-12",
      label: "Last week (Mon 5 Oct to Sun 11 Oct)",
    });
  });

  it("this month runs from the 1st through today; last month is the whole month before", () => {
    assert.deepEqual(range("this_month"), {
      from: "2026-10-01",
      to: "2026-10-15",
      label: "This month so far (Thu 1 Oct to Wed 14 Oct)",
    });
    assert.deepEqual(range("last_month"), {
      from: "2026-09-01",
      to: "2026-10-01",
      label: "Last month (Tue 1 Sep to Wed 30 Sep)",
    });
  });

  it("gets the new year, leap day and month ends right", () => {
    // Thursday 1 Jan 2026
    assert.equal(range("this_week", null, "2026-01-01").from, "2025-12-29");
    assert.deepEqual(
      [range("last_week", null, "2026-01-01").from, range("last_week", null, "2026-01-01").to],
      ["2025-12-22", "2025-12-29"],
    );
    assert.deepEqual(
      [range("last_month", null, "2026-01-01").from, range("last_month", null, "2026-01-01").to],
      ["2025-12-01", "2026-01-01"],
    );
    // the day after a leap day
    assert.equal(range("yesterday", null, "2028-03-01").from, "2028-02-29");
    assert.deepEqual(
      [range("last_month", null, "2028-03-01").from, range("last_month", null, "2028-03-01").to],
      ["2028-02-01", "2028-03-01"],
    );
    // the 31st, when the month before is shorter
    assert.deepEqual(
      [range("last_month", null, "2026-03-31").from, range("last_month", null, "2026-03-31").to],
      ["2026-02-01", "2026-03-01"],
    );
  });

  it("each range ends exactly where the next one starts, with no gap and no overlap", () => {
    for (const today of ["2026-10-14", "2026-10-12", "2026-10-18", "2026-01-01", "2028-03-01", "2026-03-31", "2026-12-31"]) {
      assert.equal(range("last_week", null, today).to, range("this_week", null, today).from, `week on ${today}`);
      assert.equal(range("last_month", null, today).to, range("this_month", null, today).from, `month on ${today}`);
      assert.equal(range("yesterday", null, today).to, range("today", null, today).from, `day on ${today}`);
      for (const p of ["today", "yesterday", "this_week", "last_week", "this_month", "last_month"] as const) {
        const r = range(p, null, today);
        assert.ok(r.from < r.to, `${p} on ${today} must cover at least one day`);
      }
    }
  });

  it("a named date is that one day, said plainly", () => {
    assert.deepEqual(range("date", "2026-09-30"), { from: "2026-09-30", to: "2026-10-01", label: "Wed 30 Sep 2026" });
    assert.equal(range("date", "2026-10-14").label, "Today, Wed 14 Oct 2026");
    assert.equal(range("date", "2026-10-13").label, "Yesterday, Tue 13 Oct 2026");
  });

  it("a date that has not happened yet is refused, not answered with zero", () => {
    const r = resolvePeriod("date", "2026-10-15", TODAY);
    assert.ok(!r.ok);
    assert.match(r.message, /hasn't happened yet/);
  });

  it("asks for a date when one is needed and missing or unreadable", () => {
    for (const date of [null, "30 Sept", "2026-02-30"]) {
      const r = resolvePeriod("date", date, TODAY);
      assert.ok(!r.ok, `${date}`);
      assert.match(r.message, /Which date/);
    }
  });

  it("nothing stated means today, and a date alone means that date", () => {
    assert.deepEqual(range(null), range("today"));
    assert.deepEqual(range(null, "2026-09-30"), range("date", "2026-09-30"));
  });
});

// ---------- money and counts ----------

describe("money and counts", () => {
  it("writes naira with thousands separators", () => {
    const cases: Array<[number, string]> = [
      [0, "₦0"],
      [800, "₦800"],
      [1500, "₦1,500"],
      [134000, "₦134,000"],
      [1234567, "₦1,234,567"],
      [1234.5, "₦1,234.50"],
      [1234.05, "₦1,234.05"], // a single-digit fraction keeps its leading zero
      [0.07, "₦0.07"],
      [1.1, "₦1.10"],
      [0.1 + 0.2, "₦0.30"],
      [999999999999.99, "₦999,999,999,999.99"],
      [-5000, "-₦5,000"],
      [-0.001, "₦0"],
      [80000.004, "₦80,000"],
    ];
    for (const [n, text] of cases) assert.equal(formatNaira(n), text, String(n));
  });

  it("writes whole numbers with thousands separators", () => {
    assert.equal(formatNumber(0), "0");
    assert.equal(formatNumber(999), "999");
    assert.equal(formatNumber(1000), "1,000");
    assert.equal(formatNumber(165), "165");
    assert.equal(formatNumber(1234567), "1,234,567");
    assert.equal(formatNumber(-3200), "-3,200");
  });

  it("never prints NaN or Infinity", () => {
    assert.equal(formatNaira(NaN), "₦?");
    assert.equal(formatNumber(Infinity), "?");
  });

  it("writes differences as plain signed figures", () => {
    assert.equal(signedNaira(102000), "+₦102,000");
    assert.equal(signedNaira(-5000), "-₦5,000");
    assert.equal(signedNaira(0), "no change");
    assert.equal(signedNaira(0.001), "no change");
    assert.equal(signedNaira(0.1 + 0.2 - 0.3), "no change"); // floating-point dust is not a difference
    assert.equal(signedCount(2), "+2");
    assert.equal(signedCount(-3), "-3");
    assert.equal(signedCount(0), "no change");
    assert.equal(signedCount(1250), "+1,250");
  });

  it('says "1 sale" but "3 sales"', () => {
    assert.equal(count(1, "sale"), "1 sale");
    assert.equal(count(3, "sale"), "3 sales");
    assert.equal(count(0, "sale"), "0 sales");
    assert.equal(count(1000, "unit"), "1,000 units");
    assert.equal(count(2, "box", "boxes"), "2 boxes");
  });

  it("joins names for a question", () => {
    assert.equal(orList(["a"]), "a");
    assert.equal(orList(["a", "b"]), "a or b");
    assert.equal(orList(["a", "b", "c"]), "a, b or c");
  });
});

describe("clipMessage", () => {
  it("leaves a short message alone", () => {
    assert.equal(clipMessage("hello\nworld", 100), "hello\nworld");
  });

  it("cuts a long one at a line break, within the limit, and says so", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const out = clipMessage(text, 100);
    assert.ok(out.length <= 100, `${out.length} characters`);
    assert.ok(out.endsWith("\n(message shortened)"));
    assert.ok(out.startsWith("line 0\nline 1\n"));
    for (const line of out.split("\n").slice(0, -1)) assert.match(line, /^line \d+$/, "only whole lines are kept");
  });

  it("copes with one enormous line", () => {
    const out = clipMessage("x".repeat(500), 100);
    assert.ok(out.length <= 100);
    assert.ok(out.endsWith("(message shortened)"));
  });

  it("keeps a message that is exactly the limit, and shortens one a single character over", () => {
    const exact = `${"a".repeat(50)}\n${"b".repeat(49)}`;
    assert.equal(exact.length, 100);
    assert.equal(clipMessage(exact, 100), exact);

    const out = clipMessage(`${exact}c`, 100);
    assert.ok(out.length <= 100, `${out.length} characters`);
    assert.equal(out, `${"a".repeat(50)}\n(message shortened)`);
  });

  it("uses the WhatsApp-safe limit when none is given", () => {
    const fits = "z".repeat(3800);
    assert.equal(clipMessage(fits), fits);
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const out = clipMessage(long);
    assert.ok(out.length <= 3800, `${out.length} characters`);
    assert.ok(out.length > 3000, "uses most of the room it is allowed");
  });
});

// ---------- reading the database's reports ----------

describe("reading the database's reports", () => {
  it("accepts the real output of the daily report", () => {
    const d = daily();
    assert.equal(d.date, "2026-09-30");
    assert.equal(d.timezone, "Africa/Lagos");
    assert.equal(d.day.revenue, 134000);
    assert.equal(d.day.transactions, 3);
    assert.equal(d.day.units, 165);
    assert.deepEqual(d.day.by_product.map((p) => p.name), ["White Paper", "Gold Border", "Floral"]);
    assert.deepEqual(d.day.by_staff.map((s) => s.name), ["Chidi", "Amaka"]);
    assert.deepEqual(d.previous_day, { date: "2026-09-29", revenue: 32000, transactions: 1, units: 40 });
    assert.deepEqual(
      d.low_stock.map((p) => [p.name, p.current_stock, p.low_stock_threshold]),
      [
        ["Gold Border", 28, 50],
        ["Floral", 56, 75],
      ],
    );
    assert.deepEqual(
      d.restock.map((r) => [r.name, r.status, r.quantity_ordered]),
      [
        ["Gold Border", "pending", null],
        ["Floral", "ordered", 200],
      ],
    );
  });

  it("accepts the real output of the other reports", () => {
    assert.equal(summary("salesAll").revenue, 134000);
    assert.equal(summary("salesWp").units, 150);
    assert.equal(summary("salesAmaka").by_staff.length, 1);
    assert.equal(summary("salesEmpty").transactions, 0);
    assert.equal(stockLevels().length, 5);
    assert.equal(stockLevels("stockWp")[0].current_stock, 253);
    assert.equal(parseLowStock(fixture("low"))?.length, 2);
    assert.equal(parseRestock(fixture("restock"))?.length, 2);
    assert.equal(daily("dailyEmpty").day.transactions, 0);
  });

  // Each of these is a database reply that has drifted from what the code expects. The report
  // must be refused, never shown with a wrong or missing figure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DRIFT: Array<[string, (d: any) => void]> = [
    ["revenue written as text", (d) => (d.day.revenue = "134000")],
    ["no by_staff list", (d) => delete d.day.by_staff],
    ["a fractional unit count", (d) => (d.day.units = 165.5)],
    ["a product with no name", (d) => delete d.day.by_product[1].name],
    ["a restock row that is not open", (d) => (d.restock[0].status = "received")],
    ["a fractional stock figure", (d) => (d.low_stock[1].current_stock = 56.5)],
    ["no previous day", (d) => delete d.previous_day],
    ["a refusal instead of a report", (d) => (d.ok = false)],
    ["no timezone", (d) => delete d.timezone],
    ["a refused day section", (d) => (d.day = { ok: false, error: { code: "INVALID_INPUT", message: "x" } })],
    ["an ordered quantity written as text", (d) => (d.restock[1].quantity_ordered = "200")],
  ];
  for (const [what, change] of DRIFT) {
    it(`refuses a daily report with ${what}`, () => {
      const raw = fixture("daily0930");
      change(raw);
      assert.equal(parseDailyReport(raw), null);
    });
  }

  it("refuses replies that are not reports at all", () => {
    for (const junk of [null, undefined, 42, "text", [], true]) {
      assert.equal(parseDailyReport(junk), null);
      assert.equal(parseSalesSummary(junk), null);
    }
    for (const junk of [null, undefined, 42, "text", {}, true]) {
      assert.equal(parseStockLevels(junk), null);
      assert.equal(parseLowStock(junk), null);
      assert.equal(parseRestock(junk), null);
    }
  });

  it("refuses a whole list when one entry in it is unreadable", () => {
    const raw = fixture("stockAll");
    raw[2].name = 7;
    assert.equal(parseStockLevels(raw), null);
    const restock = fixture("restock");
    delete restock[1].current_stock;
    assert.equal(parseRestock(restock), null);
  });

  it("allows a product with no price, but not a price written as text", () => {
    const raw = fixture("stockAll");
    raw[0].default_price = null;
    assert.equal(parseStockLevels(raw)?.[0].default_price, null);
    raw[0].default_price = "800";
    assert.equal(parseStockLevels(raw), null);
  });
});

// ---------- the daily report text ----------

const GOLDEN_DAILY = [
  "*Daily report: Wed 30 Sep 2026*",
  "",
  "Revenue: ₦134,000",
  "Sales: 3 (165 units)",
  "",
  "*Top products*",
  "1. White Paper: 150 units, ₦120,000",
  "2. Gold Border: 10 units, ₦9,500",
  "3. Floral: 5 units, ₦4,500",
  "",
  "*By salesperson*",
  "Chidi: 2 sales, 150 units, ₦120,000",
  "Amaka: 1 sale, 15 units, ₦14,000",
  "",
  "*Compared with Tue 29 Sep*",
  "Revenue: +₦102,000 (₦134,000 vs ₦32,000)",
  "Sales: +2 (3 vs 1)",
  "Units: +125 (165 vs 40)",
  "",
  "*Low stock*",
  "Gold Border: 28 left (alert at 50)",
  "Floral: 56 left (alert at 75)",
  "",
  "*Restock list*",
  "Gold Border: pending, 28 left",
  "Floral: ordered 200, 56 left",
].join("\n");

describe("the daily report", () => {
  it("reads exactly as the owner should see it", () => {
    assert.equal(formatDailyReport(daily()), GOLDEN_DAILY);
  });

  it("says plainly when nothing was sold, and still compares and lists stock", () => {
    const text = formatDailyReport(daily("dailyEmpty"));
    assert.equal(
      text,
      [
        "*Daily report: Mon 5 Oct 2026*",
        "",
        "No sales were recorded.",
        "",
        "*Compared with Sun 4 Oct*",
        "Revenue: no change (₦0 vs ₦0)",
        "Sales: no change (0 vs 0)",
        "Units: no change (0 vs 0)",
        "",
        "*Low stock*",
        "Gold Border: 28 left (alert at 50)",
        "Floral: 56 left (alert at 75)",
        "",
        "*Restock list*",
        "Gold Border: pending, 28 left",
        "Floral: ordered 200, 56 left",
      ].join("\n"),
    );
  });

  it("shows a fall against the day before as a minus, with both figures", () => {
    const r = daily();
    r.previous_day = { date: "2026-09-29", revenue: 200000, transactions: 9, units: 400 };
    const text = formatDailyReport(r);
    assert.ok(text.includes("Revenue: -₦66,000 (₦134,000 vs ₦200,000)"));
    assert.ok(text.includes("Sales: -6 (3 vs 9)"));
    assert.ok(text.includes("Units: -235 (165 vs 400)"));
  });

  it("says no change when the two days match", () => {
    const r = daily();
    r.previous_day = { date: "2026-09-29", revenue: 134000, transactions: 3, units: 165 };
    const text = formatDailyReport(r);
    assert.ok(text.includes("Revenue: no change (₦134,000 vs ₦134,000)"));
    assert.ok(text.includes("Sales: no change (3 vs 3)"));
    assert.ok(text.includes("Units: no change (165 vs 165)"));
  });

  it("says so when nothing is low and the restock list is empty", () => {
    const r = daily();
    r.low_stock = [];
    r.restock = [];
    const text = formatDailyReport(r);
    assert.ok(text.includes("*Low stock*\nNothing is low."));
    assert.ok(text.includes("*Restock list*\nThe list is empty."));
  });

  it("uses the singular for exactly one sale and one unit", () => {
    const r = daily();
    r.day = summary("salesAmaka");
    r.day.by_staff = [{ user_id: "u", name: "Amaka", transactions: 1, units: 1, revenue: 900 }];
    r.day.transactions = 1;
    r.day.units = 1;
    r.day.revenue = 900;
    const text = formatDailyReport(r);
    assert.ok(text.includes("Sales: 1 (1 unit)"));
    assert.ok(text.includes("Amaka: 1 sale, 1 unit, ₦900"));
  });

  it("shows at most ten products and says how many more", () => {
    const r = daily();
    r.day.by_product = Array.from({ length: 25 }, (_, i) => ({
      product_id: `p${i}`,
      name: `Design ${i + 1}`,
      units: 25 - i,
      revenue: (25 - i) * 100,
    }));
    const text = formatDailyReport(r);
    const numbered = text.split("\n").filter((line) => /^\d+\. /.test(line));
    assert.equal(numbered.length, 10);
    assert.ok(text.includes("1. Design 1: 25 units, ₦2,500"));
    assert.ok(text.includes("10. Design 10: 16 units, ₦1,600"));
    assert.ok(!text.includes("11. Design 11"));
    assert.ok(text.includes("(+15 more)"));
  });

  it("never grows past one WhatsApp message, and says when it was shortened", () => {
    const r = daily();
    const long = "N".repeat(150);
    r.day.by_product = Array.from({ length: 30 }, (_, i) => ({ product_id: `p${i}`, name: `${long}${i}`, units: 5, revenue: 500 }));
    r.day.by_staff = Array.from({ length: 30 }, (_, i) => ({ user_id: `u${i}`, name: `${long}${i}`, transactions: 1, units: 5, revenue: 500 }));
    r.low_stock = Array.from({ length: 30 }, (_, i) => ({ product_id: `p${i}`, name: `${long}${i}`, current_stock: i, low_stock_threshold: 100 }));
    r.restock = Array.from({ length: 30 }, (_, i): RestockEntry => ({
      restock_id: `r${i}`,
      product_id: `p${i}`,
      name: `${long}${i}`,
      status: "pending",
      stock_when_flagged: i,
      current_stock: i,
      quantity_ordered: null,
    }));
    const text = formatDailyReport(r);
    assert.ok(text.length <= 3800, `${text.length} characters`);
    assert.ok(text.endsWith("(message shortened)"));
  });

  it("never prints NaN, undefined or null", () => {
    for (const name of ["daily0930", "dailyEmpty"] as const) {
      assert.doesNotMatch(formatDailyReport(daily(name)), /NaN|undefined|null|\[object/);
    }
  });
});

// ---------- answers ----------

describe("sales answers", () => {
  const base = { label: "Wed 30 Sep 2026", metric: "revenue", groupBy: "none", productName: null, staffName: null } as const;

  it("answers a revenue question with the total and how many sales", () => {
    assert.equal(formatSalesAnswer(summary("salesAll"), base), "*Wed 30 Sep 2026*\n\nRevenue: ₦134,000 from 3 sales");
  });

  it("answers a units question", () => {
    assert.equal(
      formatSalesAnswer(summary("salesAll"), { ...base, metric: "units" }),
      "*Wed 30 Sep 2026*\n\nUnits sold: 165 in 3 sales",
    );
  });

  it("answers a how-many-sales question", () => {
    assert.equal(
      formatSalesAnswer(summary("salesAll"), { ...base, metric: "transactions" }),
      "*Wed 30 Sep 2026*\n\nSales recorded: 3",
    );
  });

  it("names the product when the figures are for one product only", () => {
    assert.equal(
      formatSalesAnswer(summary("salesWp"), { ...base, metric: "units", productName: "White Paper" }),
      "*Wed 30 Sep 2026*\nWhite Paper\n\nUnits sold: 150 in 2 sales",
    );
  });

  it("names the person when the figures are for one person only", () => {
    assert.equal(
      formatSalesAnswer(summary("salesAmaka"), { ...base, metric: "summary", staffName: "Amaka" }),
      "*Wed 30 Sep 2026*\nSold by Amaka\n\nRevenue: ₦14,000\nSales: 1\nUnits sold: 15",
    );
  });

  it("names both when both filters are used", () => {
    const text = formatSalesAnswer(summary("salesWp"), { ...base, productName: "White Paper", staffName: "Chidi" });
    assert.ok(text.startsWith("*Wed 30 Sep 2026*\nWhite Paper, sold by Chidi\n"));
  });

  it("breaks the figures down by product", () => {
    assert.equal(
      formatSalesAnswer(summary("salesAll"), { ...base, metric: "summary", groupBy: "product" }),
      [
        "*Wed 30 Sep 2026*",
        "",
        "Revenue: ₦134,000",
        "Sales: 3",
        "Units sold: 165",
        "",
        "*By product*",
        "1. White Paper: 150 units, ₦120,000",
        "2. Gold Border: 10 units, ₦9,500",
        "3. Floral: 5 units, ₦4,500",
      ].join("\n"),
    );
  });

  it("breaks the figures down by salesperson", () => {
    assert.equal(
      formatSalesAnswer(summary("salesAll"), { ...base, groupBy: "staff" }),
      [
        "*Wed 30 Sep 2026*",
        "",
        "Revenue: ₦134,000 from 3 sales",
        "",
        "*By salesperson*",
        "Chidi: 2 sales, 150 units, ₦120,000",
        "Amaka: 1 sale, 15 units, ₦14,000",
      ].join("\n"),
    );
  });

  it("says plainly when there were no sales, and still says which days", () => {
    assert.equal(
      formatSalesAnswer(summary("salesEmpty"), { ...base, label: "Yesterday, Sun 4 Oct 2026", groupBy: "product" }),
      "*Yesterday, Sun 4 Oct 2026*\n\nNo sales recorded.",
    );
  });
});

describe("stock answers", () => {
  const level = (over: Partial<StockLevel>): StockLevel => ({
    product_id: "p",
    name: "Gold Border",
    current_stock: 100,
    low_stock_threshold: 50,
    default_price: 1000,
    ...over,
  });

  it("gives stock and price for one product", () => {
    assert.equal(formatStockOne(stockLevels("stockWp")[0]), "White Paper: 253 in stock\nPrice: ₦800 each");
  });

  it("flags a product that is low, including exactly at the alert level", () => {
    assert.equal(
      formatStockOne(level({ current_stock: 28 })),
      "Gold Border: 28 in stock (low, alert at 50)\nPrice: ₦1,000 each",
    );
    assert.ok(formatStockOne(level({ current_stock: 50 })).includes("(low, alert at 50)"));
    assert.ok(!formatStockOne(level({ current_stock: 51 })).includes("low"));
  });

  it("says out of stock at zero, and oversold below zero", () => {
    // Zero is "out of stock" and is not also flagged "low"; below zero is "oversold" with the real size of the gap.
    assert.equal(formatStockOne(level({ current_stock: 0, name: "Ribbon", default_price: 150 })), "Ribbon: out of stock\nPrice: ₦150 each");
    assert.equal(formatStockOne(level({ current_stock: -5 })), "Gold Border: oversold by 5\nPrice: ₦1,000 each");
    assert.equal(formatStockOne(level({ current_stock: -1200 })), "Gold Border: oversold by 1,200\nPrice: ₦1,000 each");
    assert.equal(formatStockOne(level({ current_stock: 1 })), "Gold Border: 1 in stock (low, alert at 50)\nPrice: ₦1,000 each");
  });

  it("says when no price is set", () => {
    assert.ok(formatStockOne(level({ default_price: null })).endsWith("Price: not set"));
  });

  it("lists every product on one screen", () => {
    assert.equal(
      formatStockList(stockLevels()),
      [
        "*Stock*",
        "Brown Paper: 300, ₦700 each",
        "Floral: 56 (low), ₦900 each",
        "Gold Border: 28 (low), ₦1,000 each",
        "Ribbon: 200, ₦150 each",
        "White Paper: 253, ₦800 each",
      ].join("\n"),
    );
  });

  it("cuts a long product list and says how many more", () => {
    const many = Array.from({ length: 12 }, (_, i) => level({ product_id: `p${i}`, name: `Design ${i + 1}` }));
    const lines = formatStockList(many).split("\n");
    assert.equal(lines.length, 12); // heading + ten products + "(+2 more)"
    assert.equal(lines[11], "(+2 more)");
  });

  it("marks a product low from the alert level down, in the full list too", () => {
    const text = formatStockList([
      level({ product_id: "a", name: "At Alert", current_stock: 50 }),
      level({ product_id: "b", name: "Just Above", current_stock: 51 }),
      level({ product_id: "c", name: "Empty", current_stock: 0 }),
    ]);
    assert.ok(text.includes("At Alert: 50 (low), ₦1,000 each"));
    assert.ok(text.includes("Just Above: 51, ₦1,000 each"));
    assert.ok(text.includes("Empty: 0 (low), ₦1,000 each"));
  });

  it("says so when there are no products", () => {
    assert.equal(formatStockList([]), "There are no products yet.");
  });

  it("lists low stock, lowest first as the database sent it", () => {
    assert.equal(
      formatLowStock(parseLowStock(fixture("low")) ?? []),
      "*Low stock*\nGold Border: 28 left (alert at 50)\nFloral: 56 left (alert at 75)",
    );
    assert.equal(formatLowStock([]), "Nothing is low on stock right now.");
  });

  it("lists the restock list with ordered quantities", () => {
    assert.equal(
      formatRestockList(parseRestock(fixture("restock")) ?? []),
      "*Restock list*\nGold Border: pending, 28 left\nFloral: ordered 200, 56 left",
    );
    const noQuantity = parseRestock(fixture("restock")) ?? [];
    noQuantity[1].quantity_ordered = null;
    assert.ok(formatRestockList(noQuantity).includes("Floral: ordered, 56 left"));
    assert.equal(formatRestockList([]), "The restock list is empty.");
  });
});

// ---------- long lists ----------

describe("long lists stop at ten rows", () => {
  // The "(+N more)" line may appear only when something was really left out: not at exactly ten.
  const productRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ product_id: `p${i}`, name: `Design ${i + 1}`, units: 2, revenue: 200 }));
  const staffRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ user_id: `u${i}`, name: `Person ${i + 1}`, transactions: 1, units: 2, revenue: 200 }));
  const lowRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ product_id: `p${i}`, name: `Design ${i + 1}`, current_stock: i, low_stock_threshold: 100 }));
  const restockRows = (n: number): RestockEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      restock_id: `r${i}`,
      product_id: `p${i}`,
      name: `Design ${i + 1}`,
      status: "pending",
      stock_when_flagged: i,
      current_stock: i,
      quantity_ordered: null,
    }));
  const stockRows = (n: number): StockLevel[] =>
    Array.from({ length: n }, (_, i) => ({
      product_id: `p${i}`,
      name: `Design ${i + 1}`,
      current_stock: 500,
      low_stock_threshold: 50,
      default_price: 100,
    }));

  const startingWith = (text: string, prefix: RegExp) => text.split("\n").filter((line) => prefix.test(line)).length;
  const moreLines = (text: string) => text.split("\n").filter((line) => /^\(\+[\d,]+ more\)$/.test(line));

  // [rows given, rows shown, the "more" line expected]
  const cases: Array<[number, number, string | null]> = [
    [1, 1, null],
    [9, 9, null],
    [10, 10, null],
    [11, 10, "(+1 more)"],
    [12, 10, "(+2 more)"],
    [10 + 1234, 10, "(+1,234 more)"],
  ];

  for (const [given, shown, more] of cases) {
    const what = more === null ? "no 'more' line" : `says ${more}`;

    it(`stock list, ${given} products: shows ${shown}, ${what}`, () => {
      const text = formatStockList(stockRows(given));
      assert.equal(startingWith(text, /^Design \d+:/), shown);
      assert.deepEqual(moreLines(text), more === null ? [] : [more]);
    });

    it(`low stock list, ${given} items: shows ${shown}, ${what}`, () => {
      const text = formatLowStock(lowRows(given));
      assert.equal(startingWith(text, /^Design \d+:/), shown);
      assert.deepEqual(moreLines(text), more === null ? [] : [more]);
    });

    it(`restock list, ${given} items: shows ${shown}, ${what}`, () => {
      const text = formatRestockList(restockRows(given));
      assert.equal(startingWith(text, /^Design \d+:/), shown);
      assert.deepEqual(moreLines(text), more === null ? [] : [more]);
    });

    it(`sales answer by product and by person, ${given} rows each: shows ${shown}, ${what}`, () => {
      const s = summary("salesAll");
      s.by_product = productRows(given);
      s.by_staff = staffRows(given);
      const byProduct = formatSalesAnswer(s, { label: "Today", metric: "summary", groupBy: "product", productName: null, staffName: null });
      assert.equal(startingWith(byProduct, /^\d+\. Design \d+:/), shown);
      assert.deepEqual(moreLines(byProduct), more === null ? [] : [more]);
      const byStaff = formatSalesAnswer(s, { label: "Today", metric: "summary", groupBy: "staff", productName: null, staffName: null });
      assert.equal(startingWith(byStaff, /^Person \d+:/), shown);
      assert.deepEqual(moreLines(byStaff), more === null ? [] : [more]);
    });

    it(`daily report, ${given} rows in every section: shows ${shown} of each, ${what}`, () => {
      const r = daily();
      r.day.by_product = productRows(given);
      r.day.by_staff = staffRows(given);
      r.low_stock = lowRows(given);
      r.restock = restockRows(given);
      const text = formatDailyReport(r);
      assert.equal(startingWith(text, /^\d+\. Design \d+:/), shown, "top products");
      assert.equal(startingWith(text, /^Person \d+:/), shown, "salespeople");
      assert.equal(startingWith(text, /^Design \d+:/), shown * 2, "low stock and restock rows");
      // one "more" line for each of the four sections that was cut
      assert.deepEqual(moreLines(text), more === null ? [] : [more, more, more, more]);
    });
  }
});
