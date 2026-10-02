// Shapes returned by the Postgres engine functions in
// supabase/migrations/002_engine_functions.sql.
// Money is naira (number). Stock is whole units.

export type EngineErrorCode =
  | "INVALID_INPUT"
  | "INVALID_QUANTITY"
  | "INVALID_AMOUNT"
  | "PRODUCT_NOT_FOUND"
  | "INSUFFICIENT_STOCK"
  | "USER_NOT_FOUND"
  | "SALE_NOT_FOUND"
  | "SALE_ALREADY_REVERSED"
  | "NO_CHANGE"
  | "INTERNAL_ERROR"; // anything unexpected (network, database fault)

export interface EngineError {
  code: EngineErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export type EngineResult<T> = ({ ok: true } & T) | { ok: false; error: EngineError };

export interface LowStockNotice {
  product_id: string;
  product_name: string;
  remaining_stock: number;
  low_stock_threshold: number;
  newly_flagged: boolean; // false = it was already on the restock list
}

export interface SoldItem {
  sale_item_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  amount: number;
  remaining_stock: number;
}

export interface RecordSaleData {
  sale_id: string;
  total_amount: number;
  items: SoldItem[];
  low_stock: LowStockNotice[];
}

export interface CorrectSaleItemData {
  sale_id: string;
  sale_item_id: string;
  product_id: string;
  product_name: string;
  old_quantity: number;
  new_quantity: number;
  old_amount: number;
  new_amount: number;
  sale_total: number;
  remaining_stock: number;
  /** True when only the quantity changed: the amount was left as-is, so ask the user. */
  needs_amount_review: boolean;
  low_stock: LowStockNotice[];
}

export interface ReverseSaleData {
  sale_id: string;
  total_amount: number;
  restored: Array<{
    product_id: string;
    product_name: string;
    quantity: number;
    stock_before: number;
    stock_after: number;
  }>;
}

export interface AdjustStockData {
  product_id: string;
  product_name: string;
  stock_before: number;
  stock_after: number;
  low_stock: LowStockNotice[];
}
