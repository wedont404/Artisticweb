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
