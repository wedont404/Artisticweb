-- ======================================================================
-- DK ARTISTIC HUB - DATABASE SELF-TEST  (permissions + the whole order journey)
-- Run AFTER all_in_one.sql. Everything it creates is ROLLED BACK at the end,
-- so no test data stays in your database.
-- It stops with an error on the first failed check; if it ends with
-- "ALL CHECKS PASSED" the database is behaving as designed.
-- ======================================================================
begin;

do $verify$
declare
  v_p1 uuid; v_p2 uuid; v_price1 numeric; v_price2 numeric; v_expected numeric;
  v_admin_uid uuid := gen_random_uuid();
  v_claim_uid uuid := gen_random_uuid();
  v_other_uid uuid := gen_random_uuid();
  v_can_admin boolean := true;
  v_o1 jsonb; v_o2 jsonb; v_res jsonb; v_n1 text; v_n2 text; v_id1 uuid; v_id2 uuid; v_pay uuid;
  v_cnt int; v_t text; r record; v_i int;
begin
  -- ============ A. STRUCTURE ============
  foreach v_t in array array['admin_users','categories','products','payment_methods','order_counters',
                             'orders','order_items','payments','order_status_history','rate_limit_events'] loop
    assert to_regclass('public.' || v_t) is not null, format('table %s is missing', v_t);
    assert (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.' || v_t)),
           format('RLS is NOT enabled on %s', v_t);
  end loop;
  raise notice 'PASS A  all 10 tables exist and have Row Level Security enabled';

  select id, price into v_p1, v_price1 from public.products where lower(name) = 'brochettes' limit 1;
  select id, price into v_p2, v_price2 from public.products where lower(name) = 'loaded fries' limit 1;
  assert v_p1 is not null and v_p2 is not null, 'seed menu missing (Brochettes / Loaded Fries)';

  -- test administrators (allowlist row first, then the auth user -> trigger links them)
  insert into public.admin_users (email, role) values ('verify-admin@example.test', 'staff');
  begin
    insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'verify-admin@example.test', now());
    insert into auth.users (id, email, email_confirmed_at) values (v_claim_uid, 'verify-claim@example.test', now());
    insert into auth.users (id, email, email_confirmed_at) values (v_other_uid, 'verify-other@example.test', now());
  exception when others then
    v_can_admin := false;
    raise notice 'NOTE  could not create test auth users (%). Admin-role tests are SKIPPED.', sqlerrm;
  end;
  insert into public.admin_users (email, role) values ('verify-claim@example.test', 'staff');

  -- ============ B. VISITOR (anon) ============
  execute 'set local role anon';

  select count(*) into v_cnt from public.categories;  assert v_cnt >= 1, 'anon cannot read the menu categories';
  select count(*) into v_cnt from public.products;    assert v_cnt >= 1, 'anon cannot read the menu';
  select count(*) into v_cnt from public.payment_methods; assert v_cnt >= 1, 'anon cannot read payment methods';
  raise notice 'PASS B1 visitors can read the public menu and payment methods';

  foreach v_t in array array['orders','order_items','payments','order_status_history','admin_users','rate_limit_events','order_counters'] loop
    begin
      execute format('select count(*) from public.%I', v_t);
      raise exception 'LEAK: anon could read %', v_t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    insert into public.products (category_id, name, price) values (gen_random_uuid(), 'hack', 1);
    raise exception 'LEAK: anon could insert a product';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.orders (order_number, customer_name, customer_phone) values ('DK-2026-99999', 'x', '+250788000000');
    raise exception 'LEAK: anon could insert an order directly';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS B2 visitors cannot read or write orders, payments, items, history, admins, counters';

  -- every bad order must be rejected with the exact reason
  for r in select * from (values
    ('bad phone',        'invalid_phone',                'Aline', '0123',        'pickup',   null,      null::numeric, null::numeric, jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'mtn_momo'),
    ('short name',       'invalid_name',                 'A',     '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'mtn_momo'),
    ('bad fulfillment',  'invalid_fulfillment_type',     'Aline', '0788123456',  'teleport', null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'mtn_momo'),
    ('delivery no addr', 'delivery_address_required',    'Aline', '0788123456',  'delivery', null,      -1.94,         30.06,         jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'mtn_momo'),
    ('delivery no gps',  'delivery_location_required',   'Aline', '0788123456',  'delivery', 'Masoro',  null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'mtn_momo'),
    ('outside rwanda',   'delivery_location_outside_rwanda','Aline','0788123456','delivery', 'Masoro',  48.85,         2.35,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'mtn_momo'),
    ('empty cart',       'invalid_items',                'Aline', '0788123456',  'pickup',   null,      null,          null,          '[]'::jsonb, 'mtn_momo'),
    ('not an array',     'invalid_items',                'Aline', '0788123456',  'pickup',   null,      null,          null,          '{"a":1}'::jsonb, 'mtn_momo'),
    ('zero qty',         'invalid_quantity',             'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 0)), 'mtn_momo'),
    ('negative qty',     'invalid_quantity',             'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', -3)), 'mtn_momo'),
    ('fractional qty',   'invalid_quantity',             'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1.5)), 'mtn_momo'),
    ('huge qty',         'invalid_quantity',             'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 5000)), 'mtn_momo'),
    ('bad product id',   'invalid_items',                'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', 'not-a-uuid', 'quantity', 1)), 'mtn_momo'),
    ('unknown product',  'item_unavailable',             'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', gen_random_uuid(), 'quantity', 1)), 'mtn_momo'),
    ('bad pay method',   'invalid_payment_method',       'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'bitcoin'),
    ('inactive method',  'invalid_payment_method',       'Aline', '0788123456',  'pickup',   null,      null,          null,          jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'airtel_money')
  ) as t(label, expect, nm, ph, ft, ad, la, ln, items, pm)
  loop
    begin
      perform public.create_order(r.nm, r.ph, r.ft, r.ad, r.la::double precision, r.ln::double precision, null, null, r.items, r.pm, null);
      raise exception 'NO_ERROR';
    exception when others then
      assert sqlerrm = r.expect, format('case "%s": expected %s but got %s', r.label, r.expect, sqlerrm);
    end;
  end loop;
  raise notice 'PASS B3 16 kinds of bad orders are all rejected with the right reason';

  -- a good pickup order; the browser tries to cheat with its own prices and duplicate lines
  v_expected := v_price1 * 2 + v_price2;
  v_o1 := public.create_order('Aline Test', '0788123456', 'pickup', null, null, null, null, null,
            jsonb_build_array(
              jsonb_build_object('product_id', v_p1, 'quantity', 1, 'unit_price', 1, 'price', 1),
              jsonb_build_object('product_id', v_p1, 'quantity', 1, 'unit_price', 1),
              jsonb_build_object('product_id', v_p2, 'quantity', 1, 'unit_price', 1)),
            'mtn_momo', 'verify-key-1');
  v_n1 := v_o1->>'order_number';
  assert v_n1 ~ '^DK-[0-9]{4}-[0-9]{5}$', 'bad order number format: ' || v_n1;
  assert (v_o1->>'subtotal')::numeric = v_expected, format('subtotal %s, expected %s (browser prices must be ignored)', v_o1->>'subtotal', v_expected);
  assert v_o1->>'order_status' = 'pending' and v_o1->>'payment_status' = 'unpaid', 'new order must be pending + unpaid';
  raise notice 'PASS B4 order % created; prices recalculated on the server (% RWF)', v_n1, v_expected;

  v_res := public.create_order('Aline Test', '0788123456', 'pickup', null, null, null, null, null,
            jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 9)), 'mtn_momo', 'verify-key-1');
  assert v_res->>'order_number' = v_n1 and (v_res->>'replayed')::boolean, 'duplicate submission created a second order';
  begin
    perform public.create_order('Someone Else', '0731234567', 'pickup', null, null, null, null, null,
            jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)), 'mtn_momo', 'verify-key-1');
    raise exception 'NO_ERROR';
  exception when others then
    assert sqlerrm = 'idempotency_conflict', 'same key + different phone must be refused, got ' || sqlerrm;
  end;
  raise notice 'PASS B5 duplicate order submission returns the same order (no double order)';

  v_o2 := public.create_order('Eric Test', '+250 731 234 567', 'delivery', 'Masoro, near the church', -1.9441, 30.0619, 'ChIJtest', 'Blue gate',
            jsonb_build_array(jsonb_build_object('product_id', v_p2, 'quantity', 3)), 'cash_on_delivery', 'verify-key-2');
  v_n2 := v_o2->>'order_number';
  assert v_n2 <> v_n1 and (v_o2->>'subtotal')::numeric = v_price2 * 3, 'second order wrong';

  -- tracking before the admin confirms
  v_res := public.track_order(v_n1, '0788123456');
  assert (v_res->>'found')::boolean and not (v_res->>'tracking_available')::boolean
         and v_res->>'message' = 'awaiting_confirmation', 'tracking must be unavailable before confirmation';
  assert not (public.track_order(v_n1, '0731234567')->>'found')::boolean, 'wrong phone must not find the order';
  assert not (public.track_order('DK-2026-77777', '0788123456')->>'found')::boolean, 'unknown order must not be found';
  assert not (public.track_order('garbage', 'garbage')->>'found')::boolean, 'garbage input must not be found';
  assert public.track_order(v_n1, '0788123456') ? 'delivery_latitude' = false, 'unconfirmed tracking must not leak details';
  raise notice 'PASS B6 tracking needs order number + the right phone, and stays closed until confirmed';

  -- payments: customer submits a MoMo reference -> pending_verification (never paid)
  assert not (public.submit_payment_reference(v_n1, '0731234567', 'MP20260101')->>'found')::boolean, 'wrong phone accepted a reference';
  v_res := public.submit_payment_reference(v_n1, '0788123456', 'MP20260101');
  assert v_res->>'payment_status' = 'pending_verification', 'reference must move payment to pending_verification';
  begin
    perform public.submit_payment_reference(v_n2, '0731234567', 'MP20260101');
    raise exception 'NO_ERROR';
  exception when others then
    assert sqlerrm in ('reference_already_used', 'reference_not_required'), 'reused reference must be refused, got ' || sqlerrm;
  end;
  begin
    perform public.submit_payment_reference(v_n1, '0788123456', 'a b!');
    raise exception 'NO_ERROR';
  exception when others then
    assert sqlerrm = 'invalid_reference', 'bad reference format must be refused, got ' || sqlerrm;
  end;
  raise notice 'PASS B7 payment reference -> pending_verification; reused/invalid references refused';

  -- ============ C. SIGNED-IN BUT NOT AN ADMIN ============
  if v_can_admin then
    execute 'reset role';
    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_other_uid::text, true);

    select count(*) into v_cnt from public.orders;
    assert v_cnt = 0, 'non-admin can see orders!';
    select count(*) into v_cnt from public.payments;
    assert v_cnt = 0, 'non-admin can see payments!';
    begin perform public.admin_dashboard_stats(); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'forbidden', 'non-admin ran admin_dashboard_stats: ' || sqlerrm; end;
    begin perform public.admin_set_order_status(gen_random_uuid(), 'confirmed'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'forbidden', 'non-admin ran admin_set_order_status: ' || sqlerrm; end;
    begin perform public.admin_verify_payment(gen_random_uuid(), 'paid'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'forbidden', 'non-admin ran admin_verify_payment: ' || sqlerrm; end;
    begin insert into public.products (category_id, name, price) select id, 'hack', 1 from public.categories limit 1; raise exception 'NO_ERROR';
    exception when others then assert sqlstate = '42501', 'non-admin could write products: ' || sqlerrm; end;
    begin insert into public.admin_users (email, role) values ('evil@example.test', 'owner'); raise exception 'NO_ERROR';
    exception when others then assert sqlstate = '42501', 'non-admin could add an admin: ' || sqlerrm; end;
    assert public.claim_admin() = false, 'claim_admin must be false for a non-allowlisted user';
    raise notice 'PASS C  signed-in non-admins see no orders and cannot run any admin action';

    -- ============ D. ADMINISTRATOR ============
    perform set_config('request.jwt.claim.sub', v_claim_uid::text, true);
    assert public.claim_admin() = true, 'allowlisted user could not claim admin';
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    assert public.claim_admin() = true, 'trigger-linked admin not recognised';
    assert public.is_admin(), 'is_admin() false for admin';

    v_res := public.admin_dashboard_stats();
    assert (v_res->>'total_orders')::int >= 2 and (v_res->>'pending')::int >= 2, 'dashboard stats wrong';
    v_res := public.admin_list_orders(v_n1);
    assert (v_res->>'total')::int = 1, 'search by order number failed';
    v_res := public.admin_list_orders('788123456');
    assert (v_res->>'total')::int >= 1, 'search by phone failed';
    v_res := public.admin_list_orders(null, 'pending', 'unpaid', null, null, 1, 0);
    assert jsonb_array_length(v_res->'rows') <= 1, 'pagination limit ignored';
    select id into v_id1 from public.orders where order_number = v_n1;
    select id into v_id2 from public.orders where order_number = v_n2;

    -- illegal moves
    begin perform public.admin_set_order_status(v_id2, 'ready'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'invalid_transition', 'pending->ready allowed: ' || sqlerrm; end;
    begin perform public.admin_set_order_status(v_id2, 'cancelled'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'cancel_reason_required', 'cancel without reason allowed: ' || sqlerrm; end;

    -- confirm order 1 -> tracking opens
    v_res := public.admin_set_order_status(v_id1, 'confirmed', 'Confirmed by phone');
    assert v_res->>'tracking_code' like 'TRK-%' and v_res->>'confirmed_at' is not null, 'confirm did not create tracking code';
    v_res := public.admin_set_delivery_fee(v_id1, 1500);
    assert (v_res->>'delivery_fee')::numeric = 1500 and (v_res->>'total_amount')::numeric = v_expected + 1500, 'delivery fee / total wrong';
    select id into v_pay from public.payments where order_id = v_id1;
    assert (select amount from public.payments where id = v_pay) = v_expected + 1500, 'payment amount not updated with fee';

    execute 'reset role'; execute 'set local role anon';
    v_res := public.track_order(v_n1, '0788123456');
    assert (v_res->>'tracking_available')::boolean and v_res->>'order_status' = 'confirmed'
           and v_res->>'payment_status' = 'pending_verification'
           and jsonb_array_length(v_res->'progress') = 3, 'tracking after confirm wrong: ' || v_res::text;
    assert not (v_res ? 'internal_notes') and not (v_res ? 'customer_phone') and not (v_res ? 'id'), 'tracking leaks private fields';
    raise notice 'PASS D1 admin confirms -> tracking opens; order and payment status stay independent';

    -- payment verification
    execute 'reset role'; execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    begin perform public.admin_verify_payment(v_pay, 'paid', null, 100); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'amount_too_low', 'underpayment accepted: ' || sqlerrm; end;
    begin perform public.admin_verify_payment(v_pay, 'failed'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'notes_required', 'failed without notes: ' || sqlerrm; end;
    v_res := public.admin_verify_payment(v_pay, 'paid', 'MoMo SMS checked', v_expected + 1500);
    assert v_res->>'payment_status' = 'paid' and v_res->>'verified_by' is not null and v_res->>'verified_at' is not null, 'verification not recorded';
    assert (select payment_status from public.orders where id = v_id1) = 'paid', 'order payment_status not synced';
    begin perform public.admin_set_delivery_fee(v_id1, 0); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'locked_after_payment', 'fee changed after payment: ' || sqlerrm; end;
    begin perform public.admin_verify_payment(v_pay, 'paid'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'invalid_payment_transition', 'paid twice: ' || sqlerrm; end;
    raise notice 'PASS D2 admin verifies payment (who + when recorded); fee locked after payment';

    -- full delivery journey on order 2 (a delivery order)
    perform public.admin_set_order_status(v_id2, 'confirmed');
    perform public.admin_set_order_status(v_id2, 'preparing', 'On the grill');
    perform public.admin_set_order_status(v_id2, 'ready');
    begin perform public.admin_set_order_status(v_id2, 'delivered'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'delivery_must_go_out_first', 'ready->delivered on delivery: ' || sqlerrm; end;
    begin perform public.admin_set_order_status(v_id2, 'out_for_delivery', null, -1.95, null); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'location_incomplete', 'half a location accepted: ' || sqlerrm; end;
    perform public.admin_set_order_status(v_id2, 'out_for_delivery', 'Rider left', -1.9500, 30.0500, now() + interval '25 minutes');
    perform public.admin_add_progress(v_id2, 'Near Kimironko', -1.9400, 30.0900);

    execute 'reset role'; execute 'set local role anon';
    v_res := public.track_order(v_n2, '0731234567');
    assert v_res->>'order_status' = 'out_for_delivery' and v_res->>'payment_status' = 'unpaid', 'order2 tracking wrong';
    assert (v_res->'courier_position'->>'latitude')::numeric = -1.9400, 'courier position should be the latest update';
    assert v_res->>'estimated_delivery_at' is not null and (v_res->>'delivery_latitude')::numeric = -1.9441, 'ETA / customer pin missing';

    execute 'reset role'; execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    perform public.admin_set_order_status(v_id2, 'delivered', 'Handed over');
    select count(*) into v_cnt from public.order_status_history where order_id = v_id2;
    assert v_cnt = 7, 'expected 7 history rows for order 2, got ' || v_cnt;
    begin perform public.admin_set_order_status(v_id2, 'preparing'); raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'invalid_transition', 'delivered order reopened: ' || sqlerrm; end;

    execute 'reset role'; execute 'set local role anon';
    assert (public.track_order(v_n2, '0731234567')->'courier_position') = 'null'::jsonb, 'courier position must hide after delivery';
    raise notice 'PASS D3 delivery journey pending -> delivered with courier position + full history (7 rows)';

    -- sold-out product cannot be ordered
    execute 'reset role'; execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    update public.products set is_available = false where id = v_p2;
    execute 'reset role'; execute 'set local role anon';
    begin
      perform public.create_order('Aline Test', '0795551234', 'pickup', null, null, null, null, null,
              jsonb_build_array(jsonb_build_object('product_id', v_p2, 'quantity', 1)), 'mtn_momo', null);
      raise exception 'NO_ERROR';
    exception when others then assert sqlerrm = 'item_unavailable', 'sold-out item was orderable: ' || sqlerrm; end;
    execute 'reset role'; execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin_uid::text, true);
    update public.products set is_available = true where id = v_p2;
    raise notice 'PASS D4 sold-out products cannot be ordered';
  end if;

  -- ============ E. HISTORY IS APPEND-ONLY, RATE LIMITS ============
  execute 'reset role';
  begin
    update public.order_status_history set progress_note = 'tampered' where order_id = v_id1;
    raise exception 'NO_ERROR';
  exception when others then
    assert sqlerrm = 'order_status_history is append-only' or sqlerrm = 'NO_ERROR' and v_id1 is null,
           'history can be edited: ' || sqlerrm;
  end;
  execute 'set local role anon';
  v_i := 0;
  begin
    loop
      exit when v_i > 80;
      perform public.track_order('DK-2026-00001', '0788123456');
      v_i := v_i + 1;
    end loop;
    raise exception 'NO_ERROR';
  exception when others then
    assert sqlerrm = 'rate_limited', 'tracking is not rate limited: ' || sqlerrm;
  end;
  raise notice 'PASS E  history is append-only; brute-force tracking is rate limited (blocked after % tries)', v_i;

  execute 'reset role';
  raise notice '=========================================';
  raise notice 'ALL CHECKS PASSED';
  raise notice '=========================================';
end
$verify$;

rollback;
