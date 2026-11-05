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
