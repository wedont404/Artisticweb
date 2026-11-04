-- ============================================================
-- 0005  TABLES order_counters + orders + order_items
-- Customers can NOT read or write these directly. Orders are created only
-- by the create_order() function, which recalculates all prices server-side.
-- ============================================================

-- yearly counter -> DK-2026-00001
create table if not exists public.order_counters (
  year       integer primary key,
  last_value integer not null default 0
);
alter table public.order_counters enable row level security;   -- no policies = no access

create or replace function public.next_order_number()
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare y int := extract(year from (now() at time zone 'Africa/Kigali'))::int; n int;
begin
  insert into public.order_counters (year, last_value) values (y, 1)
  on conflict (year) do update set last_value = public.order_counters.last_value + 1
  returning last_value into n;
  return 'DK-' || y || '-' || lpad(n::text, 5, '0');
end $$;

create or replace function public._new_tracking_code()
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare c text;
begin
  loop
    c := 'TRK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.orders where tracking_code = c);
  end loop;
  return c;
end $$;

create table if not exists public.orders (
  id                    uuid primary key default gen_random_uuid(),
  order_number          text not null unique,
  idempotency_key       text unique,                -- blocks duplicate submissions
  tracking_code         text unique,                -- created when admin confirms
  customer_name         text not null,
  customer_phone        text not null,              -- normalized +2507XXXXXXXX
  fulfillment_type      text not null default 'delivery',
  delivery_address      text,
  delivery_latitude     double precision,
  delivery_longitude    double precision,
  google_place_id       text,
  delivery_instructions text,
  subtotal              numeric(12,2) not null default 0,
  delivery_fee          numeric(12,2) not null default 0,
  total_amount          numeric(12,2) generated always as (subtotal + delivery_fee) stored,
  order_status          text not null default 'pending',
  payment_status        text not null default 'unpaid',
  estimated_delivery_at timestamptz,
  internal_notes        text,                       -- staff only, never shown to customers
  confirmed_at          timestamptz,
  cancelled_at          timestamptz,
  delivered_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint orders_name_chk   check (char_length(btrim(customer_name)) between 2 and 80),
  constraint orders_phone_chk  check (customer_phone ~ '^\+2507[2389][0-9]{7}$'),
  constraint orders_fulfil_chk check (fulfillment_type in ('delivery', 'pickup', 'dine_in')),
  constraint orders_status_chk check (order_status in
    ('pending','confirmed','preparing','ready','out_for_delivery','delivered','cancelled')),
  constraint orders_pay_chk    check (payment_status in
    ('unpaid','pending_verification','paid','failed','refunded')),
  constraint orders_money_chk  check (subtotal >= 0 and delivery_fee >= 0 and delivery_fee <= 1000000),
  constraint orders_lat_chk    check (delivery_latitude  is null or delivery_latitude  between -90 and 90),
  constraint orders_lng_chk    check (delivery_longitude is null or delivery_longitude between -180 and 180),
  constraint orders_instr_chk  check (delivery_instructions is null or char_length(delivery_instructions) <= 500),
  constraint orders_notes_chk  check (internal_notes is null or char_length(internal_notes) <= 2000),
  -- a delivery order MUST have an address and exact coordinates
  constraint orders_delivery_location_chk check (
    fulfillment_type <> 'delivery'
    or (delivery_address is not null and char_length(btrim(delivery_address)) >= 3
        and delivery_latitude is not null and delivery_longitude is not null)
  ),
  -- anything past 'pending' (except cancel) must have been confirmed
  constraint orders_confirmed_chk check (order_status in ('pending', 'cancelled') or confirmed_at is not null)
);
create index if not exists orders_created_idx        on public.orders (created_at desc);
create index if not exists orders_status_idx         on public.orders (order_status, created_at desc);
create index if not exists orders_payment_status_idx on public.orders (payment_status, created_at desc);
create index if not exists orders_phone_idx          on public.orders (customer_phone);

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create table if not exists public.order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders (id) on delete cascade,
  product_id            uuid references public.products (id) on delete set null,
  product_name_snapshot text not null,                       -- survives product edits/deletes
  quantity              integer not null,
  unit_price            numeric(12,2) not null,              -- price snapshot, set by the server
  total_price           numeric(12,2) generated always as (quantity * unit_price) stored,
  created_at            timestamptz not null default clock_timestamp(),
  constraint order_items_qty_chk   check (quantity between 1 and 99),
  constraint order_items_price_chk check (unit_price >= 0)
);
create index if not exists order_items_order_idx on public.order_items (order_id);
create unique index if not exists order_items_order_product_uidx
  on public.order_items (order_id, product_id) where product_id is not null;

-- ---------- RLS: admin read only; all writes go through functions ----------
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

drop policy if exists orders_admin_read on public.orders;
create policy orders_admin_read on public.orders
  for select to authenticated using (public.is_admin());

drop policy if exists order_items_admin_read on public.order_items;
create policy order_items_admin_read on public.order_items
  for select to authenticated using (public.is_admin());
