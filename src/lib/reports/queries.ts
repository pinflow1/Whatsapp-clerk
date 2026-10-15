// Reads the report figures from the database and checks their shape before anyone is shown them.
// The database does all the counting (see supabase/migrations/003_reports.sql); this file
// never adds anything up. If the database ever sends back something unexpected, the result is
// an error, not a half-readable report.
// SERVER ONLY: it uses the service-role client. Never import this from browser code.

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------- shapes (they mirror the JSON the SQL functions return) ----------

export interface ProductSales {
  product_id: string;
  name: string;
  units: number;
  revenue: number;
}

export interface StaffSales {
  user_id: string;
  name: string;
  transactions: number;
  units: number;
  revenue: number;
}

export interface SalesSummary {
  /** First day included (YYYY-MM-DD). */
  from: string;
  /** First day NOT included. */
  to: string;
  revenue: number;
  transactions: number;
  units: number;
  by_product: ProductSales[];
  by_staff: StaffSales[];
}

export interface StockLevel {
  product_id: string;
  name: string;
  current_stock: number;
  low_stock_threshold: number;
  /** Price of one piece, in naira. null = no price set. */
  default_price: number | null;
}

export interface LowStockItem {
  product_id: string;
  name: string;
  current_stock: number;
  low_stock_threshold: number;
}

export interface RestockEntry {
  restock_id: string;
  product_id: string;
  name: string;
  status: "pending" | "ordered";
  stock_when_flagged: number;
  current_stock: number;
  quantity_ordered: number | null;
}

export interface DayFigures {
  date: string;
  revenue: number;
  transactions: number;
  units: number;
}

export interface DailyReport {
  date: string;
  timezone: string;
  day: SalesSummary;
  previous_day: DayFigures;
  low_stock: LowStockItem[];
  restock: RestockEntry[];
}

export interface ReportError {
  code: string;
  message: string;
}

export type ReportResult<T> = { ok: true; data: T } | { ok: false; error: ReportError };

