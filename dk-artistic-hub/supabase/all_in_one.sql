-- ======================================================================
-- DK ARTISTIC HUB - COMPLETE DATABASE  (all tables, security, functions, seed)
-- Paste this WHOLE file into Supabase -> SQL Editor -> Run. That is all.
--
--  * Runs as ONE transaction: everything is saved, or nothing is.
--  * Safe to run again any time (it never deletes data or overwrites your edits).
--  * EDIT THE ADMIN EMAIL on the line below BEFORE running (comma separated for more).
-- ======================================================================
begin;

select set_config('dk.admin_emails', 'REPLACE_WITH_YOUR_EMAIL@example.com', true);


-- >>>>>>>>>> 0001_helpers.sql <<<<<<<<<<
-- ============================================================
-- 0001  HELPERS: updated_at trigger, Rwanda phone normalizer,
--       rate limiting, client key
-- Safe to re-run (idempotent).
-- ============================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Accepts: +250788123456, 250788123456, 0788123456, 788123456
-- Returns +2507XXXXXXXX or NULL when invalid. Valid prefixes: 72 73 (Airtel) 78 79 (MTN).
create or replace function public.normalize_rw_phone(p text)
returns text language plpgsql immutable as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '[^0-9]', '', 'g');
  if d like '250%' and length(d) = 12 then
    null;
  elsif d like '0%' and length(d) = 10 then
    d := '250' || substr(d, 2);
  elsif length(d) = 9 then
    d := '250' || d;
  else
    return null;
  end if;
  if d !~ '^2507[2389][0-9]{7}$' then return null; end if;
  return '+' || d;
end $$;

-- ---------- rate limiting (no direct access: RLS on, zero policies) ----------
create table if not exists public.rate_limit_events (
  id         bigint generated always as identity primary key,
  bucket     text        not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_events_bucket_idx
  on public.rate_limit_events (bucket, created_at desc);
alter table public.rate_limit_events enable row level security;

create or replace function public.client_key()
returns text language plpgsql stable as $$
declare h json; ip text;
begin
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    h := null;
  end;
  ip := coalesce(h->>'cf-connecting-ip', split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1));
  return coalesce(nullif(btrim(ip), ''), 'unknown');
end $$;

-- Records one hit; raises 'rate_limited' when the bucket is full.
create or replace function public.rl_hit(p_bucket text, p_max int, p_window interval)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if random() < 0.02 then
    delete from public.rate_limit_events where created_at < now() - interval '1 day';
  end if;
  select count(*) into n from public.rate_limit_events
   where bucket = p_bucket and created_at > now() - p_window;
  if n >= p_max then
    raise exception 'rate_limited';
  end if;
  insert into public.rate_limit_events (bucket) values (p_bucket);
end $$;


-- >>>>>>>>>> 0002_admin_users.sql <<<<<<<<<<
-- ============================================================
-- 0002  TABLE admin_users  (administrator allowlist)
-- Customers never get accounts. Only emails listed here can become admins.
-- NOTE: also turn OFF "Allow new users to sign up" in Supabase
--       Dashboard -> Authentication -> Providers -> Email.
-- ============================================================

create table if not exists public.admin_users (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete cascade,
  email        text not null,
  role         text not null default 'staff',
  created_at   timestamptz not null default now(),
  constraint admin_users_role_chk  check (role in ('owner', 'staff')),
  constraint admin_users_email_chk check (email = lower(btrim(email)) and position('@' in email) > 1)
);
create unique index if not exists admin_users_email_uidx on public.admin_users (email);

-- ---------- role helpers (used by every RLS policy) ----------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.admin_users a where a.auth_user_id = auth.uid());
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.admin_users a where a.auth_user_id = auth.uid() and a.role = 'owner');
$$;

create or replace function public.current_admin_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select a.id from public.admin_users a where a.auth_user_id = auth.uid();
$$;

