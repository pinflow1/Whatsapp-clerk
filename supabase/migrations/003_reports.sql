-- =====================================================================
-- WhatsApp Business Clerk — Phase 5a: report queries
-- Run after 002_engine_functions.sql. Everything here only READS data.
--
-- Rules these queries follow:
--  * The database does all the counting. The AI never calculates a figure.
--  * Reversed sales are never counted (only status = 'recorded').
--  * A "day" is a calendar day in the business timezone (settings.business_timezone,
--    default Africa/Lagos), not UTC. A sale at 00:30 Lagos time belongs to that day.
--  * Date ranges are [from, to): "to" is NOT included.
--
-- Same contract as the engine: { "ok": true, ... } or { "ok": false, "error": {...} }.
-- =====================================================================

begin;

-- ---------- time helpers ---------------------------------------------
create function business_tz() returns text
language sql stable
as $$
  select coalesce((select business_timezone from settings limit 1), 'Africa/Lagos');
$$;

-- The moment a local calendar day begins, as an absolute time.
create function local_day_start(p_day date) returns timestamptz
language sql stable
as $$
  select p_day::timestamp at time zone business_tz();
$$;

-- ---------- sales summary --------------------------------------------
-- Totals plus breakdowns by product and by salesperson for [p_from, p_to).
-- Optional filters: one product, one salesperson. With a product filter, every
-- figure is about that product only.
create function sales_summary(
  p_from date,
  p_to date,
  p_product_id uuid default null,
  p_staff_id uuid default null
) returns jsonb
language plpgsql stable
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return engine_error('INVALID_INPUT', 'The end date must be after the start date');
  end if;

  v_from := local_day_start(p_from);
  v_to := local_day_start(p_to);

  return (
    with items as (
      select si.sale_id, si.product_id, si.quantity, si.amount, sa.salesperson_id
      from sale_items si
      join sales sa on sa.id = si.sale_id
      where sa.status = 'recorded'
        and sa.created_at >= v_from
        and sa.created_at < v_to
        and (p_product_id is null or si.product_id = p_product_id)
        and (p_staff_id is null or sa.salesperson_id = p_staff_id)
    ),
    totals as (
      select
        coalesce(sum(amount), 0) as revenue,
        count(distinct sale_id) as transactions,
        coalesce(sum(quantity), 0) as units
      from items
    ),
    by_product as (
      select i.product_id, p.name, sum(i.quantity) as units, sum(i.amount) as revenue
      from items i
      join products p on p.id = i.product_id
      group by i.product_id, p.name
    ),
    by_staff as (
      select
        i.salesperson_id as user_id,
        u.name,
        count(distinct i.sale_id) as transactions,
        sum(i.quantity) as units,
        sum(i.amount) as revenue
      from items i
      join users u on u.id = i.salesperson_id
      group by i.salesperson_id, u.name
    )
    select jsonb_build_object(
      'ok', true,
      'from', p_from,
      'to', p_to,
      'revenue', t.revenue,
      'transactions', t.transactions,
      'units', t.units,
      'by_product', coalesce((
        select jsonb_agg(
          jsonb_build_object('product_id', bp.product_id, 'name', bp.name, 'units', bp.units, 'revenue', bp.revenue)
          order by bp.units desc, bp.revenue desc, bp.name)
        from by_product bp
      ), '[]'::jsonb),
      'by_staff', coalesce((
        select jsonb_agg(
          jsonb_build_object('user_id', bs.user_id, 'name', bs.name, 'transactions', bs.transactions,
                             'units', bs.units, 'revenue', bs.revenue)
          order by bs.revenue desc, bs.name)
        from by_staff bs
      ), '[]'::jsonb)
    )
    from totals t
  );
end $$;

-- ---------- stock, low stock, restock list ---------------------------
-- Current stock for every active product, or just one.
create function stock_levels(p_product_id uuid default null) returns jsonb
language sql stable
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', p.id,
      'name', p.name,
      'current_stock', p.current_stock,
      'low_stock_threshold', p.low_stock_threshold,
      'default_price', p.default_price)
    order by p.name), '[]'::jsonb)
  from products p
  where p.is_active and (p_product_id is null or p.id = p_product_id);
$$;

-- Products at or below their low-stock threshold, lowest stock first.
create function low_stock_list() returns jsonb
language sql stable
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', l.product_id,
      'name', l.name,
      'current_stock', l.current_stock,
      'low_stock_threshold', l.low_stock_threshold)
    order by l.current_stock, l.name), '[]'::jsonb)
  from v_low_stock l;
$$;

-- The open restock list (pending or ordered), lowest stock first.
create function restock_list() returns jsonb
language sql stable
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'restock_id', r.id,
      'product_id', r.product_id,
      'name', p.name,
      'status', r.status,
      'stock_when_flagged', r.stock_when_flagged,
      'current_stock', p.current_stock,
      'quantity_ordered', r.quantity_ordered)
    order by p.current_stock, p.name), '[]'::jsonb)
  from restock_items r
  join products p on p.id = r.product_id
  where r.status <> 'received';
$$;

-- ---------- daily report ---------------------------------------------
-- One local day, the day before it (figures only, for a factual comparison),
-- and the stock position right now.
create function daily_report(p_date date) returns jsonb
language plpgsql stable
as $$
declare
  v_day jsonb;
  v_prev jsonb;
begin
  if p_date is null then
    return engine_error('INVALID_INPUT', 'A date is required');
  end if;

  v_day := sales_summary(p_date, p_date + 1);
  v_prev := sales_summary(p_date - 1, p_date);

  return jsonb_build_object(
    'ok', true,
    'date', p_date,
    'timezone', business_tz(),
    'day', v_day,
    'previous_day', jsonb_build_object(
      'date', p_date - 1,
      'revenue', v_prev->'revenue',
      'transactions', v_prev->'transactions',
      'units', v_prev->'units'
    ),
    'low_stock', low_stock_list(),
    'restock', restock_list()
  );
end $$;

-- ---------- lock the functions down ----------------------------------
revoke all on function business_tz() from public, anon, authenticated;
revoke all on function local_day_start(date) from public, anon, authenticated;
revoke all on function sales_summary(date, date, uuid, uuid) from public, anon, authenticated;
revoke all on function stock_levels(uuid) from public, anon, authenticated;
revoke all on function low_stock_list() from public, anon, authenticated;
revoke all on function restock_list() from public, anon, authenticated;
revoke all on function daily_report(date) from public, anon, authenticated;

commit;
