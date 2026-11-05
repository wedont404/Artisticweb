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
