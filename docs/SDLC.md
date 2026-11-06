# DK ARTISTIC HUB - Software Development Life Cycle (SDLC) v2

Project: Restaurant ordering, payment tracking and delivery tracking web app for DK ARTISTIC RESTO & BAR, Masoro, Kigali.
Built by: WecodeNo 404-tresor
Method: lightweight iterative (small releases, owner feedback each round)
Stack: plain HTML + CSS + JavaScript, Supabase (PostgreSQL + Auth + Storage), GitHub Pages

> v1 was a static site that sent orders to WhatsApp. v2 (this document) adds a real database, order and payment tracking, delivery tracking and an admin dashboard.

---

## 1. Planning

**Problem.** Orders arrived only as WhatsApp messages: easy to lose, no payment record, no tracking for the customer, no way to see sales.

**Goal.** A fast, fun, mobile-first site where a customer orders without an account, pins an exact delivery spot, pays by MTN or cash, and follows the order live, while staff manage everything from one admin page.

**In scope.** Menu, cart, checkout with map pin, order numbers, payment verification, delivery tracking, admin dashboard, menu and payment-method management, Terms page, installable app.

**Out of scope (on purpose).**
- Customer accounts or logins.
- Automatic MTN payment detection (a static site cannot see MoMo payments; staff verify by hand).
- Live GPS from a rider's phone (staff post the rider position manually).
- Card payments.

**Why no server of our own.** The database enforces every rule (Row Level Security + functions), so the site is static files. Nothing to host or patch, and it loads fast on mobile data. Same approach as SquadVault.

**Risks and answers**

| Risk | Answer |
|---|---|
| Customer claims "I paid" | Payment stays *pending verification* until staff mark it paid; staff see the customer's MoMo reference and record who verified and when |
| Someone tries to read or change orders | Visitors have no access to order tables; all writes go through checked functions; tested |
| Browser tampering with prices | Prices are recalculated in the database from the product table |
| Guessing order numbers | Tracking needs order number + phone; wrong phone and wrong order give the same answer; rate limits |
| Duplicate orders (double tap, bad network) | Idempotency key per checkout; same key returns the same order |
| Anyone registering as admin | Sign-ups switched off; only allowlisted emails are linked as admins |
| Wrong delivery location | Customer must search or drag a pin and confirm; coordinates saved; address required |
| Free Supabase plan pauses when idle | Documented; visit the dashboard to wake |
| Image uploads slow the menu | Photos are resized and compressed (max 1 MB) before upload |

---

## 2. Requirements

### Functional
| ID | Requirement |
|---|---|
| F1 | Public menu from the database, categories, search, sold-out state |
| F2 | Cart that survives refresh |
| F3 | Checkout: name, Rwandan phone (validated, +250), delivery / pickup / dine-in |
| F4 | Delivery location: address search, "use my location", draggable pin, confirm, landmark; saved as latitude, longitude and address |
| F5 | Unique order number DK-YYYY-00001 |
| F6 | Order status and payment status kept separate |
| F7 | Payment methods set by admin; MTN code with dial and copy; customer sends a reference |
| F8 | WhatsApp button with the order summary |
| F9 | Tracking page: order number + phone, progress steps, ETA, payment status, delivery map, rider position, history; auto-refresh |
| F10 | Tracking opens only after staff confirm the order |
| F11 | Admin sign in (allowlist only), dashboard counts, order search and filters, pagination |
| F12 | Admin actions: confirm, cancel (with reason), prepare, ready, out for delivery, delivered, delivery fee, notes, rider position, ETA, verify payment, refund |
| F13 | Admin menu: products, categories, price, photo upload, visible, in stock; payment method editor |
| F14 | Full history of every status change (append-only) |
| F15 | Terms & Conditions linked in every footer; "made by" credit |
| F16 | Fun: 3D spinning menu, surprise me, moods, vibes, dark/light, bigger text, confetti |

### Non-functional
- Mobile-first, works from 320 px wide; no horizontal scroll.
- No framework and no build step; small files, maps load only when needed.
- Accessible: focus styles, labels, large tap targets, reduced-motion support.
- Works offline for already-visited pages (service worker); data needs a connection.
- Privacy: store only name, phone, order and location; staff-only access; no card data.

---

## 3. Design

### Architecture
```
Browser (static files on GitHub Pages)
 ├─ index / menu / cart / checkout / done / how / visit .html
 │   shop.js (menu + cart shared), home.js, menu.js, cart.js, checkout.js, done.js, info.js
 ├─ track.html + track.js    customer tracking
 ├─ admin.html + admin.js    staff dashboard (sign in required)
 └─ core.js                  config, API helper (plain fetch), maps, theme
        │  HTTPS, publishable key (public by design)
        ▼
Supabase
 ├─ PostgREST  tables (read rules) + RPC functions (all writes)
 ├─ Auth       admin sign in (email + password), invite and reset links
 ├─ Storage    product-images bucket (admin upload only)
 └─ PostgreSQL tables, constraints, triggers, Row Level Security
```
Maps use Leaflet with OpenStreetMap tiles and Nominatim address search (free, no key).

### Data model (10 tables)
`admin_users`, `categories`, `products`, `payment_methods`, `orders`, `order_items`, `payments`, `order_status_history`, `order_counters`, `rate_limit_events`.
UUID keys, foreign keys, indexes, `numeric` money, database-set timestamps, product name and price snapshotted into `order_items`.

