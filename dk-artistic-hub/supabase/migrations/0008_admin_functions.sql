-- ============================================================
-- 0008  ADMIN FUNCTIONS (signed-in administrators only)
-- Every function re-checks is_admin() itself, so even a leaked
-- function name is useless to a non-admin.
-- All order / payment changes go through here so history and
-- verification details are always recorded.
-- ============================================================

-- ------------------------------------------------------------
-- Move an order forward (or cancel it). Writes order_status_history.
-- Tracking becomes available the moment status becomes 'confirmed'.
create or replace function public.admin_set_order_status(
  p_order_id   uuid,
  p_new_status text,
  p_note       text default null,
  p_lat        double precision default null,
  p_lng        double precision default null,
  p_eta        timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_admin uuid; v_o public.orders; v_prev text; v_note text; v_ok boolean;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_admin := public.current_admin_id();

  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  v_prev := v_o.order_status;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 500 then raise exception 'note_too_long'; end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'location_incomplete'; end if;
  if p_lat is not null and (p_lat not between -3.0 and -0.9 or p_lng not between 28.8 and 31.0) then
    raise exception 'location_outside_rwanda';
  end if;

  v_ok := case v_prev
    when 'pending'          then p_new_status in ('confirmed', 'cancelled')
    when 'confirmed'        then p_new_status in ('preparing', 'cancelled')
    when 'preparing'        then p_new_status in ('ready', 'cancelled')
    when 'ready'            then p_new_status in ('out_for_delivery', 'delivered', 'cancelled')
    when 'out_for_delivery' then p_new_status in ('delivered', 'cancelled')
    else false end;
  if not coalesce(v_ok, false) then
    raise exception 'invalid_transition' using detail = v_prev || ' -> ' || coalesce(p_new_status, 'null');
  end if;
  if p_new_status = 'out_for_delivery' and v_o.fulfillment_type <> 'delivery' then
    raise exception 'not_a_delivery_order';
  end if;
  if p_new_status = 'delivered' and v_prev = 'ready' and v_o.fulfillment_type = 'delivery' then
    raise exception 'delivery_must_go_out_first';
  end if;
  if p_new_status = 'cancelled' and v_note is null then raise exception 'cancel_reason_required'; end if;

  update public.orders set
    order_status          = p_new_status,
    confirmed_at          = case when p_new_status = 'confirmed' then now() else confirmed_at end,
    tracking_code         = case when p_new_status = 'confirmed' and tracking_code is null
                                 then public._new_tracking_code() else tracking_code end,
    cancelled_at          = case when p_new_status = 'cancelled' then now() else cancelled_at end,
    delivered_at          = case when p_new_status = 'delivered' then now() else delivered_at end,
    estimated_delivery_at = coalesce(p_eta, estimated_delivery_at)
  where id = p_order_id
  returning * into v_o;

  insert into public.order_status_history
    (order_id, previous_status, new_status, location_latitude, location_longitude,
     progress_note, estimated_delivery_at, updated_by)
  values (p_order_id, v_prev, p_new_status, p_lat, p_lng, v_note, p_eta, v_admin);

  return to_jsonb(v_o);
end $$;

-- ------------------------------------------------------------
-- Progress update WITHOUT changing the status: note, ETA, courier position.
create or replace function public.admin_add_progress(
  p_order_id uuid,
  p_note     text default null,
  p_lat      double precision default null,
  p_lng      double precision default null,
  p_eta      timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_admin uuid; v_o public.orders; v_note text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_admin := public.current_admin_id();

  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_o.order_status in ('pending', 'delivered', 'cancelled') then raise exception 'not_in_progress'; end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 500 then raise exception 'note_too_long'; end if;
  if (p_lat is null) <> (p_lng is null) then raise exception 'location_incomplete'; end if;
  if p_lat is not null and (p_lat not between -3.0 and -0.9 or p_lng not between 28.8 and 31.0) then
    raise exception 'location_outside_rwanda';
  end if;
  if v_note is null and p_lat is null and p_eta is null then raise exception 'nothing_to_update'; end if;

  if p_eta is not null then
    update public.orders set estimated_delivery_at = p_eta where id = p_order_id returning * into v_o;
  end if;

  insert into public.order_status_history
    (order_id, previous_status, new_status, location_latitude, location_longitude,
     progress_note, estimated_delivery_at, updated_by)
  values (p_order_id, v_o.order_status, v_o.order_status, p_lat, p_lng, v_note, p_eta, v_admin);

  return to_jsonb(v_o);
end $$;

-- ------------------------------------------------------------
create or replace function public.admin_set_delivery_fee(p_order_id uuid, p_fee numeric)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_admin uuid; v_o public.orders;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_admin := public.current_admin_id();
  if p_fee is null or p_fee < 0 or p_fee > 1000000 then raise exception 'invalid_fee'; end if;

  select * into v_o from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_o.order_status in ('delivered', 'cancelled') then raise exception 'order_closed'; end if;
  if exists (select 1 from public.payments where order_id = p_order_id and payment_status = 'paid') then
    raise exception 'locked_after_payment';
  end if;

  update public.orders set delivery_fee = p_fee where id = p_order_id returning * into v_o;
  update public.payments set amount = v_o.total_amount
   where order_id = p_order_id and payment_status in ('unpaid', 'pending_verification');

  insert into public.order_status_history
    (order_id, previous_status, new_status, progress_note, updated_by)
  values (p_order_id, v_o.order_status, v_o.order_status, 'Delivery fee set to ' || p_fee::bigint || ' RWF', v_admin);

  return to_jsonb(v_o);
end $$;

-- ------------------------------------------------------------
-- Admin checks the MoMo SMS / cash and marks the payment. Records who and when.
create or replace function public.admin_verify_payment(
  p_payment_id       uuid,
  p_status           text,                  -- 'paid' | 'failed' | 'refunded'
  p_notes            text default null,
  p_amount_received  numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_admin uuid; v_pay public.payments; v_notes text; v_ok boolean;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_admin := public.current_admin_id();
  if p_status is null or p_status not in ('paid', 'failed', 'refunded') then raise exception 'invalid_status'; end if;

  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment_not_found'; end if;

  v_ok := case v_pay.payment_status
    when 'unpaid'               then p_status in ('paid', 'failed')
    when 'pending_verification' then p_status in ('paid', 'failed')
    when 'paid'                 then p_status = 'refunded'
    when 'failed'               then p_status = 'paid'
    else false end;
  if not coalesce(v_ok, false) then
    raise exception 'invalid_payment_transition' using detail = v_pay.payment_status || ' -> ' || p_status;
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if v_notes is not null and char_length(v_notes) > 500 then raise exception 'note_too_long'; end if;
  if p_status in ('failed', 'refunded') and (v_notes is null or char_length(v_notes) < 3) then
    raise exception 'notes_required';
  end if;
  if p_status = 'paid' and p_amount_received is not null and p_amount_received < v_pay.amount then
    raise exception 'amount_too_low';
  end if;

  update public.payments
     set payment_status = p_status,
         verification_notes = coalesce(v_notes, verification_notes),
         verified_by = v_admin,
         verified_at = now()
   where id = p_payment_id
   returning * into v_pay;       -- trigger copies the status to orders.payment_status

  return to_jsonb(v_pay);
end $$;

-- ------------------------------------------------------------
create or replace function public.admin_set_internal_notes(p_order_id uuid, p_notes text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_o public.orders;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_notes is not null and char_length(p_notes) > 2000 then raise exception 'note_too_long'; end if;
  update public.orders set internal_notes = nullif(btrim(coalesce(p_notes, '')), '')
   where id = p_order_id returning * into v_o;
  if not found then raise exception 'order_not_found'; end if;
  return to_jsonb(v_o);
end $$;

-- ------------------------------------------------------------
create or replace function public.admin_dashboard_stats()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    select jsonb_build_object(
      'total_orders',        count(*),
      'pending',             count(*) filter (where order_status = 'pending'),
      'confirmed',           count(*) filter (where order_status = 'confirmed'),
      'preparing',           count(*) filter (where order_status = 'preparing'),
      'ready',               count(*) filter (where order_status = 'ready'),
      'out_for_delivery',    count(*) filter (where order_status = 'out_for_delivery'),
      'delivered',           count(*) filter (where order_status = 'delivered'),
      'cancelled',           count(*) filter (where order_status = 'cancelled'),
      'unpaid',              count(*) filter (where payment_status = 'unpaid' and order_status <> 'cancelled'),
      'pending_verification',count(*) filter (where payment_status = 'pending_verification'),
      'paid_orders',         count(*) filter (where payment_status = 'paid'),
      'revenue_paid',        coalesce(sum(total_amount) filter (where payment_status = 'paid'), 0))
    from public.orders);
end $$;

-- ------------------------------------------------------------
-- Paginated, filterable order list for the dashboard.
create or replace function public.admin_list_orders(
  p_search         text default null,    -- order reference or phone digits
  p_order_status   text default null,
  p_payment_status text default null,
  p_from           date default null,    -- Kigali dates, inclusive
  p_to             date default null,
  p_limit          int  default 25,
  p_offset         int  default 0
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_s text := nullif(btrim(coalesce(p_search, '')), '');
  v_digits text; v_like text; v_lim int; v_off int; v_total bigint; v_rows jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_lim := greatest(1, least(coalesce(p_limit, 25), 100));
  v_off := greatest(0, coalesce(p_offset, 0));
  v_digits := regexp_replace(coalesce(v_s, ''), '[^0-9]', '', 'g');
  v_like := '%' || replace(replace(replace(coalesce(v_s, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with f as (
    select o.* from public.orders o
     where (p_order_status   is null or o.order_status   = p_order_status)
       and (p_payment_status is null or o.payment_status = p_payment_status)
       and (p_from is null or o.created_at >= (p_from::timestamp at time zone 'Africa/Kigali'))
       and (p_to   is null or o.created_at <  ((p_to + 1)::timestamp at time zone 'Africa/Kigali'))
       and (v_s is null
            or o.order_number ilike v_like
            or (char_length(v_digits) >= 3 and o.customer_phone like '%' || v_digits || '%'))
  ), pg as (
    select * from f order by created_at desc limit v_lim offset v_off
  )
  select (select count(*) from f),
         coalesce((select jsonb_agg(
             to_jsonb(pg) || jsonb_build_object(
               'payment_method', (select p.payment_method from public.payments p
                                   where p.order_id = pg.id order by p.created_at desc limit 1))
             order by pg.created_at desc) from pg), '[]'::jsonb)
    into v_total, v_rows;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows);
end $$;
