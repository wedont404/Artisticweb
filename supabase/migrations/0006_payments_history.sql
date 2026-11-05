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