// ---------- checking the database's reply ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const money = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Every entry must be readable. One bad entry rejects the whole list: a partly wrong report is worse than none. */
function listOf<T>(v: unknown, one: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const parsed = one(x);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function productSales(x: unknown): ProductSales | null {
  if (!isObj(x)) return null;
  const product_id = text(x.product_id);
  const name = text(x.name);
  const units = whole(x.units);
  const revenue = money(x.revenue);
  if (product_id === null || name === null || units === null || revenue === null) return null;
  return { product_id, name, units, revenue };
}

function staffSales(x: unknown): StaffSales | null {
  if (!isObj(x)) return null;
  const user_id = text(x.user_id);
  const name = text(x.name);
  const transactions = whole(x.transactions);
  const units = whole(x.units);
  const revenue = money(x.revenue);
  if (user_id === null || name === null || transactions === null || units === null || revenue === null) return null;
  return { user_id, name, transactions, units, revenue };
}

function stockLevel(x: unknown): StockLevel | null {
  if (!isObj(x)) return null;
  const product_id = text(x.product_id);
  const name = text(x.name);
  const current_stock = whole(x.current_stock);
  const low_stock_threshold = whole(x.low_stock_threshold);
  const default_price = x.default_price === null ? null : money(x.default_price);
  if (product_id === null || name === null || current_stock === null || low_stock_threshold === null) return null;
  if (x.default_price !== null && default_price === null) return null;
  return { product_id, name, current_stock, low_stock_threshold, default_price };
}

function lowStockItem(x: unknown): LowStockItem | null {
  if (!isObj(x)) return null;
  const product_id = text(x.product_id);
  const name = text(x.name);
  const current_stock = whole(x.current_stock);
  const low_stock_threshold = whole(x.low_stock_threshold);
  if (product_id === null || name === null || current_stock === null || low_stock_threshold === null) return null;
  return { product_id, name, current_stock, low_stock_threshold };
}

function restockEntry(x: unknown): RestockEntry | null {
  if (!isObj(x)) return null;
  const restock_id = text(x.restock_id);
  const product_id = text(x.product_id);
  const name = text(x.name);
  const status = x.status === "pending" || x.status === "ordered" ? x.status : null;
  const stock_when_flagged = whole(x.stock_when_flagged);
  const current_stock = whole(x.current_stock);
  const quantity_ordered = x.quantity_ordered === null ? null : whole(x.quantity_ordered);
  if (
    restock_id === null ||
    product_id === null ||
    name === null ||
    status === null ||
    stock_when_flagged === null ||
    current_stock === null
  ) {
    return null;
  }
  if (x.quantity_ordered !== null && quantity_ordered === null) return null;
  return { restock_id, product_id, name, status, stock_when_flagged, current_stock, quantity_ordered };
}

function dayFigures(x: unknown): DayFigures | null {
  if (!isObj(x)) return null;
  const date = text(x.date);
  const revenue = money(x.revenue);
  const transactions = whole(x.transactions);
  const units = whole(x.units);
  if (date === null || revenue === null || transactions === null || units === null) return null;
  return { date, revenue, transactions, units };
}

export function parseSalesSummary(raw: unknown): SalesSummary | null {
  if (!isObj(raw) || raw.ok !== true) return null;
  const from = text(raw.from);
  const to = text(raw.to);
  const revenue = money(raw.revenue);
  const transactions = whole(raw.transactions);
  const units = whole(raw.units);
  const by_product = listOf(raw.by_product, productSales);
  const by_staff = listOf(raw.by_staff, staffSales);
  if (
    from === null ||
    to === null ||
    revenue === null ||
    transactions === null ||
    units === null ||
    by_product === null ||
    by_staff === null
  ) {
    return null;
  }
  return { from, to, revenue, transactions, units, by_product, by_staff };
}

export const parseStockLevels = (raw: unknown): StockLevel[] | null => listOf(raw, stockLevel);
export const parseLowStock = (raw: unknown): LowStockItem[] | null => listOf(raw, lowStockItem);
export const parseRestock = (raw: unknown): RestockEntry[] | null => listOf(raw, restockEntry);

export function parseDailyReport(raw: unknown): DailyReport | null {
  if (!isObj(raw) || raw.ok !== true) return null;
  const date = text(raw.date);
  const timezone = text(raw.timezone);
  const day = parseSalesSummary(raw.day);
  const previous_day = dayFigures(raw.previous_day);
  const low_stock = parseLowStock(raw.low_stock);
  const restock = parseRestock(raw.restock);
  if (
    date === null ||
    timezone === null ||
    day === null ||
    previous_day === null ||
    low_stock === null ||
    restock === null
  ) {
    return null;
  }
  return { date, timezone, day, previous_day, low_stock, restock };
}

// ---------- calling the database ----------

async function call(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<ReportResult<unknown>> {
  try {
    const { data, error } = await db.rpc(fn, args);
    if (error) return { ok: false, error: { code: "DB_ERROR", message: error.message } };
    if (isObj(data) && data.ok === false) {
      const e = isObj(data.error) ? data.error : {};
      return {
        ok: false,
        error: { code: text(e.code) ?? "DB_ERROR", message: text(e.message) ?? "The database refused the request" },
      };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: { code: "DB_ERROR", message: e instanceof Error ? e.message : "Unknown error" } };
  }
}

const unreadable = (what: string): { ok: false; error: ReportError } => ({
  ok: false,
  error: { code: "BAD_REPLY", message: `The database sent back a ${what} that could not be read` },
});

/** Sales for [from, to). Optionally only one product and/or one salesperson. */
export async function getSalesSummary(
  db: SupabaseClient,
  q: { from: string; to: string; productId?: string | null; staffId?: string | null },
): Promise<ReportResult<SalesSummary>> {
  const r = await call(db, "sales_summary", {
    p_from: q.from,
    p_to: q.to,
    p_product_id: q.productId ?? null,
    p_staff_id: q.staffId ?? null,
  });
  if (!r.ok) return r;
  const data = parseSalesSummary(r.data);
  return data === null ? unreadable("sales summary") : { ok: true, data };
}

/** Stock for every active product, or just one. */
export async function getStockLevels(db: SupabaseClient, productId?: string | null): Promise<ReportResult<StockLevel[]>> {
  const r = await call(db, "stock_levels", { p_product_id: productId ?? null });
  if (!r.ok) return r;
  const data = parseStockLevels(r.data);
  return data === null ? unreadable("stock list") : { ok: true, data };
}

/** Products at or below their low-stock level, lowest first. */
export async function getLowStock(db: SupabaseClient): Promise<ReportResult<LowStockItem[]>> {
  const r = await call(db, "low_stock_list", {});
  if (!r.ok) return r;
  const data = parseLowStock(r.data);
  return data === null ? unreadable("low-stock list") : { ok: true, data };
}

/** The open restock list (pending or ordered). */
export async function getRestockList(db: SupabaseClient): Promise<ReportResult<RestockEntry[]>> {
  const r = await call(db, "restock_list", {});
  if (!r.ok) return r;
  const data = parseRestock(r.data);
  return data === null ? unreadable("restock list") : { ok: true, data };
}

/** One local day, the day before it, and the stock position now. `date` is YYYY-MM-DD. */
export async function getDailyReport(db: SupabaseClient, date: string): Promise<ReportResult<DailyReport>> {
  const r = await call(db, "daily_report", { p_date: date });
  if (!r.ok) return r;
  const data = parseDailyReport(r.data);
  return data === null ? unreadable("daily report") : { ok: true, data };
}
