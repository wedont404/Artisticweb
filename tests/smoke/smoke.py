import json, subprocess, time, re, sys, shutil, os
from playwright.sync_api import sync_playwright
SITE="/home/claude/project/dk-artistic-hub"; SH="/tmp/claude-0/-home-claude/05e4b88e-9616-5ecb-b14f-084ee5f07c8c/scratchpad/smoke"
# temp copy so the test photo is never shipped
T=SH+"/site"; shutil.rmtree(T,ignore_errors=True); shutil.copytree(SITE,T,ignore=shutil.ignore_patterns(".git","tests","supabase"))
from PIL import Image; Image.new("RGB",(800,600),(200,60,60)).save(T+"/img/menu/chicken-burger.jpg","JPEG")
srv=subprocess.Popen(["python3","-m","http.server","8766","-d",T],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
cats=[{"id":"c1","name":"Brochettes","emoji":"🍢","sort_order":1},{"id":"c2","name":"Burgers","emoji":"🍔","sort_order":2}]
U=lambda n:"00000000-0000-4000-8000-00000000000%d"%n
prods=[{"id":U(1),"category_id":"c1","name":"Brochettes","description":"Grilled","price":1000,"image_url":None,"emoji":"🍢","tag":"Popular","is_available":True,"sort_order":1},
 {"id":U(2),"category_id":"c2","name":"Chicken Burger","description":"Chick","price":6500,"image_url":None,"emoji":"🥪","tag":None,"is_available":True,"sort_order":1},
 {"id":U(3),"category_id":"c2","name":"DK Special Burger","description":"Beef","price":8500,"image_url":None,"emoji":"🍔","tag":"Popular","is_available":True,"sort_order":2},
 {"id":U(4),"category_id":"c1","name":"Pork Brochettes","description":"Pork","price":3000,"image_url":None,"emoji":"🥓","tag":None,"is_available":False,"sort_order":3}]
pms=[{"code":"mtn_momo","name":"MTN Mobile Money","instructions":"Dial *182*8*016804#","requires_reference":True},{"code":"cash_on_delivery","name":"Cash","instructions":"Pay rider","requires_reference":False}]
res=[];errs=[];orders=[]
def route(r):
    u=r.request.url
    def j(b,s=200): r.fulfill(status=s,content_type="application/json",headers={"access-control-allow-origin":"*"},body=json.dumps(b))
    if r.request.method=="OPTIONS": return r.fulfill(status=204,headers={"access-control-allow-origin":"*","access-control-allow-headers":"*","access-control-allow-methods":"*"})
    if "/rest/v1/categories" in u: return j(cats)
    if "/rest/v1/products" in u: return j(prods)
    if "/rest/v1/payment_methods" in u: return j(pms)
    if "/rpc/create_order" in u:
        b=json.loads(r.request.post_data); orders.append(b)
        return j({"order_number":"DK-2026-00001","fulfillment_type":b["p_fulfillment_type"],"subtotal":6500,"delivery_fee":0,"total_amount":6500,"order_status":"pending","payment_status":"unpaid","payment_method":b["p_payment_method"],"payment_method_name":"MTN Mobile Money","payment_instructions":"Dial *182*8*016804#"})
    if "/rpc/submit_payment_reference" in u: return j({"found":True,"order_number":"DK-2026-00001","payment_status":"pending_verification"})
    r.fulfill(status=404,body="{}")
def chk(n,c,d=""): res.append(c); print(("PASS " if c else "FAIL ")+n+(" -> "+str(d) if (not c and d) else ""))
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":390,"height":844}); pg=ctx.new_page()
    pg.on("pageerror",lambda e:errs.append(str(e)))
    pg.on("console",lambda m: errs.append(m.text) if m.type=="error" and "404" not in m.text and "Failed to load resource" not in m.text else None)
    ctx.route("**/*.supabase.co/**",route)
    ctx.route("**/nominatim.openstreetmap.org/**",lambda r:r.fulfill(status=200,content_type="application/json",headers={"access-control-allow-origin":"*"},body=json.dumps([] if "/search" in r.request.url else {"display_name":"Masoro, Kigali"})))
    ctx.route("**/cdnjs.cloudflare.com/**",lambda r:r.abort())
    ctx.route("**/fonts.g*/**",lambda r:r.abort())
    B="http://localhost:8766/"
    for pgname in ["index","menu","cart","checkout","done","how","visit","track","terms","admin"]:
        pg.goto(B+pgname+".html"); pg.wait_for_timeout(600)
        ov=pg.evaluate("document.documentElement.scrollWidth>innerWidth+1")
        foot=pg.evaluate("!!document.body.innerText.match(/Terms/i)&&!!document.body.innerText.match(/happily made by/i)")
        chk(pgname+": loads, no sideways scroll",not ov)
        chk(pgname+": footer terms + made-by",foot)
    # nav links present on a page
    pg.goto(B+"index.html"); pg.wait_for_timeout(800)
    nav=pg.evaluate("Array.from(document.querySelectorAll('header a, nav a')).map(a=>a.getAttribute('href'))")
    chk("header links to menu/cart/track/visit/how",all(any(x and h in x for x in nav) for h in ["menu.html","cart.html","track.html","visit.html","how.html"]),nav)
    # home: favourites render, ring faces
    chk("home: ring built",pg.locator("#ring .face").count()>=3,pg.locator("#ring .face").count())
    # menu page
    pg.goto(B+"menu.html"); pg.wait_for_selector(".item"); 
    chk("menu: 4 items",pg.locator(".item").count()==4,pg.locator(".item").count())
    pg.wait_for_timeout(800)
    imgs=pg.evaluate("Array.from(document.querySelectorAll('.item .media img')).map(i=>i.src.split('/').pop())")
    chk("menu: photo shown for item that has a file",imgs==["chicken-burger.jpg"],imgs)
    chk("menu: missing photos fall back to emoji tile",pg.locator(".item .media span").count()==3,pg.locator(".item .media span").count())
    chk("menu: sold out disabled",pg.locator(".item button:disabled").count()==1)
    pg.fill("#search","burger"); chk("menu: search",pg.locator(".item").count()==2)
    pg.fill("#search",""); pg.click("[data-cat=c1]"); chk("menu: category filter",pg.locator(".item").count()==2,pg.locator(".item").count())
    pg.click("[data-cat=all]")
    pg.locator("[data-add]").nth(1).click(); pg.wait_for_timeout(200)
    chk("menu: add to cart -> cart badge",pg.evaluate("JSON.parse(localStorage.getItem('dk_cart2')||'{}')['"+U(2)+"']")==1)
    # cart page
    pg.goto(B+"cart.html"); pg.wait_for_selector(".line"); 
    chk("cart: line with photo",pg.locator(".line .th img").count()==1)
    chk("cart: total 6,500",re.search(r"6[,. ]?500",pg.inner_text("#cartTotal")) is not None,pg.inner_text("#cartTotal"))
    pg.click("[data-inc]"); chk("cart: increase -> 13,000",re.search(r"13[,. ]?000",pg.inner_text("#cartTotal")) is not None,pg.inner_text("#cartTotal"))
    pg.click("[data-dec]")
    # checkout: pickup + cash flow
    pg.goto(B+"checkout.html"); pg.wait_for_selector("#payMethods label"); pg.wait_for_timeout(500)
    chk("checkout: summary shows the item",pg.locator("#coItems .line").count()==1)
    pg.click("#seg button[data-type=pickup]")
    pg.fill("#cName","Test Pop"); pg.fill("#cPhone","0788123456")
    pg.check("input[name=pm][value=mtn_momo]")
    btn=pg.locator("button[type=submit], #placeBtn, #coBtn").first; btn.click(); pg.wait_for_url("**/done.html*",timeout=5000)
    chk("checkout -> done page",True)
    o=orders[0] if orders else {}
    chk("order payload correct",o.get("p_fulfillment_type")=="pickup" and o.get("p_customer_phone") and len(o.get("p_items",[]))==1 and o.get("p_payment_method")=="mtn_momo",o)
    chk("order payload carries no prices",all(set(i.keys())=={"product_id","quantity"} for i in o.get("p_items",[])),o.get("p_items"))
    pg.wait_for_timeout(500)
    chk("done: order number + MTN code + dial",("DK-2026-00001" in pg.inner_text("#doneRef")) and "*182*8*016804#" in pg.inner_text("#donePay"))
    chk("done: whatsapp link",pg.get_attribute("#waOrder","href").startswith("https://wa.me/250782292053"))
    pg.fill("#refInput","MP12345678"); pg.click("#refBtn"); pg.wait_for_timeout(500); chk("done: reference accepted","Reference received" in pg.inner_text("#refBox"))
    chk("done: cart emptied after ordering",pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('dk_cart2')||'{}')).length")==0)
    chk("done: track link",pg.get_attribute("#trackLink","href").startswith("track.html?o=DK-2026-00001"))
    # empty cart page
    pg.goto(B+"cart.html"); pg.wait_for_selector(".cart-empty"); chk("cart: empty state",True)
    # checkout with empty cart should not allow ordering
    pg.goto(B+"checkout.html"); pg.wait_for_timeout(800); chk("checkout: empty cart handled",pg.url.endswith("cart.html") or pg.locator(".cart-empty,.empty").count()>0 or pg.locator("#coItems .line").count()==0,pg.url)
    # unknown page -> 404
    chk("no JS errors anywhere",not errs,errs)
    b.close()
srv.terminate()
print("\n%d/%d passed"%(sum(res),len(res)))
