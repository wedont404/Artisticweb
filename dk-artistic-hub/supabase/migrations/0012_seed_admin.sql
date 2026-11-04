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
