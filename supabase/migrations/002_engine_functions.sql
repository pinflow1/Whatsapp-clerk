-- =====================================================================
-- WhatsApp Business Clerk — Phase 2: sales + inventory engine
-- Run after 001_core_schema.sql.
--
-- Why Postgres functions: supabase-js can't run multi-statement
-- transactions, and a sale touches several tables (sales, sale_items,
-- products, inventory_transactions, audit_logs). Each function below does
-- all of its writes in one transaction: it all happens or none of it does.
--
-- Contract: every function returns jsonb.
--   success: { "ok": true, ... }
--   refused: { "ok": false, "error": { "code", "message", "details" } }
-- All checks run BEFORE any write, so a refusal never leaves partial data.
-- Unexpected failures raise a normal Postgres error and roll back.
--
-- Authorisation (who may do what) is NOT decided here. These functions
-- trust the server that calls them with the service role key.
-- Role rules (staff vs admin) arrive in Phase 7.
--
-- Lock order, to avoid deadlocks: sale row first, then product rows
-- sorted by id.
-- =====================================================================

begin;

-- ---------- helpers --------------------------------------------------
create function engine_error(
  p_code text,
  p_message text,
  p_details jsonb default '{}'::jsonb
) returns jsonb
language sql
as $$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', p_code,
      'message', p_message,
      'details', coalesce(p_details, '{}'::jsonb)
    )
  );
$$;