-- Called by the admin login page right after sign-in. Links the signed-in,
-- email-confirmed auth user to the pre-authorized admin row. Returns true if admin.
create or replace function public.claim_admin()
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_email text;
begin
  if v_uid is null then return false; end if;
  select lower(btrim(u.email)) into v_email
    from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then return false; end if;
  update public.admin_users
     set auth_user_id = v_uid
   where email = v_email and auth_user_id is null;
  return exists (select 1 from public.admin_users where auth_user_id = v_uid);
end $$;

-- Auto-link when an allowlisted email signs up / confirms (no public admin creation:
-- this only LINKS an existing allowlist row, it never creates one).
create or replace function public.link_admin_on_signup()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.email_confirmed_at is not null and new.email is not null then
    update public.admin_users
       set auth_user_id = new.id
     where email = lower(btrim(new.email)) and auth_user_id is null;
  end if;
  return new;
end $$;

do $$
begin
  drop trigger if exists dk_link_admin on auth.users;
  create trigger dk_link_admin
    after insert or update of email_confirmed_at on auth.users
    for each row execute function public.link_admin_on_signup();
exception when insufficient_privilege then
  raise notice 'Could not create trigger on auth.users (permissions). Admins will be linked by claim_admin() at login instead.';
end $$;

-- ---------- RLS ----------
alter table public.admin_users enable row level security;
drop policy if exists admin_users_select on public.admin_users;
drop policy if exists admin_users_owner_write on public.admin_users;
create policy admin_users_select on public.admin_users
  for select to authenticated using (public.is_admin());
create policy admin_users_owner_write on public.admin_users
  for all to authenticated using (public.is_owner()) with check (public.is_owner());


-- >>>>>>>>>> 0003_categories_products.sql <<<<<<<<<<
-- ============================================================
-- 0003  TABLES categories + products  (public menu)
-- ============================================================

create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  emoji       text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint categories_name_chk check (char_length(btrim(name)) between 1 and 60)
);
create unique index if not exists categories_name_uidx on public.categories (lower(name));

create table if not exists public.products (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references public.categories (id) on delete restrict,
  name         text not null,
  description  text,
  price        numeric(12,2) not null,
  image_url    text,
  emoji        text,
  tag          text,
  sort_order   integer not null default 0,
  is_active    boolean not null default true,    -- visible on the menu
  is_available boolean not null default true,    -- in stock right now
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint products_name_chk  check (char_length(btrim(name)) between 1 and 100),
  constraint products_price_chk check (price >= 0 and price <= 10000000),
  constraint products_image_chk check (image_url is null or image_url ~* '^(https://|img/|/)')
);
create unique index if not exists products_category_name_uidx on public.products (category_id, lower(name));
create index if not exists products_category_idx on public.products (category_id);
create index if not exists products_visible_idx  on public.products (is_active, is_available);

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at before update on public.products
  for each row execute function public.set_updated_at();

-- ---------- RLS ----------
alter table public.categories enable row level security;
alter table public.products   enable row level security;

drop policy if exists categories_public_read  on public.categories;
drop policy if exists categories_admin_write  on public.categories;
create policy categories_public_read on public.categories
  for select to anon, authenticated using (is_active or public.is_admin());
create policy categories_admin_write on public.categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists products_public_read on public.products;
drop policy if exists products_admin_write on public.products;
create policy products_public_read on public.products
  for select to anon, authenticated
  using (
    public.is_admin()
    or (is_active and exists (select 1 from public.categories c where c.id = category_id and c.is_active))
  );
create policy products_admin_write on public.products
  for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- >>>>>>>>>> 0004_payment_methods.sql <<<<<<<<<<
-- ============================================================
-- 0004  TABLE payment_methods  (admin-configurable payment instructions)
-- ============================================================

create table if not exists public.payment_methods (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  name               text not null,
  instructions       text,
  requires_reference boolean not null default true,   -- false for cash on delivery
  is_active          boolean not null default true,
  sort_order         integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint payment_methods_code_chk check (code ~ '^[a-z0-9_]{2,30}$'),
  constraint payment_methods_name_chk check (char_length(btrim(name)) between 1 and 60)
);

