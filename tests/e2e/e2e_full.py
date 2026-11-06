"""End-to-end test: real pages in Chrome -> mini PostgREST/GoTrue emulator -> REAL Postgres with the real all_in_one.sql."""
import asyncio, json, os, re, subprocess, sys, time, urllib.parse
import psycopg2, psycopg2.extras
from playwright.async_api import async_playwright

SITE = "http://localhost:8765"
HOST = "https://qgprmrtyksygfiqpxsxx.supabase.co"
LEAF = "/tmp/claude-0/-home-claude/05e4b88e-9616-5ecb-b14f-084ee5f07c8c/scratchpad/leaf/node_modules/leaflet/dist/"
SHOTS = "/tmp/claude-0/-home-claude/05e4b88e-9616-5ecb-b14f-084ee5f07c8c/scratchpad/e2e/"
USERS = {"admin@dk.test": "Passw0rd!x", "other@dk.test": "Passw0rd!y"}

conn = psycopg2.connect("host=/tmp port=5544 dbname=dktest user=postgres")
raw = psycopg2.connect("host=/tmp port=5544 dbname=dktest user=postgres"); raw.autocommit = True
def q(sql, args=None):
    c = raw.cursor(); c.execute(sql, args); return c.fetchall() if c.description else None

IDENT = re.compile(r"^[a-z_]+$")
def ident(x):
    assert IDENT.match(x), x
    return psycopg2.sql.Identifier(x)
import psycopg2.sql

def run(role, sub, fn):
    cur = conn.cursor()
    try:
        cur.execute("set local role " + role)
        cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (sub or "",))
        cur.execute("select set_config('request.headers', %s, true)", (json.dumps({"x-forwarded-for": "9.9.9.9"}),))
        res = fn(cur); conn.commit(); return 200, res
    except psycopg2.Error as e:
        conn.rollback(); code = e.pgcode or ""
        st = 401 if code == "42501" and role == "anon" else 403 if code == "42501" else 404 if code in ("42P01", "42883") else 409 if code.startswith("235") or code == "23503" else 400
        return st, {"code": code, "message": e.diag.message_primary or str(e), "details": e.diag.message_detail, "hint": None}

def where(filters):
    parts, vals = [], []
    for k, op, v in filters:
        if op == "eq": parts.append(psycopg2.sql.SQL("{} = %s").format(ident(k))); vals.append(v)
        elif op == "is": parts.append(psycopg2.sql.SQL("{} is null").format(ident(k)))
    return (psycopg2.sql.SQL(" where ") + psycopg2.sql.SQL(" and ").join(parts)) if parts else psycopg2.sql.SQL(""), vals

def table(method, tbl, qs, body, role, sub):
    ident(tbl); sel = "*"; order = []; filters = []
    for k, v in urllib.parse.parse_qsl(qs, keep_blank_values=True):
        if k == "select": sel = v
        elif k == "order": order = v.split(",")
        else:
            m = re.fullmatch(r"(eq|is)\.(.*)", v); filters.append((k, m.group(1), m.group(2)))
    W, wv = where(filters)
    def go(cur):
        if method == "GET":
            cols = psycopg2.sql.SQL("*") if sel == "*" else psycopg2.sql.SQL(",").join(ident(c) for c in sel.split(","))
            ob = psycopg2.sql.SQL("")
            if order:
                ob = psycopg2.sql.SQL(" order by ") + psycopg2.sql.SQL(",").join(
                    psycopg2.sql.SQL("{} {}").format(ident(o.split(".")[0]), psycopg2.sql.SQL("desc" if o.endswith(".desc") else "asc")) for o in order)
            cur.execute(psycopg2.sql.SQL("select to_jsonb(t) from (select {} from public.{}").format(cols, ident(tbl)) + W + ob + psycopg2.sql.SQL(") t"), wv)
        elif method == "POST":
            ks = list(body.keys())
            cur.execute(psycopg2.sql.SQL("insert into public.{} as t ({}) values ({}) returning to_jsonb(t)").format(
                ident(tbl), psycopg2.sql.SQL(",").join(ident(k) for k in ks), psycopg2.sql.SQL(",").join(psycopg2.sql.Placeholder() for _ in ks)), [body[k] for k in ks])
        elif method == "PATCH":
            ks = list(body.keys())
            cur.execute(psycopg2.sql.SQL("update public.{} as t set ").format(ident(tbl)) + psycopg2.sql.SQL(",").join(psycopg2.sql.SQL("{} = %s").format(ident(k)) for k in ks) + W + psycopg2.sql.SQL(" returning to_jsonb(t)"), [body[k] for k in ks] + wv)
        elif method == "DELETE":
            cur.execute(psycopg2.sql.SQL("delete from public.{} as t").format(ident(tbl)) + W + psycopg2.sql.SQL(" returning to_jsonb(t)"), wv)
        return [r[0] for r in cur.fetchall()]
    return run(role, sub, go)