### Security model
| Who | Can |
|---|---|
| Visitor (anon) | Read active menu and payment methods. Call `create_order`, `submit_payment_reference`, `track_order`. Nothing else |
| Signed in, not an admin | Same as visitor. Admin functions answer "forbidden" |
| Admin | Read all orders, payments, history. Run `admin_*` functions. Manage menu and payment methods |
| Owner (admin role) | Also manage the admin list |

Every `admin_*` function re-checks admin status itself. History cannot be edited. Statuses only move forward (or to cancelled with a reason).

### Order flow
```
Customer: pick items -> checkout -> create_order      (order: pending, payment: unpaid)
Staff:    confirm  -> tracking opens                  (order: confirmed)
Customer: pays by MTN/cash, sends reference           (payment: pending verification)
Staff:    checks MoMo SMS -> Mark paid                (payment: paid, who + when)
Staff:    preparing -> ready -> out for delivery (+ rider position, ETA) -> delivered
Customer: follows every step on track.html
```

### UX and brand
Deep plum background with pink outlines (from the owner's reference image), rounded cards, 3D menu ring that follows the pointer or phone tilt, a time-aware header (open now, happy-hour countdown, day-part glow), vibes, dark and light.

---

## 4. Implementation

| Step | Output |
|---|---|
| 1 | SDLC and requirements |
| 2 | Database: 12 numbered SQL files + `all_in_one.sql` (one transaction) + `verify.sql` self-test |
| 3 | `core.js` shared config, API, helpers |
| 4 | Storefront: menu, 3D ring, cart, checkout, map pin, confirmation |
| 5 | Tracking page |
| 6 | Admin: login, dashboard, orders, payments, delivery, menu, payment methods |
| 7 | Terms, 404, PWA files, README |
| 8 | Automated end-to-end tests and fixes |

---

## 5. Testing

### Database self-test (`supabase/verify.sql`)
14 groups of checks: RLS on every table; visitors cannot read or write orders, payments or admins; 16 kinds of bad orders rejected with the right reason; prices recalculated server-side; duplicate submission returns the same order; tracking needs the right phone and stays closed until confirmed; payment references; non-admins blocked; admin journey pending -> delivered; sold-out items refused; history append-only; rate limiting. Ends with `ALL CHECKS PASSED` and rolls back.

### End-to-end test (`tests/e2e/e2e_full.py`) - 65 checks
Real pages in Chrome against a real PostgreSQL loaded with `all_in_one.sql`, through a small PostgREST/Auth emulator.

- **Storefront (28):** menu from the database, 3D ring, no horizontal scroll, no auth header from visitors, filters, search, cart persistence, checkout validation, address search, pin and confirm, order saved with exact GPS and +250 phone, MTN code, WhatsApp link, reference -> pending verification, duplicate submit, sold-out while in cart, pickup and cash order.
- **Admin (31):** signed-out visitors see only the login; no data requested before login; wrong password; valid login that is not on the allowlist is refused and keeps no session; dashboard, search, filters; confirm; delivery fee; underpayment refused; payment verified (who + when) with order status separate; fee locked after payment; rider position and ETA; cancel needs a reason; products, categories, in-stock switch, duplicate-name error, delete; payment instructions; sign out; forged token rejected.
- **Customer tracking (6):** wrong phone gives "not found"; stepper, ETA, payment, total, home and rider pins; no private data on the page; delivered state.

Result at hand-over: **65 / 65 passed**, no JavaScript errors on any page. Bugs found and fixed by these tests: ordering of same-moment updates in the database, error-code handling in the front end, sticky hover on touch screens.

### Not tested here (needs your real accounts and phone)
| # | Check | Who |
|---|---|---|
| M1 | Run `all_in_one.sql` on the real Supabase project, then `verify.sql` | Owner |
| M2 | Invite email arrives, link opens the admin page, password set | Owner |
| M3 | Real MTN dial of `*182*8*016804#` from the Dial button | Owner, on an MTN SIM |
| M4 | WhatsApp opens to +250 782 292 053 with the order | Owner |
| M5 | Photo upload to the real `product-images` bucket | Owner |
| M6 | Real map tiles and address search on a phone | Owner |
| M7 | Place a test order on a phone, confirm and deliver it from the admin page, watch the tracking page | Owner |
| M8 | Add to Home Screen, open offline | Owner |

---

## 6. Deployment

1. Install the database (README step 1) and lock down sign-ups (step 2).
2. Upload the repo to GitHub and enable Pages (step 3).
3. Set Supabase Site URL and Redirect URL (step 4).
4. Run M1 to M8 above before announcing the site.

## 7. Maintenance

- **Menu, prices, photos, stock:** admin page, no code.
- **Business details:** top of `assets/core.js`.
- **Database changes:** edit a file in `supabase/migrations/`, run `supabase/build.sh`, run the new `all_in_one.sql` (safe to repeat).
- **After big code edits:** bump `VERSION` in `sw.js` so phones fetch the new files.
- **Backups:** Supabase dashboard -> Database -> Backups; export orders as CSV from the Table Editor when needed.
- Keep the project awake on the free plan; clean old rate-limit rows (done automatically).

## 8. Future releases

- v2.1: Kinyarwanda toggle, loyalty stamps, order history on the customer's phone
- v2.2: payment gateway with webhooks (for example IntaSend) to verify MoMo automatically
- v2.3: rider phone page that posts real GPS
- v2.4: daily sales report and CSV export in the admin page
