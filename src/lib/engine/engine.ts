// The only code that is allowed to change money or stock.
// Everything here calls a Postgres function; nothing writes tables directly.
// SERVER ONLY: uses the service role key. Never import this from browser code.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AdjustStockData,
  CorrectSaleItemData,
  EngineResult,
  RecordSaleData,
  ReverseSaleData,
} from "./types";
import type { Sale, SaleItem } from "../db/types";

let cached: SupabaseClient | null = null;

/** Service-role client. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. */
export function getServiceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

async function callEngine<T>(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<EngineResult<T>> {
  try {
    const { data, error } = await db.rpc(fn, args);
    if (error) {
      return {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: error.message, details: { pgCode: error.code } },
      };
    }
    return data as EngineResult<T>;
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : "Unknown error",
        details: {},
      },
    };
  }
}

export interface SaleItemInput {
  productId: string;
  quantity: number;
  /** Line total in naira, not unit price. */
  amount: number;
}

export function recordSale(
  db: SupabaseClient,
  input: {
    salespersonId: string;
    originalMessage: string;
    items: SaleItemInput[];
    interpretedCommand?: unknown;
  },
) {
  return callEngine<RecordSaleData>(db, "record_sale", {
    p_salesperson_id: input.salespersonId,
    p_original_message: input.originalMessage,
    p_items: input.items.map((i) => ({
      product_id: i.productId,
      quantity: i.quantity,
      amount: i.amount,
    })),
    p_interpreted_command: input.interpretedCommand ?? null,
  });
}

export function correctSaleItem(
  db: SupabaseClient,
  input: {
    saleItemId: string;
    userId: string;
    newQuantity?: number;
    newAmount?: number;
    originalMessage?: string;
    interpretedCommand?: unknown;
  },
) {
  return callEngine<CorrectSaleItemData>(db, "correct_sale_item", {
    p_sale_item_id: input.saleItemId,
    p_user_id: input.userId,
    p_new_quantity: input.newQuantity ?? null,
    p_new_amount: input.newAmount ?? null,
    p_original_message: input.originalMessage ?? null,
    p_interpreted_command: input.interpretedCommand ?? null,
  });
}

export function reverseSale(
  db: SupabaseClient,
  input: {
    saleId: string;
    userId: string;
    reason?: string;
    originalMessage?: string;
    interpretedCommand?: unknown;
  },
) {
  return callEngine<ReverseSaleData>(db, "reverse_sale", {
    p_sale_id: input.saleId,
    p_user_id: input.userId,
    p_reason: input.reason ?? null,
    p_original_message: input.originalMessage ?? null,
    p_interpreted_command: input.interpretedCommand ?? null,
  });
}

export function adjustStock(
  db: SupabaseClient,
  input: {
    productId: string;
    delta: number;
    userId: string;
    note: string;
    originalMessage?: string;
    interpretedCommand?: unknown;
  },
) {
  return callEngine<AdjustStockData>(db, "adjust_stock", {
    p_product_id: input.productId,
    p_delta: input.delta,
    p_user_id: input.userId,
    p_note: input.note,
    p_original_message: input.originalMessage ?? null,
    p_interpreted_command: input.interpretedCommand ?? null,
  });
}

export type SaleWithItems = Sale & { sale_items: SaleItem[] };

/**
 * A person's most recent live (not reversed) sales, newest first.
 * Used to resolve "undo my last sale" and "actually make the last one 30".
 */
export async function getRecentSales(
  db: SupabaseClient,
  salespersonId: string,
  limit = 5,
): Promise<SaleWithItems[]> {
  const { data, error } = await db
    .from("sales")
    .select("*, sale_items(*)")
    .eq("salesperson_id", salespersonId)
    .eq("status", "recorded")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as SaleWithItems[];
}