def rpc(name, body, role, sub):
    ident(name)
    ks = list(body.keys())
    def go(cur):
        args = [(k, psycopg2.extras.Json(v) if isinstance(v, (list, dict)) else v) for k, v in body.items()]
        qq = psycopg2.sql.SQL("select to_jsonb(public.{}({}))").format(ident(name), psycopg2.sql.SQL(",").join(psycopg2.sql.SQL("{} => %s").format(ident(k)) for k, _ in args))
        cur.execute(qq, [v for _, v in args]); return cur.fetchone()[0]
    return run(role, sub, go)

def uid_of(email): return q("select id::text from auth.users where email=%s", (email,))[0][0]
def tokens(uid):
    return {"access_token": f"tok:{uid}:{int(time.time()*1000)}", "refresh_token": "ref:" + uid, "expires_in": 3600, "expires_at": int(time.time()) + 3600, "token_type": "bearer"}

LOG = []  # (method, path, has_auth)
async def handle(route):
    req = route.request; u = urllib.parse.urlparse(req.url)
    cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*"}
    if req.method == "OPTIONS": await route.fulfill(status=204, headers=cors); return
    h = {k.lower(): v for k, v in req.headers.items()}
    auth = h.get("authorization", ""); LOG.append((req.method, u.path, bool(auth)))
    role, sub = "anon", None
    if auth.startswith("Bearer tok:"): role, sub = "authenticated", auth.split(":")[1]
    elif auth: await route.fulfill(status=401, headers={**cors, "content-type": "application/json"}, body=json.dumps({"code": "PGRST301", "message": "JWT expired"})); return
    body = None
    if req.post_data and "json" in h.get("content-type", ""):
        try: body = json.loads(req.post_data)
        except Exception: body = None
    p = u.path; st, out = 404, {"message": "not found"}
    if p.startswith("/rest/v1/rpc/"): st, out = rpc(p.split("/")[-1], body or {}, role, sub)
    elif p.startswith("/rest/v1/"): st, out = table(req.method, p.split("/")[3], u.query, body, role, sub)
    elif p == "/auth/v1/token":
        g = urllib.parse.parse_qs(u.query)["grant_type"][0]
        if g == "password":
            if USERS.get((body or {}).get("email")) == (body or {}).get("password"): st, out = 200, tokens(uid_of(body["email"]))
            else: st, out = 400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}
        else: st, out = 200, tokens(body["refresh_token"].split(":")[1])
    elif p == "/auth/v1/logout": await route.fulfill(status=204, headers=cors); return
    elif p in ("/auth/v1/recover", "/auth/v1/user"): st, out = 200, {}
    elif p.startswith("/storage/v1/object/product-images/"): st, out = 200, {"Key": p}
    await route.fulfill(status=st, headers={**cors, "content-type": "application/json"}, body=json.dumps(out, default=str))

async def other_routes(ctx):
    await ctx.route(HOST + "/**", handle)
    async def leaf(route):
        f = route.request.url.split("/")[-1]
        await route.fulfill(path=LEAF + f.replace(".min", ""), content_type="text/css" if f.endswith("css") else "application/javascript")
    await ctx.route("https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/*", leaf)
    async def nom(route):
        if "/reverse" in route.request.url: body = {"display_name": "Test Street 1, Kimironko, Kigali"}
        else: body = [{"lat": "-1.9400", "lon": "30.0900", "display_name": "Kimironko, Gasabo, Kigali, Rwanda"}]
        await route.fulfill(status=200, headers={"access-control-allow-origin": "*"}, content_type="application/json", body=json.dumps(body))
    await ctx.route("https://nominatim.openstreetmap.org/**", nom)
    await ctx.route("https://tile.openstreetmap.org/**", lambda r: r.abort())
    await ctx.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())

RES = []
def ok(name, cond, extra=""):
    RES.append(bool(cond)); print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)), flush=True)

PHOTO = "/home/claude/project/dk-artistic-hub/img/menu/brochettes.jpg"
def make_photo():
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (800, 600), (200, 120, 60)); d = ImageDraw.Draw(im)
    for i in range(0, 800, 40): d.rectangle([i, 0, i + 20, 600], fill=(170, 90, 40))
    d.ellipse([200, 150, 600, 450], fill=(120, 50, 20)); im.save(PHOTO, "JPEG", quality=80)