drop trigger if exists payment_methods_set_updated_at on public.payment_methods;
create trigger payment_methods_set_updated_at before update on public.payment_methods
  for each row execute function public.set_updated_at();

alter table public.payment_methods enable row level security;
drop policy if exists payment_methods_public_read on public.payment_methods;
drop policy if exists payment_methods_admin_write on public.payment_methods;
create policy payment_methods_public_read on public.payment_methods
  for select to anon, authenticated using (is_active or public.is_admin());
create policy payment_methods_admin_write on public.payment_methods
  for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- >>>>>>>>>> 0005_orders.sql <<<<<<<<<<
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


-- >>>>>>>>>> 0006_payments_history.sql <<<<<<<<<<
-- ============================================================
-- 0006  TABLES payments + order_status_history
-- Order status and payment status are INDEPENDENT.
-- A submitted order is never auto-marked paid.
-- ============================================================

create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders (id) on delete cascade,
  payment_method     text not null references public.payment_methods (code) on update cascade,
  amount             numeric(12,2) not null,
  payment_reference  text,                       -- e.g. MoMo transaction ID given by the customer
  payment_status     text not null default 'unpaid',
  verification_notes text,
  verified_by        uuid references public.admin_users (id) on delete set null,
  verified_at        timestamptz,
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default now(),
  constraint payments_amount_chk check (amount >= 0),
  constraint payments_status_chk check (payment_status in
    ('unpaid','pending_verification','paid','failed','refunded')),
  constraint payments_ref_chk check (payment_reference is null or payment_reference ~ '^[A-Za-z0-9._-]{4,64}$'),
  constraint payments_notes_chk check (verification_notes is null or char_length(verification_notes) <= 500),
  constraint payments_verified_chk check (
    payment_status in ('unpaid', 'pending_verification') or verified_at is not null
  )
);
create index if not exists payments_order_idx on public.payments (order_id);
-- only ONE live payment per order (prevents duplicate payments)
create unique index if not exists payments_one_live_per_order
  on public.payments (order_id) where payment_status in ('unpaid', 'pending_verification', 'paid');
-- the same MoMo reference can never be claimed twice
create unique index if not exists payments_reference_uidx
  on public.payments (lower(payment_reference))
  where payment_reference is not null and payment_status in ('pending_verification', 'paid');

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

-- keep orders.payment_status in sync with the live payment row
create or replace function public.sync_order_payment_status()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.orders
     set payment_status = new.payment_status
   where id = new.order_id and payment_status is distinct from new.payment_status;
  return null;
end $$;

drop trigger if exists payments_sync_order on public.payments;
create trigger payments_sync_order
  after insert or update of payment_status on public.payments
  for each row execute function public.sync_order_payment_status();

create table if not exists public.order_status_history (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders (id) on delete cascade,
  previous_status       text,
  new_status            text not null,
  location_latitude     double precision,
  location_longitude    double precision,
  progress_note         text,                    -- visible to the customer on the tracking page
  estimated_delivery_at timestamptz,
  updated_by            uuid references public.admin_users (id) on delete set null,
  created_at            timestamptz not null default clock_timestamp(),   -- real clock: keeps order even inside one transaction
  constraint osh_prev_chk check (previous_status is null or previous_status in
    ('pending','confirmed','preparing','ready','out_for_delivery','delivered','cancelled')),
  constraint osh_new_chk  check (new_status in
    ('pending','confirmed','preparing','ready','out_for_delivery','delivered','cancelled')),
  constraint osh_loc_chk  check ((location_latitude is null) = (location_longitude is null)),
  constraint osh_note_chk check (progress_note is null or char_length(progress_note) <= 500)
);
create index if not exists osh_order_idx on public.order_status_history (order_id, created_at desc);

-- history is append-only
create or replace function public.block_history_update()
returns trigger language plpgsql as $$
begin
  raise exception 'order_status_history is append-only';
end $$;
drop trigger if exists osh_no_update on public.order_status_history;
create trigger osh_no_update before update on public.order_status_history
  for each row execute function public.block_history_update();

