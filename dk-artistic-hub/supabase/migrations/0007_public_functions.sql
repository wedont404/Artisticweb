-- ============================================================
-- 0007  PUBLIC FUNCTIONS (called by the website, no login needed)
--   create_order            secure server-side order creation
--   submit_payment_reference customer tells us their MoMo reference
--   track_order             order reference + phone -> tracking info
-- Prices are NEVER taken from the browser. Everything is recalculated here.
-- ============================================================

create or replace function public._order_summary(p_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'order_number',         o.order_number,
    'fulfillment_type',     o.fulfillment_type,
    'subtotal',             o.subtotal,
    'delivery_fee',         o.delivery_fee,
    'total_amount',         o.total_amount,
    'order_status',         o.order_status,
    'payment_status',       o.payment_status,
    'payment_method',       pm.code,
    'payment_method_name',  pm.name,
    'payment_instructions', pm.instructions,
    'created_at',           o.created_at)
  from public.orders o
  left join lateral (
    select p.payment_method from public.payments p
     where p.order_id = o.id order by p.created_at desc limit 1) lp on true
  left join public.payment_methods pm on pm.code = lp.payment_method
  where o.id = p_id;
$$;

-- ------------------------------------------------------------
create or replace function public.create_order(
  p_customer_name         text,
  p_customer_phone        text,
  p_fulfillment_type      text,
  p_delivery_address      text,
  p_delivery_latitude     double precision,
  p_delivery_longitude    double precision,
  p_google_place_id       text,
  p_delivery_instructions text,
  p_items                 jsonb,          -- [{"product_id":"<uuid>","quantity":2}, ...]
  p_payment_method        text,           -- payment_methods.code
  p_idempotency_key       text default null   -- any unique string made once per checkout
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phone text; v_name text; v_addr text; v_instr text; v_place text; v_key text;
  v_pm public.payment_methods;
  v_order public.orders;
  v_existing public.orders;
  v_e jsonb; v_qty numeric; r record; v_sub numeric := 0;
begin
  perform public.rl_hit('order_ip:' || public.client_key(), 10, interval '10 minutes');

  v_phone := public.normalize_rw_phone(p_customer_phone);
  if v_phone is null then raise exception 'invalid_phone'; end if;
  perform public.rl_hit('order_phone:' || v_phone, 5, interval '10 minutes');

  v_name := btrim(coalesce(p_customer_name, ''));
  if char_length(v_name) not between 2 and 80 then raise exception 'invalid_name'; end if;

  if p_fulfillment_type is null or p_fulfillment_type not in ('delivery', 'pickup', 'dine_in') then
    raise exception 'invalid_fulfillment_type';
  end if;

  v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_key is not null and char_length(v_key) > 100 then raise exception 'invalid_idempotency_key'; end if;
  if v_key is not null then
    select * into v_existing from public.orders where idempotency_key = v_key;
    if found then
      if v_existing.customer_phone <> v_phone then raise exception 'idempotency_conflict'; end if;
      return public._order_summary(v_existing.id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  v_instr := nullif(btrim(coalesce(p_delivery_instructions, '')), '');
  if v_instr is not null and char_length(v_instr) > 500 then raise exception 'instructions_too_long'; end if;
  v_place := nullif(btrim(coalesce(p_google_place_id, '')), '');
  if v_place is not null and char_length(v_place) > 200 then raise exception 'invalid_place_id'; end if;

  if p_fulfillment_type = 'delivery' then
    v_addr := btrim(coalesce(p_delivery_address, ''));
    if char_length(v_addr) not between 3 and 300 then raise exception 'delivery_address_required'; end if;
    if p_delivery_latitude is null or p_delivery_longitude is null then
      raise exception 'delivery_location_required';
    end if;
    -- Rwanda bounding box (also rejects NaN/Infinity)
    if p_delivery_latitude not between -3.0 and -0.9 or p_delivery_longitude not between 28.8 and 31.0 then
      raise exception 'delivery_location_outside_rwanda';
    end if;
  else
    v_addr := null; v_place := null;
    p_delivery_latitude := null; p_delivery_longitude := null;
  end if;

  -- ---- validate the cart shape ----
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'invalid_items';
  end if;
  for v_e in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_e) is distinct from 'object'
       or jsonb_typeof(v_e->'quantity') is distinct from 'number'
       or jsonb_typeof(v_e->'product_id') is distinct from 'string'
       or (v_e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_items';
    end if;
    v_qty := (v_e->>'quantity')::numeric;
    if v_qty <> floor(v_qty) or v_qty not between 1 and 99 then raise exception 'invalid_quantity'; end if;
  end loop;

  select * into v_pm from public.payment_methods where code = p_payment_method and is_active;
  if not found then raise exception 'invalid_payment_method'; end if;

  -- ---- create the order (one transaction: any error rolls everything back) ----
  begin
    insert into public.orders (order_number, idempotency_key, customer_name, customer_phone,
                               fulfillment_type, delivery_address, delivery_latitude,
                               delivery_longitude, google_place_id, delivery_instructions)
    values (public.next_order_number(), v_key, v_name, v_phone, p_fulfillment_type, v_addr,
            p_delivery_latitude, p_delivery_longitude, v_place, v_instr)
    returning * into v_order;
  exception when unique_violation then
    -- two identical submissions at the same moment: return the winner
    select * into v_existing from public.orders where idempotency_key = v_key;
    if v_key is not null and found and v_existing.customer_phone = v_phone then
      return public._order_summary(v_existing.id) || jsonb_build_object('replayed', true);
    end if;
    raise;
  end;

  for r in
    select q.pid, q.qty, p.id as prod_id, p.name, p.price,
           p.is_active, p.is_available, c.is_active as cat_active
      from (select (e->>'product_id')::uuid as pid, sum((e->>'quantity')::numeric)::int as qty
              from jsonb_array_elements(p_items) e group by 1) q
      left join public.products   p on p.id = q.pid
      left join public.categories c on c.id = p.category_id
  loop
    if r.prod_id is null or not r.is_active or not r.is_available or not r.cat_active then
      raise exception 'item_unavailable' using detail = coalesce(r.name, r.pid::text);
    end if;
    if r.qty > 99 then raise exception 'invalid_quantity'; end if;
    insert into public.order_items (order_id, product_id, product_name_snapshot, quantity, unit_price)
    values (v_order.id, r.prod_id, r.name, r.qty, r.price);   -- price comes from the DB, never the browser
    v_sub := v_sub + r.qty * r.price;
  end loop;

  update public.orders set subtotal = v_sub where id = v_order.id;

  -- payment starts UNPAID. It only changes when an admin verifies it.
  insert into public.payments (order_id, payment_method, amount, payment_status)
  values (v_order.id, v_pm.code, v_sub, 'unpaid');

  insert into public.order_status_history (order_id, previous_status, new_status, progress_note)
  values (v_order.id, null, 'pending', 'Order received');

  return public._order_summary(v_order.id);
end $$;

-- ------------------------------------------------------------
-- Customer says "I paid, my MoMo reference is XXXX" -> pending_verification.
-- An admin must still verify it. Wrong order/phone returns {"found": false}.
create or replace function public.submit_payment_reference(
  p_order_number text, p_phone text, p_reference text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phone text; v_ref text; v_o public.orders; v_pay public.payments; v_pm public.payment_methods;
begin
  perform public.rl_hit('payref_ip:' || public.client_key(), 20, interval '10 minutes');
  v_phone := public.normalize_rw_phone(p_phone);
  p_order_number := upper(btrim(coalesce(p_order_number, '')));
  if v_phone is null or p_order_number !~ '^DK-[0-9]{4}-[0-9]{5}$' then
    return jsonb_build_object('found', false);
  end if;
  perform public.rl_hit('payref_order:' || p_order_number, 10, interval '10 minutes');

  select * into v_o from public.orders where order_number = p_order_number and customer_phone = v_phone;
  if not found then return jsonb_build_object('found', false); end if;
  if v_o.order_status = 'cancelled' then raise exception 'order_cancelled'; end if;

  v_ref := btrim(coalesce(p_reference, ''));
  if v_ref !~ '^[A-Za-z0-9._-]{4,64}$' then raise exception 'invalid_reference'; end if;

  select * into v_pay from public.payments where order_id = v_o.id order by created_at desc limit 1 for update;
  select * into v_pm  from public.payment_methods where code = v_pay.payment_method;
  if not v_pm.requires_reference then raise exception 'reference_not_required'; end if;
  if v_pay.payment_status = 'paid'     then raise exception 'already_paid'; end if;
  if v_pay.payment_status = 'refunded' then raise exception 'order_refunded'; end if;

  begin
    if v_pay.payment_status = 'failed' then
      insert into public.payments (order_id, payment_method, amount, payment_reference, payment_status)
      values (v_o.id, v_pay.payment_method, v_o.total_amount, v_ref, 'pending_verification');
    else
      update public.payments
         set payment_reference = v_ref, payment_status = 'pending_verification',
             amount = v_o.total_amount
       where id = v_pay.id;
    end if;
  exception when unique_violation then
    raise exception 'reference_already_used';
  end;

  return jsonb_build_object('found', true, 'order_number', v_o.order_number,
                            'payment_status', 'pending_verification');
end $$;

-- ------------------------------------------------------------
-- Tracking: needs BOTH order number and the phone used at checkout.
-- Tracking details only appear after an admin confirmed the order.
-- Any mismatch returns {"found": false} (same answer for "wrong phone" and
-- "no such order") so order numbers cannot be probed.
create or replace function public.track_order(p_order_number text, p_phone text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phone text; v_o public.orders; v_hist jsonb; v_pos jsonb; v_items jsonb; v_last timestamptz;
  v_pay record;
begin
  perform public.rl_hit('track_ip:' || public.client_key(), 40, interval '10 minutes');
  v_phone := public.normalize_rw_phone(p_phone);
  p_order_number := upper(btrim(coalesce(p_order_number, '')));
  if v_phone is null or p_order_number !~ '^DK-[0-9]{4}-[0-9]{5}$' then
    return jsonb_build_object('found', false);
  end if;
  perform public.rl_hit('track_order:' || p_order_number, 20, interval '10 minutes');

  select * into v_o from public.orders where order_number = p_order_number and customer_phone = v_phone;
  if not found then return jsonb_build_object('found', false); end if;

  if v_o.confirmed_at is null then
    return jsonb_build_object(
      'found', true, 'order_number', v_o.order_number, 'tracking_available', false,
      'order_status', v_o.order_status, 'payment_status', v_o.payment_status,
      'message', case when v_o.order_status = 'cancelled' then 'cancelled' else 'awaiting_confirmation' end);
  end if;

  select max(created_at) into v_last from public.order_status_history where order_id = v_o.id;

  select coalesce(jsonb_agg(jsonb_build_object('status', h.new_status, 'note', h.progress_note, 'at', h.created_at)
                            order by h.created_at), '[]'::jsonb)
    into v_hist from public.order_status_history h where h.order_id = v_o.id;

  -- courier position is only shown while the order is out for delivery
  v_pos := null;
  if v_o.order_status = 'out_for_delivery' then
    select jsonb_build_object('latitude', h.location_latitude, 'longitude', h.location_longitude,
                              'at', h.created_at, 'note', h.progress_note)
      into v_pos
      from public.order_status_history h
     where h.order_id = v_o.id and h.location_latitude is not null
     order by h.created_at desc limit 1;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', i.product_name_snapshot, 'quantity', i.quantity,
                                               'unit_price', i.unit_price, 'total_price', i.total_price)
                            order by i.created_at), '[]'::jsonb)
    into v_items from public.order_items i where i.order_id = v_o.id;

  select pm.name as method_name,
         case when p.payment_status = 'paid' then null else pm.instructions end as instructions
    into v_pay
    from public.payments p join public.payment_methods pm on pm.code = p.payment_method
   where p.order_id = v_o.id order by p.created_at desc limit 1;

  return jsonb_build_object(
    'found', true,
    'tracking_available', true,
    'order_number', v_o.order_number,
    'tracking_code', v_o.tracking_code,
    'fulfillment_type', v_o.fulfillment_type,
    'order_status', v_o.order_status,
    'payment_status', v_o.payment_status,
    'payment_method', v_pay.method_name,
    'payment_instructions', v_pay.instructions,
    'estimated_delivery_at', v_o.estimated_delivery_at,
    'last_updated', coalesce(v_last, v_o.updated_at),
    'delivery_address', v_o.delivery_address,
    'delivery_latitude', v_o.delivery_latitude,
    'delivery_longitude', v_o.delivery_longitude,
    'courier_position', v_pos,
    'subtotal', v_o.subtotal, 'delivery_fee', v_o.delivery_fee, 'total_amount', v_o.total_amount,
    'items', v_items,
    'progress', v_hist);
end $$;
