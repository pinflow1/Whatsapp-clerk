// Row types matching supabase/migrations/001_core_schema.sql.
// Hand-written because there is no local Supabase CLI. Keep in sync with the schema.
// Money is naira (numeric -> number). Stock is whole units. Dates are ISO strings.

export type UserRole = "staff" | "admin";
export type SaleStatus = "recorded" | "reversed";
export type RestockStatus = "pending" | "ordered" | "received";
export type InventoryTxnType =
  | "initial_stock"
  | "sale"
  | "sale_correction"
  | "sale_reversal"
  | "restock_received"
  | "manual_adjustment";

export interface Settings {
  id: true;
  allow_negative_stock: boolean;
  business_timezone: string;
  updated_at: string;
}

export interface User {
  id: string;
  name: string;
  phone: string; // E.164, e.g. +2348012345678
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  name: string;
  sku: string | null;
  current_stock: number;
  low_stock_threshold: number;
  default_price: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductAlias {
  id: string;
  product_id: string;
  alias: string; // always lowercase, trimmed
  created_at: string;
}

export interface Sale {
  id: string;
  salesperson_id: string;
  total_amount: number;
  original_message: string;
  status: SaleStatus;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaleItem {
  id: string;
  sale_id: string;
  product_id: string;
  product_name: string; // snapshot at time of sale
  quantity: number;
  amount: number; // line total, not unit price
  created_at: string;
  updated_at: string;
}

export interface RestockItem {
  id: string;
  product_id: string;
  status: RestockStatus;
  stock_when_flagged: number;
  quantity_ordered: number | null;
  quantity_received: number | null;
  note: string | null;
  flagged_at: string;
  ordered_at: string | null;
  received_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryTransaction {
  id: string;
  product_id: string;
  type: InventoryTxnType;
  quantity_delta: number; // signed
  stock_before: number;
  stock_after: number;
  sale_id: string | null;
  sale_item_id: string | null;
  restock_item_id: string | null;
  performed_by: string | null; // null = system
  note: string | null;
  created_at: string;
}

export interface AuditLog {
  id: number;
  user_id: string | null; // null = system
  action: string;
  original_message: string | null;
  interpreted_command: unknown | null;
  affected_records: unknown | null;
  before_state: unknown | null;
  after_state: unknown | null;
  created_at: string;
}
