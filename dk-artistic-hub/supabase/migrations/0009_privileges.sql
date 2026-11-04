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