-- Adds a product to the restock list if it is at/below its threshold and
-- not already on the open list. Returns true only when newly added.
create function flag_low_stock(p_product_id uuid, p_user_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_p products%rowtype;
  v_new_id uuid;
begin
  select * into v_p from products where id = p_product_id;
  if not found or not v_p.is_active or v_p.current_stock > v_p.low_stock_threshold then
    return false;
  end if;

  insert into restock_items (product_id, stock_when_flagged, updated_by)
  values (v_p.id, v_p.current_stock, p_user_id)
  on conflict do nothing
  returning id into v_new_id;

  if v_new_id is not null then
    insert into audit_logs (user_id, action, affected_records, after_state)
    values (
      p_user_id,
      'low_stock_flagged',
      jsonb_build_object('product_id', v_p.id, 'restock_item_id', v_new_id),
      jsonb_build_object(
        'product_name', v_p.name,
        'current_stock', v_p.current_stock,
        'low_stock_threshold', v_p.low_stock_threshold
      )
    );
  end if;

  return v_new_id is not null;
end $$;

-- ---------- record_sale ----------------------------------------------
-- p_items: [{ "product_id": uuid, "quantity": int, "amount": number }, ...]
-- amount is the LINE TOTAL in naira, not a unit price.
create function record_sale(
  p_salesperson_id uuid,
  p_original_message text,
  p_items jsonb,
  p_interpreted_command jsonb default null
) returns jsonb
language plpgsql
as $$
declare
  v_user users%rowtype;
  v_allow_negative boolean;
  v_elem jsonb;
  v_idx integer := 0;
  v_pid_text text;
  v_qty numeric;
  v_amt numeric;
  v_norm jsonb := '[]'::jsonb;
  v_total numeric(14,2) := 0;
  r record;
  v_prod products%rowtype;
  v_sale_id uuid;
  v_item_id uuid;
  v_before integer;
  v_after integer;
  v_results jsonb := '[]'::jsonb;
  v_low jsonb := '[]'::jsonb;
  v_before_stock jsonb := '{}'::jsonb;
  v_after_stock jsonb := '{}'::jsonb;
  v_newly boolean;
begin
  if p_original_message is null or length(trim(p_original_message)) = 0 then
    return engine_error('INVALID_INPUT', 'The original message is required');
  end if;

  select * into v_user from users where id = p_salesperson_id and is_active;
  if not found then
    return engine_error('USER_NOT_FOUND', 'Salesperson not found or inactive');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return engine_error('INVALID_INPUT', 'A sale needs at least one item');
  end if;

  v_allow_negative := coalesce((select allow_negative_stock from settings limit 1), false);

  -- Phase A: validate every item. Nothing is written yet.
  for v_elem in select value from jsonb_array_elements(p_items) loop
    v_idx := v_idx + 1;

    if jsonb_typeof(v_elem) <> 'object' then
      return engine_error('INVALID_INPUT', format('Item %s is not an object', v_idx),
        jsonb_build_object('item_index', v_idx));
    end if;

    v_pid_text := v_elem->>'product_id';
    if v_pid_text is null
       or v_pid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return engine_error('INVALID_INPUT', format('Item %s has no valid product_id', v_idx),
        jsonb_build_object('item_index', v_idx));
    end if;

    if jsonb_typeof(v_elem->'quantity') is distinct from 'number' then
      return engine_error('INVALID_QUANTITY', format('Item %s needs a numeric quantity', v_idx),
        jsonb_build_object('item_index', v_idx));
    end if;
    v_qty := (v_elem->>'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > 1000000 then
      return engine_error('INVALID_QUANTITY',
        format('Item %s: quantity must be a whole number from 1 to 1,000,000', v_idx),
        jsonb_build_object('item_index', v_idx, 'quantity', v_qty));
    end if;

    if jsonb_typeof(v_elem->'amount') is distinct from 'number' then
      return engine_error('INVALID_AMOUNT', format('Item %s needs a numeric amount', v_idx),
        jsonb_build_object('item_index', v_idx));
    end if;
    v_amt := (v_elem->>'amount')::numeric;
    if v_amt < 0 or v_amt > 999999999999 or v_amt <> round(v_amt, 2) then
      return engine_error('INVALID_AMOUNT',
        format('Item %s: amount must be zero or more, with at most 2 decimals', v_idx),
        jsonb_build_object('item_index', v_idx, 'amount', v_amt));
    end if;

    if not exists (select 1 from products where id = v_pid_text::uuid and is_active) then
      return engine_error('PRODUCT_NOT_FOUND', format('Item %s: product not found', v_idx),
        jsonb_build_object('item_index', v_idx, 'product_id', v_pid_text));
    end if;

    v_norm := v_norm || jsonb_build_array(jsonb_build_object(
      'product_id', lower(v_pid_text),
      'quantity', v_qty::integer,
      'amount', v_amt
    ));
    v_total := v_total + v_amt;
  end loop;

  -- Phase A2: lock products in id order and check stock on the combined
  -- quantity (the same product may appear in more than one item).
  for r in
    select (e->>'product_id')::uuid as product_id, sum((e->>'quantity')::integer) as qty
    from jsonb_array_elements(v_norm) e
    group by 1
    order by 1
  loop
    select * into v_prod from products where id = r.product_id and is_active for update;
    if not found then
      return engine_error('PRODUCT_NOT_FOUND', 'Product not found',
        jsonb_build_object('product_id', r.product_id));
    end if;
    if not v_allow_negative and v_prod.current_stock < r.qty then
      return engine_error('INSUFFICIENT_STOCK',
        format('Only %s of %s in stock (requested %s)', v_prod.current_stock, v_prod.name, r.qty),
        jsonb_build_object(
          'product_id', v_prod.id,
          'product_name', v_prod.name,
          'available', v_prod.current_stock,
          'requested', r.qty
        ));
    end if;
  end loop;

  -- Phase B: write everything.
  insert into sales (salesperson_id, total_amount, original_message)
  values (p_salesperson_id, v_total, trim(p_original_message))
  returning id into v_sale_id;

  for v_elem in select value from jsonb_array_elements(v_norm) loop
    select * into v_prod from products where id = (v_elem->>'product_id')::uuid;
    v_before := v_prod.current_stock;
    v_after := v_before - (v_elem->>'quantity')::integer;

    insert into sale_items (sale_id, product_id, product_name, quantity, amount)
    values (v_sale_id, v_prod.id, v_prod.name,
            (v_elem->>'quantity')::integer, (v_elem->>'amount')::numeric)
    returning id into v_item_id;

    update products set current_stock = v_after where id = v_prod.id;

    insert into inventory_transactions
      (product_id, type, quantity_delta, stock_before, stock_after,
       sale_id, sale_item_id, performed_by)
    values
      (v_prod.id, 'sale', -((v_elem->>'quantity')::integer), v_before, v_after,
       v_sale_id, v_item_id, p_salesperson_id);

    if (v_before_stock ->> v_prod.id::text) is null then
      v_before_stock := v_before_stock || jsonb_build_object(v_prod.id::text, v_before);
    end if;
    v_after_stock := v_after_stock || jsonb_build_object(v_prod.id::text, v_after);

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'sale_item_id', v_item_id,
      'product_id', v_prod.id,
      'product_name', v_prod.name,
      'quantity', (v_elem->>'quantity')::integer,
      'amount', (v_elem->>'amount')::numeric,
      'remaining_stock', v_after
    ));
  end loop;

  -- Phase C: low-stock detection, once per distinct product.
  for r in
    select distinct (e->>'product_id')::uuid as product_id
    from jsonb_array_elements(v_norm) e
    order by 1
  loop
    select * into v_prod from products where id = r.product_id;
    if v_prod.current_stock <= v_prod.low_stock_threshold then
      v_newly := flag_low_stock(v_prod.id, p_salesperson_id);
      v_low := v_low || jsonb_build_array(jsonb_build_object(
        'product_id', v_prod.id,
        'product_name', v_prod.name,
        'remaining_stock', v_prod.current_stock,
        'low_stock_threshold', v_prod.low_stock_threshold,
        'newly_flagged', v_newly
      ));
    end if;
  end loop;

  insert into audit_logs
    (user_id, action, original_message, interpreted_command,
     affected_records, before_state, after_state)
  values (
    p_salesperson_id, 'sale_recorded', p_original_message, p_interpreted_command,
    jsonb_build_object('sale_id', v_sale_id),
    jsonb_build_object('stock', v_before_stock),
    jsonb_build_object('total_amount', v_total, 'items', v_results, 'stock', v_after_stock)
  );

  return jsonb_build_object(
    'ok', true,
    'sale_id', v_sale_id,
    'total_amount', v_total,
    'items', v_results,
    'low_stock', v_low
  );