-- ---------- RLS: admin read only ----------
alter table public.payments             enable row level security;
alter table public.order_status_history enable row level security;

drop policy if exists payments_admin_read on public.payments;
create policy payments_admin_read on public.payments
  for select to authenticated using (public.is_admin());

drop policy if exists osh_admin_read on public.order_status_history;
create policy osh_admin_read on public.order_status_history
  for select to authenticated using (public.is_admin());


-- >>>>>>>>>> 0007_public_functions.sql <<<<<<<<<<
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


-- >>>>>>>>>> 0008_admin_functions.sql <<<<<<<<<<
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


-- >>>>>>>>>> 0009_privileges.sql <<<<<<<<<<
-- ============================================================
-- 0009  PRIVILEGES  (lock everything, then open only what is needed)
-- Public visitors (anon) can: read the active menu + payment methods,
-- and call create_order / track_order / submit_payment_reference.
-- They can NOT read or write orders, payments, items or history.
-- ============================================================

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- future objects created in this schema start locked too
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---- tables ----
grant select on public.categories, public.products, public.payment_methods to anon, authenticated;
grant insert, update, delete on public.categories, public.products, public.payment_methods to authenticated;
grant select, insert, update, delete on public.admin_users to authenticated;
grant select on public.orders, public.order_items, public.payments, public.order_status_history to authenticated;
-- (rate_limit_events and order_counters: no grants at all)

-- ---- helpers that RLS policies call ----
grant execute on function public.is_admin(), public.is_owner() to anon, authenticated;

-- ---- public (no login) ----
grant execute on function
  public.create_order(text, text, text, text, double precision, double precision, text, text, jsonb, text, text),
  public.submit_payment_reference(text, text, text),
  public.track_order(text, text)
to anon, authenticated;

-- ---- administrators (each function re-checks is_admin()) ----
grant execute on function
  public.claim_admin(),
  public.admin_set_order_status(uuid, text, text, double precision, double precision, timestamptz),
  public.admin_add_progress(uuid, text, double precision, double precision, timestamptz),
  public.admin_set_delivery_fee(uuid, numeric),
  public.admin_verify_payment(uuid, text, text, numeric),
  public.admin_set_internal_notes(uuid, text),
  public.admin_dashboard_stats(),
  public.admin_list_orders(text, text, text, date, date, int, int)
to authenticated;


-- >>>>>>>>>> 0010_storage.sql <<<<<<<<<<
-- ============================================================
-- 0010  STORAGE bucket for product photos
-- Anyone can VIEW photos (public bucket). Only admins can upload/replace/delete.
-- Max 1 MB, webp / jpeg / png only (keeps the site fast on mobile data).
-- ============================================================

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then

    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-images', 'product-images', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    drop policy if exists "dk product images admin write" on storage.objects;
    create policy "dk product images admin write" on storage.objects
      for all to authenticated
      using (bucket_id = 'product-images' and public.is_admin())
      with check (bucket_id = 'product-images' and public.is_admin());
  else
    raise notice 'storage schema not found - skipping product-images bucket (not Supabase?)';
  end if;
exception when insufficient_privilege then
  raise notice 'No permission to configure storage - create a public bucket named product-images in the dashboard.';
end $$;


-- >>>>>>>>>> 0011_seed_menu.sql <<<<<<<<<<
-- ============================================================
-- 0011  SEED: categories, menu, payment methods
-- Uses "do nothing" on conflict, so re-running NEVER overwrites
-- prices or text that you edited later.
-- Menu = the current website items. Replace with your real menu any time
-- from the admin dashboard (or edit this file before the first run).
-- ============================================================

insert into public.categories (name, emoji, sort_order) values
  ('Brochettes',    '🍢', 1),
  ('Burgers',       '🍔', 2),
  ('Sides & Fries', '🍟', 3),
  ('Beers',         '🍺', 4),
  ('Cocktails',     '🍹', 5)
on conflict (lower(name)) do nothing;

