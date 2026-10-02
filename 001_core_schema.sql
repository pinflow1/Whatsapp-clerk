-- =====================================================================
-- WhatsApp Business Clerk — Phase 1: core schema
-- Target: Supabase (Postgres 14+). Run once in the SQL Editor.
-- Wrapped in a transaction: if anything fails, nothing is applied.
--
-- Principles
--  * The database is the source of truth. The LLM never writes here.
--  * Money is in naira, numeric(14,2). Stock is whole units (integer).
--  * Nothing important is hard-deleted. Products are archived
--    (is_active = false) so old sales keep pointing at them.
--  * inventory_transactions and audit_logs are append-only.
-- =====================================================================

begin;

-- ---------- Enums ----------------------------------------------------
create type user_role as enum ('staff', 'admin');
create type sale_status as enum ('recorded', 'reversed');
create type restock_status as enum ('pending', 'ordered', 'received');
create type inventory_txn_type as enum (
  'initial_stock',
  'sale',
  'sale_correction',
  'sale_reversal',
  'restock_received',
  'manual_adjustment'
);

-- ---------- Helper functions ----------------------------------------
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create function prevent_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; % is not allowed', tg_table_name, tg_op;
end $$;

-- ---------- settings (exactly one row) -------------------------------
create table settings (
  id boolean primary key default true check (id),
  allow_negative_stock boolean not null default false,
  business_timezone text not null default 'Africa/Lagos',
  updated_at timestamptz not null default now()
);
insert into settings default values;

-- ---------- users (staff + admins, matched by WhatsApp number) -------
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  phone text not null unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  role user_role not null default 'staff',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- products -------------------------------------------------
create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  sku text,
  current_stock integer not null default 0,
  low_stock_threshold integer not null default 0 check (low_stock_threshold >= 0),
  default_price numeric(14,2) check (default_price is null or default_price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_name_active_uidx on products (lower(name)) where is_active;
create unique index products_sku_active_uidx on products (lower(sku)) where sku is not null and is_active;

-- Stock may only go below zero if an admin turns that setting on.
create function enforce_non_negative_stock() returns trigger
language plpgsql as $$
begin
  if new.current_stock < 0
     and not coalesce((select allow_negative_stock from settings limit 1), false) then
    raise exception 'Stock for "%" cannot go below zero (attempted %)', new.name, new.current_stock
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_products_non_negative_stock
  before insert or update of current_stock on products
  for each row execute function enforce_non_negative_stock();

-- Short names the staff actually use ("wp" -> White Paper).
create table product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  alias text not null check (alias = lower(trim(alias)) and length(alias) > 0),
  created_at timestamptz not null default now()
);
create unique index product_aliases_alias_uidx on product_aliases (alias);
create index product_aliases_product_idx on product_aliases (product_id);

-- ---------- sales ----------------------------------------------------
create table sales (
  id uuid primary key default gen_random_uuid(),
  salesperson_id uuid not null references users(id),
  total_amount numeric(14,2) not null check (total_amount >= 0),
  original_message text not null,
  status sale_status not null default 'recorded',
  reversed_at timestamptz,
  reversed_by uuid references users(id),
  reversal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'reversed') = (reversed_at is not null))
);
create index sales_created_idx on sales (created_at desc);
create index sales_person_created_idx on sales (salesperson_id, created_at desc);

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete restrict,
  product_id uuid not null references products(id) on delete restrict,
  product_name text not null,                       -- snapshot at time of sale
  quantity integer not null check (quantity between 1 and 1000000),
  amount numeric(14,2) not null check (amount >= 0), -- line total, not unit price
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_product_idx on sale_items (product_id);

-- ---------- restock list ---------------------------------------------
create table restock_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  status restock_status not null default 'pending',
  stock_when_flagged integer not null,
  quantity_ordered integer check (quantity_ordered is null or quantity_ordered > 0),
  quantity_received integer check (quantity_received is null or quantity_received > 0),
  note text,
  flagged_at timestamptz not null default now(),
  ordered_at timestamptz,
  received_at timestamptz,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A product can only be on the open restock list once.
create unique index restock_one_open_per_product_uidx
  on restock_items (product_id) where status <> 'received';
create index restock_status_idx on restock_items (status);

-- ---------- inventory ledger (append-only) ---------------------------
create table inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  type inventory_txn_type not null,
  quantity_delta integer not null check (quantity_delta <> 0),
  stock_before integer not null,
  stock_after integer not null,
  sale_id uuid references sales(id),
  sale_item_id uuid references sale_items(id),
  restock_item_id uuid references restock_items(id),
  performed_by uuid references users(id),            -- null = system
  note text,
  created_at timestamptz not null default now(),
  check (stock_after = stock_before + quantity_delta)
);
create index inv_txn_product_created_idx on inventory_transactions (product_id, created_at desc);
create index inv_txn_sale_idx on inventory_transactions (sale_id);

create trigger trg_inv_txn_append_only
  before update or delete on inventory_transactions
  for each row execute function prevent_mutation();

-- ---------- audit log (append-only) ----------------------------------
create table audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid references users(id),                 -- null = system
  action text not null,
  original_message text,
  interpreted_command jsonb,
  affected_records jsonb,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index audit_created_idx on audit_logs (created_at desc);
create index audit_user_created_idx on audit_logs (user_id, created_at desc);

create trigger trg_audit_append_only
  before update or delete on audit_logs
  for each row execute function prevent_mutation();

-- ---------- updated_at triggers --------------------------------------
create trigger trg_settings_updated before update on settings
  for each row execute function set_updated_at();
create trigger trg_users_updated before update on users
  for each row execute function set_updated_at();
create trigger trg_products_updated before update on products
  for each row execute function set_updated_at();
create trigger trg_sales_updated before update on sales
  for each row execute function set_updated_at();
create trigger trg_sale_items_updated before update on sale_items
  for each row execute function set_updated_at();
create trigger trg_restock_updated before update on restock_items
  for each row execute function set_updated_at();

-- ---------- helper views ---------------------------------------------
create view v_low_stock as
select id as product_id, name, current_stock, low_stock_threshold
from products
where is_active and current_stock <= low_stock_threshold;

-- Every stock change must be in the ledger. difference <> 0 means a bug.
create view v_stock_reconciliation as
select
  p.id as product_id,
  p.name,
  p.current_stock,
  coalesce(sum(t.quantity_delta), 0)::integer as ledger_stock,
  p.current_stock - coalesce(sum(t.quantity_delta), 0)::integer as difference
from products p
left join inventory_transactions t on t.product_id = p.id
group by p.id, p.name, p.current_stock;

-- ---------- Lock the tables down -------------------------------------
-- Supabase exposes tables to the public API by default. This is real
-- money and stock data, so: RLS on, no policies, no anon/authenticated
-- grants. Only the server (service role key) can touch these tables.
alter table settings enable row level security;
alter table users enable row level security;
alter table products enable row level security;
alter table product_aliases enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table restock_items enable row level security;
alter table inventory_transactions enable row level security;
alter table audit_logs enable row level security;

revoke all on table
  settings, users, products, product_aliases, sales, sale_items,
  restock_items, inventory_transactions, audit_logs,
  v_low_stock, v_stock_reconciliation
from anon, authenticated;

commit;
