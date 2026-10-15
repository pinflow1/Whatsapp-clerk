// Turns report figures into the plain text people read in WhatsApp.
// This is only text-making: every number comes from the database, and nothing here adds up,
// estimates or guesses. WhatsApp shows *like this* as bold.

import type { Grouping, SalesMetric } from "../nlp/interpretation";
import { humanDate } from "./dates";
import type { DailyReport, LowStockItem, RestockEntry, SalesSummary, StockLevel } from "./queries";

/** Longest list we print before saying "+N more". */
const MAX_ROWS = 10;
/** WhatsApp's limit for one text message is 4096 characters; stay clear of it. */
const MAX_CHARS = 3800;

// ---------- numbers ----------

/** 134000 -> "134,000". */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const rounded = Math.round(n);
  const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rounded < 0 ? `-${grouped}` : grouped;
}

/** 134000 -> "₦134,000"; 1234.5 -> "₦1,234.50". */
export function formatNaira(n: number): string {
  if (!Number.isFinite(n)) return "₦?";
  const cents = Math.round(Math.abs(n) * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = fraction === 0 ? grouped : `${grouped}.${String(fraction).padStart(2, "0")}`;
  return `${n < 0 && cents > 0 ? "-" : ""}₦${body}`;
}

/** "+₦102,000", "-₦5,000", or "no change". */
export function signedNaira(diff: number): string {
  const rounded = Math.round(diff * 100) / 100;
  if (rounded === 0) return "no change";
  return `${rounded > 0 ? "+" : "-"}${formatNaira(Math.abs(rounded))}`;
}

/** "+2", "-3", or "no change". */
export function signedCount(diff: number): string {
  if (diff === 0) return "no change";
  return `${diff > 0 ? "+" : "-"}${formatNumber(Math.abs(diff))}`;
}

/** 1 -> "1 sale", 3 -> "3 sales". */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** ["a", "b", "c"] -> "a, b or c". */
export function orList(names: string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

// ---------- layout helpers ----------

/** One line per item, cut off after `limit` with a "+N more" line. */
function rows<T>(items: T[], line: (item: T, index: number) => string, limit = MAX_ROWS): string[] {
  const out = items.slice(0, limit).map(line);
  if (items.length > limit) out.push(`(+${formatNumber(items.length - limit)} more)`);
  return out;
}

const join = (blocks: string[][]): string => blocks.map((b) => b.join("\n")).join("\n\n");

/** Never longer than one WhatsApp message: cuts at a line break and says so. */
export function clipMessage(message: string, max = MAX_CHARS): string {
  if (message.length <= max) return message;
  const note = "\n(message shortened)";
  let out = "";
  for (const line of message.split("\n")) {
    const next = out === "" ? line : `${out}\n${line}`;
    if (next.length + note.length > max) break;
    out = next;
  }
  if (out === "") out = message.slice(0, Math.max(0, max - note.length));
  return `${out}${note}`;
}

// ---------- lines shared by several messages ----------

const productLine = (p: { name: string; units: number; revenue: number }, i: number) =>
  `${i + 1}. ${p.name}: ${count(p.units, "unit")}, ${formatNaira(p.revenue)}`;

const staffLine = (s: { name: string; transactions: number; units: number; revenue: number }) =>
  `${s.name}: ${count(s.transactions, "sale")}, ${count(s.units, "unit")}, ${formatNaira(s.revenue)}`;

const lowStockLine = (p: LowStockItem) =>
  `${p.name}: ${formatNumber(p.current_stock)} left (alert at ${formatNumber(p.low_stock_threshold)})`;

const restockLine = (r: RestockEntry) => {
  const state =
    r.status === "ordered"
      ? `ordered${r.quantity_ordered === null ? "" : ` ${formatNumber(r.quantity_ordered)}`}`
      : "pending";
  return `${r.name}: ${state}, ${formatNumber(r.current_stock)} left`;
};

// ---------- the daily report ----------

/** The owner's end-of-day message. The comparison is plain figures: no judgement, no percentages. */
export function formatDailyReport(r: DailyReport): string {
  const d = r.day;
  const p = r.previous_day;
  const blocks: string[][] = [[`*Daily report: ${humanDate(r.date)}*`]];

  if (d.transactions === 0) {
    blocks.push(["No sales were recorded."]);
  } else {
    blocks.push([
      `Revenue: ${formatNaira(d.revenue)}`,
      `Sales: ${formatNumber(d.transactions)} (${count(d.units, "unit")})`,
    ]);
    blocks.push(["*Top products*", ...rows(d.by_product, productLine)]);
    blocks.push(["*By salesperson*", ...rows(d.by_staff, staffLine)]);
  }

  blocks.push([
    `*Compared with ${humanDate(p.date, false)}*`,
    `Revenue: ${signedNaira(d.revenue - p.revenue)} (${formatNaira(d.revenue)} vs ${formatNaira(p.revenue)})`,
    `Sales: ${signedCount(d.transactions - p.transactions)} (${formatNumber(d.transactions)} vs ${formatNumber(p.transactions)})`,
    `Units: ${signedCount(d.units - p.units)} (${formatNumber(d.units)} vs ${formatNumber(p.units)})`,
  ]);

  blocks.push(["*Low stock*", ...(r.low_stock.length === 0 ? ["Nothing is low."] : rows(r.low_stock, lowStockLine))]);
  blocks.push([
    "*Restock list*",
    ...(r.restock.length === 0 ? ["The list is empty."] : rows(r.restock, restockLine)),
  ]);

  return clipMessage(join(blocks));
}

// ---------- answers to questions ----------

export interface SalesAnswerOptions {
  /** Which days were used: "Today, Wed 14 Oct 2026". Always shown. */
  label: string;
  metric: SalesMetric;
  groupBy: Grouping;
  /** Filters that were applied, shown so a filtered figure is never mistaken for the shop's total. */
  productName: string | null;
  staffName: string | null;
}

function headline(s: SalesSummary, metric: SalesMetric): string[] {
  switch (metric) {
    case "revenue":
      return [`Revenue: ${formatNaira(s.revenue)} from ${count(s.transactions, "sale")}`];
    case "units":
      return [`Units sold: ${formatNumber(s.units)} in ${count(s.transactions, "sale")}`];
    case "transactions":
      return [`Sales recorded: ${formatNumber(s.transactions)}`];
    case "summary":
      return [
        `Revenue: ${formatNaira(s.revenue)}`,
        `Sales: ${formatNumber(s.transactions)}`,
        `Units sold: ${formatNumber(s.units)}`,
      ];
  }
}

export function formatSalesAnswer(s: SalesSummary, o: SalesAnswerOptions): string {
  const top = [`*${o.label}*`];
  if (o.productName !== null && o.staffName !== null) top.push(`${o.productName}, sold by ${o.staffName}`);
  else if (o.productName !== null) top.push(o.productName);
  else if (o.staffName !== null) top.push(`Sold by ${o.staffName}`);

  const blocks: string[][] = [top];
  if (s.transactions === 0) {
    blocks.push(["No sales recorded."]);
    return clipMessage(join(blocks));
  }

  blocks.push(headline(s, o.metric));
  if (o.groupBy === "product") blocks.push(["*By product*", ...rows(s.by_product, productLine)]);
  if (o.groupBy === "staff") blocks.push(["*By salesperson*", ...rows(s.by_staff, staffLine)]);
  return clipMessage(join(blocks));
}

const priceText = (price: number | null) => (price === null ? "not set" : `${formatNaira(price)} each`);

/** One product: how many are left and what one costs. */
export function formatStockOne(p: StockLevel): string {
  let stock: string;
  if (p.current_stock < 0) stock = `oversold by ${formatNumber(-p.current_stock)}`;
  else if (p.current_stock === 0) stock = "out of stock";
  else stock = `${formatNumber(p.current_stock)} in stock`;
  const low =
    p.current_stock > 0 && p.current_stock <= p.low_stock_threshold
      ? ` (low, alert at ${formatNumber(p.low_stock_threshold)})`
      : "";
  return `${p.name}: ${stock}${low}\nPrice: ${priceText(p.default_price)}`;
}

/** Every product on one list, for "what do we have?". */
export function formatStockList(levels: StockLevel[]): string {
  if (levels.length === 0) return "There are no products yet.";
  const lines = rows(levels, (p) => {
    const low = p.current_stock <= p.low_stock_threshold ? " (low)" : "";
    return `${p.name}: ${formatNumber(p.current_stock)}${low}, ${priceText(p.default_price)}`;
  });
  return clipMessage(["*Stock*", ...lines].join("\n"));
}

export function formatLowStock(items: LowStockItem[]): string {
  if (items.length === 0) return "Nothing is low on stock right now.";
  return clipMessage(["*Low stock*", ...rows(items, lowStockLine)].join("\n"));
}

export function formatRestockList(items: RestockEntry[]): string {
  if (items.length === 0) return "The restock list is empty.";
  return clipMessage(["*Restock list*", ...rows(items, restockLine)].join("\n"));
  }
                                                                                                  