async def main():
    make_photo()
    srv = subprocess.Popen(["python3", "-m", "http.server", "8765", "--directory", "/home/claude/project/dk-artistic-hub"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
            mob = await b.new_context(viewport={"width": 390, "height": 800}, is_mobile=True, has_touch=True)
            dsk = await b.new_context(viewport={"width": 1280, "height": 900})
            await other_routes(mob); await other_routes(dsk)
            errs = []

            # ======================= STOREFRONT (phone) - separate pages =======================
            pg = await mob.new_page(); pg.on("pageerror", lambda e: errs.append("store: " + str(e)))
            async def scroll_all():
                for y in range(0, 4000, 500):
                    await pg.evaluate(f"window.scrollTo(0,{y})"); await pg.wait_for_timeout(60)
                await pg.evaluate("window.scrollTo(0,0)"); await pg.wait_for_timeout(500)
            # ---- Home
            await pg.goto(SITE + "/index.html"); await pg.wait_for_selector("#fav .item", timeout=8000); await pg.wait_for_timeout(1200)
            ok("S1 home: 4 crowd favourites + 5 category tiles (no full menu on the home page)", await pg.locator("#fav .item").count() == 4 and await pg.locator(".cat-tile").count() == 5 and await pg.locator("#grid").count() == 0, (await pg.locator("#fav .item").count(), await pg.locator(".cat-tile").count()))
            ok("S2 home: 3D ring built with 8 faces", await pg.locator("#ring .face").count() == 8, await pg.locator("#ring .face").count())
            ok("S3 home: no sideways scroll on phone", await pg.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
            ok("S4 visitors send no Authorization header", all(not a for (_, pth, a) in LOG if pth.startswith("/rest/v1/")), [x for x in LOG if x[2]][:3])
            ok("S5 home: live open/happy-hour chips filled", "happy" in (await pg.inner_text("#happyTxt")).lower())
            ok("S5b mobile tab bar visible, Home tab marked current", await pg.is_visible(".tabbar") and await pg.get_attribute('.tabbar a[href="index.html"]', "aria-current") == "page")
            await pg.screenshot(path=SHOTS + "home.png")
            # ---- real photos: put one real jpg in img/menu and check it shows (and every missing one falls back to its emoji)
            await pg.goto(SITE + "/menu.html"); await pg.wait_for_selector(".item", timeout=8000); await scroll_all()
            ok("S6 menu page: 12 items loaded from the database", await pg.locator(".item").count() == 12, await pg.locator(".item").count())
            broken = await pg.evaluate("Array.from(document.querySelectorAll('.media img')).filter(i=>i.complete&&i.naturalWidth===0).length")
            imgs = await pg.locator(".media img").count()
            ok("S7 photo present -> shown as <img>; the 11 missing photos fall back to emoji (no broken images)", imgs == 1 and broken == 0, (imgs, broken))
            ok("S7b the photo really decoded", await pg.evaluate("(()=>{var i=document.querySelector('.media img');return !!i&&i.naturalWidth>=400})()"))
            await pg.screenshot(path=SHOTS + "menu.png")
            await pg.click('[data-cat]:has-text("Beers")'); await pg.wait_for_timeout(200)
            ok("S8 category filter Beers -> 3", await pg.locator(".item").count() == 3)
            await pg.click('[data-cat="all"]'); await pg.fill("#search", "burger"); await pg.wait_for_timeout(200)
            ok("S9 search burger -> 2", await pg.locator(".item").count() == 2)
            await pg.fill("#search", "")
            async def add(name, times=1):
                for _ in range(times):
                    card = pg.locator(".item", has=pg.locator("h3", has_text=re.compile("^" + re.escape(name) + "$")))
                    btn = card.locator("[data-add],[data-inc]").first; await btn.click(); await pg.wait_for_timeout(120)
            await add("Brochettes", 2); await add("Loaded Fries")
            ok("S10 cart badge in the tab bar shows 3", (await pg.inner_text(".tab-n")) == "3", await pg.inner_text(".tab-n"))
            # ---- Cart page
            await pg.click('.tabbar a[href="cart.html"]'); await pg.wait_for_url("**/cart.html"); await pg.wait_for_selector(".line", timeout=6000)
            ok("S11 cart is its own page: 2 lines, subtotal 4,500 RWF", await pg.locator(".line").count() == 2 and "4,500" in await pg.inner_text("#cartTotal"), await pg.inner_text("#cartTotal"))
            ok("S11b cart line for Brochettes shows its photo", await pg.locator('.line .th img').count() == 1)
            await pg.locator('.line', has_text="Loaded Fries").locator("[data-inc]").click(); await pg.wait_for_timeout(200)
            ok("S11c cart stepper updates the total (7,000)", "7,000" in await pg.inner_text("#cartTotal"), await pg.inner_text("#cartTotal"))
            await pg.locator('.line', has_text="Loaded Fries").locator("[data-dec]").click(); await pg.wait_for_timeout(200)
            await pg.reload(); await pg.wait_for_selector(".line"); ok("S12 cart survives refresh", "4,500" in await pg.inner_text("#cartTotal"))
            # ---- Checkout page
            await pg.click('a:has-text("Checkout")'); await pg.wait_for_url("**/checkout.html"); await pg.wait_for_selector("#coBox:not([hidden])", timeout=8000); await pg.wait_for_timeout(500)
            await pg.click("#placeBtn"); ok("S13 empty name blocked", "name" in (await pg.inner_text("#formErr")).lower())
            await pg.fill("#cName", "Aline Uwase"); await pg.fill("#cPhone", "123"); await pg.click("#placeBtn")
            ok("S14 bad phone blocked", "phone" in (await pg.inner_text("#formErr")).lower())
            await pg.fill("#cPhone", "0788 123 456"); await pg.click("#placeBtn")
            ok("S15 delivery without confirmed location blocked", "confirm" in (await pg.inner_text("#formErr")).lower(), await pg.inner_text("#formErr"))
            await pg.wait_for_selector("#pickMap.leaflet-container", timeout=6000)
            await pg.click("#confirmLoc"); ok("S16 confirm before moving pin is refused", "pin" in (await pg.inner_text("#locStatus")).lower(), await pg.inner_text("#locStatus"))
            await pg.fill("#addrQ", "kimiron"); await pg.wait_for_selector("#suggest button", timeout=6000); await pg.click("#suggest button")
            ok("S17 address suggestion fills the address", "Kimironko" in await pg.input_value("#cAddr"))
            await pg.fill("#cInstr", "Blue gate near the pharmacy"); await pg.click("#confirmLoc")
            ok("S18 location confirmed with coordinates", "-1.94000" in await pg.inner_text("#locStatus"), await pg.inner_text("#locStatus"))
            ok("S19 payment methods = MTN + cash (Airtel is off)", await pg.locator(".paymeth").count() == 2, await pg.locator(".paymeth").count())
            ok("S19b checkout shows the order summary with the same total", "4,500" in await pg.inner_text("#coTotal") and await pg.locator("#coItems .line").count() == 2)
            await pg.screenshot(path=SHOTS + "checkout.png")
            await pg.click("#placeBtn"); await pg.wait_for_url("**/done.html", timeout=9000); await pg.wait_for_selector("#doneRef")
            ref1 = (await pg.inner_text("#doneRef")).split(" ")[0]
            ok("S20 order placed -> own 'Order received' page, number from the database", re.fullmatch(r"DK-\d{4}-\d{5}", ref1), ref1)
            row = q("select order_status,payment_status,subtotal,delivery_latitude,delivery_longitude,customer_phone,delivery_instructions from orders where order_number=%s", (ref1,))[0]
            ok("S21 stored pending/unpaid, 4500, exact GPS, +250 phone", row[0] == "pending" and row[1] == "unpaid" and float(row[2]) == 4500 and abs(row[3] + 1.94) < 1e-6 and row[5] == "+250788123456" and row[6], row)
            ok("S21b cart emptied after ordering", await pg.evaluate("DK.cartCount()") == 0)
            ok("S22 MTN code + dial/copy shown after ordering", "*182*8*016804#" in await pg.inner_text("#donePay") and await pg.locator('a[href^="tel:%2A182"]').count() >= 1)
            ok("S23 WhatsApp link carries the order number", ref1 in urllib.parse.unquote(await pg.get_attribute("#waOrder", "href")))
            await pg.reload(); await pg.wait_for_selector("#doneRef")
            ok("S23b done page survives a refresh", (await pg.inner_text("#doneRef")).startswith(ref1))
            await pg.fill("#refInput", "a b!"); await pg.click("#refBtn"); ok("S24 bad reference rejected", "4-64" in await pg.inner_text("#refErr"), await pg.inner_text("#refErr"))
            await pg.fill("#refInput", "MP20261104AB"); await pg.click("#refBtn"); await pg.wait_for_timeout(800)
            pr = q("select p.payment_status,o.payment_status,p.payment_reference from payments p join orders o on o.id=p.order_id where o.order_number=%s", (ref1,))[0]
            ok("S25 reference -> pending_verification (never paid)", pr[0] == "pending_verification" and pr[1] == "pending_verification" and pr[2] == "MP20261104AB", pr)
            await pg.screenshot(path=SHOTS + "done.png")
            k = "idem-test-1"
            def mk(): return {"p_customer_name": "Dup Test", "p_customer_phone": "0731112233", "p_fulfillment_type": "pickup", "p_delivery_address": None, "p_delivery_latitude": None, "p_delivery_longitude": None, "p_google_place_id": None, "p_delivery_instructions": None, "p_items": [{"product_id": q("select id::text from products where name='Mutzig'")[0][0], "quantity": 1}], "p_payment_method": "cash_on_delivery", "p_idempotency_key": k}
            a1 = await pg.evaluate("(a)=>DK.api.rpc('create_order',a)", mk()); a2 = await pg.evaluate("(a)=>DK.api.rpc('create_order',a)", mk())
            ok("S26 duplicate submission returns the same order", a1["order_number"] == a2["order_number"] and a2.get("replayed") is True, (a1, a2))
            # ---- sold out while in the cart
            await pg.goto(SITE + "/menu.html"); await pg.wait_for_selector(".item"); await add("Street Fries")
            q("update products set is_available=false where name='Street Fries'")
            await pg.goto(SITE + "/checkout.html"); await pg.wait_for_selector("#coBox:not([hidden])", timeout=8000)
            # cached menu is refreshed on load, so the sold-out item is pruned before the form even shows
            gone = await pg.is_visible("#coEmpty")
            if not gone:
                await pg.fill("#cName", "Sold Out"); await pg.fill("#cPhone", "0788000111"); await pg.click('#seg [data-type="pickup"]'); await pg.click("#placeBtn"); await pg.wait_for_timeout(900)
                gone = await pg.is_visible("#coEmpty")
            ok("S27 sold-out item is refused and removed; the cart ends up empty with a clear message", gone, await pg.inner_text("main"))
            ok("S28 cart badge back to 0", await pg.evaluate("DK.cartCount()") == 0)
            q("update products set is_available=true where name='Street Fries'")
            # ---- pickup + cash order (no map needed)
            await pg.goto(SITE + "/menu.html"); await pg.wait_for_selector(".item"); await add("Street Fries")
            await pg.goto(SITE + "/checkout.html"); await pg.wait_for_selector("#coBox:not([hidden])", timeout=8000)
            ok("S29 checkout remembers name + phone from last time", await pg.input_value("#cName") == "Aline Uwase")
            await pg.click('#seg [data-type="pickup"]'); ok("S30 pickup hides the map section", not await pg.is_visible("#deliveryBox"))
            await pg.check('input[name="pm"][value="cash_on_delivery"]'); await pg.click("#placeBtn"); await pg.wait_for_url("**/done.html", timeout=9000); await pg.wait_for_selector("#doneRef")
            ref2 = (await pg.inner_text("#doneRef")).split(" ")[0]
            ok("S31 pickup/cash order placed, no reference box", re.fullmatch(r"DK-\d{4}-\d{5}", ref2) and await pg.is_hidden("#refBox"), ref2)
            await pg.click("#trackLink"); await pg.wait_for_selector("#result:not([hidden])", timeout=6000)
            ok("S32 tracking opens from the link, waits for confirmation", await pg.is_visible("#waiting") and await pg.is_hidden("#trackBox"))
            await pg.screenshot(path=SHOTS + "track_wait.png")
            # ---- other pages + every page has the shared header / footer
            ok("S33 empty cart page + empty checkout page are friendly", True)
            await pg.goto(SITE + "/cart.html"); await pg.wait_for_selector(".cart-empty"); ok("S33a empty cart shows a button to the menu", await pg.locator('.cart-empty a[href="menu.html"]').count() == 1)
            await pg.goto(SITE + "/checkout.html"); await pg.wait_for_selector("#coEmpty:not([hidden])", timeout=6000); ok("S33b checkout with an empty cart does not show the form", await pg.is_hidden("#coBox"))
            await pg.goto(SITE + "/done.html"); await pg.evaluate("localStorage.removeItem('dk_done')"); await pg.reload(); ok("S33c order-placed page without an order is friendly", await pg.is_visible("#doneNone") and await pg.is_hidden("#doneBox"))
            await pg.goto(SITE + "/how.html"); await pg.wait_for_selector("#ussdText"); ok("S34 how-to-order page shows the MTN code + dial link", "*182*8*016804#" in await pg.inner_text("#ussdText") and await pg.locator('#dialBtn[href^="tel:%2A182"]').count() == 1)
            await pg.goto(SITE + "/visit.html"); await pg.wait_for_selector("#visitMap.leaflet-container", timeout=6000); ok("S35 visit page: map, phone, WhatsApp, hours", "Masoro" in await pg.inner_text("#vArea") and "wa.me/250782292053" in await pg.get_attribute("#waBtn", "href") and "10:00" in await pg.inner_text("#vHours"))
            titles = set(); allok = True; bad = []
            for pth in ["index", "menu", "cart", "checkout", "done", "how", "visit", "track", "terms"]:
                await pg.goto(SITE + f"/{pth}.html"); await pg.wait_for_timeout(250)
                foot = await pg.inner_text("footer.foot"); t = await pg.title(); titles.add(t)
                good = "Terms & Conditions" in foot and "This website was happily made by WecodeNo 404-tresor" in foot and await pg.locator('footer.foot a[href="terms.html"]').count() == 1 and await pg.locator("header.top .nav a").count() == 5
                if not good: allok = False; bad.append(pth)
            ok("S36 all 9 customer pages: shared header + T&C link + 'happily made by' footer", allok, bad)
            ok("S37 every page has its own title", len(titles) == 9, titles)
            await pg.goto(SITE + "/admin.html"); ok("S38 admin page footer has T&C + made-by too", "Terms & Conditions" in await pg.inner_text("footer.foot") and "happily made by" in await pg.inner_text("footer.foot"))
            dp = await dsk.new_page(); await dp.goto(SITE + "/menu.html"); await dp.wait_for_selector(".item")
            ok("S39 desktop: top nav shown, mobile tab bar hidden, Menu marked current", await dp.is_visible("header.top .nav") and await dp.is_hidden(".tabbar") and await dp.get_attribute('header.top .nav a[href="menu.html"]', "aria-current") == "page")
            await dp.screenshot(path=SHOTS + "menu_desktop.png"); await dp.close()

            # ======================= ADMIN (desktop) =======================
            ad = await dsk.new_page(); ad.on("pageerror", lambda e: errs.append("admin: " + str(e)))
            n0 = len(LOG)
            await ad.goto(SITE + "/admin.html"); await ad.wait_for_timeout(800)
            ok("A1 signed-out visitor sees only the login form", await ad.is_visible("#viewLogin") and await ad.is_hidden("#viewApp"))
            ok("A2 no order data requested before login", not any("orders" in pth or "admin_" in pth for (_, pth, _a) in LOG[n0:]), LOG[n0:])
            await ad.fill("#lEmail", "admin@dk.test"); await ad.fill("#lPass", "wrong"); await ad.click("#lBtn"); await ad.wait_for_timeout(500)
            ok("A3 wrong password rejected", "Wrong email or password" in await ad.inner_text("#lErr"), await ad.inner_text("#lErr"))
            await ad.fill("#lEmail", "other@dk.test"); await ad.fill("#lPass", "Passw0rd!y"); await ad.click("#lBtn"); await ad.wait_for_timeout(900)
            ok("A4 valid login but NOT on the allowlist is refused", "not an authorized administrator" in await ad.inner_text("#lErr") and await ad.is_visible("#viewLogin"), await ad.inner_text("#lErr"))
            ok("A5 refused user keeps no session", await ad.evaluate("localStorage.getItem('dk_admin_ses')") is None)
            await ad.fill("#lEmail", "admin@dk.test"); await ad.fill("#lPass", "Passw0rd!x"); await ad.click("#lBtn"); await ad.wait_for_selector("#viewApp:not([hidden])", timeout=8000); await ad.wait_for_selector(".orow", timeout=6000)
            ok("A6 allowlisted admin signs in", True)
            pend = await ad.inner_text('.stat[data-card="0"] b'); ok("A7 dashboard counts pending orders", int(pend) >= 3, pend)
            await ad.fill("#fSearch", ref1); await ad.wait_for_timeout(900)
            ok("A8 search by order number -> 1 row", await ad.locator(".orow").count() == 1, await ad.locator(".orow").count())
            await ad.fill("#fSearch", "788123456"); await ad.wait_for_timeout(900)
            ok("A9 search by phone finds the order", await ad.locator(".orow").count() >= 1)
            await ad.fill("#fSearch", ""); await ad.select_option("#fOs", "confirmed"); await ad.wait_for_timeout(900)
            ok("A10 status filter (confirmed) -> none yet", await ad.locator(".orow").count() == 0)
            await ad.select_option("#fOs", ""); await ad.fill("#fSearch", ref1); await ad.wait_for_timeout(900)
            await ad.screenshot(path=SHOTS + "admin_list.png")
            await ad.click(".orow"); await ad.wait_for_selector("#dBody .sec-box", timeout=6000); await ad.wait_for_selector("#oMap.leaflet-container", timeout=6000)
            ok("A11 order drawer: customer, map pin, Google Maps link", "Aline Uwase" in await ad.inner_text("#dBody") and await ad.locator('a[href*="google.com/maps?q=-1.94"]').count() == 1)
            await ad.fill("#aNote", "Confirmed, thank you!"); await ad.click('[data-status="confirmed"]'); await ad.wait_for_timeout(1200)
            ok("A12 admin confirms -> tracking code created", q("select tracking_code like 'TRK-%%' from orders where order_number=%s", (ref1,))[0][0])
            await ad.fill("#fee", "1500"); await ad.click("#saveFee"); await ad.wait_for_timeout(1000)
            ok("A13 delivery fee 1,500 -> total 6,000", float(q("select total_amount from orders where order_number=%s", (ref1,))[0][0]) == 6000)
            await ad.fill('[data-pamt]', "100"); await ad.click('[data-to="paid"]'); await ad.wait_for_timeout(900)
            ok("A14 underpayment refused", "less than" in await ad.inner_text("#aErr"), await ad.inner_text("#aErr"))
            await ad.fill('[data-pamt]', ""); await ad.fill('[data-pnote]', "MoMo SMS checked"); await ad.click('[data-to="paid"]'); await ad.wait_for_timeout(1200)
            v = q("select p.payment_status,o.payment_status,p.verified_by is not null,p.verified_at is not null,o.order_status from payments p join orders o on o.id=p.order_id where o.order_number=%s", (ref1,))[0]
            ok("A15 payment verified (who + when), order status stays separate", v == ("paid", "paid", True, True, "confirmed"), v)
            ok("A16 fee locked after payment", await ad.is_disabled("#fee"))
            await ad.click('[data-status="preparing"]'); await ad.wait_for_timeout(1000); await ad.click('[data-status="ready"]'); await ad.wait_for_timeout(1000)
            await ad.wait_for_selector("#cMap.leaflet-container", timeout=6000)
            await ad.locator("#cMap").click(position={"x": 120, "y": 90}); await ad.wait_for_timeout(300)
            ok("A17 rider position set by tapping the map", "Rider at" in await ad.inner_text("#cpTxt"), await ad.inner_text("#cpTxt"))
            await ad.fill("#aEta", "2026-11-04T20:30"); await ad.fill("#aNote", "Rider just left"); await ad.click('[data-status="out_for_delivery"]'); await ad.wait_for_timeout(1200)
            h = q("select h.new_status,h.location_latitude is not null,h.estimated_delivery_at is not null from order_status_history h join orders o on o.id=h.order_id where o.order_number=%s order by h.created_at desc limit 1", (ref1,))[0]
            ok("A18 out-for-delivery saved with rider position + ETA", h == ("out_for_delivery", True, True), h)
            await ad.screenshot(path=SHOTS + "admin_order.png")

            # customer tracking after the admin updates
            tp = await mob.new_page(); tp.on("pageerror", lambda e: errs.append("track: " + str(e)))
            await tp.goto(SITE + "/track.html"); await tp.fill("#tOrder", ref1); await tp.fill("#tPhone", "0731000000"); await tp.click("#tBtn"); await tp.wait_for_timeout(900)
            ok("T1 wrong phone -> 'not found' (no leak)", "could not find" in (await tp.inner_text("#tErr")).lower(), await tp.inner_text("#tErr"))
            await tp.fill("#tPhone", "0788 123 456"); await tp.click("#tBtn"); await tp.wait_for_selector("#trackBox:not([hidden])", timeout=8000); await tp.wait_for_selector("#tMap.leaflet-container", timeout=6000); await tp.wait_for_timeout(500)
            ok("T2 stepper shows 'On the way' as current", "now" in (await tp.get_attribute("#stepper .st:nth-child(4)", "class")), await tp.get_attribute("#stepper .st:nth-child(4)", "class"))
            ok("T3 ETA + Paid + total 6,000 shown", "Estimated" in await tp.inner_text("#etaLine") and "6,000" in await tp.inner_text("#sums") and "Paid" in await tp.inner_text("#rPay"))
            ok("T4 map shows home + rider pins", await tp.locator(".pin").count() == 2, await tp.locator(".pin").count())
            ok("T5 internal notes / phone not in page", "internal" not in (await tp.content()).lower() and "0788123456" not in (await tp.content()))
            await tp.screenshot(path=SHOTS + "track_live.png")
            await ad.click('[data-status="delivered"]'); await ad.wait_for_timeout(1200)
            await tp.reload(); await tp.wait_for_timeout(300); await tp.fill("#tPhone", "0788123456"); await tp.click("#tBtn"); await tp.wait_for_timeout(900)
            ok("T6 delivered shown to the customer", "Delivered" in await tp.inner_text("#etaLine") and await tp.locator("#stepper .st.done").count() == 5)
            await ad.click("#dClose")

            # cancel flow on the pickup order
            await ad.fill("#fSearch", ref2); await ad.wait_for_timeout(900); await ad.click(".orow"); await ad.wait_for_selector("#dBody .sec-box")
            await ad.click('[data-status="cancelled"]'); ok("A19 cancel without a reason refused", "reason" in (await ad.inner_text("#aErr")).lower())
            ad.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
            await ad.fill("#aNote", "Customer asked to cancel"); await ad.click('[data-status="cancelled"]'); await ad.wait_for_timeout(1200)
            ok("A20 order cancelled with reason", q("select order_status from orders where order_number=%s", (ref2,))[0][0] == "cancelled")
            await ad.click("#dClose")

            # products tab
            await ad.click('[data-tab="products"]'); await ad.wait_for_selector(".prow", timeout=6000)
            ok("A21 products tab lists the 12 menu items", await ad.locator(".prow").count() == 12, await ad.locator(".prow").count())
            await ad.locator(".prow", has_text="Mutzig").locator('[data-tog="is_available"]').uncheck(); await ad.wait_for_timeout(900)
            ok("A22 'In stock' switch saved", q("select is_available from products where name='Mutzig'")[0][0] is False)
            await ad.locator(".prow", has_text="Mutzig").locator('[data-tog="is_available"]').check(); await ad.wait_for_timeout(700)
            await ad.click('[data-catedit=""]'); await ad.fill('#cf [name="name"]', "Desserts"); await ad.fill('#cf [name="emoji"]', "🍰"); await ad.click('#cf button[type="submit"]'); await ad.wait_for_timeout(1200)
            ok("A23 new category saved", q("select count(*) from categories where name='Desserts'")[0][0] == 1)
            await ad.click('[data-pedit=""]'); await ad.wait_for_selector("#pf")
            await ad.select_option('#pf [name="category_id"]', label="Desserts"); await ad.fill('#pf [name="name"]', "Test Cake"); await ad.fill('#pf [name="price"]', "3500"); await ad.fill('#pf [name="tag"]', "New")
            await ad.click('#pf button[type="submit"]'); await ad.wait_for_timeout(1300)
            ok("A24 new product saved with price", q("select price from products where name='Test Cake'")[0][0] == 3500)
            await ad.click('[data-pedit=""]'); await ad.wait_for_selector("#pf"); await ad.fill('#pf [name="name"]', "Test Cake"); await ad.fill('#pf [name="price"]', "100"); await ad.select_option('#pf [name="category_id"]', label="Desserts"); await ad.click('#pf button[type="submit"]'); await ad.wait_for_timeout(900)
            ok("A25 duplicate product name gives a friendly error", "already exists" in (await ad.inner_text("#pf [data-err]")).lower(), await ad.inner_text("#pf [data-err]"))
            await ad.click('#pf [data-close]')
            await ad.locator(".prow", has_text="Test Cake").locator("[data-pdel]").click(); await ad.wait_for_timeout(1000)
            ok("A26 product deleted", q("select count(*) from products where name='Test Cake'")[0][0] == 0)
            await ad.screenshot(path=SHOTS + "admin_products.png")
            await ad.click('[data-tab="payments"]'); await ad.wait_for_selector("[data-mcode]")
            await ad.locator('[data-mcode="mtn_momo"] [data-f="instructions"]').fill("Dial *182*8*016804# then send the reference."); await ad.click('[data-msave="mtn_momo"]'); await ad.wait_for_timeout(900)
            ok("A27 payment instructions edited", "send the reference" in q("select instructions from payment_methods where code='mtn_momo'")[0][0])
            await ad.click("#logoutBtn"); await ad.wait_for_timeout(500)
            ok("A28 sign out returns to login and clears session", await ad.is_visible("#viewLogin") and await ad.evaluate("localStorage.getItem('dk_admin_ses')") is None)
            await ad.reload(); await ad.wait_for_timeout(700); ok("A29 reload stays signed out", await ad.is_visible("#viewLogin"))
            # a stale/forged token is rejected by the database
            r = await ad.evaluate("""async()=>{DK.api.tokenFn=async()=>'tok:00000000-0000-0000-0000-000000000000:1';try{return await DK.api.rpc('admin_dashboard_stats')}catch(e){return {code:e.code,status:e.status}}}""")
            ok("A30 token of a non-admin cannot run admin functions", r.get("code") in ("forbidden", "42501") or r.get("status") in (401, 403), r)
            ok("A31 no JavaScript errors on any page", not errs, errs)
            await b.close()
    finally:
        srv.terminate()
        try: os.remove(PHOTO)
        except OSError: pass
    print(f"\n{sum(RES)}/{len(RES)} passed"); sys.exit(0 if all(RES) else 1)

asyncio.run(main())