end $$;

-- ---------- correct_sale_item ----------------------------------------
-- Edits an existing sale line in place. Pass the new quantity, the new
-- amount, or both; whatever is null stays as it was.
-- If only the quantity changes, the amount is left alone and the result
-- says needs_amount_review = true, so the bot can ask rather than guess.
create function correct_sale_item(
  p_sale_item_id uuid,
  p_user_id uuid,
  p_new_quantity integer default null,
  p_new_amount numeric default null,
  p_original_message text default null,
  p_interpreted_command jsonb default null
) returns jsonb
language plpgsql
as $$
declare
  v_user users%rowtype;
  v_item sale_items%rowtype;
  v_sale sales%rowtype;
  v_prod products%rowtype;
  v_allow_negative boolean;
  v_old_qty integer;
  v_old_amt numeric;
  v_new_qty integer;
  v_new_amt numeric;
  v_delta integer;
  v_before integer;
  v_after integer;
  v_new_total numeric(14,2);
  v_low jsonb := '[]'::jsonb;
  v_newly boolean;
begin
  select * into v_user from users where id = p_user_id and is_active;
  if not found then
    return engine_error('USER_NOT_FOUND', 'User not found or inactive');
  end if;

  if p_new_quantity is null and p_new_amount is null then
    return engine_error('INVALID_INPUT', 'Provide a new quantity, a new amount, or both');
  end if;

  select * into v_item from sale_items where id = p_sale_item_id;
  if not found then
    return engine_error('SALE_NOT_FOUND', 'Sale item not found');
  end if;

  select * into v_sale from sales where id = v_item.sale_id for update;
  select * into v_item from sale_items where id = p_sale_item_id;  -- re-read under lock

  if v_sale.status <> 'recorded' then
    return engine_error('SALE_ALREADY_REVERSED', 'That sale was already reversed',
      jsonb_build_object('sale_id', v_sale.id));
  end if;

  v_allow_negative := coalesce((select allow_negative_stock from settings limit 1), false);
  v_old_qty := v_item.quantity;
  v_old_amt := v_item.amount;
  v_new_qty := coalesce(p_new_quantity, v_old_qty);
  v_new_amt := coalesce(p_new_amount, v_old_amt);

  if v_new_qty < 1 or v_new_qty > 1000000 then
    return engine_error('INVALID_QUANTITY', 'Quantity must be a whole number from 1 to 1,000,000',
      jsonb_build_object('quantity', v_new_qty));
  end if;
  if v_new_amt < 0 or v_new_amt > 999999999999 or v_new_amt <> round(v_new_amt, 2) then
    return engine_error('INVALID_AMOUNT', 'Amount must be zero or more, with at most 2 decimals',
      jsonb_build_object('amount', v_new_amt));
  end if;
  if v_new_qty = v_old_qty and v_new_amt = v_old_amt then
    return engine_error('NO_CHANGE', 'That is already what the sale says');
  end if;

  v_delta := v_old_qty - v_new_qty;  -- positive: units go back to stock

  select * into v_prod from products where id = v_item.product_id for update;
  v_before := v_prod.current_stock;
  v_after := v_before + v_delta;

  if v_after < 0 and not v_allow_negative then
    return engine_error('INSUFFICIENT_STOCK',
      format('Only %s of %s in stock; that change needs %s more',
             v_before, v_prod.name, -v_delta),
      jsonb_build_object(
        'product_id', v_prod.id,
        'product_name', v_prod.name,
        'available', v_before,
        'requested', -v_delta
      ));
  end if;

  update sale_items set quantity = v_new_qty, amount = v_new_amt where id = v_item.id;

  update sales
  set total_amount = (select coalesce(sum(amount), 0) from sale_items where sale_id = v_sale.id)
  where id = v_sale.id
  returning total_amount into v_new_total;

  if v_delta <> 0 then
    update products set current_stock = v_after where id = v_prod.id;

    insert into inventory_transactions
      (product_id, type, quantity_delta, stock_before, stock_after,
       sale_id, sale_item_id, performed_by, note)
    values
      (v_prod.id, 'sale_correction', v_delta, v_before, v_after,
       v_sale.id, v_item.id, p_user_id,
       format('Quantity corrected from %s to %s', v_old_qty, v_new_qty));
  end if;

  if v_delta < 0 and v_after <= v_prod.low_stock_threshold then
    v_newly := flag_low_stock(v_prod.id, p_user_id);
    v_low := jsonb_build_array(jsonb_build_object(
      'product_id', v_prod.id,
      'product_name', v_prod.name,
      'remaining_stock', v_after,
      'low_stock_threshold', v_prod.low_stock_threshold,
      'newly_flagged', v_newly
    ));
  end if;

  insert into audit_logs
    (user_id, action, original_message, interpreted_command,
     affected_records, before_state, after_state)
  values (
    p_user_id, 'sale_corrected', p_original_message, p_interpreted_command,
    jsonb_build_object('sale_id', v_sale.id, 'sale_item_id', v_item.id, 'product_id', v_prod.id),
    jsonb_build_object('quantity', v_old_qty, 'amount', v_old_amt,
                       'sale_total', v_sale.total_amount, 'stock', v_before),
    jsonb_build_object('quantity', v_new_qty, 'amount', v_new_amt,
                       'sale_total', v_new_total, 'stock', v_after)
  );

  return jsonb_build_object(
    'ok', true,
    'sale_id', v_sale.id,
    'sale_item_id', v_item.id,
    'product_id', v_prod.id,
    'product_name', v_prod.name,
    'old_quantity', v_old_qty,
    'new_quantity', v_new_qty,
    'old_amount', v_old_amt,
    'new_amount', v_new_amt,
    'sale_total', v_new_total,
    'remaining_stock', v_after,
    'needs_amount_review', (v_new_qty <> v_old_qty and p_new_amount is null),
    'low_stock', v_low
  );
