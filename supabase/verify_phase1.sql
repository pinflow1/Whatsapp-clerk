-- =====================================================================
-- Phase 1 checks. Run after 001_core_schema.sql and seed.sql.
-- Any failure aborts with a message starting "FAIL:".
-- If you see the "all checks passed" row at the end, Phase 1 is good.
-- Every check rolls itself back, so no data is changed.
-- =====================================================================

-- 1. Seed loaded and ledger matches stock
do $$
begin
  if (select count(*) from products) <> 5 then
    raise exception 'FAIL: expected 5 seeded products';
  end if;
  if exists (select 1 from v_stock_reconciliation where difference <> 0) then
    raise exception 'FAIL: stock does not match inventory ledger';
  end if;
  if (select count(*) from v_low_stock) <> 2 then
    raise exception 'FAIL: expected exactly 2 low-stock products (Gold Border, Floral)';
  end if;
  if (select count(*) from restock_items where status = 'pending') <> 2 then
    raise exception 'FAIL: expected 2 pending restock items';
  end if;
end $$;

-- 2. Stock cannot go negative
do $$
declare blocked boolean := false;
begin
  begin
    update products set current_stock = -5 where name = 'White Paper';
  exception when others then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: negative stock was allowed'; end if;
end $$;

-- 3. Same product cannot be on the open restock list twice
do $$
declare blocked boolean := false;
begin
  begin
    insert into restock_items (product_id, stock_when_flagged)
    values ('b0000000-0000-0000-0000-000000000003', 38);
  exception when unique_violation then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: duplicate open restock item allowed'; end if;
end $$;

-- 4. Zero quantity sale item is rejected
do $$
declare blocked boolean := false;
begin
  begin
    insert into sales (id, salesperson_id, total_amount, original_message)
    values ('c0000000-0000-0000-0000-000000000001',
            'a0000000-0000-0000-0000-000000000002', 0, 'test');
    insert into sale_items (sale_id, product_id, product_name, quantity, amount)
    values ('c0000000-0000-0000-0000-000000000001',
            'b0000000-0000-0000-0000-000000000001', 'White Paper', 0, 0);
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: zero-quantity sale item allowed'; end if;
end $$;

-- 5. A sale cannot be marked reversed without a reversal time
do $$
declare blocked boolean := false;
begin
  begin
    insert into sales (salesperson_id, total_amount, original_message, status)
    values ('a0000000-0000-0000-0000-000000000002', 100, 'test', 'reversed');
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: reversed sale without reversed_at allowed'; end if;
end $$;

-- 6. Ledger and audit log are append-only
do $$
declare blocked boolean := false;
begin
  begin
    update inventory_transactions set note = 'tampered';
  exception when others then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: inventory ledger was editable'; end if;

  blocked := false;
  begin
    delete from audit_logs;
  exception when others then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: audit log was deletable'; end if;
end $$;

-- 7. Bad phone number format is rejected
do $$
declare blocked boolean := false;
begin
  begin
    insert into users (name, phone) values ('Bad Phone', '08012345678');
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then raise exception 'FAIL: invalid phone format allowed'; end if;
end $$;

select 'all checks passed' as result;
