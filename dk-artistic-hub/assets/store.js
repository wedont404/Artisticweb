/* DK ARTISTIC HUB - storefront: live menu, 3D ring, cart, checkout (map pin), confirmation */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, $$ = D.$$, esc = D.esc, money = D.money;
  var S = { cats: [], prods: [], methods: [], cat: "all", q: "", cart: {}, type: "delivery", method: null, loc: null, auto: true, map: null, marker: null, last: null, busy: false };
  var NF = "https://nominatim.openstreetmap.org";

  try { S.cart = JSON.parse(D.store.get("dk_cart2", "{}")) || {}; } catch (e) { S.cart = {}; }
  function saveCart() { D.store.set("dk_cart2", JSON.stringify(S.cart)); }
  function byId(id) { for (var i = 0; i < S.prods.length; i++) if (S.prods[i].id === id) return S.prods[i]; return null; }
  function catOf(id) { for (var i = 0; i < S.cats.length; i++) if (S.cats[i].id === id) return S.cats[i]; return null; }
  function emojiOf(p) { return p.emoji || (catOf(p.category_id) || {}).emoji || "\u{1F37D}️"; }

  /* ---------------- static info ---------------- */
  function fillStatic() {
    $("#areaTxt").textContent = D.area;
    $("#vArea").textContent = D.area; $("#vPlus").textContent = "Plus code: " + D.plusCode;
    $("#vHours").textContent = D.openHour + ":00 - " + D.closeHour + ":00 daily";
    $("#vHappy").textContent = D.happyFrom + ":00 - " + D.happyTo + ":00 (drinks only)";
    $("#vPhone").textContent = D.phoneDisplay;
    $("#mapBtn").href = D.gmaps(D.lat, D.lng);
    $("#callBtn").href = "tel:+" + D.whatsapp;
    $("#waBtn").href = "https://wa.me/" + D.whatsapp + "?text=" + encodeURIComponent("Hello DK Artistic Hub");
    $("#ussdText").textContent = D.ussd;
    $("#dialBtn").href = dialHref();
  }
  function dialHref() { return "tel:" + D.ussd.replace(/\*/g, "%2A").replace(/#/g, "%23"); }

  /* ---------------- time dimension: live open / happy hour / day part ---------------- */
  function live() {
    var k = D.kigali(), open = k.h >= D.openHour && k.h < D.closeHour;
    $("#openChip .dot").classList.toggle("off", !open);
    $("#openTxt").textContent = open ? "Open now until " + D.closeHour + ":00" : "Closed. Opens at " + D.openHour + ":00";
    var hf = D.happyFrom * 60, ht = D.happyTo * 60, t;
    function hm(m) { return (m >= 60 ? Math.floor(m / 60) + "h " : "") + (m % 60) + "m"; }
    if (k.mins >= hf && k.mins < ht) t = "Happy hour ends in " + hm(ht - k.mins);
    else if (k.mins < hf) t = "Happy hour starts in " + hm(hf - k.mins);
    else t = "Happy hour " + D.happyFrom + ":00-" + D.happyTo + ":00 tomorrow";
    $("#happyTxt").textContent = t;
    document.body.setAttribute("data-daypart", k.h < 11 ? "morning" : k.h < 17 ? "day" : k.h < 20 ? "evening" : "night");
  }

  /* ---------------- menu ---------------- */
  async function loadMenu() {
    var note = $("#menuNote"), r;
    try {
      r = await Promise.all([
        D.api.get("categories?select=id,name,emoji,sort_order&is_active=eq.true&order=sort_order.asc"),
        D.api.get("products?select=id,category_id,name,description,price,image_url,emoji,tag,is_available,sort_order&is_active=eq.true&order=sort_order.asc"),
        D.api.get("payment_methods?select=code,name,instructions,requires_reference&is_active=eq.true&order=sort_order.asc")
      ]);
      D.store.set("dk_menu_cache", JSON.stringify(r));
      note.hidden = true;
    } catch (e) {
      var c = null; try { c = JSON.parse(D.store.get("dk_menu_cache", "null")); } catch (x) {}
      if (c) { r = c; note.hidden = false; note.textContent = "Showing the last saved menu. " + D.friendly(e); }
      else { showMenuError(e); return; }
    }
    S.cats = r[0]; S.prods = r[1]; S.methods = r[2];
    Object.keys(S.cart).forEach(function (id) { var p = byId(id); if (!p || !p.is_available || !(S.cart[id] > 0)) delete S.cart[id]; });
    saveCart(); renderCats(); renderMenu(); buildRing(); cartUI();
  }
  function showMenuError(e) {
    $("#grid").innerHTML = '<div class="empty">Could not load the menu.<br><span class="small">' + esc(D.friendly(e)) + '</span><br><br>' +
      '<button class="btn primary" id="retryMenu">Try again</button> <a class="btn ghost" href="https://wa.me/' + D.whatsapp + '" target="_blank" rel="noopener">Order on WhatsApp</a></div>';
    var b = $("#retryMenu"); if (b) b.addEventListener("click", function () { $("#grid").innerHTML = '<div class="skel"></div><div class="skel"></div>'; loadMenu(); });
  }
  function renderCats() {
    var all = [{ id: "all", name: "All", emoji: "✨" }].concat(S.cats);
    $("#cats").innerHTML = all.map(function (c) {
      return '<button class="cat' + (c.id === S.cat ? " on" : "") + '" data-cat="' + esc(c.id) + '" role="tab">' + esc((c.emoji || "") + " " + c.name) + "</button>";
    }).join("");
  }
  function actionHTML(p) {
    if (!p.is_available) return '<button class="add" disabled>Sold out</button>';
    var q = S.cart[p.id] || 0;
    if (!q) return '<button class="add" data-add="' + esc(p.id) + '">+ Add</button>';
    return '<div class="stepper"><button data-dec="' + esc(p.id) + '" aria-label="Less">&minus;</button><b>' + q + '</b><button data-inc="' + esc(p.id) + '" aria-label="More">+</button></div>';
  }
  function renderMenu() {
    var q = S.q.trim().toLowerCase();
    var list = S.prods.filter(function (p) {
      return (S.cat === "all" || p.category_id === S.cat) && (!q || (p.name + " " + (p.description || "")).toLowerCase().indexOf(q) > -1);
    });
    $("#grid").innerHTML = list.length ? list.map(function (p, i) {
      var media = p.image_url ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.name) + '" loading="lazy" width="400" height="300">' : "<span>" + esc(emojiOf(p)) + "</span>";
      return '<article class="card item" style="animation-delay:' + Math.min(i, 8) * 50 + 'ms" data-id="' + esc(p.id) + '">' +
        (p.tag ? '<span class="tag">' + esc(p.tag) + "</span>" : "") + '<div class="media">' + media + "</div>" +
        '<div class="item-body"><h3>' + esc(p.name) + "</h3><p>" + esc(p.description || "") + "</p>" +
        '<div class="price-row"><span class="price">' + money(p.price) + '</span><span class="act">' + actionHTML(p) + "</span></div></div></article>";
    }).join("") : '<div class="empty">Nothing found. Try another word.</div>';
  }
  function syncCards() { $$(".item").forEach(function (c) { var p = byId(c.getAttribute("data-id")); if (p) $(".act", c).innerHTML = actionHTML(p); }); }

  /* ---------------- 3D ring (depth + motion) ---------------- */
  var ringRot = 0, ringVel = 0, dragging = false, ringOn = true;
  function buildRing() {
    var ring = $("#ring"), list = S.prods.filter(function (p) { return p.is_available; });
    list.sort(function (a, b) { return (b.tag ? 1 : 0) - (a.tag ? 1 : 0); });
    list = list.slice(0, 8);
    if (list.length < 3) { $("#scene").hidden = true; return; }
    $("#scene").hidden = false;
    var n = list.length, w = innerWidth < 560 ? 132 : 170, r = Math.round((w / 2) / Math.tan(Math.PI / n)) + 26;
    ring.innerHTML = list.map(function (p, i) {
      return '<div class="face" style="transform:rotateY(' + (i * 360 / n) + 'deg) translateZ(' + r + 'px)">' +
        (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="' + esc(p.name) + '" loading="lazy">' : '<div class="fe">' + esc(emojiOf(p)) + "</div>") +
        "<h4>" + esc(p.name) + '</h4><span class="price">' + money(p.price) + '</span><button class="add" data-add="' + esc(p.id) + '">+ Add</button></div>';
    }).join("");
  }
  function ringLoop() {
    if (!dragging && ringOn && !document.hidden) { ringRot += (D.reduce ? 0 : 0.2) + ringVel; ringVel *= 0.94; }
    var r = $("#ring"); if (r) r.style.transform = "rotateY(" + ringRot + "deg)";
    requestAnimationFrame(ringLoop);
  }
  function heroFx() {
    var scene = $("#scene"), stage = $("#stage"), hero = $("#heroSec"), lx = 0, floats = $$(".float");
    scene.addEventListener("pointerdown", function (e) { if (e.target.closest("button")) return; dragging = true; lx = e.clientX; ringVel = 0; try { scene.setPointerCapture(e.pointerId); } catch (x) {} });
    scene.addEventListener("pointermove", function (e) { if (!dragging) return; var dx = e.clientX - lx; lx = e.clientX; ringRot += dx * 0.45; ringVel = dx * 0.25; });
    function up() { dragging = false; }
    scene.addEventListener("pointerup", up); scene.addEventListener("pointercancel", up);
    function tilt(nx, ny) { // nx, ny in -1..1
      stage.style.setProperty("--ty", (nx * 9).toFixed(2) + "deg"); stage.style.setProperty("--tx", (-ny * 6).toFixed(2) + "deg");
      floats.forEach(function (f) { var d = +f.getAttribute("data-depth") || 20; f.style.transform = "translate(" + (nx * d).toFixed(1) + "px," + (ny * d).toFixed(1) + "px)"; });
    }
    if (!D.reduce) {
      hero.addEventListener("pointermove", function (e) { if (e.pointerType === "touch") return; var b = hero.getBoundingClientRect(); tilt(((e.clientX - b.left) / b.width - .5) * 2, ((e.clientY - b.top) / b.height - .5) * 2); });
      window.addEventListener("deviceorientation", function (e) { if (e.gamma == null) return; tilt(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 30))); });
    }
    if ("IntersectionObserver" in window) new IntersectionObserver(function (en) { ringOn = en[0].isIntersecting; }).observe(hero);
    ringLoop();
    var words = ["Brochettes", "Burgers", "Loaded Fries", "Cold Beers", "Cocktails"], wi = 0, el = $("#rot");
    if (!D.reduce) setInterval(function () { el.classList.add("out"); setTimeout(function () { wi = (wi + 1) % words.length; el.textContent = words[wi]; el.classList.remove("out"); }, 300); }, 2200);
  }

  /* ---------------- cart ---------------- */
  function totals() { var n = 0, s = 0; Object.keys(S.cart).forEach(function (id) { var p = byId(id); if (p) { n += S.cart[id]; s += S.cart[id] * Number(p.price); } }); return { n: n, sum: s }; }
  function setQty(id, q) { if (q <= 0) delete S.cart[id]; else S.cart[id] = Math.min(q, 99); saveCart(); cartUI(); syncCards(); }
  function bump(el) { if (!el) return; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  function cartUI() {
    var T = totals(), ids = Object.keys(S.cart);
    $("#cartCount").textContent = T.n; $("#fabCount").textContent = T.n; $("#fabTotal").textContent = money(T.sum);
    $("#fab").classList.toggle("show", T.n > 0); $("#cartTotal").textContent = money(T.sum); $("#coTotal").textContent = money(T.sum);
    if (!ids.length) { $("#cartList").innerHTML = '<div class="cart-empty"><div>&#128722;</div><p>Your cart is empty.<br>Add something tasty!</p></div>'; $("#cartFoot").hidden = true; return; }
    $("#cartList").innerHTML = ids.map(function (id) {
      var p = byId(id); if (!p) return "";
      return '<div class="line"><span class="e">' + esc(emojiOf(p)) + "</span><div><h4>" + esc(p.name) + "</h4><p>" + money(p.price) + " &times; " + S.cart[id] + " = " + money(p.price * S.cart[id]) +
        '</p></div><div class="stepper"><button data-dec="' + esc(id) + '" aria-label="Less">&minus;</button><b>' + S.cart[id] + '</b><button data-inc="' + esc(id) + '" aria-label="More">+</button></div></div>';
    }).join("");
    $("#cartFoot").hidden = false;
  }
  function panel(name) {
    ["pCart", "pCheckout", "pDone"].forEach(function (id) { $("#" + id).hidden = id !== name; });
    $("#drawerTitle").textContent = name === "pCart" ? "Your cart" : name === "pCheckout" ? "Checkout" : "Order placed";
    $("#drawer").classList.toggle("wide", false);
    $(".drawer-body:not([hidden])").scrollTop = 0;
  }
  function openCart(p) { panel(p || "pCart"); $("#drawer").classList.add("on"); $("#overlay").classList.add("on"); $("#drawer").setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; }
  function closeCart() { $("#drawer").classList.remove("on"); $("#overlay").classList.remove("on"); $("#drawer").setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; }

  /* ---------------- checkout ---------------- */
  function openCheckout() {
    if (!Object.keys(S.cart).length) return;
    var c = null; try { c = JSON.parse(D.store.get("dk_cust", "null")); } catch (e) {}
    if (c) { if (!$("#cName").value) $("#cName").value = c.n || ""; if (!$("#cPhone").value) $("#cPhone").value = c.p || ""; }
    renderMethods(); setType(S.type); panel("pCheckout"); $("#formErr").textContent = "";
  }
  function renderMethods() {
    if (!S.methods.length) { $("#payMethods").innerHTML = '<p class="muted small">No payment methods are available right now. Please call us.</p>'; return; }
    if (!S.method || !S.methods.some(function (m) { return m.code === S.method; })) S.method = S.methods[0].code;
    $("#payMethods").innerHTML = S.methods.map(function (m) {
      return '<label class="paymeth' + (m.code === S.method ? " on" : "") + '"><input type="radio" name="pm" value="' + esc(m.code) + '"' + (m.code === S.method ? " checked" : "") + '><span><b>' + esc(m.name) + "</b><small>" + esc(m.instructions || "") + "</small></span></label>";
    }).join("");
  }
  function setType(t) {
    S.type = t; $$("#seg button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-type") === t); });
    $("#deliveryBox").hidden = t !== "delivery";
    $("#feeNote").textContent = t === "delivery" ? "Delivery fee is confirmed by us after you order. You pay the final total." : "No delivery fee for pickup or dine-in.";
    if (t === "delivery") ensureMap();
  }
  function ensureMap() {
    D.loadMap().then(function (L) {
      if (!S.map) {
        S.map = D.makeMap($("#pickMap"), D.lat, D.lng, 14);
        S.marker = L.marker([D.lat, D.lng], { draggable: true, icon: D.pin("\u{1F4CD}") }).addTo(S.map);
        S.marker.on("dragend", function () { var p = S.marker.getLatLng(); setLoc(p.lat, p.lng, null, true); });
        S.map.on("click", function (e) { setLoc(e.latlng.lat, e.latlng.lng, null, true); });
      }
      setTimeout(function () { S.map.invalidateSize(); }, 400);
    }).catch(function () { $("#locStatus").textContent = "The map could not load. Type your address and landmarks instead, then place the order again once the map loads."; });
  }
  function setLoc(lat, lng, addr, reverse) {
    S.loc = { lat: lat, lng: lng, confirmed: false };
    if (S.marker) { S.marker.setLatLng([lat, lng]); }
    if (S.map) S.map.setView([lat, lng], Math.max(S.map.getZoom(), 16));
    if (addr) { $("#cAddr").value = addr; S.auto = true; }
    if (reverse) reverseGeo(lat, lng);
    $("#locStatus").className = "small muted"; $("#locStatus").textContent = "Pin moved. Press Confirm when it is on your door.";
  }
  async function reverseGeo(lat, lng) {
    try {
      var r = await fetch(NF + "/reverse?format=jsonv2&lat=" + lat + "&lon=" + lng); var j = await r.json();
      if (j && j.display_name && (S.auto || !$("#cAddr").value.trim())) { $("#cAddr").value = j.display_name; S.auto = true; }
    } catch (e) { /* address can be typed manually */ }
  }
  var sT;
  function searchAddr() {
    clearTimeout(sT); var q = $("#addrQ").value.trim();
    if (q.length < 3) { $("#suggest").innerHTML = ""; return; }
    sT = setTimeout(async function () {
      try {
        var r = await fetch(NF + "/search?format=jsonv2&limit=5&countrycodes=rw&q=" + encodeURIComponent(q)); var j = await r.json();
        $("#suggest").innerHTML = (j || []).map(function (x) { return '<button type="button" data-lat="' + esc(x.lat) + '" data-lng="' + esc(x.lon) + '" data-name="' + esc(x.display_name) + '">' + esc(x.display_name) + "</button>"; }).join("") || '<p class="muted small">No matches. Try another name or drop the pin by hand.</p>';
      } catch (e) { $("#suggest").innerHTML = '<p class="muted small">Search is unavailable. Drop the pin by hand.</p>'; }
    }, 600);
  }
  function geo() {
    if (!navigator.geolocation) { $("#locStatus").textContent = "Location is not supported on this device."; return; }
    $("#locStatus").textContent = "Finding you...";
    navigator.geolocation.getCurrentPosition(function (p) { setLoc(p.coords.latitude, p.coords.longitude, null, true); }, function () { $("#locStatus").textContent = "Could not get your location. Search or drop the pin by hand."; }, { enableHighAccuracy: true, timeout: 12000 });
  }
  function confirmLoc() {
    var st = $("#locStatus"), a = $("#cAddr").value.trim();
    if (!S.loc) { st.className = "small err"; st.textContent = "Move the pin to your location first (search, use my location, or drag the pin)."; return; }
    if (!D.inRwanda(S.loc.lat, S.loc.lng)) { st.className = "small err"; st.textContent = "That location is outside Rwanda."; return; }
    if (a.length < 3) { st.className = "small err"; st.textContent = "Please type or confirm your delivery address."; $("#cAddr").focus(); return; }
    S.loc.confirmed = true; st.className = "small ok-note"; st.textContent = "✔ Location confirmed (" + S.loc.lat.toFixed(5) + ", " + S.loc.lng.toFixed(5) + ")";
  }
  function fingerprint(items, phone, name) { return JSON.stringify([items, phone, name, S.type, S.loc && [S.loc.lat, S.loc.lng], S.method, $("#cAddr").value, $("#cInstr").value]); }
  function idemKey(fp) {
    var o = null; try { o = JSON.parse(sessionStorage.getItem("dk_idem") || "null"); } catch (e) {}
    if (o && o.fp === fp) return o.key;
    var k = D.uuid(); try { sessionStorage.setItem("dk_idem", JSON.stringify({ fp: fp, key: k })); } catch (e) {} return k;
  }
  async function placeOrder() {
    if (S.busy) return;
    var err = $("#formErr"); err.textContent = "";
    var name = $("#cName").value.trim(), phone = D.normPhone($("#cPhone").value), items = Object.keys(S.cart).map(function (id) { return { product_id: id, quantity: S.cart[id] }; });
    if (!items.length) { err.textContent = "Your cart is empty."; return; }
    if (name.length < 2) { err.textContent = D.friendly({ code: "invalid_name" }); $("#cName").focus(); return; }
    if (!phone) { err.textContent = D.friendly({ code: "invalid_phone" }); $("#cPhone").focus(); return; }
    if (!S.method) { err.textContent = D.friendly({ code: "invalid_payment_method" }); return; }
    var addr = null, lat = null, lng = null, instr = $("#cInstr").value.trim() || null;
    if (S.type === "delivery") {
      addr = $("#cAddr").value.trim();
      if (!S.loc || !S.loc.confirmed) { err.textContent = "Please confirm your exact location on the map."; return; }
      if (addr.length < 3) { err.textContent = D.friendly({ code: "delivery_address_required" }); return; }
      lat = S.loc.lat; lng = S.loc.lng;
    } else instr = null;
    S.busy = true; var btn = $("#placeBtn"); btn.disabled = true; btn.textContent = "Placing your order...";
    try {
      var res = await D.api.rpc("create_order", {
        p_customer_name: name, p_customer_phone: phone, p_fulfillment_type: S.type, p_delivery_address: addr,
        p_delivery_latitude: lat, p_delivery_longitude: lng, p_google_place_id: null, p_delivery_instructions: instr,
        p_items: items, p_payment_method: S.method, p_idempotency_key: idemKey(fingerprint(items, phone, name))
      });
      D.store.set("dk_cust", JSON.stringify({ n: name, p: $("#cPhone").value.trim() }));
      D.store.set("dk_last", JSON.stringify({ o: res.order_number, p: phone }));
      try { sessionStorage.removeItem("dk_idem"); } catch (e) {}
      S.last = { res: res, name: name, phone: phone, items: items, addr: addr, lat: lat, lng: lng, instr: instr, type: S.type };
      S.cart = {}; saveCart(); cartUI(); syncCards(); showDone(); D.confetti();
    } catch (e) {
      err.textContent = D.friendly(e);
      if (e.code === "item_unavailable") { loadMenu(); }
    } finally { S.busy = false; btn.disabled = false; btn.textContent = "Place order"; }
  }
  function showDone() {
    var L = S.last, r = L.res, m = null;
    S.methods.forEach(function (x) { if (x.code === r.payment_method) m = x; });
    $("#doneRef").textContent = r.order_number + " · " + money(r.subtotal) + (L.type === "delivery" ? " + delivery fee" : "");
    var html = "<b>Payment: " + esc(r.payment_method_name || (m && m.name) || "") + "</b><p class=\"muted small\" style=\"margin-top:6px\">" + esc(r.payment_instructions || (m && m.instructions) || "") + "</p>";
    if (r.payment_method === "mtn_momo") {
      html += '<div class="center"><div class="code">' + esc(D.ussd) + '</div><div class="pay-btns" style="justify-content:center"><a class="btn primary sm" href="' + dialHref() + '">&#128222; Dial to pay</a><button class="btn ghost sm" id="doneCopy" type="button">Copy code</button></div>' +
        '<p class="muted small" style="margin-top:8px">Pay after we confirm your total (delivery fee included).</p></div>';
    }
    $("#donePay").innerHTML = html;
    var dc = $("#doneCopy"); if (dc) dc.addEventListener("click", function () { D.copy(D.ussd); });
    var needRef = m ? !!m.requires_reference : r.payment_method !== "cash_on_delivery";
    $("#refBox").hidden = !needRef; $("#refInput").value = ""; $("#refErr").textContent = "";
    var lines = L.items.map(function (i) { var p = byId(i.product_id); return "• " + i.quantity + " x " + (p ? p.name : "item"); });
    var msg = "NEW ORDER " + r.order_number + "\nName: " + L.name + "\nPhone: " + L.phone + "\nType: " + L.type.replace("_", "-") +
      (L.addr ? "\nAddress: " + L.addr + "\nMap: " + D.gmaps(L.lat, L.lng) : "") + "\n\n" + lines.join("\n") + "\n\nSubtotal: " + money(r.subtotal) + (L.instr ? "\nNotes: " + L.instr : "") + "\nPayment: " + (r.payment_method_name || "");
    $("#waOrder").href = "https://wa.me/" + D.whatsapp + "?text=" + encodeURIComponent(msg);
    $("#trackLink").href = "track.html?o=" + encodeURIComponent(r.order_number);
    panel("pDone");
  }
  async function submitRef() {
    var ref = $("#refInput").value.trim(), er = $("#refErr"); er.textContent = "";
    if (!/^[A-Za-z0-9._-]{4,64}$/.test(ref)) { er.textContent = D.friendly({ code: "invalid_reference" }); return; }
    var b = $("#refBtn"); b.disabled = true;
    try {
      var r = await D.api.rpc("submit_payment_reference", { p_order_number: S.last.res.order_number, p_phone: S.last.phone, p_reference: ref });
      if (!r || !r.found) { er.textContent = "We could not match this order. Please contact us."; }
      else { $("#refBox").innerHTML = '<p class="ok-note">&#10004; Reference received. We will verify your payment shortly. It shows as "pending verification" until we do.</p>'; D.toast("Reference sent"); }
    } catch (e) { er.textContent = D.friendly(e); } finally { b.disabled = false; }
  }

  /* ---------------- fun: mood / surprise ---------------- */
  var MOODS = { hungry: ["brochette", "burger"], chill: ["beer"], party: ["cocktail", "beer"], snack: ["side", "fries"] };
  var rolling = false;
  function surprise(mood) {
    if (rolling) return;
    var pool = S.prods.filter(function (p) {
      if (!p.is_available) return false; if (!mood) return true;
      var n = ((catOf(p.category_id) || {}).name || "").toLowerCase();
      return MOODS[mood].some(function (k) { return n.indexOf(k) > -1; });
    });
    if (!pool.length) pool = S.prods.filter(function (p) { return p.is_available; });
    if (!pool.length) { D.toast("The menu is still loading"); return; }
    rolling = true; var box = $("#result"), n = 0, steps = D.reduce ? 1 : 14;
    $("#fun").scrollIntoView({ behavior: D.reduce ? "auto" : "smooth", block: "center" });
    (function tick() {
      var p = pool[Math.floor(Math.random() * pool.length)], last = ++n >= steps;
      box.innerHTML = '<div class="pick"><div class="big">' + esc(emojiOf(p)) + "</div><h3>" + esc(p.name) + "</h3>" +
        (last ? '<p class="muted">' + esc(p.description || "") + '</p><p class="price">' + money(p.price) + '</p><button class="btn primary" data-add="' + esc(p.id) + '">+ Add to cart</button>' : "") + "</div>";
      if (last) { rolling = false; if (!D.reduce) D.confetti(40); } else setTimeout(tick, 60 + n * 14);
    })();
  }

  /* ---------------- events ---------------- */
  function bind() {
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-add],[data-inc],[data-dec],[data-cat],[data-mood],[data-type]"); if (!b) return;
      if (b.hasAttribute("data-add")) { var id = b.getAttribute("data-add"), p = byId(id); if (!p) return; setQty(id, (S.cart[id] || 0) + 1); bump($("#fab")); bump($("#cartBtn")); D.toast("Added " + p.name); }
      else if (b.hasAttribute("data-inc")) { var a = b.getAttribute("data-inc"); setQty(a, (S.cart[a] || 0) + 1); }
      else if (b.hasAttribute("data-dec")) { var d = b.getAttribute("data-dec"); setQty(d, (S.cart[d] || 0) - 1); }
      else if (b.hasAttribute("data-cat")) { S.cat = b.getAttribute("data-cat"); renderCats(); renderMenu(); }
      else if (b.hasAttribute("data-mood")) { $$("#moods button").forEach(function (x) { x.classList.toggle("on", x === b); }); surprise(b.getAttribute("data-mood")); }
      else if (b.hasAttribute("data-type")) setType(b.getAttribute("data-type"));
    });
    $("#search").addEventListener("input", function (e) { S.q = e.target.value; renderMenu(); });
    $("#cartBtn").addEventListener("click", function () { openCart("pCart"); }); $("#fab").addEventListener("click", function () { openCart("pCart"); });
    $("#closeCart").addEventListener("click", closeCart); $("#overlay").addEventListener("click", closeCart); $("#doneClose").addEventListener("click", closeCart);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCart(); });
    $("#toCheckout").addEventListener("click", openCheckout); $("#backCart").addEventListener("click", function () { panel("pCart"); });
    $("#placeBtn").addEventListener("click", placeOrder); $("#refBtn").addEventListener("click", submitRef);
    $("#payMethods").addEventListener("change", function (e) { if (e.target.name === "pm") { S.method = e.target.value; $$(".paymeth").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); }); } });
    $("#addrQ").addEventListener("input", searchAddr);
    $("#suggest").addEventListener("click", function (e) { var b = e.target.closest("[data-lat]"); if (!b) return; setLoc(+b.getAttribute("data-lat"), +b.getAttribute("data-lng"), b.getAttribute("data-name"), false); $("#suggest").innerHTML = ""; });
    $("#cAddr").addEventListener("input", function () { S.auto = false; });
    $("#geoBtn").addEventListener("click", geo); $("#confirmLoc").addEventListener("click", confirmLoc);
    $("#surprise").addEventListener("click", function () { $$("#moods button").forEach(function (x) { x.classList.remove("on"); }); surprise(null); });
    $("#surpriseTop").addEventListener("click", function () { surprise(null); });
    $("#copyBtn").addEventListener("click", function () { D.copy(D.ussd); });
    var taps = 0, tt; $("#logoTap").addEventListener("click", function (e) { e.preventDefault(); taps++; clearTimeout(tt); tt = setTimeout(function () { taps = 0; }, 900); if (taps >= 5) { taps = 0; D.confetti(220); D.toast("You found the secret! Mention it for a surprise."); } });
    if (!D.reduce && matchMedia("(hover:hover)").matches) {
      var g = $("#grid");
      g.addEventListener("pointermove", function (e) { var c = e.target.closest(".item"); if (!c) return; var r = c.getBoundingClientRect(); c.style.setProperty("--ry", ((e.clientX - r.left) / r.width - .5) * 9 + "deg"); c.style.setProperty("--rx", (-((e.clientY - r.top) / r.height - .5)) * 9 + "deg"); });
      g.addEventListener("pointerout", function (e) { var c = e.target.closest(".item"); if (c) { c.style.setProperty("--rx", "0deg"); c.style.setProperty("--ry", "0deg"); } });
    }
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (en) { en.forEach(function (x) { if (x.isIntersecting) { x.target.classList.add("in"); io.unobserve(x.target); } }); }, { threshold: .12 });
      $$(".reveal").forEach(function (el) { io.observe(el); });
      var mio = new IntersectionObserver(function (en) {
        if (!en[0].isIntersecting) return; mio.disconnect();
        D.loadMap().then(function (L) { var m = D.makeMap($("#visitMap"), D.lat, D.lng, 16); L.marker([D.lat, D.lng], { icon: D.pin("\u{1F362}") }).addTo(m).bindPopup("DK ARTISTIC HUB"); }).catch(function () { $("#visitMap").hidden = true; });
      }, { rootMargin: "200px" });
      mio.observe($("#visitMap"));
    } else $$(".reveal").forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------------- start ---------------- */
  fillStatic(); live(); setInterval(live, 30000); bind(); heroFx(); cartUI(); loadMenu();
  var t0 = Date.now(), pre = $("#preloader");
  function hidePre() { setTimeout(function () { pre.classList.add("done"); }, Math.max(0, 700 - (Date.now() - t0))); }
  if (document.readyState === "complete") hidePre(); else window.addEventListener("load", hidePre);
  setTimeout(function () { pre.classList.add("done"); }, 4000);
})();