end $$;

-- ---------- reverse_sale ---------------------------------------------
-- Puts every unit back and marks the sale reversed. The sale and its
-- items stay on record; reports must count only status = 'recorded'.
create function reverse_sale(
  p_sale_id uuid,
  p_user_id uuid,
  p_reason text default null,
  p_original_message text default null,
  p_interpreted_command jsonb default null
) returns jsonb
language plpgsql
as $$
declare
  v_user users%rowtype;
  v_sale sales%rowtype;
  r record;
  v_before integer;
  v_after integer;
  v_restored jsonb := '[]'::jsonb;
  v_snapshot jsonb;
begin
  select * into v_user from users where id = p_user_id and is_active;
  if not found then
    return engine_error('USER_NOT_FOUND', 'User not found or inactive');
  end if;

  select * into v_sale from sales where id = p_sale_id for update;
  if not found then
    return engine_error('SALE_NOT_FOUND', 'Sale not found');
  end if;
  if v_sale.status <> 'recorded' then
    return engine_error('SALE_ALREADY_REVERSED', 'That sale was already reversed',
      jsonb_build_object('sale_id', v_sale.id));
  end if;

  -- Lock all affected products in id order.
  perform id from products
  where id in (select product_id from sale_items where sale_id = p_sale_id)
  order by id
  for update;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_name', product_name, 'quantity', quantity, 'amount', amount)
           order by created_at, id), '[]'::jsonb)
  into v_snapshot
  from sale_items where sale_id = p_sale_id;

  for r in select * from sale_items where sale_id = p_sale_id order by created_at, id loop
    select current_stock into v_before from products where id = r.product_id;
    v_after := v_before + r.quantity;

    update products set current_stock = v_after where id = r.product_id;

    insert into inventory_transactions
      (product_id, type, quantity_delta, stock_before, stock_after,
       sale_id, sale_item_id, performed_by, note)
    values
      (r.product_id, 'sale_reversal', r.quantity, v_before, v_after,
       p_sale_id, r.id, p_user_id, p_reason);

    v_restored := v_restored || jsonb_build_array(jsonb_build_object(
      'product_id', r.product_id,
      'product_name', r.product_name,
      'quantity', r.quantity,
      'stock_before', v_before,
      'stock_after', v_after
    ));
  end loop;

  update sales
  set status = 'reversed', reversed_at = now(), reversed_by = p_user_id, reversal_reason = p_reason
  where id = p_sale_id;

  insert into audit_logs
    (user_id, action, original_message, interpreted_command,
     affected_records, before_state, after_state)
  values (
    p_user_id, 'sale_reversed', p_original_message, p_interpreted_command,
    jsonb_build_object('sale_id', p_sale_id),
    jsonb_build_object('status', 'recorded', 'total_amount', v_sale.total_amount, 'items', v_snapshot),
    jsonb_build_object('status', 'reversed', 'reason', p_reason, 'restored', v_restored)
  );

  return jsonb_build_object(
    'ok', true,
    'sale_id', p_sale_id,
    'total_amount', v_sale.total_amount,
    'restored', v_restored
  );
end $$;

-- ---------- adjust_stock ---------------------------------------------
-- Manual stock change (miscount, damaged goods, found stock...).
-- A reason is mandatory so the audit trail explains every adjustment.
create function adjust_stock(
  p_product_id uuid,
  p_delta integer,
  p_user_id uuid,
  p_note text,
  p_original_message text default null,
  p_interpreted_command jsonb default null
) returns jsonb
language plpgsql
as $$
declare
  v_user users%rowtype;
  v_prod products%rowtype;
  v_allow_negative boolean;
  v_before integer;
  v_after integer;
  v_newly boolean := false;
  v_low jsonb := '[]'::jsonb;
begin
  select * into v_user from users where id = p_user_id and is_active;
  if not found then
    return engine_error('USER_NOT_FOUND', 'User not found or inactive');
  end if;

  if p_delta is null or p_delta = 0 or abs(p_delta) > 1000000 then
    return engine_error('INVALID_INPUT', 'Adjustment must be a non-zero whole number up to 1,000,000');
  end if;
  if p_note is null or length(trim(p_note)) = 0 then
    return engine_error('INVALID_INPUT', 'A reason is required for stock adjustments');
  end if;

  select * into v_prod from products w
