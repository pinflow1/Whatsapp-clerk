-- =====================================================================
-- Phase 2 engine tests.
-- Run after 001, seed.sql and 002. Safe to re-run: everything the tests
-- do is rolled back at the end. Any failure aborts with "FAIL: ...".
-- Seeing the "all phase 2 checks passed" row means the engine works.
-- =====================================================================

do $$
declare
  v_owner constant uuid := 'a0000000-0000-0000-0000-000000000001';
  v_chidi constant uuid := 'a0000000-0000-0000-0000-000000000002';
  v_amaka constant uuid := 'a0000000-0000-0000-0000-000000000003';
  v_wp    constant uuid := 'b0000000-0000-0000-0000-000000000001';
  v_bp    constant uuid := 'b0000000-0000-0000-0000-000000000002';
  v_gb    constant uuid := 'b0000000-0000-0000-0000-000000000003';
  res jsonb;
  v_case record;
  v_sale1 uuid;
  v_sale2 uuid;
  v_item1 uuid;
  v_item2 uuid;
  v_n integer;
  v_stock integer;
  v_sales_before integer;
begin
  begin  -- everything below is rolled back by the sentinel at the end

    -- ===== T1: single-item sale =====================================
    res := record_sale(v_chidi, 'Sold 100 white paper for 80k',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 100, 'amount', 80000)));
    if (res->>'ok')::boolean is not true then
      raise exception 'FAIL: T1 sale was not recorded: %', res;
    end if;
    v_sale1 := (res->>'sale_id')::uuid;
    select current_stock into v_stock from products where id = v_wp;
    if v_stock <> 350 then raise exception 'FAIL: T1 stock should be 350, got %', v_stock; end if;
    if (res->>'total_amount')::numeric <> 80000 then
      raise exception 'FAIL: T1 total should be 80000, got %', res->>'total_amount';
    end if;
    select count(*) into v_n from inventory_transactions
      where sale_id = v_sale1 and type = 'sale' and quantity_delta = -100
        and stock_before = 450 and stock_after = 350 and performed_by = v_chidi;
    if v_n <> 1 then raise exception 'FAIL: T1 ledger row missing or wrong'; end if;
    select count(*) into v_n from audit_logs
      where action = 'sale_recorded' and (affected_records->>'sale_id')::uuid = v_sale1
        and original_message = 'Sold 100 white paper for 80k' and user_id = v_chidi;
    if v_n <> 1 then raise exception 'FAIL: T1 audit row missing or wrong'; end if;
    select count(*) into v_n from v_stock_reconciliation where difference <> 0;
    if v_n <> 0 then raise exception 'FAIL: T1 stock no longer matches ledger'; end if;

    -- ===== T2: two items in one sale; low stock already on list ======
    res := record_sale(v_chidi, 'Sold 50 white paper 40k and 20 gold border 18k',
      jsonb_build_array(
        jsonb_build_object('product_id', v_wp, 'quantity', 50, 'amount', 40000),
        jsonb_build_object('product_id', v_gb, 'quantity', 20, 'amount', 18000)));
    if (res->>'ok')::boolean is not true then
      raise exception 'FAIL: T2 sale was not recorded: %', res;
    end if;
    v_sale2 := (res->>'sale_id')::uuid;
    if (res->>'total_amount')::numeric <> 58000 then
      raise exception 'FAIL: T2 total should be 58000, got %', res->>'total_amount';
    end if;
    select current_stock into v_stock from products where id = v_wp;
    if v_stock <> 300 then raise exception 'FAIL: T2 white paper should be 300, got %', v_stock; end if;
    select current_stock into v_stock from products where id = v_gb;
    if v_stock <> 18 then raise exception 'FAIL: T2 gold border should be 18, got %', v_stock; end if;
    if jsonb_array_length(res->'low_stock') <> 1
       or res->'low_stock'->0->>'product_name' <> 'Gold Border'
       or (res->'low_stock'->0->>'newly_flagged')::boolean is not false then
      raise exception 'FAIL: T2 low_stock report wrong: %', res->'low_stock';
    end if;
    select count(*) into v_n from restock_items where product_id = v_gb and status <> 'received';
    if v_n <> 1 then raise exception 'FAIL: T2 gold border should be on the restock list once, got %', v_n; end if;

    -- ===== T3: not enough stock is refused and changes nothing =======
    select count(*) into v_sales_before from sales;
    res := record_sale(v_chidi, 'Sold 99999 white paper',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 99999, 'amount', 1)));
    if res->'error'->>'code' is distinct from 'INSUFFICIENT_STOCK' then
      raise exception 'FAIL: T3 expected INSUFFICIENT_STOCK, got %', res;
    end if;
    select count(*) into v_n from sales;
    if v_n <> v_sales_before then raise exception 'FAIL: T3 a sale was created despite the refusal'; end if;
    select current_stock into v_stock from products where id = v_wp;
    if v_stock <> 300 then raise exception 'FAIL: T3 stock changed to %', v_stock; end if;

    -- ===== T4: same product twice is checked on the combined total ===
    res := record_sale(v_chidi, 'two lines same product',
      jsonb_build_array(
        jsonb_build_object('product_id', v_wp, 'quantity', 200, 'amount', 10),
        jsonb_build_object('product_id', v_wp, 'quantity', 200, 'amount', 10)));
    if res->'error'->>'code' is distinct from 'INSUFFICIENT_STOCK' then
      raise exception 'FAIL: T4 expected INSUFFICIENT_STOCK, got %', res;
    end if;

    -- ===== T5: malformed, zero, negative, huge, missing inputs =======
    select count(*) into v_sales_before from sales;
    for v_case in
      select * from (values
        ('zero quantity',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 0, 'amount', 100)),
          'INVALID_QUANTITY'),
        ('negative quantity',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', -5, 'amount', 100)),
          'INVALID_QUANTITY'),
        ('fractional quantity',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 2.5, 'amount', 100)),
          'INVALID_QUANTITY'),
        ('quantity as text',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', '100', 'amount', 100)),
          'INVALID_QUANTITY'),
        ('missing quantity ("I sold some paper")',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'amount', 100)),
          'INVALID_QUANTITY'),
        ('absurdly large quantity',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1000000000, 'amount', 100)),
          'INVALID_QUANTITY'),
        ('negative amount',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1, 'amount', -1)),
          'INVALID_AMOUNT'),
        ('missing amount',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1)),
          'INVALID_AMOUNT'),
        ('too many decimals',
          jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1, 'amount', 100.123)),
          'INVALID_AMOUNT'),
        ('unknown product',
          jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-0000-0000-00000000dead', 'quantity', 1, 'amount', 100)),
          'PRODUCT_NOT_FOUND'),
        ('malformed product id',
          jsonb_build_array(jsonb_build_object('product_id', 'not-a-uuid', 'quantity', 1, 'amount', 100)),
          'INVALID_INPUT'),
        ('empty item list', '[]'::jsonb, 'INVALID_INPUT'),
        ('items not an array', '{}'::jsonb, 'INVALID_INPUT'),
        ('items null', null::jsonb, 'INVALID_INPUT')
      ) as t(label, items, expected)
    loop
      res := record_sale(v_chidi, 'test message', v_case.items);
      if res->'error'->>'code' is distinct from v_case.expected then
        raise exception 'FAIL: T5 "%" expected %, got %', v_case.label, v_case.expected, res;
      end if;
    end loop;

    res := record_sale(v_chidi, '   ',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1, 'amount', 100)));
    if res->'error'->>'code' is distinct from 'INVALID_INPUT' then
      raise exception 'FAIL: T5 blank message should be refused, got %', res;
    end if;

    res := record_sale('00000000-0000-0000-0000-00000000beef', 'test',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1, 'amount', 100)));
    if res->'error'->>'code' is distinct from 'USER_NOT_FOUND' then
      raise exception 'FAIL: T5 unknown user should be refused, got %', res;
    end if;

    update users set is_active = false where id = v_amaka;
    res := record_sale(v_amaka, 'test',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1, 'amount', 100)));
    if res->'error'->>'code' is distinct from 'USER_NOT_FOUND' then
      raise exception 'FAIL: T5 inactive user should be refused, got %', res;
    end if;

    res := record_sale(v_chidi, 'a million white paper',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1000000, 'amount', 100)));
    if res->'error'->>'code' is distinct from 'INSUFFICIENT_STOCK' then
      raise exception 'FAIL: T5 1,000,000 units should hit INSUFFICIENT_STOCK, got %', res;
    end if;

    select count(*) into v_n from sales;
    if v_n <> v_sales_before then raise exception 'FAIL: T5 a refused sale left a row behind'; end if;

    -- ===== T6: corrections ==========================================
    select id into v_item1 from sale_items where sale_id = v_sale1;

    -- quantity only: 100 -> 80
    res := correct_sale_item(v_item1, v_chidi, 80, null,
      'Actually that was 80 white paper, not 100');
    if (res->>'ok')::boolean is not true then raise exception 'FAIL: T6 correction refused: %', res; end if;
    select current_stock into v_stock from products where id = v_wp;
    if v_stock <> 320 then raise exception 'FAIL: T6 stock should be 320, got %', v_stock; end if;
    if (res->>'needs_amount_review')::boolean is not true then
      raise exception 'FAIL: T6 quantity-only correction should flag needs_amount_review';
    end if;
    if (res->>'sale_total')::numeric <> 80000 then
      raise exception 'FAIL: T6 amount must not change on its own, got %', res->>'sale_total';
    end if;
    select count(*) into v_n from inventory_transactions
      where sale_id = v_sale1 and type = 'sale_correction' and quantity_delta = 20;
    if v_n <> 1 then raise exception 'FAIL: T6 correction ledger row missing'; end if;
    select count(*) into v_n from sales where salesperson_id = v_chidi and status = 'recorded' and id = v_sale1;
    if v_n <> 1 then raise exception 'FAIL: T6 correction must edit the sale, not replace it'; end if;

    -- amount only: 80000 -> 64000, stock untouched
    res := correct_sale_item(v_item1, v_chidi, null, 64000);
    if (res->>'ok')::boolean is not true then raise exception 'FAIL: T6 amount correction refused: %', res; end if;
    select current_stock into v_stock from products where id = v_wp;
    if v_stock <> 320 then raise exception 'FAIL: T6 amount-only correction changed stock to %', v_stock; end if;
    if (res->>'sale_total')::numeric <> 64000 then
      raise exception 'FAIL: T6 sale total should be 64000, got %', res->>'sale_total';
    end if;
    select count(*) into v_n from inventory_transactions
      where sale_id = v_sale1 and type = 'sale_correction';
    if v_n <> 1 then raise exception 'FAIL: T6 amount-only correction must not write a stock ledger row'; end if;

    -- refusals
    res := correct_sale_item(v_item1, v_chidi, 80, 64000);
    if res->'error'->>'code' is distinct from 'NO_CHANGE' then raise exception 'FAIL: T6 expected NO_CHANGE, got %', res; end if;
    res := correct_sale_item(v_item1, v_chidi, null, null);
    if res->'error'->>'code' is distinct from 'INVALID_INPUT' then raise exception 'FAIL: T6 expected INVALID_INPUT, got %', res; end if;
    res := correct_sale_item(v_item1, v_chidi, 0, null);
    if res->'error'->>'code' is distinct from 'INVALID_QUANTITY' then raise exception 'FAIL: T6 expected INVALID_QUANTITY, got %', res; end if;
    res := correct_sale_item(v_item1, v_chidi, 5000, null);
    if res->'error'->>'code' is distinct from 'INSUFFICIENT_STOCK' then raise exception 'FAIL: T6 expected INSUFFICIENT_STOCK, got %', res; end if;
    res := correct_sale_item('00000000-0000-0000-0000-00000000dead', v_chidi, 5, null);
    if res->'error'->>'code' is distinct from 'SALE_NOT_FOUND' then raise exception 'FAIL: T6 expected SALE_NOT_FOUND, got %', res; end if;

    select count(*) into v_n from v_stock_reconciliation where difference <> 0;
    if v_n <> 0 then raise exception 'FAIL: T6 stock no longer matches ledger'; end if;

    -- ===== T7: reversal ==============================================
    select id into v_item2 from sale_items where sale_id = v_sale2 and product_id = v_gb;
    res := reverse_sale(v_sale2, v_owner, 'Customer cancelled', 'Undo my last sale');
    if (res->>'ok')::boolean is not true then raise exception 'FAIL: T7 reversal refused: %', res; end if;
    select current_stock into v_stock from products where id = v_wp;
    if v_stock <> 370 then raise exception 'FAIL: T7 white paper should be 370, got %', v_stock; end if;
    select current_stock into v_stock from products where id = v_gb;
    if v_stock <> 38 then raise exception 'FAIL: T7 gold border should be 38, got %', v_stock; end if;
    select count(*) into v_n from sales
      where id = v_sale2 and status = 'reversed' and reversed_by = v_owner
        and reversal_reason = 'Customer cancelled' and reversed_at is not null;
    if v_n <> 1 then raise exception 'FAIL: T7 sale not marked reversed properly'; end if;
    select count(*) into v_n from inventory_transactions where sale_id = v_sale2 and type = 'sale_reversal';
    if v_n <> 2 then raise exception 'FAIL: T7 expected 2 reversal ledger rows, got %', v_n; end if;
    select count(*) into v_n from audit_logs
      where action = 'sale_reversed' and (affected_records->>'sale_id')::uuid = v_sale2
        and original_message = 'Undo my last sale';
    if v_n <> 1 then raise exception 'FAIL: T7 reversal not in audit log'; end if;

    res := reverse_sale(v_sale2, v_owner, 'again');
    if res->'error'->>'code' is distinct from 'SALE_ALREADY_REVERSED' then
      raise exception 'FAIL: T7 double reversal must be refused, got %', res;
    end if;
    res := correct_sale_item(v_item2, v_chidi, 5, null);
    if res->'error'->>'code' is distinct from 'SALE_ALREADY_REVERSED' then
      raise exception 'FAIL: T7 correcting a reversed sale must be refused, got %', res;
    end if;
    res := reverse_sale('00000000-0000-0000-0000-00000000dead', v_owner);
    if res->'error'->>'code' is distinct from 'SALE_NOT_FOUND' then
      raise exception 'FAIL: T7 expected SALE_NOT_FOUND, got %', res;
    end if;
    select count(*) into v_n from v_stock_reconciliation where difference <> 0;
    if v_n <> 0 then raise exception 'FAIL: T7 stock no longer matches ledger'; end if;

    -- ===== T8: crossing the threshold flags once, not repeatedly =====
    res := record_sale(v_chidi, 'Sold 230 brown paper',
      jsonb_build_array(jsonb_build_object('product_id', v_bp, 'quantity', 230, 'amount', 161000)));
    if (res->>'ok')::boolean is not true then raise exception 'FAIL: T8 sale refused: %', res; end if;
    if jsonb_array_length(res->'low_stock') <> 1
       or (res->'low_stock'->0->>'newly_flagged')::boolean is not true then
      raise exception 'FAIL: T8 brown paper should be newly flagged: %', res->'low_stock';
    end if;
    res := record_sale(v_chidi, 'Sold 5 brown paper',
      jsonb_build_array(jsonb_build_object('product_id', v_bp, 'quantity', 5, 'amount', 3500)));
    if (res->'low_stock'->0->>'newly_flagged')::boolean is not false then
      raise exception 'FAIL: T8 brown paper must not be flagged twice: %', res->'low_stock';
    end if;
    select count(*) into v_n from restock_items where product_id = v_bp and status <> 'received';
    if v_n <> 1 then raise exception 'FAIL: T8 brown paper should be on the open list once, got %', v_n; end if;

    -- ===== T9: manual stock adjustment ===============================
    res := adjust_stock(v_wp, 10, v_owner, 'Found 10 in the back store');
    if (res->>'ok')::boolean is not true or (res->>'stock_after')::integer <> 380 then
      raise exception 'FAIL: T9 adjustment wrong: %', res;
    end if;
    select count(*) into v_n from inventory_transactions
      where product_id = v_wp and type = 'manual_adjustment' and quantity_delta = 10;
    if v_n <> 1 then raise exception 'FAIL: T9 adjustment ledger row missing'; end if;

    res := adjust_stock(v_wp, -100000, v_owner, 'too much');
    if res->'error'->>'code' is distinct from 'INSUFFICIENT_STOCK' then raise exception 'FAIL: T9 expected INSUFFICIENT_STOCK, got %', res; end if;
    res := adjust_stock(v_wp, 0, v_owner, 'nothing');
    if res->'error'->>'code' is distinct from 'INVALID_INPUT' then raise exception 'FAIL: T9 zero delta must be refused, got %', res; end if;
    res := adjust_stock(v_wp, 5, v_owner, '  ');
    if res->'error'->>'code' is distinct from 'INVALID_INPUT' then raise exception 'FAIL: T9 blank reason must be refused, got %', res; end if;
    res := adjust_stock('00000000-0000-0000-0000-00000000dead', 5, v_owner, 'x');
    if res->'error'->>'code' is distinct from 'PRODUCT_NOT_FOUND' then raise exception 'FAIL: T9 expected PRODUCT_NOT_FOUND, got %', res; end if;

    -- ===== T10: negative stock only when an admin allows it ==========
    update settings set allow_negative_stock = true;
    res := record_sale(v_chidi, 'Sold 1000 white paper',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1000, 'amount', 800000)));
    if (res->>'ok')::boolean is not true then raise exception 'FAIL: T10 should be allowed when enabled: %', res; end if;
    select current_stock into v_stock from products where id = v_wp;
    if v_stock <> -620 then raise exception 'FAIL: T10 stock should be -620, got %', v_stock; end if;
    update settings set allow_negative_stock = false;
    res := record_sale(v_chidi, 'Sold 1 white paper',
      jsonb_build_array(jsonb_build_object('product_id', v_wp, 'quantity', 1, 'amount', 800)));
    if res->'error'->>'code' is distinct from 'INSUFFICIENT_STOCK' then
      raise exception 'FAIL: T10 must refuse again once disabled, got %', res;
    end if;
    select count(*) into v_n from v_stock_reconciliation where difference <> 0;
    if v_n <> 0 then raise exception 'FAIL: T10 stock no longer matches ledger'; end if;

    -- ===== T11: audit trail covers every kind of action ==============
    select count(distinct action) into v_n from audit_logs
      where action in ('sale_recorded', 'sale_corrected', 'sale_reversed',
                       'stock_adjusted', 'low_stock_flagged');
    if v_n <> 5 then raise exception 'FAIL: T11 expected 5 audit action types, got %', v_n; end if;

    -- ===== T12: the public API roles cannot call the engine ==========
    if has_function_privilege('anon', 'record_sale(uuid,text,jsonb,jsonb)', 'execute')
       or has_function_privilege('authenticated', 'record_sale(uuid,text,jsonb,jsonb)', 'execute')
       or has_function_privilege('anon', 'reverse_sale(uuid,uuid,text,text,jsonb)', 'execute')
       or has_function_privilege('anon', 'adjust_stock(uuid,integer,uuid,text,text,jsonb)', 'execute')
       or has_function_privilege('anon', 'correct_sale_item(uuid,uuid,integer,numeric,text,jsonb)', 'execute') then
      raise exception 'FAIL: T12 engine functions are callable by anon/authenticated';
    end if;

    raise exception 'TESTS_DONE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'TESTS_DONE_ROLLBACK' then
      raise;
    end if;
  end;
end $$;

select 'all phase 2 checks passed' as result;
