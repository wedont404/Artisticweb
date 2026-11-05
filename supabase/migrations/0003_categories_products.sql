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
