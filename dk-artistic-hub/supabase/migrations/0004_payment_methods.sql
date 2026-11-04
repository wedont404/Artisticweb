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
