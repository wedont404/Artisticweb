# DK ARTISTIC HUB

Order street food from **DK ARTISTIC RESTO & BAR**, Masoro, Kigali. Delivery, pickup or dine-in. Pay with MTN Mobile Money or cash. Track your order live.

Built like SquadVault: **plain HTML + CSS + JavaScript** (no framework, no build step), **Supabase** for the database, hosted free on **GitHub Pages**.

*This website was happily made by WecodeNo 404-tresor.*

## What's inside

| Page | For | What it does |
|---|---|---|
| `index.html` | Customers | 3D spinning menu, live menu from the database, cart, checkout with map pin, MTN code, WhatsApp |
| `track.html` | Customers | Order number + phone -> live progress, rider position, payment status |
| `admin.html` | Staff only | Sign in, dashboard, orders, payment verification, delivery tracking, menu, payment methods |
| `terms.html` | Everyone | Terms & Conditions (linked in every footer) |

Customers never create accounts. Only emails on the admin allowlist can sign in.

## Set up in 4 steps

### 1. Install the database (2 minutes)
1. Open `supabase/all_in_one.sql`. On the line near the top
   `select set_config('dk.admin_emails', 'REPLACE_WITH_YOUR_EMAIL@example.com', true);`
   type **your email** (several admins: separate with commas).
2. Supabase dashboard -> **SQL Editor -> New query** -> paste the whole file -> **Run**.
   It runs as one transaction (everything or nothing) and is safe to run again.
3. Optional check: paste `supabase/verify.sql` and Run. It must end with `ALL CHECKS PASSED`. It leaves nothing behind.

### 2. Lock down sign-ups (important)
Supabase -> **Authentication -> Providers -> Email** -> turn **OFF** "Allow new users to sign up".
Then **Authentication -> Users -> Invite user** -> your email. Open the invite link, choose a password. You land on the admin page, linked as admin automatically.

### 3. Publish on GitHub Pages
1. Create a GitHub repo (for example `dk-artistic-hub`) and upload everything in this folder.
2. Repo -> **Settings -> Pages** -> Source: **Deploy from a branch** -> `main` / `(root)` -> Save.
3. After about a minute the site is at `https://YOUR-USERNAME.github.io/dk-artistic-hub/`.

### 4. Tell Supabase where the site lives
Supabase -> **Authentication -> URL Configuration**:
- **Site URL**: your GitHub Pages address
- **Redirect URLs**: add `https://YOUR-USERNAME.github.io/dk-artistic-hub/admin.html`

(This makes invite and "forgot password" links open the admin page.)

Then open the site on a phone, tap **Add to Home Screen**, and you have an app.

## Already filled in for you
`assets/core.js` already holds your Supabase project URL and **publishable key** (`sb_publishable_...`). That key is meant to be public; the database rules (RLS) protect the data. **Never** put a `secret` / `service_role` key anywhere in this folder.

Business details (WhatsApp number, MTN code `*182*8*016804#`, hours, map position) are at the top of `assets/core.js`.

## Everyday use
- **Menu, prices, photos, sold-out:** Admin -> *Menu & products*. Photos are compressed automatically.
- **Payment instructions:** Admin -> *Payment methods* (turn Airtel Money on when you have the details).
- **An order comes in:** Admin -> Orders (new orders also beep and show in the tab title). Confirm it, set the delivery fee, then move it along. The customer sees every step on `track.html`.
- **Payments:** a customer's MoMo reference puts the payment in *To verify*. Check your MoMo SMS, then **Mark paid**. Nothing is ever marked paid automatically.

## How orders stay safe
- Prices are recalculated by the database. The browser cannot change them.
- A submitted order is never "paid". Order status and payment status are separate.
- Tracking needs the order number **and** the phone used. Wrong phone and wrong order look identical, so numbers cannot be guessed.
- Delivery orders must have an address and exact map coordinates inside Rwanda.
- Double taps and retries cannot create two orders.
- Strangers cannot read any order, payment, or customer data. Rate limits slow down guessing.

## Folder map
```
index.html  track.html  admin.html  terms.html  404.html
assets/     app.css  core.js  store.js  track.js  admin.js
sw.js  manifest.webmanifest  icon.svg  robots.txt  .nojekyll
supabase/   all_in_one.sql  verify.sql  migrations/0001..0012  build.sh  apply.sh
docs/       SDLC.md
tests/      stub_supabase.sql  e2e/e2e_full.py
```
After editing a file in `supabase/migrations/`, run `supabase/build.sh` to rebuild `all_in_one.sql`.

## Honest limits
- **Rider position is placed by your team**, not live GPS. Staff tap the map or use "my location" when they post an update.
- **MTN payment is not automatic.** A static site cannot see MoMo payments. You verify them by hand.
- **Map tiles and address search** use free OpenStreetMap services (fine for a restaurant's volume).
- **Supabase free plan** pauses a project after about a week with no use. Visit the dashboard to wake it.
- `terms.html` is a plain-language template. Have a lawyer check it if you need it to be binding.
- **Kinyarwanda toggle** from the earlier WhatsApp-only version is not in this version yet.

## Tests
`tests/e2e/e2e_full.py` drives the real pages in Chrome against a real PostgreSQL loaded with `all_in_one.sql` (65 checks: ordering, checkout rules, payment, tracking, admin, permissions). See `docs/SDLC.md` section 5.
