-- =====================================================================
-- WhatsApp Business Clerk — Phase 1: seed data (TEST DATA ONLY)
-- Run after 001_core_schema.sql. Replace the phone numbers with real
-- ones before any real use. Do not run this against live business data.
-- =====================================================================

begin;

-- ---------- Staff ----------------------------------------------------
insert into users (id, name, phone, role) values
  ('a0000000-0000-0000-0000-000000000001', 'Owner', '+2348000000001', 'admin'),
  ('a0000000-0000-0000-0000-000000000002', 'Chidi', '+2348000000002', 'staff'),
  ('a0000000-0000-0000-0000-000000000003', 'Amaka', '+2348000000003', 'staff');

-- ---------- Products -------------------------------------------------
-- Gold Border and Floral start below their thresholds on purpose,
-- so low-stock and restock logic has something to find.
insert into products (id, name, sku, current_stock, low_stock_threshold, default_price) values
  ('b0000000-0000-0000-0000-000000000001', 'White Paper',  'WP-001', 450, 100,  800),
  ('b0000000-0000-0000-0000-000000000002', 'Brown Paper',  'BP-001', 300,  80,  700),
  ('b0000000-0000-0000-0000-000000000003', 'Gold Border',  'GB-001',  38,  50, 1000),
  ('b0000000-0000-0000-0000-000000000004', 'Floral',       'FL-001',  61,  75,  900),
  ('b0000000-0000-0000-0000-000000000005', 'Ribbon',       'RB-001', 200,  40,  150);

-- ---------- Aliases --------------------------------------------------
-- Note: no alias for plain "paper" — it matches two products, and the
-- matcher (Phase 4) must ask the user which one they mean.
insert into product_aliases (product_id, alias) values
  ('b0000000-0000-0000-0000-000000000001', 'wp'),
  ('b0000000-0000-0000-0000-000000000001', 'white papers'),
  ('b0000000-0000-0000-0000-000000000002', 'bp'),
  ('b0000000-0000-0000-0000-000000000003', 'gb'),
  ('b0000000-0000-0000-0000-000000000004', 'floral design');

-- ---------- Opening stock goes in the ledger -------------------------
insert into inventory_transactions
  (product_id, type, quantity_delta, stock_before, stock_after, performed_by, note)
select
  id, 'initial_stock'::inventory_txn_type, current_stock, 0, current_stock,
  'a0000000-0000-0000-0000-000000000001'::uuid, 'Opening stock (seed data)'
from products
where current_stock > 0;

-- ---------- Restock list: anything already low -----------------------
insert into restock_items (product_id, stock_when_flagged, note)
select id, current_stock, 'Flagged at seed time'
from products
where is_active and current_stock <= low_stock_threshold;

-- ---------- Audit trail for the seed itself --------------------------
insert into audit_logs (user_id, action, after_state)
values (
  'a0000000-0000-0000-0000-000000000001',
  'seed_loaded',
  jsonb_build_object('users', 3, 'products', 5)
);

commit;