insert into public.products (category_id, name, description, price, emoji, tag, sort_order)
select c.id, v.name, v.descr, v.price, v.emoji, v.tag, v.ord
from (values
  ('Brochettes',    'Brochettes',            'Traditional grilled meat skewers with spices and vegetables.',          1000, '🍢', 'Popular', 1),
  ('Brochettes',    'Double-Beef Brochette', 'Double portion of tender beef with special seasoning.',                  2000, '🍢', 'Popular', 2),
  ('Brochettes',    'Pork Brochettes',       'Juicy pork skewers marinated in local spices.',                         7000, '🥓', null,      3), -- check this price
  ('Burgers',       'DK Special Burger',     'Double beef patty, cheese, lettuce, tomato, special sauce on brioche.', 8500, '🍔', 'Popular', 1),
  ('Burgers',       'Chicken Burger',        'Grilled chicken breast with lettuce, tomato and mayo.',                 6500, '🥪', null,      2),
  ('Sides & Fries', 'Loaded Fries',          'Crispy fries with cheese, bacon bits and street sauce.',                2500, '🍟', 'Popular', 1),
  ('Sides & Fries', 'Street Fries',          'Classic crispy fries with salt and pepper.',                            1500, '🍟', null,      2),
  ('Beers',         'Mutzig',                'Ice-cold, Rwanda''s favourite.',                                        1500, '🍺', null,      1),
  ('Beers',         'Primus',                'Fresh and served ice-cold.',                                            1500, '🍺', null,      2),
  ('Beers',         'Turbo King',            'Strong beer for extra kick.',                                           2000, '🍻', null,      3),
  ('Cocktails',     'DK Signature Cocktail', 'House mix with premium spirits and fresh fruit.',                       8000, '🍹', 'Popular', 1),
  ('Cocktails',     'Street Mojito',         'Fresh mint, lime, rum and soda with a street twist.',                   7000, '🍸', null,      2)
) as v(cat, name, descr, price, emoji, tag, ord)
join public.categories c on lower(c.name) = lower(v.cat)
on conflict (category_id, (lower(name))) do nothing;

insert into public.payment_methods (code, name, instructions, requires_reference, is_active, sort_order) values
  ('mtn_momo',        'MTN Mobile Money',
   'Dial *182*8*016804# and pay the total we confirm on WhatsApp. Keep the MoMo SMS and send us the transaction reference.',
   true,  true,  1),
  ('airtel_money',    'Airtel Money',
   'Not set up yet. An admin can fill in the instructions and turn it on.',
   true,  false, 2),
  ('cash_on_delivery','Cash on delivery',
   'Pay in cash to the rider (or at the counter for pickup).',
   false, true,  3)
on conflict (code) do nothing;


-- >>>>>>>>>> 0012_seed_admin.sql <<<<<<<<<<
-- ============================================================
-- 0012  SEED: first administrator(s)  (the allowlist)
-- Reads the emails from the setting  dk.admin_emails  (comma separated).
-- In all_in_one.sql that setting is the FIRST line of the file - edit it there.
-- This only ADDS emails to the allowlist. The person then creates their
-- password in Supabase (Authentication -> Users -> Invite user), confirms
-- the email, and is linked automatically.
-- ============================================================

do $$
declare
  v_raw text := coalesce(current_setting('dk.admin_emails', true), '');
  v_email text;
  v_added int := 0;
begin
  foreach v_email in array string_to_array(v_raw, ',') loop
    v_email := lower(btrim(v_email));
    if v_email = '' or v_email like 'replace_with%' or position('@' in v_email) < 2 then
      continue;
    end if;
    insert into public.admin_users (email, role) values (v_email, 'owner')
      on conflict (email) do nothing;
    v_added := v_added + 1;
  end loop;

  if v_added = 0 then
    raise notice 'No admin email set. Add one with:  insert into public.admin_users (email, role) values (''you@example.com'', ''owner'');';
  end if;

  -- link anyone who already has a confirmed auth account
  update public.admin_users a
     set auth_user_id = u.id
    from auth.users u
   where a.auth_user_id is null
     and lower(btrim(u.email)) = a.email
     and u.email_confirmed_at is not null;
end $$;

commit;
