-- ============================================================
-- 0013  PRODUCT PHOTOS: default photo path for each starter menu item
-- Photos live in the website's  img/menu/  folder (see img/menu/README.md).
-- This ONLY fills products whose image_url is still empty, so a photo you
-- upload from the admin page is never replaced. Safe to re-run.
-- If a photo file is missing, the site shows the item's emoji tile instead.
-- ============================================================

update public.products p
   set image_url = 'img/menu/' || v.file
  from (values
    ('Brochettes',            'brochettes.jpg'),
    ('Double-Beef Brochette', 'double-beef-brochette.jpg'),
    ('Pork Brochettes',       'pork-brochettes.jpg'),
    ('DK Special Burger',     'dk-special-burger.jpg'),
    ('Chicken Burger',        'chicken-burger.jpg'),
    ('Loaded Fries',          'loaded-fries.jpg'),
    ('Street Fries',          'street-fries.jpg'),
    ('Mutzig',                'mutzig.jpg'),
    ('Primus',                'primus.jpg'),
    ('Turbo King',            'turbo-king.jpg'),
    ('DK Signature Cocktail', 'dk-signature-cocktail.jpg'),
    ('Street Mojito',         'street-mojito.jpg')
  ) as v(name, file)
 where lower(p.name) = lower(v.name)
   and p.image_url is null;
